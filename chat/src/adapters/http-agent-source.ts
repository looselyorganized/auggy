import type { AgentRef, AgentSource } from "./types";

/**
 * Browser-side AgentSource. Fetches agent list from the GUI server's
 * `/api/agents` endpoint (same-origin), which in turn delegates to the
 * server-side `localPidSource`.
 *
 * `localPidSource` uses node:fs / node:os and cannot run in a browser
 * bundle; this adapter is the symmetric browser-to-server bridge that
 * `httpProxyConnection` is for `/api/chat/<id>`.
 */
export interface HttpAgentSourceOptions {
  /** UI label, defaults to "local". */
  label?: string;
  /** Section ordering, defaults to 0. */
  order?: number;
  /** Polling interval for live updates. Defaults to 2000ms. 0 disables polling. */
  pollIntervalMs?: number;
}

export function createHttpAgentSource(opts: HttpAgentSourceOptions = {}): AgentSource {
  const label = opts.label ?? "local";
  const order = opts.order ?? 0;
  const pollIntervalMs = opts.pollIntervalMs ?? 2000;

  return {
    label,
    order,
    async list(): Promise<AgentRef[]> {
      const res = await fetch("/api/agents", {
        headers: { accept: "application/json" },
      });
      if (!res.ok) {
        throw new Error(`/api/agents failed: ${res.status} ${res.statusText}`);
      }
      const body = (await res.json()) as { agents: AgentRef[] };
      return body.agents ?? [];
    },
    subscribe(onChange) {
      if (pollIntervalMs <= 0) return () => {};
      const id = setInterval(() => onChange(), pollIntervalMs);
      return () => clearInterval(id);
    },
  };
}
