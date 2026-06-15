import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, RotateCcw, Square } from "lucide-react";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { findCsrfToken } from "@/lib/api";
import { cn } from "@/lib/utils";
import { parseSSEStream, type AGUIEvent } from "@/lib/ag-ui-parse";

const VISITOR_TOKEN_STORAGE_KEY = "auggy-visitor-token";
type ChatPreviewMode = "creator" | "anonymous" | "visitor";

const CHAT_PREVIEW_MODE_LABELS: Record<ChatPreviewMode, string> = {
  creator: "Creator",
  anonymous: "Anonymous",
  visitor: "Verified visitor",
};

// ---------------------------------------------------------------------------
// Local message model — session-scoped, no localStorage persistence, no
// per-source keying. If operators ask for chat history across reloads we'll
// add it then.
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
  const [previewMode, setPreviewMode] = useState<ChatPreviewMode>("creator");
  const [hasVisitorToken, setHasVisitorToken] = useState(() => Boolean(readVisitorToken()));
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const wasStreamingRef = useRef(false);

  // Cleanup on unmount — kill any in-flight stream.
  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    const refreshVisitorTokenState = () => setHasVisitorToken(Boolean(readVisitorToken()));
    refreshVisitorTokenState();
    window.addEventListener("focus", refreshVisitorTokenState);
    window.addEventListener("storage", refreshVisitorTokenState);
    return () => {
      window.removeEventListener("focus", refreshVisitorTokenState);
      window.removeEventListener("storage", refreshVisitorTokenState);
    };
  }, []);

  useEffect(() => {
    if (!hasVisitorToken && previewMode === "visitor") {
      setPreviewMode("creator");
    }
  }, [hasVisitorToken, previewMode]);

  useEffect(() => {
    if (wasStreamingRef.current && !streaming) {
      requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
    }
    wasStreamingRef.current = streaming;
  }, [streaming]);

  const sendMessage = useCallback(async (overrideText?: string) => {
    const text = (overrideText ?? input).trim();
    if (!text || streaming) return;
    const storedVisitorToken = readVisitorToken();
    setHasVisitorToken(Boolean(storedVisitorToken));
    const visitorToken = previewMode === "visitor" ? storedVisitorToken : undefined;
    if (previewMode === "visitor" && !visitorToken) {
      setStreamError("Verify a visitor first, then choose Verified visitor.");
      return;
    }

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
        body: JSON.stringify({ csrf, message: text, threadId, chatMode: previewMode, visitorToken }),
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
  }, [input, streaming, threadId, data, previewMode]);

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
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const handleClearVisitor = () => {
    if (streaming) return;
    clearVisitorToken();
    setHasVisitorToken(false);
    setPreviewMode("creator");
    setMessages([]);
    setThreadId(crypto.randomUUID());
    setStreamError(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const handlePreviewModeChange = (mode: ChatPreviewMode) => {
    if (streaming || mode === previewMode) return;
    if (mode === "visitor" && !hasVisitorToken) return;
    setPreviewMode(mode);
    setMessages([]);
    setThreadId(crypto.randomUUID());
    setStreamError(null);
    requestAnimationFrame(() => inputRef.current?.focus({ preventScroll: true }));
  };

  const agentName = useMemo(() => {
    if (!data) return "Agent";
    return (
      data.agentMeta?.displayName ??
      data.card.provider.displayName ??
      data.agentMeta?.name ??
      data.card.provider.name ??
      "Agent"
    );
  }, [data]);
  const responseLabel = agentName;
  const identityLabel = `Previewing as ${CHAT_PREVIEW_MODE_LABELS[previewMode].toLowerCase()}`;

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
    <div className="relative h-full overflow-hidden bg-background">
      <div
        className="pointer-events-none absolute inset-0 opacity-45"
        aria-hidden="true"
        style={{
          backgroundImage:
            "linear-gradient(hsl(var(--border) / 0.45) 1px, transparent 1px), linear-gradient(90deg, hsl(var(--border) / 0.45) 1px, transparent 1px)",
          backgroundSize: "32px 32px",
        }}
      />
      <div className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-background to-transparent" />

      <MessageList
        messages={messages}
        streaming={streaming}
        agentName={agentName}
        responseLabel={responseLabel}
        identityLabel={identityLabel}
        onPrompt={(prompt) => void sendMessage(prompt)}
      />

      <div className="absolute inset-x-0 bottom-0 z-10 px-3 pb-3 sm:px-6 sm:pb-6">
        <div className="mx-auto max-w-3xl">
          {streamError && (
            <div className="mb-2 rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm">
              {streamError}
            </div>
          )}
          <div className="rounded-lg border bg-card/95 p-3 shadow-lg backdrop-blur">
            <div className="flex items-end gap-2">
              <Textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={handleKeyDown}
                placeholder={`Message ${agentName}...`}
                rows={3}
                disabled={streaming}
                className="max-h-48 min-h-[5rem] resize-none border-0 bg-transparent px-2 py-2 shadow-none focus-visible:ring-0"
                aria-label={`Message ${agentName}`}
              />
              {streaming && (
                <Button onClick={handleStop} variant="outline" size="icon" aria-label="Stop">
                  <Square className="size-4" />
                </Button>
              )}
            </div>
            <div className="mt-2 flex items-center justify-between gap-3 px-1">
              <div className="flex min-w-0 flex-wrap items-center gap-2">
                <span className="truncate font-mono text-[11px] text-muted-foreground">
                  {identityLabel}
                </span>
                <div className="flex shrink-0 items-center rounded-md border bg-background/80 p-0.5">
                  {(["creator", "anonymous", "visitor"] as const).map((mode) => {
                    const disabled = streaming || (mode === "visitor" && !hasVisitorToken);
                    return (
                      <Button
                        key={mode}
                        type="button"
                        variant={previewMode === mode ? "secondary" : "ghost"}
                        size="sm"
                        onClick={() => handlePreviewModeChange(mode)}
                        disabled={disabled}
                        className="h-6 rounded-sm px-2 text-[11px]"
                        title={
                          mode === "visitor" && !hasVisitorToken
                            ? "Verify a visitor first"
                            : `Preview as ${CHAT_PREVIEW_MODE_LABELS[mode]}`
                        }
                      >
                        {CHAT_PREVIEW_MODE_LABELS[mode]}
                      </Button>
                    );
                  })}
                </div>
                {hasVisitorToken && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClearVisitor}
                    disabled={streaming}
                    className="h-7 shrink-0 px-2 text-xs"
                  >
                    Clear visitor
                  </Button>
                )}
              </div>
              <div className="flex shrink-0 items-center gap-2 text-[11px] text-muted-foreground">
                <span className="hidden sm:inline">Enter to send</span>
                <span className="hidden text-muted-foreground/40 sm:inline">|</span>
                <span className="hidden sm:inline">Shift+Enter for a new line</span>
                {messages.length > 0 && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={handleClear}
                    disabled={streaming}
                    className="h-7 shrink-0 px-2 text-xs"
                  >
                    <RotateCcw className="mr-1.5 size-3.5" />
                    New thread
                  </Button>
                )}
              </div>
            </div>
          </div>
        </div>
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
  responseLabel,
  identityLabel,
  onPrompt,
}: {
  messages: Message[];
  streaming: boolean;
  agentName: string;
  responseLabel: string;
  identityLabel: string;
  onPrompt: (prompt: string) => void;
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
      <div className="relative z-[1] flex h-full items-center justify-center px-4 pb-36 text-center">
        <div className="w-full max-w-2xl">
          <p className="mb-2 text-sm font-medium text-muted-foreground">{identityLabel}</p>
          <h2 className="text-2xl font-semibold tracking-normal sm:text-3xl">
            Talk to {agentName}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
            Use this workspace to test behavior, tool calls, memory, and integration posture before
            publishing a frontend.
          </p>
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {[
              "What can you help with?",
              "Summarize your current capabilities.",
              "What context do you have about this agent?",
              "Run a small tool-use smoke test.",
            ].map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                onClick={() => onPrompt(prompt)}
                className="h-auto min-h-11 justify-start whitespace-normal bg-card/85 px-3 py-2 text-left text-sm shadow-sm hover:bg-muted"
              >
                {prompt}
              </Button>
            ))}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="relative z-[1] h-full overflow-y-auto px-4 pb-44 pt-8 sm:px-6"
      role="log"
      aria-live="polite"
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((m) => (
          <MessageView key={m.id} message={m} responseLabel={responseLabel} />
        ))}
        {streaming && (
          <div className="inline-block animate-pulse font-mono text-xs text-muted-foreground">
            ▍
          </div>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function MessageView({ message, responseLabel }: { message: Message; responseLabel: string }) {
  const isUser = message.role === "user";
  return (
    <article className={cn("flex", isUser ? "justify-end" : "justify-start")}>
      <div
        className={cn(
          "max-w-[88%] space-y-2 text-sm sm:max-w-[78%]",
          isUser
            ? "rounded-lg border bg-card px-4 py-3 shadow-sm"
            : "rounded-lg border border-transparent bg-background/70 px-4 py-3",
        )}
      >
        <div className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
          {isUser ? "you" : responseLabel}
        </div>
        {message.content && <MarkdownContent content={message.content} isUser={isUser} />}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {message.toolCalls.map((tc) => (
              <ToolCallView key={tc.id} tc={tc} />
            ))}
          </div>
        )}
        {message.error && (
          <p className="rounded border border-destructive/30 bg-destructive/5 px-2 py-1 text-xs text-destructive">
            {message.error}
          </p>
        )}
      </div>
    </article>
  );
}

