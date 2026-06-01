/**
 * Persistent rate-limit / dedup state for the agentMail augment.
 *
 * Codex finding #3: the in-memory `RateLimitState` resets on every boot.
 * In a crash loop, deploy, or rollback, that erases the global cap, the
 * per-recipient cooldown, and the subject-hash dedup — exactly when
 * duplicate outbound mail is most likely. This module persists the state
 * to a JSON file in the agent directory (alongside `admin-overrides.json`)
 * and loads it on boot.
 *
 * Format:
 *   {
 *     "version": 1,
 *     "savedAt": "<ISO8601>",
 *     "globalTimestamps": [<ms>, ...],
 *     "lastByRecipient": { "<email lowercased>": <ms>, ... },
 *     "subjectHashes": { "<normalized hash>": <ms>, ... }
 *   }
 *
 * Write semantics:
 *   - Synchronous atomic write (tmp + rename) with mode 0o600
 *   - Called after every successful send (cheap — ~KB JSON, atomic on POSIX)
 *
 * Load semantics:
 *   - Read once at `onBoot`
 *   - Stale entries (older than 1h) are pruned at load
 *   - Corrupt file → log a warning, start fresh (do not throw — the augment
 *     must boot even if state is unreadable)
 *
 * Scope:
 *   - Single inbox per augment instance — the state file lives in the
 *     declared `agentDir`. If two augments share an `agentDir`, they
 *     SHARE state (which is fine for single-process; multi-process is
 *     not supported by the in-memory rate-limit anyway).
 */

import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RateLimitState } from "./rate-limit";

const HOUR_MS = 3_600_000;
const STATE_VERSION = 1;
const STATE_FILENAME = "agent-mail-state.json";

interface PersistedRateState {
  version: 1;
  savedAt: string;
  globalTimestamps: number[];
  lastByRecipient: Record<string, number>;
  subjectHashes: Record<string, number>;
}

function statePath(agentDir: string): string {
  return join(agentDir, STATE_FILENAME);
}

function isPersistedRateState(v: unknown): v is PersistedRateState {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Record<string, unknown>;
  if (x.version !== 1) return false;
  if (!Array.isArray(x.globalTimestamps)) return false;
  if (typeof x.lastByRecipient !== "object" || x.lastByRecipient === null) return false;
  if (typeof x.subjectHashes !== "object" || x.subjectHashes === null) return false;
  return true;
}

/**
 * Load persisted rate-limit state. Returns null when:
 *   - agentDir is undefined or doesn't exist
 *   - state file doesn't exist
 *   - file is corrupt JSON or fails schema validation (warn logged)
 *
 * Stale entries (anything older than `now - HOUR_MS`) are pruned at load
 * so a crashed agent that comes back up an hour later doesn't drag old
 * timestamps forward.
 */
export function loadRateState(agentDir: string | undefined, now: number): RateLimitState | null {
  if (!agentDir || !existsSync(agentDir)) return null;
  const path = statePath(agentDir);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(
      `[agent-mail] failed to parse ${path}: ${(err as Error).message}. ` +
        `Starting with empty rate-limit state.`,
    );
    return null;
  }

  if (!isPersistedRateState(parsed)) {
    console.warn(
      `[agent-mail] state file ${path} failed validation. ` +
        `Starting with empty rate-limit state.`,
    );
    return null;
  }

  const windowStart = now - HOUR_MS;
  const globalTimestamps = parsed.globalTimestamps.filter(
    (t) => typeof t === "number" && t > windowStart,
  );

  const lastByRecipient = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed.lastByRecipient)) {
    if (typeof v === "number" && v > windowStart) lastByRecipient.set(k, v);
  }

  const subjectHashes = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed.subjectHashes)) {
    if (typeof v === "number" && v > windowStart) subjectHashes.set(k, v);
  }

  return { globalTimestamps, lastByRecipient, subjectHashes };
}

/**
 * Atomic write of the current rate-limit state. Mirrors the
 * `lib/admin-overrides.ts` pattern: write to a uniquely-named temp file
 * then rename. Mode 0o600 because the file contains recipient email
 * timestamps — minor PII that shouldn't be world-readable on multi-user
 * hosts.
 *
 * Synchronous on purpose: the calling site is `recordSend` which is
 * already on the critical path of a successful tool execution. We want
 * the durability guarantee before returning "sent" to the model.
 */
export function saveRateState(agentDir: string, state: RateLimitState, now: number): void {
  const path = statePath(agentDir);
  const payload: PersistedRateState = {
    version: STATE_VERSION,
    savedAt: new Date(now).toISOString(),
    globalTimestamps: state.globalTimestamps,
    lastByRecipient: Object.fromEntries(state.lastByRecipient),
    subjectHashes: Object.fromEntries(state.subjectHashes),
  };
  const tmp = `${path}.tmp.${process.pid}.${randomUUID()}`;
  writeFileSync(tmp, JSON.stringify(payload), { mode: 0o600 });
  renameSync(tmp, path);
}
