import { readdirSync, readFileSync, watch } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import type { AgentRef, AgentSource } from "./types";

interface PidManifest {
  pid: number;
  name: string;
  port: number | null;
  configPath: string;
  agentDir: string;
  startedAt: string;
  mode: "dev" | "launchd";
}

export interface LocalPidSourceOptions {
  auggyDir?: string;
  pollIntervalMs?: number;
  cardFetchTimeoutMs?: number;
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function fetchAgentCard(baseUrl: string, timeoutMs: number) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/.well-known/agent-card.json`, { signal: ctrl.signal });
    if (!res.ok) return null;
    return (await res.json()) as {
      name?: string;
      provider?: { description?: string };
      skills?: { name: string }[];
    };
  } catch { return null; }
  finally { clearTimeout(t); }
}

export function createLocalPidSource(opts: LocalPidSourceOptions = {}): AgentSource {
  const auggyDir = opts.auggyDir ?? join(homedir(), ".auggy");
  const pollMs = opts.pollIntervalMs ?? 5000;
  const cardTimeoutMs = opts.cardFetchTimeoutMs ?? 1000;

  function readManifests(): PidManifest[] {
    let files: string[];
    try { files = readdirSync(auggyDir).filter(f => f.endsWith(".json")); }
    catch { return []; }

    const out: PidManifest[] = [];
    for (const f of files) {
      try {
        const raw = readFileSync(join(auggyDir, f), "utf8");
        out.push(JSON.parse(raw) as PidManifest);
      } catch { /* skip malformed */ }
    }
    return out;
  }

  return {
    label: "Local agents",
    order: 0,
    async list() {
      const manifests = readManifests();
      return Promise.all(manifests.map(async (m): Promise<AgentRef> => {
        const alive = isProcessAlive(m.pid);
        const card = (alive && m.port) ? await fetchAgentCard(`http://localhost:${m.port}`, cardTimeoutMs) : null;
        const status: AgentRef["status"] = (alive && card) ? "online" : "offline";
        return {
          id: m.name,
          name: m.name,
          description: card?.provider?.description,
          capabilities: card?.skills?.map(s => s.name),
          status,
          metadata: { port: m.port, agentDir: m.agentDir, pid: m.pid },
        };
      }));
    },
    subscribe(onChange) {
      let watcher: ReturnType<typeof watch> | null = null;
      try {
        watcher = watch(auggyDir, { persistent: false }, () => onChange());
      } catch {
        // fs.watch unavailable; poll only.
      }
      // Always run polling as a backstop — fs.watch latency varies by platform
      // (FSEvents can be 50-500ms on macOS) and isn't reliable enough alone.
      const interval = setInterval(onChange, pollMs);
      return () => {
        if (watcher) { try { watcher.close(); } catch { /* already closed */ } }
        clearInterval(interval);
      };
    },
  };
}
