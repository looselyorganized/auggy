import { useEffect, useState, useMemo } from "react";
import type { AgentRef, AgentSource } from "../adapters/types";

export interface AgentPickerProps {
  /** One or more sources to display. v1 ships with localPidSource;
   *  v2 adds spineRegistrySource alongside. */
  sources: AgentSource[];
  /** Currently selected agent key — `${agent.id}@${source.label}`. */
  selectedKey: string | null;
  /** Called when operator picks an agent. */
  onSelect: (agent: AgentRef, source: AgentSource) => void;
}

interface SourceState {
  source: AgentSource;
  agents: AgentRef[];
  loading: boolean;
  error: string | null;
}

export function AgentPicker({ sources, selectedKey, onSelect }: AgentPickerProps) {
  const [states, setStates] = useState<SourceState[]>(() =>
    sources.map(s => ({ source: s, agents: [], loading: true, error: null }))
  );

  useEffect(() => {
    let cancelled = false;
    const unsubs: Array<() => void> = [];

    async function refreshSource(s: AgentSource) {
      try {
        const agents = await s.list();
        if (cancelled) return;
        setStates(prev =>
          prev.map(st => (st.source === s ? { ...st, agents, loading: false, error: null } : st))
        );
      } catch (err) {
        if (cancelled) return;
        setStates(prev =>
          prev.map(st =>
            st.source === s
              ? { ...st, agents: [], loading: false, error: (err as Error).message }
              : st
          )
        );
      }
    }

    for (const s of sources) {
      refreshSource(s);
      if (s.subscribe) unsubs.push(s.subscribe(() => refreshSource(s)));
    }

    return () => {
      cancelled = true;
      unsubs.forEach(u => u());
    };
  }, [sources]);

  const sortedStates = useMemo(
    () => [...states].sort((a, b) => a.source.order - b.source.order),
    [states]
  );

  const totalAgents = states.reduce((sum, s) => sum + s.agents.length, 0);
  const allLoaded = states.every(s => !s.loading);

  if (totalAgents === 0 && allLoaded) {
    return (
      <aside className="agent-picker agent-picker--empty">
        <p>No agents detected on this machine.</p>
      </aside>
    );
  }

  return (
    <aside className="agent-picker">
      {sortedStates.map(({ source, agents, loading, error }) => (
        <section key={source.label} className="agent-picker__group">
          <h2 className="agent-picker__group-label">{source.label.toUpperCase()}</h2>
          {loading && <p className="agent-picker__loading">Loading...</p>}
          {error && <p className="agent-picker__error">Error: {error}</p>}
          {!loading && !error && agents.length === 0 && (
            <p className="agent-picker__empty-section">(none)</p>
          )}
          <ul className="agent-picker__list" role="list">
            {agents.map(agent => {
              const key = `${agent.id}@${source.label}`;
              const isSelected = key === selectedKey;
              const disabled = agent.status === "offline";
              return (
                <li key={key}>
                  <button
                    type="button"
                    className={
                      "agent-picker__item " +
                      (isSelected ? "agent-picker__item--selected " : "") +
                      (disabled ? "agent-picker__item--disabled" : "")
                    }
                    disabled={disabled}
                    onClick={() => onSelect(agent, source)}
                    aria-label={`${agent.name}, ${agent.status}`}
                    aria-current={isSelected ? "true" : undefined}
                    title={
                      disabled
                        ? `offline — start with \`auggy dev ${agent.name}\``
                        : agent.description ?? agent.name
                    }
                  >
                    <span
                      className={`agent-picker__status agent-picker__status--${agent.status}`}
                      aria-hidden="true"
                    />
                    <span className="agent-picker__name">{agent.name}</span>
                    {agent.description && (
                      <span className="agent-picker__description">{agent.description}</span>
                    )}
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </aside>
  );
}