function MarkdownContent({ content, isUser }: { content: string; isUser: boolean }) {
  return (
    <div
      className={cn(
        "space-y-3 break-words leading-6",
        isUser ? "text-foreground" : "text-foreground/95",
      )}
    >
      {renderMarkdownBlocks(content)}
    </div>
  );
}

function readVisitorToken(): string | undefined {
  try {
    const value = localStorage.getItem(VISITOR_TOKEN_STORAGE_KEY);
    return value && value.trim() !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

function clearVisitorToken() {
  try {
    localStorage.removeItem(VISITOR_TOKEN_STORAGE_KEY);
  } catch {
    // Storage can be unavailable in private browsing or sandboxed contexts.
  }
}

function renderMarkdownBlocks(markdown: string): ReactNode[] {
  const lines = markdown.replace(/\r\n/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (line.trim() === "") {
      i += 1;
      continue;
    }

    if (line.trimStart().startsWith("```")) {
      const language = line.trim().slice(3).trim();
      const code: string[] = [];
      i += 1;
      while (i < lines.length && !(lines[i] ?? "").trimStart().startsWith("```")) {
        code.push(lines[i] ?? "");
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push(
        <pre key={blocks.length} className="overflow-x-auto rounded-md bg-muted/60 p-3 text-xs">
          <code className="font-mono" data-language={language || undefined}>
            {code.join("\n")}
          </code>
        </pre>,
      );
      continue;
    }

    if (isTableStart(lines, i)) {
      const tableLines = [lines[i] ?? "", lines[i + 1] ?? ""];
      i += 2;
      while (i < lines.length && isPipeRow(lines[i] ?? "")) {
        tableLines.push(lines[i] ?? "");
        i += 1;
      }
      blocks.push(<MarkdownTable key={blocks.length} lines={tableLines} />);
      continue;
    }

    if (isListItem(line)) {
      const items: string[] = [];
      const ordered = /^\s*\d+\.\s+/.test(line);
      while (i < lines.length && isListItem(lines[i] ?? "")) {
        items.push((lines[i] ?? "").replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        i += 1;
      }
      const Tag = ordered ? "ol" : "ul";
      blocks.push(
        <Tag
          key={blocks.length}
          className={cn("space-y-1 pl-5", ordered ? "list-decimal" : "list-disc")}
        >
          {items.map((item, index) => (
            <li key={index}>{renderInlineMarkdown(item)}</li>
          ))}
        </Tag>,
      );
      continue;
    }

    const paragraph: string[] = [];
    while (
      i < lines.length &&
      lines[i]?.trim() !== "" &&
      !isTableStart(lines, i) &&
      !isListItem(lines[i] ?? "") &&
      !(lines[i] ?? "").trimStart().startsWith("```")
    ) {
      paragraph.push(lines[i] ?? "");
      i += 1;
    }
    blocks.push(
      <p key={blocks.length} className="whitespace-pre-wrap">
        {renderInlineMarkdown(paragraph.join("\n"))}
      </p>,
    );
  }

  return blocks;
}

function MarkdownTable({ lines }: { lines: string[] }) {
  const headers = splitTableRow(lines[0] ?? "");
  const rows = lines.slice(2).map(splitTableRow);

  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="min-w-full border-collapse text-left text-xs">
        <thead className="bg-muted/60 text-muted-foreground">
          <tr>
            {headers.map((cell, index) => (
              <th key={index} className="border-b px-3 py-2 font-semibold">
                {renderInlineMarkdown(cell)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-b last:border-b-0">
              {headers.map((_, cellIndex) => (
                <td key={cellIndex} className="px-3 py-2 align-top">
                  {renderInlineMarkdown(row[cellIndex] ?? "")}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function renderInlineMarkdown(text: string): ReactNode[] {
  const nodes: ReactNode[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|__[^_]+__|\*[^*]+\*|_[^_]+_)/g;
  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > lastIndex) nodes.push(text.slice(lastIndex, match.index));
    const token = match[0];
    const key = nodes.length;
    if (token.startsWith("`")) {
      nodes.push(
        <code key={key} className="rounded bg-muted px-1 py-0.5 font-mono text-[0.92em]">
          {token.slice(1, -1)}
        </code>,
      );
    } else if (token.startsWith("**") || token.startsWith("__")) {
      nodes.push(
        <strong key={key} className="font-semibold">
          {token.slice(2, -2)}
        </strong>,
      );
    } else {
      nodes.push(
        <em key={key} className="italic">
          {token.slice(1, -1)}
        </em>,
      );
    }
    lastIndex = pattern.lastIndex;
  }

  if (lastIndex < text.length) nodes.push(text.slice(lastIndex));
  return nodes.map((node, index) => <Fragment key={index}>{node}</Fragment>);
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-*]|\d+\.)\s+/.test(line);
}

function isTableStart(lines: string[], index: number): boolean {
  return isPipeRow(lines[index] ?? "") && isTableSeparator(lines[index + 1] ?? "");
}

function isPipeRow(line: string): boolean {
  return line.includes("|") && splitTableRow(line).length > 1;
}

function isTableSeparator(line: string): boolean {
  const cells = splitTableRow(line);
  return cells.length > 1 && cells.every((cell) => /^:?-{3,}:?$/.test(cell.trim()));
}

function splitTableRow(line: string): string[] {
  return line
    .trim()
    .replace(/^\|/, "")
    .replace(/\|$/, "")
    .split("|")
    .map((cell) => cell.trim());
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
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((e) => !e)}
        className="h-auto w-full justify-start rounded-none px-2 py-1.5 text-left hover:bg-muted/40 [&_svg]:size-3"
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
      </Button>
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
