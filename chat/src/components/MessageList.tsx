import { useEffect, useRef } from "react";
import type { ChatMessage } from "../state/chat-store";
import { ToolCallView } from "./ToolCallView";

export function MessageList({ messages, streaming }: { messages: ChatMessage[]; streaming: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  return (
    <div className="message-list" role="log" aria-live="polite">
      {messages.map(m => (
        <article
          key={m.id}
          className={`message message--${m.role}` + (m.error ? " message--error" : "")}
        >
          <div className="message__role">{m.role === "user" ? "you" : "agent"}</div>
          <div className="message__content">
            {m.content && <p>{m.content}</p>}
            {m.toolCalls?.length ? (
              <div className="message__tool-calls">
                {m.toolCalls.map(tc => <ToolCallView key={tc.id} tc={tc} />)}
              </div>
            ) : null}
            {m.error && <p className="message__error">⚠ {m.error}</p>}
          </div>
        </article>
      ))}
      {streaming && <div className="message-list__cursor">▍</div>}
      <div ref={endRef} />
    </div>
  );
}
