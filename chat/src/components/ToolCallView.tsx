import { useState } from "react";
import type { ChatMessage } from "../state/chat-store";

type ToolCall = NonNullable<ChatMessage["toolCalls"]>[number];

export function ToolCallView({ tc }: { tc: ToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const statusLabel = tc.status === "running" ? "running…" : tc.status;
  return (
    <div className={`tool-call tool-call--${tc.status}`}>
      <button
        type="button"
        className="tool-call__header"
        onClick={() => setExpanded(e => !e)}
        aria-expanded={expanded}
      >
        <span className="tool-call__name">{tc.name}</span>
        <span className="tool-call__status">{statusLabel}</span>
        <span className="tool-call__chevron">{expanded ? "▾" : "▸"}</span>
      </button>
      {expanded && (
        <div className="tool-call__body">
          {tc.args && (
            <details>
              <summary>args</summary>
              <pre className="tool-call__pre">{tc.args}</pre>
            </details>
          )}
          {tc.result && (
            <details open>
              <summary>result</summary>
              <pre className="tool-call__pre">{tc.result}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
