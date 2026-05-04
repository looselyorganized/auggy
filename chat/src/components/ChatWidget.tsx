import { useEffect, useRef, useState, useCallback } from "react";
import type { AgentRef, AgentConnection } from "../adapters/types";
import type { ChatMessage, AgentHistory } from "../state/chat-store";
import { loadAgentHistory, saveAgentHistory, clearAgentHistory } from "../state/chat-store";
import type { AGUIEvent } from "../lib/ag-ui-parse";
import { MessageList } from "./MessageList";
import { ErrorBanner } from "./ErrorBanner";

export interface ChatWidgetProps {
  agent: AgentRef;
  sourceName: string;
  connection: AgentConnection;
}

export function ChatWidget({ agent, sourceName, connection }: ChatWidgetProps) {
  const [history, setHistory] = useState<AgentHistory>(() => {
    const loaded = loadAgentHistory(agent.id, sourceName);
    return (
      loaded ?? {
        threadId: crypto.randomUUID(),
        messages: [],
        lastUpdated: new Date().toISOString(),
        agentMetadata: { name: agent.name, description: agent.description, capabilities: agent.capabilities },
      }
    );
  });
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [awaitingUser, setAwaitingUser] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  // When operator switches to a different agent, reload that agent's history.
  // Dep array is identity-stable: agent.id + sourceName uniquely identify the
  // agent. agent.capabilities is a fresh `string[]` on every /api/agents poll
  // (JSON.parse), so including it would re-fire this effect every poll
  // interval — aborting in-flight streams every 2s. Visual metadata can stale-
  // update on the next genuine agent switch.
  useEffect(() => {
    const loaded = loadAgentHistory(agent.id, sourceName);
    setHistory(
      loaded ?? {
        threadId: crypto.randomUUID(),
        messages: [],
        lastUpdated: new Date().toISOString(),
        agentMetadata: { name: agent.name, description: agent.description, capabilities: agent.capabilities },
      }
    );
    setBannerError(null);
    setAwaitingUser(false);
    abortRef.current?.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- agent.id+sourceName uniquely identify the agent; metadata changes don't warrant abort+reload
  }, [agent.id, sourceName]);

  // Persist history on every change. localStorage.setItem can throw
  // (QuotaExceededError, Safari private mode, third-party iframe with storage
  // disabled) — catch synchronously to avoid crashing the widget mid-stream.
  useEffect(() => {
    try {
      saveAgentHistory(agent.id, sourceName, history);
    } catch (err) {
      console.warn(`[chat-widget] localStorage save failed:`, err);
      setBannerError(`Couldn't save chat history: ${(err as Error).message}`);
    }
  }, [agent.id, sourceName, history]);

  // Cleanup on unmount.
  useEffect(() => () => abortRef.current?.abort(), []);

  const updateAssistant = useCallback(
    (id: string, patch: Partial<ChatMessage>) => {
      setHistory(h => ({
        ...h,
        messages: h.messages.map(m => (m.id === id ? { ...m, ...patch } : m)),
        lastUpdated: new Date().toISOString(),
      }));
    },
    []
  );

  const sendMessage = useCallback(async () => {
    const text = input.trim();
    if (!text || streaming) return;

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content: text,
      createdAt: new Date().toISOString(),
    };
    const assistantMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      content: "",
      createdAt: new Date().toISOString(),
      toolCalls: [],
    };

    setHistory(h => ({
      ...h,
      messages: [...h.messages, userMsg, assistantMsg],
      lastUpdated: new Date().toISOString(),
    }));
    setInput("");
    setStreaming(true);
    setBannerError(null);
    setAwaitingUser(false);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    // rAF-throttled rendering — buffer received text, drain via rAF
    let receivedText = "";
    let renderedText = "";
    let rafId = 0;
    const toolCallsLocal = new Map<string, NonNullable<ChatMessage["toolCalls"]>[number]>();

    const flushNow = () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = 0;
      renderedText = receivedText;
      updateAssistant(assistantMsg.id, {
        content: renderedText,
        toolCalls: [...toolCallsLocal.values()],
      });
    };

    const tick = () => {
      if (renderedText.length >= receivedText.length) {
        rafId = 0;
        return;
      }
      const remaining = receivedText.length - renderedText.length;
      const chars = remaining > 80 ? Math.ceil(remaining / 8) : 2;
      renderedText = receivedText.slice(0, renderedText.length + chars);
      updateAssistant(assistantMsg.id, {
        content: renderedText,
        toolCalls: [...toolCallsLocal.values()],
      });
      rafId = requestAnimationFrame(tick);
    };

    try {
      for await (const ev of connection.stream({ agent, message: text, threadId: history.threadId, signal: ctrl.signal })) {
        applyEvent(ev);
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        setBannerError(`Connection error: ${(err as Error).message}`);
        updateAssistant(assistantMsg.id, { error: (err as Error).message });
      }
    } finally {
      flushNow();
      setStreaming(false);
      abortRef.current = null;
    }

    function applyEvent(ev: AGUIEvent) {
      switch (ev.type) {
        case "RUN_STARTED":
          if (ev.threadId) {
            setHistory(h => ({ ...h, threadId: ev.threadId! }));
          }
          break;
        case "TEXT_MESSAGE_CONTENT":
          receivedText += ev.delta ?? "";
          if (!rafId) rafId = requestAnimationFrame(tick);
          break;
        case "TOOL_CALL_START":
          toolCallsLocal.set(ev.toolCallId, {
            id: ev.toolCallId,
            name: ev.toolCallName ?? "unknown",
            status: "running",
          });
          updateAssistant(assistantMsg.id, { toolCalls: [...toolCallsLocal.values()] });
          break;
        case "TOOL_CALL_ARGS": {
          const tc = toolCallsLocal.get(ev.toolCallId);
          if (tc) {
            tc.args = (tc.args ?? "") + (ev.delta ?? "");
            // Without this rAF, a long-running tool that emits args followed
            // by a stall (no text deltas) would leave the args block empty
            // until the next event arrives. tick() spreads toolCallsLocal
            // when it calls updateAssistant, so it picks up the new args.
            if (!rafId) rafId = requestAnimationFrame(tick);
          }
          break;
        }
        case "TOOL_CALL_RESULT": {
          const tc = toolCallsLocal.get(ev.toolCallId);
          if (tc) {
            tc.result = ev.content ?? "";
            tc.status = "completed";
          }
          updateAssistant(assistantMsg.id, { toolCalls: [...toolCallsLocal.values()] });
          break;
        }
        case "TOOL_CALL_END": {
          const tc = toolCallsLocal.get(ev.toolCallId);
          if (tc && tc.status === "running") tc.status = "completed";
          break;
        }
        case "RUN_FINISHED": {
          flushNow();
          // Render the "waiting for you" hint when the runtime ends a turn
          // with status input-required (the request_input tool was called).
          // Unknown statuses fall through — treat as completed for back-compat.
          setAwaitingUser(ev.result?.status === "input-required");
          break;
        }
        case "RUN_ERROR":
          flushNow();
          updateAssistant(assistantMsg.id, { error: ev.message ?? "Agent error" });
          break;
      }
    }
  }, [input, streaming, connection, agent, history.threadId, updateAssistant]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void sendMessage();
    }
  };

  const handleClear = () => {
    if (!confirm(`Clear conversation with ${agent.name}?`)) return;
    clearAgentHistory(agent.id, sourceName);
    setHistory({
      threadId: crypto.randomUUID(),
      messages: [],
      lastUpdated: new Date().toISOString(),
      agentMetadata: { name: agent.name, description: agent.description, capabilities: agent.capabilities },
    });
    setAwaitingUser(false);
  };

  const handleAbort = () => abortRef.current?.abort();

  return (
    <div className="chat-widget">
      <header className="chat-widget__header">
        <h2 className="chat-widget__title">{agent.name}</h2>
        {agent.description && <p className="chat-widget__description">{agent.description}</p>}
        <button
          type="button"
          className="chat-widget__clear"
          onClick={handleClear}
          disabled={streaming || history.messages.length === 0}
        >
          Clear conversation
        </button>
      </header>
      {bannerError && <ErrorBanner message={bannerError} onDismiss={() => setBannerError(null)} />}
      <MessageList messages={history.messages} streaming={streaming} />
      <footer className="chat-widget__footer">
        {awaitingUser && !streaming && (
          <p className="chat-widget__awaiting-hint" aria-live="polite">
            Waiting for your reply…
          </p>
        )}
        <textarea
          ref={inputRef}
          value={input}
          onChange={e => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={`Message ${agent.name}…`}
          rows={2}
          disabled={streaming}
          aria-label={`Message ${agent.name}`}
        />
        {streaming ? (
          <button type="button" onClick={handleAbort}>Stop</button>
        ) : (
          <button type="button" onClick={() => void sendMessage()} disabled={!input.trim()}>
            Send
          </button>
        )}
      </footer>
    </div>
  );
}
