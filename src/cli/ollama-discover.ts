/**
 * Discover Ollama models installed on the operator's machine.
 *
 * `ollama list` queries the local daemon (no network). We shell out with
 * array-args spawn (no shell interpretation, no injection vector), apply
 * a short timeout so a stuck daemon doesn't hang the wizard, and parse
 * the tab-separated output defensively. Failures fall back to an empty
 * list — discovery is best-effort; the wizard still works without it.
 *
 * Security:
 * - Fixed command `ollama list`, no user-controlled args.
 * - Array-args spawn, no shell.
 * - Output sanitized (non-printable characters stripped) before render.
 */

import { spawn, type ChildProcess } from "node:child_process";

export interface DiscoverOpts {
  /** Override the spawn factory for unit tests. */
  spawnFactory?: SpawnFactory;
  /** Timeout in ms (default 2000). */
  timeoutMs?: number;
}

export type SpawnFactory = (
  command: string,
  args: string[],
) => Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;

/**
 * Discover installed Ollama models by running `ollama list`.
 *
 * Returns model IDs (the first column of `ollama list`), e.g.
 * `["qwen3:8b", "gemma4", "llama3.2:3b"]`. Returns [] on any failure
 * — caller treats empty as "discovery unavailable" and falls back to
 * a typed model name.
 */
export async function listInstalledOllamaModels(opts: DiscoverOpts = {}): Promise<string[]> {
  const factory: SpawnFactory =
    opts.spawnFactory ?? ((cmd, args) => spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"] }));
  const timeoutMs = opts.timeoutMs ?? 2000;

  let stdout = "";
  let stderr = "";

  return new Promise<string[]>((resolve) => {
    let child: Pick<ChildProcess, "stdout" | "stderr" | "on" | "kill">;
    try {
      child = factory("ollama", ["list"]);
    } catch {
      // spawn itself threw (e.g., ollama binary not found on PATH)
      resolve([]);
      return;
    }

    const timer = setTimeout(() => {
      try {
        child.kill?.("SIGKILL");
      } catch {
        // ignore
      }
      resolve([]);
    }, timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on?.("error", () => {
      clearTimeout(timer);
      resolve([]);
    });

    child.on?.("close", (code: number | null) => {
      clearTimeout(timer);
      if (code !== 0) {
        // Non-zero exit (daemon down, command unknown, etc.). stderr is
        // discarded — discovery is opportunistic and a noisy fallback is
        // worse than a quiet one.
        void stderr;
        resolve([]);
        return;
      }
      resolve(parseOllamaList(stdout));
    });
  });
}

/**
 * Parse `ollama list` output. Expected shape:
 *
 *   NAME                  ID            SIZE      MODIFIED
 *   qwen3:8b              abc123        4.7 GB    2 days ago
 *   gemma4:latest         def456        7.5 GB    3 weeks ago
 *
 * We take the first column (model ID), drop the header, sanitize, and
 * dedupe. Models with weird characters are skipped rather than rendered.
 */
export function parseOllamaList(raw: string): string[] {
  if (!raw.trim()) return [];

  const lines = raw.split("\n");
  const out: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    if (/^NAME(\s|$)/i.test(trimmed)) continue; // header row

    // First whitespace-separated token is the model ID.
    const first = trimmed.split(/\s+/, 1)[0];
    if (!first) continue;

    // Only allow safe model-name chars. Anything else is dropped.
    // Ollama model IDs use [a-z0-9._:-/]+ in practice.
    if (!/^[a-zA-Z0-9._:/-]+$/.test(first)) continue;

    if (seen.has(first)) continue;
    seen.add(first);
    out.push(first);
  }

  return out;
}

/**
 * Recommended tool-capable model families on Ollama (verified 2026-06-01).
 *
 * Evidence base:
 * - Ollama's tool-calling docs demonstrate structured tools with qwen3.
 * - Ollama's current "Tools" catalog surfaces qwen3.6, qwen3.5, gemma4,
 *   glm-5.1, and deepseek-v3.2 as tool-capable families.
 *
 * Explicitly dropped:
 * - llama3.2 (1B/3B) — BFCL V4 21.95 / 10.82 (ranks 98 / 107) AND
 *   emits tool calls in non-standard "pythonic text" format, not the
 *   structured tool_use channel Ollama's API expects. See vLLM #9991.
 *
 * Families match by prefix: a discovered "qwen3.6:27b" or
 * "qwen3:14b-instruct" both match their family. Order is recommendation
 * order, not lexical order.
 */
export const RECOMMENDED_OLLAMA_FAMILIES: readonly string[] = [
  "qwen3.6",
  "qwen3.5",
  "qwen3",
  "gemma4",
  "glm-5.1",
  "deepseek-v3.2",
];

/** Suggested first-pull when the user has no tool-capable model installed. */
export const RECOMMENDED_FIRST_PULL = "qwen3.5:9b";

/**
 * Partition discovered models into "recommended for tool calling" and
 * "other" (installed but not on the tool-capable shortlist).
 */
export function partitionByRecommended(installed: string[]): {
  recommended: string[];
  other: string[];
} {
  const recommended: string[] = [];
  const other: string[] = [];
  for (const id of installed) {
    const family = id.split(":")[0] ?? id;
    if (RECOMMENDED_OLLAMA_FAMILIES.some((f) => family === f)) {
      recommended.push(id);
    } else {
      other.push(id);
    }
  }
  return { recommended, other };
}
