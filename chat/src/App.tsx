import { useEffect, useMemo, useRef, useState } from "react";
import type { AgentRef, AgentSource } from "./adapters/types";
import { createHttpAgentSource } from "./adapters/http-agent-source";
import { httpProxyConnection } from "./adapters/http-proxy-connection";
import { AgentPicker } from "./components/AgentPicker";
import { ChatWidget } from "./components/ChatWidget";

export function App() {
  // Adapters are stable across renders; instantiate once.
  // Note: `localPidSource` is server-side only (uses node:fs); the browser
  // talks to the GUI server's /api/agents endpoint via httpAgentSource —
  // mirrors httpProxyConnection's role for /api/chat/<id>.
  const sources: AgentSource[] = useMemo(() => [createHttpAgentSource()], []);
  const connection = httpProxyConnection;

  const [selectedAgent, setSelectedAgent] = useState<AgentRef | null>(null);
  const [selectedSource, setSelectedSource] = useState<AgentSource | null>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  const selectedKey = selectedAgent && selectedSource
    ? `${selectedAgent.id}@${selectedSource.label}`
    : null;

  // Global keyboard shortcuts: Cmd+K focuses picker; Esc returns focus to picker.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === "k") {
        e.preventDefault();
        const firstButton = pickerRef.current?.querySelector<HTMLButtonElement>("button.agent-picker__item");
        firstButton?.focus();
      } else if (e.key === "Escape") {
        const firstButton = pickerRef.current?.querySelector<HTMLButtonElement>("button.agent-picker__item");
        firstButton?.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <h1>Auggy Chat</h1>
        <span className="app-header__hint">Cmd+K to focus picker</span>
      </header>
      <main className="app-main">
        <div ref={pickerRef} className="app-main__picker">
          <AgentPicker
            sources={sources}
            selectedKey={selectedKey}
            onSelect={(agent, source) => {
              setSelectedAgent(agent);
              setSelectedSource(source);
            }}
          />
        </div>
        <div className="app-main__chat">
          {selectedAgent && selectedSource ? (
            <ChatWidget
              agent={selectedAgent}
              sourceName={selectedSource.label}
              connection={connection}
            />
          ) : (
            <div className="app-main__empty">
              <p>Select an agent from the picker to start chatting.</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
