import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight, Send, Square } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { findCsrfToken } from "@/lib/api";
import { cn } from "@/lib/utils";
// Reuses only the AG-UI parser logic from chat/ — no UI components, no
// stylesheet. The widget itself is native to console's idiom (Tailwind +
// shadcn) so it inherits dark mode + the rest of the surface naturally.
import { parseSSEStream, type AGUIEvent } from "@chat/lib/ag-ui-parse";

// ---------------------------------------------------------------------------
// Local message model — narrower than the chat/ chat-store; this tab is
// session-scoped, no localStorage persistence, no per-source keying. If
// operators ask for chat history across reloads we'll add it then.
// ---------------------------------------------------------------------------

interface ToolCall {
  id: string;
  name: string;
  args?: string;
  result?: string;
  status: "running" | "completed" | "error";
}

interface Message {
  id: string;
  role: "user" | "assistant";
  content: string;
  toolCalls?: ToolCall[];
  error?: string;
}

// ---------------------------------------------------------------------------
// Tab
// ---------------------------------------------------------------------------

export function ChatTab() {
  const { data, loading, error } = useDashboardContext();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [threadId, setThreadId] = useState<string>(() => crypto.randomUUID());
  const abortRef = useRef<AbortController | null>(null);

  // Cleanup on unmount — kill any in-flight stream.
  useEffect(() => () => abortRef.current?.abort(), []);

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: Message = { id: crypto.randomUUID(), role: "user", content: text };
    const assistantMsg: Message = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      toolCalls: [],
    };
    setMessages((m) => [...m, userMsg, assistantMsg]);
    setInput("");
    setStreaming(true);
    setStreamError(null);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const toolCallMap = new Map<string, ToolCall>();
    let receivedText = "";

    const update = (patch: Partial<Message>) =>
      setMessages((ms) => ms.map((m) => (m.id === assistantMsg.id ? { ...m, ...patch } : m)));

    try {
      const csrf = findCsrfToken(data?.csrfTokens ?? [], "console-chat");
      if (!csrf) {
        throw new Error(
          "Missing CSRF token — reload the page to mint a fresh /console/api/chat token.",
        );
      }
      const url = buildSameOriginUrl("/console/api/chat");
      const res = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csrf, message: text, threadId }),
        signal: ctrl.signal,
      });
      if (res.status === 419) {
        throw new Error("Session expired — reload the page.");
      }
      if (!res.ok) {
        const detail = await readErrorDetail(res);
        throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
      }
      if (!res.body) throw new Error("Empty response body");

      for await (const ev of parseSSEStream(res.body, { signal: ctrl.signal })) {
        applyEvent(ev);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        const msg = (err as Error).message;
        setStreamError(msg);
        update({ error: msg });
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }

    function applyEvent(ev: AGUIEvent) {
      switch (ev.type) {
        case "RUN_STARTED":
          if (ev.threadId) setThreadId(ev.threadId);
          break;
        case "TEXT_MESSAGE_CONTENT":
          receivedText += ev.delta ?? "";
          update({ content: receivedText });
          break;
        case "TOOL_CALL_START": {
          const tc: ToolCall = {
            id: ev.toolCallId,
            name: ev.toolCallName ?? "unknown",
            status: "running",
          };
          toolCallMap.set(ev.toolCallId, tc);
          update({ toolCalls: [...toolCallMap.values()] });
          break;
        }
        case "TOOL_CALL_ARGS": {
          const tc = toolCallMap.get(ev.toolCallId);
          if (tc) {
            tc.args = (tc.args ?? "") + (ev.delta ?? "");
            update({ toolCalls: [...toolCallMap.values()] });
          }
          break;
        }
        case "TOOL_CALL_RESULT": {
          const tc = toolCallMap.get(ev.toolCallId);
          if (tc) {
            tc.result = ev.content ?? "";
            tc.status = "completed";
            update({ toolCalls: [...toolCallMap.values()] });
          }
          break;
        }
        case "TOOL_CALL_END": {
          const tc = toolCallMap.get(ev.toolCallId);
          if (tc && tc.status === "running") tc.status = "completed";
          update({ toolCalls: [...toolCallMap.values()] });
          break;
        }
        case "RUN_ERROR":
          update({ error: ev.message ?? "Agent error" });
          break;
      }
    }
  }, [input, streaming, threadId, data]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleStop = () => abortRef.current?.abort();

  const handleClear = () => {
    if (streaming) return;
    setMessages([]);
    setThreadId(crypto.randomUUID());
    setStreamError(null);
  };

  const agentName = useMemo(() => {
    if (!data) return "agent";
    return data.agentMeta?.name ?? data.card.provider.name ?? "agent";
  }, [data]);

  if (loading && !data) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Chat</CardTitle>
          <CardDescription>Loading…</CardDescription>
        </CardHeader>
      </Card>
    );
  }
  if (error && !data) {
    return (
      <Card className="border-destructive/40">
        <CardHeader>
          <CardTitle className="text-destructive">Chat load failed</CardTitle>
          <CardDescription className="font-mono text-xs">{error}</CardDescription>
        </CardHeader>
      </Card>
    );
  }

  return (
    <div className="flex h-[calc(100vh-7rem)] flex-col gap-3">
      <header className="flex items-baseline justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
            Chat
          </h2>
          <p className="text-xs text-muted-foreground">
            Live SSE stream from <code className="font-mono text-[11px]">/console/api/chat</code>.
            Tool calls and memory operations appear inline as the agent runs.
          </p>
        </div>
        <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
          <span className="font-mono" title={threadId}>
            thread: {threadId.slice(0, 8)}
          </span>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleClear}
            disabled={streaming || messages.length === 0}
          >
            Clear
          </Button>
        </div>
      </header>

      <div className="flex flex-1 flex-col overflow-hidden rounded-md border bg-background">
        <MessageList messages={messages} streaming={streaming} agentName={agentName} />
        {streamError && (
          <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
            {streamError}
          </div>
        )}
        <footer className="border-t bg-muted/30 p-3">
          <div className="flex items-end gap-2">
            <Textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder={`Message ${agentName}…`}
              rows={2}
              disabled={streaming}
              className="resize-none bg-background"
              aria-label={`Message ${agentName}`}
            />
            {streaming ? (
              <Button onClick={handleStop} variant="outline" size="icon" aria-label="Stop">
                <Square className="size-4" />
              </Button>
            ) : (
              <Button
                onClick={() => void sendMessage()}
                disabled={!input.trim()}
                size="icon"
                aria-label="Send"
              >
                <Send className="size-4" />
              </Button>
            )}
          </div>
          <p className="mt-1.5 text-[10px] text-muted-foreground">
            Enter to send · Shift+Enter for newline
          </p>
        </footer>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Message list
