"use client";

import { useEffect, useRef, useState, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  createAgentOperation,
  loadAgentConfiguration,
  runAgentOperation,
  type AgentOperation,
  type RunUpdate,
} from "@/client/agent-run";

interface ConversationEntry {
  key: string;
  prompt: string;
  response: RunUpdate;
}

export function SupportChat() {
  const [destination, setDestination] = useState<string | null>(null);
  const [configurationError, setConfigurationError] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [entries, setEntries] = useState<ConversationEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const alive = useRef(false);
  const controller = useRef<AbortController | null>(null);
  const operation = useRef<AgentOperation | null>(null);
  const thread = useRef<string | null>(null);
  const output = useRef<HTMLDivElement>(null);

  useEffect(() => {
    alive.current = true;
    void loadAgentConfiguration()
      .then((origin) => {
        if (alive.current) setDestination(origin);
      })
      .catch(() => {
        if (alive.current)
          setConfigurationError(
            "The agent connection is not configured. Contact the application operator.",
          );
      });
    return () => {
      alive.current = false;
      controller.current?.abort();
    };
  }, []);

  async function deliver(current: AgentOperation) {
    if (!destination || controller.current) return;
    const abort = new AbortController();
    controller.current = abort;
    setBusy(true);
    try {
      await runAgentOperation({
        agentOrigin: destination,
        operation: current,
        signal: abort.signal,
        onUpdate: (response) => {
          if (!alive.current) return;
          setEntries((previous) =>
            previous.map((entry) => (entry.key === current.key ? { ...entry, response } : entry)),
          );
        },
      });
    } finally {
      if (controller.current === abort) controller.current = null;
      if (alive.current) setBusy(false);
    }
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!destination || !draft.trim() || controller.current) return;
    thread.current ??= crypto.randomUUID();
    const current = createAgentOperation(draft, thread.current);
    operation.current = current;
    setEntries((previous) => [
      ...previous,
      {
        key: current.key,
        prompt: current.message,
        response: {
          state: "connecting",
          text: "",
          message: "Connecting to your agent…",
          retryable: false,
        },
      },
    ]);
    setDraft("");
    void deliver(current);
  }

  const latest = entries.at(-1);
  return (
    <div className="support-workspace">
      <section className="conversation" aria-labelledby="conversation-heading">
        <div className="conversation-heading">
          <h2 id="conversation-heading">Talk to your support agent</h2>
          <p>Ask about an order or request help with a permitted action.</p>
        </div>
        <div
          className="conversation-content"
          ref={output}
          role="log"
          aria-label="Conversation"
          aria-live="polite"
          aria-relevant="additions text"
          data-testid="conversation"
        >
          {entries.length === 0 ? (
            <div className="conversation-empty">
              <h3>How can we help?</h3>
              <p>
                Use your order number to get started. Your application decides which orders and
                actions you can access.
              </p>
            </div>
          ) : (
            entries.map((entry) => (
              <article className="conversation-turn" key={entry.key} data-operation-key={entry.key}>
                <div className="message message-user">
                  <h3>You</h3>
                  <p>{entry.prompt}</p>
                </div>
                <div
                  className="message message-agent"
                  data-state={entry.response.state}
                  data-testid="agent-response"
                >
                  <h3>Support agent</h3>
                  {entry.response.text && <p className="response-text">{entry.response.text}</p>}
                  <p
                    className="response-status"
                    role={entry.response.state === "failed" ? "alert" : "status"}
                    data-testid="run-status"
                  >
                    {entry.response.message}
                  </p>
                </div>
              </article>
            ))
          )}
        </div>
        <div className="composer">
          {configurationError && (
            <p className="configuration-error" role="alert">
              {configurationError}
            </p>
          )}
          {latest?.response.retryable && !busy && (
            <div className="delivery-retry">
              <p>
                Retrying retrieves this operation’s result. It keeps the original operation key.
              </p>
              <Button
                variant="outline"
                onClick={() => {
                  if (operation.current) void deliver(operation.current);
                }}
              >
                Retry delivery
              </Button>
            </div>
          )}
          <form onSubmit={submit}>
            <label htmlFor="support-message">Your message</label>
            <Textarea
              id="support-message"
              name="message"
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              maxLength={4000}
              placeholder="For example: What is the status of my order?"
              disabled={busy || !destination}
              aria-describedby="message-help"
            />
            <div className="composer-actions">
              <p id="message-help">Conversation history stays in this tab.</p>
              {busy ? (
                <Button type="button" variant="outline" onClick={() => controller.current?.abort()}>
                  Stop receiving
                </Button>
              ) : (
                <Button type="submit" disabled={!destination || !draft.trim()}>
                  Send message
                </Button>
              )}
            </div>
          </form>
          {busy && (
            <p className="delivery-note">
              Stopping delivery does not cancel an operation already running in the agent.
            </p>
          )}
        </div>
      </section>
      <aside className="reference-context" aria-labelledby="reference-heading">
        <h2 id="reference-heading">A controlled connection</h2>
        <p>
          Your application verifies your session. Its support agent receives only the permissions
          needed for your request.
        </p>
        <dl>
          <div>
            <dt>Orders</dt>
            <dd>Only explicitly authorized records are available.</dd>
          </div>
          <div>
            <dt>Actions</dt>
            <dd>Permissions and amount limits are checked before an action runs.</dd>
          </div>
          <div>
            <dt>Delivery</dt>
            <dd>An interrupted response can be retried without starting a new operation.</dd>
          </div>
        </dl>
        <p className="synthetic-notice">
          This reference uses synthetic orders. Refund simulations record an example effect; no
          money moves.
        </p>
      </aside>
    </div>
  );
}
