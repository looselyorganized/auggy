import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useNavigate } from "react-router-dom";

import { ChatComposer } from "@/components/admin/ChatComposer";
import { useChatWorkspace } from "@/components/admin/ChatWorkspaceProvider";
import { ChatThreadHeader } from "@/components/admin/ChatThreadHeader";
import { useDashboardContext } from "@/components/admin/DashboardContext";
import { MarkdownContent } from "@/components/admin/MarkdownContent";
import { Button } from "@/components/ui/button";
import { Card, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { detectCodeLanguage, HighlightedCode } from "@/components/ui/highlighted-code";
import { formatChatTranscript } from "@/lib/chat-transcript";
import { chatThreadPath } from "@/lib/chat-route";
import { getChatRunPresentation } from "@/lib/chat-run-state";
import {
  type ChatMessage,
  type ChatPreviewMode,
  type ChatToolCall,
} from "@/lib/chat-workspace";
import { getChatWorkspaceTargetById } from "@/lib/chat-workspace-state";
import { useToast } from "@/lib/toast";
import { cn } from "@/lib/utils";

const CHAT_PREVIEW_MODE_LABELS: Record<ChatPreviewMode, string> = {
  creator: "Verified creator",
  anonymous: "Anonymous",
  visitor: "Verified visitor",
};

const CREATOR_EMPTY_PROMPTS = [
  "What can you do right now?",
  "Help me decide what to add next.",
  "I want you to answer from my docs.",
  "I want you to remember repeat visitors.",
];

const PEER_EMPTY_PROMPTS = [
  "What can you help with?",
  "What information do you need from me?",
  "How should I get started?",
  "Summarize this conversation so far.",
];

export function ChatTab() {
  const navigate = useNavigate();
  const { data, loading, error } = useDashboardContext();
  const {
    state,
    activeThread,
    deletingThreadIds,
    anonymousAllowed,
    hasVisitorToken,
    visitorIdentity,
    rename,
    markUnread,
    deleteThread,
    setPreviewMode,
    clearVisitor,
    send,
    stop,
  } = useChatWorkspace();
  const { push } = useToast();
  assertChatTabThread(activeThread);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [preflightErrors, setPreflightErrors] = useState<Record<string, string | null>>({});

  const input = drafts[activeThread.id] ?? "";
  const messages = activeThread.messages;
  const { ownsLocalStream, activeThreadStreaming: streaming } = getChatRunPresentation(
    state.durableThreads,
    activeThread,
    state.activeRun,
  );
  const anotherLocalStream =
    state.activeRun !== null && state.activeRun.threadId !== activeThread.id;
  const externalActiveStream = streaming && !ownsLocalStream;
  const anyThreadStreaming = streaming || anotherLocalStream;
  const previewMode = activeThread.previewMode;
  const visitorVerificationRequired =
    previewMode === "visitor" && visitorIdentity.status !== "verified";
  const deleting = deletingThreadIds.has(activeThread.id);
  const disabledReason = deleting
    ? "This chat is being deleted."
    : visitorVerificationRequired
    ? messages.length > 0
      ? "This visitor credential is unavailable. Start a new verified visitor chat to continue."
      : "Verify a visitor before using this chat."
    : externalActiveStream
      ? "This response is still running in another console session."
      : anotherLocalStream
        ? `A response is running in ${
            state.activeRun
              ? getChatWorkspaceTargetById(state, state.activeRun.threadId)?.title ??
                "another chat"
              : "another chat"
          }.`
        : undefined;

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

  const liveProvider = data?.agentMeta?.engine?.provider?.trim();
  const liveModel = data?.agentMeta?.engine?.model?.trim();
  const model = activeThread.model;
  const modelDisplayName = model?.displayName ?? liveModel ?? liveProvider ?? null;
  const modelProvider = model?.provider ?? liveProvider;
  const modelId = model?.id ?? liveModel;
  const modelRawName =
    modelProvider && modelId
      ? `${modelProvider} / ${modelId}`
      : modelProvider ?? modelId ?? modelDisplayName;

  const emptyPrompts = previewMode === "creator" ? CREATOR_EMPTY_PROMPTS : PEER_EMPTY_PROMPTS;
  const preflightError = preflightErrors[activeThread.id] ?? null;
  const detailError = activeThread.lifecycle === "detail" ? activeThread.detailError : null;

  const sendFromThread = useCallback(
    (overrideText?: string) => {
      const threadId = activeThread.id;
      const text = (overrideText ?? input).trim();
      if (!text || deleting || streaming || anotherLocalStream || visitorVerificationRequired) {
        return;
      }

      setPreflightErrors((current) => ({ ...current, [threadId]: null }));
      let accepted = false;
      void send(text, threadId, () => {
        accepted = true;
        setDrafts((current) => ({ ...current, [threadId]: "" }));
      }).then((result) => {
        if (!result.ok && !accepted) {
          setPreflightErrors((current) => ({ ...current, [threadId]: result.error }));
        }
      });
    }, [
      activeThread.id,
      anotherLocalStream,
      deleting,
      input,
      send,
      streaming,
      visitorVerificationRequired,
    ],
  );

  const handlePreviewModeChange = (mode: ChatPreviewMode) => {
    if (mode === previewMode) return;
    const result = setPreviewMode(mode);
    if (!result.ok) {
      setPreflightErrors((current) => ({ ...current, [activeThread.id]: result.error }));
      return;
    }
    setDrafts((current) => ({ ...current, [result.threadId]: "" }));
    setPreflightErrors((current) => ({ ...current, [result.threadId]: null }));
    navigate(chatThreadPath(result.threadId));
  };

  const handleCopyTranscript = useCallback(async () => {
    if (messages.length === 0) return;
    const transcript = formatChatTranscript(messages, {
      agentName,
      previewModeLabel: CHAT_PREVIEW_MODE_LABELS[previewMode],
      threadId: activeThread.id,
      copiedAt: new Date(),
    });

    if (!navigator.clipboard?.writeText) throw new Error("Clipboard API unavailable");
    await navigator.clipboard.writeText(transcript);
    push("success", "copied transcript");
  }, [activeThread.id, agentName, messages, previewMode, push]);

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
    <div className="auggy-grid-surface relative flex h-full min-h-0 flex-col bg-background">
      <ChatThreadHeader
        key={activeThread.id}
        title={activeThread.title}
        previewMode={previewMode}
        hasMessages={messages.length > 0}
        unread={activeThread.unread}
        markUnreadAvailable={activeThread.lifecycle === "detail"}
        streaming={streaming}
        anonymousAllowed={anonymousAllowed}
        hasVisitorToken={hasVisitorToken}
        visitorIdentity={visitorIdentity}
        previewModeDisabledReason={
          anyThreadStreaming
            ? externalActiveStream
              ? "This response is running in another console session."
              : "Wait for the active response to finish or stop it first."
            : undefined
        }
        onPreviewModeChange={handlePreviewModeChange}
        onRename={async (title) => {
          const result = await rename(activeThread.id, title);
          if (!result.valid) throw new Error(result.message);
        }}
        onCopyTranscript={handleCopyTranscript}
        onMarkUnread={async () => {
          if (!(await markUnread(activeThread.id))) {
            throw new Error("This chat no longer exists.");
          }
        }}
        onClearVisitor={clearVisitor}
        onDelete={async () => {
          if (!(await deleteThread(activeThread.id))) {
            throw new Error("This chat cannot be deleted while its response is running.");
          }
          navigate("/chat", { replace: true });
        }}
        onActionError={(action, actionError) => {
          push(
            "error",
            `${action} failed: ${
              actionError instanceof Error ? actionError.message : "Unknown error"
            }`,
          );
        }}
      />

      <MessageList
        messages={messages}
        threadId={activeThread.id}
        streaming={streaming}
        responseLabel={agentName}
        agentName={agentName}
        emptyPrompts={emptyPrompts}
        onPrompt={sendFromThread}
        disabled={Boolean(disabledReason)}
        disabledReason={disabledReason}
      />

      <div className="relative z-10 shrink-0 px-3 pb-3 sm:px-6 sm:pb-6">
        <div className="mx-auto max-w-3xl">
          {detailError && (
            <div
              role="alert"
              className="mb-2 rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm"
            >
              {detailError}
            </div>
          )}
          {preflightError && (
            <div
              role="alert"
              className="mb-2 rounded-md border border-destructive/30 bg-background/95 px-3 py-2 text-xs text-destructive shadow-sm"
            >
              {preflightError}
            </div>
          )}
          <ChatComposer
            value={input}
            onChange={(value) => {
              setDrafts((current) => ({ ...current, [activeThread.id]: value }));
              if (preflightError) {
                setPreflightErrors((current) => ({ ...current, [activeThread.id]: null }));
              }
            }}
            onSend={sendFromThread}
            disabled={Boolean(disabledReason)}
            disabledReason={disabledReason}
            streaming={ownsLocalStream}
            onStop={stop}
            agentName={agentName}
            modelDisplayName={modelDisplayName}
            modelRawName={modelRawName}
          />
        </div>
      </div>
    </div>
  );
}