// ---------------------------------------------------------------------------

function MessageList({
  messages,
  streaming,
  agentName,
}: {
  messages: Message[];
  streaming: boolean;
  agentName: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  // Track whether the user is near the bottom; only auto-scroll then.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      const distFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      pinnedToBottomRef.current = distFromBottom < 40;
    };
    el.addEventListener("scroll", onScroll);
    return () => el.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    if (pinnedToBottomRef.current) {
      endRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex flex-1 items-center justify-center p-8 text-center">
        <div className="space-y-1">
          <p className="text-sm font-medium">Talk to {agentName}</p>
          <p className="text-xs text-muted-foreground">
            Tool calls and memory operations will appear here as the agent runs.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 space-y-4 overflow-y-auto p-4"
      role="log"
      aria-live="polite"
    >
      {messages.map((m) => (
        <MessageView key={m.id} message={m} />
      ))}
      {streaming && (
        <div className="ml-16 inline-block animate-pulse font-mono text-xs text-muted-foreground">
          ▍
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function MessageView({ message }: { message: Message }) {
  const isUser = message.role === "user";
  return (
    <article className="grid grid-cols-[3.5rem_1fr] items-start gap-2">
      <div className="pt-0.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
        {isUser ? "you" : "agent"}
      </div>
      <div className="space-y-2 text-sm">
        {message.content && (
          <p className={cn("whitespace-pre-wrap break-words", isUser && "text-foreground")}>
            {message.content}
          </p>
        )}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallView key={tc.id} tc={tc} />
            ))}
          </div>
        )}
        {message.error && (
          <p className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            ⚠ {message.error}
          </p>
        )}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Tool call — render memory_* tool calls with the same affordance as bash /
// fs_read / web_fetch. The "live state" spec ask is satisfied by surfacing
// every TOOL_CALL_* event inline as it streams in.
// ---------------------------------------------------------------------------

function ToolCallView({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const isMemoryOp = tc.name.startsWith("memory_");

  return (
    <div
      className={cn(
        "overflow-hidden rounded border text-xs",
        tc.status === "running" && "border-amber-500/40 bg-amber-500/5",
        tc.status === "error" && "border-destructive/40 bg-destructive/5",
        tc.status === "completed" && "border-muted bg-muted/30",
      )}
    >
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        className="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-muted/40"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{tc.name}</span>
        {isMemoryOp && (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-sky-500">
            memory
          </span>
        )}
        <span
          className={cn(
            "ml-auto text-[10px] uppercase tracking-wide",
            tc.status === "running" && "text-amber-500",
            tc.status === "error" && "text-destructive",
            tc.status === "completed" && "text-muted-foreground",
          )}
        >
          {tc.status === "running" ? "running…" : tc.status}
        </span>
      </button>
      {expanded && (
        <div className="space-y-2 border-t bg-background/50 p-2 text-[11px]">
          {tc.args !== undefined && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">args</summary>
              <pre className="mt-1 max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono">
                {tc.args || "(empty)"}
              </pre>
            </details>
          )}
          {tc.result !== undefined && (
            <details open>
              <summary className="cursor-pointer text-muted-foreground">result</summary>
              <pre className="mt-1 max-h-64 overflow-y-auto whitespace-pre-wrap break-words rounded bg-muted/40 p-2 font-mono">
                {tc.result || "(empty)"}
              </pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildSameOriginUrl(path: string): string {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  return new URL(path, base).toString();
}

async function readErrorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: string; message?: string };
    return body.error ?? body.message ?? "";
  } catch {
    try {
      return (await res.text()).slice(0, 300);
    } catch {
      return "";
    }
  }
}