function assertChatTabThread<T>(thread: T | null): asserts thread is T {
  if (!thread) {
    throw new Error("ChatTab requires a selected draft or loaded conversation detail.");
  }
}

function MessageList({
  messages,
  threadId,
  streaming,
  agentName,
  responseLabel,
  emptyPrompts,
  onPrompt,
  disabled,
  disabledReason,
}: {
  messages: ChatMessage[];
  threadId: string;
  streaming: boolean;
  agentName: string;
  responseLabel: string;
  emptyPrompts: string[];
  onPrompt: (prompt: string) => void;
  disabled: boolean;
  disabledReason?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pinnedToBottomRef = useRef(true);

  useEffect(() => {
    pinnedToBottomRef.current = true;
    const element = containerRef.current;
    if (!element) return;
    const onScroll = () => {
      const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
      pinnedToBottomRef.current = distance < 40;
    };
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, [threadId, messages.length === 0]);

  useEffect(() => {
    if (pinnedToBottomRef.current) endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="relative z-[1] min-h-0 flex-1 overflow-y-auto px-4 pb-8 pt-28 text-center">
        <div className="mx-auto flex min-h-full w-full max-w-2xl flex-col justify-center">
          <h2 className="text-2xl font-semibold tracking-normal sm:text-3xl">
            Talk to {agentName}
          </h2>
          <p className="mx-auto mt-3 max-w-xl text-sm text-muted-foreground">
            Use this workspace to test behavior, tool calls, memory, and integration posture before
            publishing a frontend.
          </p>
          {disabledReason && (
            <p className="mx-auto mt-3 max-w-xl text-xs text-muted-foreground" role="status">
              {disabledReason}
            </p>
          )}
          <div className="mt-6 grid gap-2 sm:grid-cols-2">
            {emptyPrompts.map((prompt) => (
              <Button
                key={prompt}
                type="button"
                variant="outline"
                onClick={() => onPrompt(prompt)}
                disabled={disabled}
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
      className="relative z-[1] min-h-0 flex-1 overflow-y-auto px-4 pb-6 pt-28 sm:px-6"
      role="log"
      aria-live="polite"
      aria-busy={streaming}
    >
      <div className="mx-auto flex max-w-3xl flex-col gap-6">
        {messages.map((message, index) => (
          <MessageView
            key={message.id}
            message={message}
            responseLabel={responseLabel}
            streaming={streaming && index === messages.length - 1 && message.role === "assistant"}
          />
        ))}
        <div ref={endRef} />
      </div>
    </div>
  );
}

function MessageView({
  message,
  responseLabel,
  streaming,
}: {
  message: ChatMessage;
  responseLabel: string;
  streaming: boolean;
}) {
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
        {streaming && !message.content && (
          <div className="flex h-6 items-center" aria-label={`${responseLabel} is responding`}>
            <span className="animate-pulse font-mono text-xs text-muted-foreground">▍</span>
          </div>
        )}
        {message.content && <MarkdownContent content={message.content} isUser={isUser} />}
        {message.toolCalls && message.toolCalls.length > 0 && (
          <div className="space-y-1.5">
            {message.toolCalls.map((toolCall) => (
              <ToolCallView key={toolCall.id} toolCall={toolCall} />
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

function ToolCallView({ toolCall }: { toolCall: ChatToolCall }) {
  const [expanded, setExpanded] = useState(true);
  const isMemoryOperation = toolCall.name.startsWith("memory_");

  return (
    <div
      className={cn(
        "overflow-hidden rounded border text-xs",
        toolCall.status === "running" && "border-amber-500/40 bg-amber-500/5",
        toolCall.status === "error" && "border-destructive/40 bg-destructive/5",
        toolCall.status === "completed" && "border-muted bg-muted/30",
      )}
    >
      <Button
        type="button"
        variant="ghost"
        onClick={() => setExpanded((value) => !value)}
        className="h-auto w-full justify-start rounded-none px-2 py-1.5 text-left hover:bg-muted/40 [&_svg]:size-3"
        aria-expanded={expanded}
      >
        {expanded ? (
          <ChevronDown className="size-3 shrink-0 text-muted-foreground" />
        ) : (
          <ChevronRight className="size-3 shrink-0 text-muted-foreground" />
        )}
        <span className="font-mono text-xs">{toolCall.name}</span>
        {isMemoryOperation && (
          <span className="text-[9px] font-semibold uppercase tracking-wide text-sky-500">
            memory
          </span>
        )}
        <span
          className={cn(
            "ml-auto text-[10px] uppercase tracking-wide",
            toolCall.status === "running" && "text-amber-500",
            toolCall.status === "error" && "text-destructive",
            toolCall.status === "completed" && "text-muted-foreground",
          )}
        >
          {toolCall.status === "running" ? "running…" : toolCall.status}
        </span>
      </Button>
      {expanded && (
        <div className="space-y-2 border-t bg-background/50 p-2 text-[11px]">
          {toolCall.args !== undefined && (
            <details>
              <summary className="cursor-pointer text-muted-foreground">args</summary>
              <HighlightedCode
                code={toolCall.args || "(empty)"}
                language={detectCodeLanguage(toolCall.args)}
                wrap
                compact
                className="mt-1 max-h-48 rounded"
              />
            </details>
          )}
          {toolCall.result !== undefined && (
            <details open>
              <summary className="cursor-pointer text-muted-foreground">result</summary>
              <HighlightedCode
                code={toolCall.result || "(empty)"}
                language={detectCodeLanguage(toolCall.result)}
                wrap
                compact
                className="mt-1 max-h-64 rounded"
              />
            </details>
          )}
        </div>
      )}
    </div>
  );
}
