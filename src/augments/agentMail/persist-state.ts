/**
 * Persistent rate-limit / dedup state for the agentMail augment.
 *
 * Codex finding #3: the in-memory `RateLimitState` resets on every boot.
 * In a crash loop, deploy, or rollback, that erases the global cap, the
 * per-recipient cooldown, and the subject-hash dedup — exactly when
 * duplicate outbound mail is most likely. This module persists the state
 * to a JSON file in the augment's durable state directory and loads it
 * during factory construction.
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
 *   - Missing file → start fresh
 *   - Corrupt, invalid, or newer state → throw and fail closed
 *
 * Scope:
 *   - One namespaced state directory per augment instance on Railway.
 *   - Multi-process writers are not supported.
 */

import { join } from "node:path";
import { readDurableJson, writeDurableJson } from "../../lib/durable-json";
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

function statePath(stateDir: string): string {
  return join(stateDir, STATE_FILENAME);
}

function isSafeTimestamp(v: unknown): v is number {
  return typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
}

function isTimestampRecord(v: unknown): v is Record<string, number> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.values(v).every(isSafeTimestamp)
  );
}

function isPersistedRateState(v: unknown): v is PersistedRateState {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Record<string, unknown>;
  return (
    x.version === STATE_VERSION &&
    typeof x.savedAt === "string" &&
    !Number.isNaN(Date.parse(x.savedAt)) &&
    Array.isArray(x.globalTimestamps) &&
    x.globalTimestamps.every(isSafeTimestamp) &&
    isTimestampRecord(x.lastByRecipient) &&
    isTimestampRecord(x.subjectHashes)
  );
}

/**
 * Load persisted rate-limit state. Returns null when:
 *   - stateDir is undefined
 *   - state file doesn't exist
 * Corrupt JSON, unknown versions, and invalid values throw instead of
 * erasing enforcement history.
 *
 * Stale entries (anything older than `now - HOUR_MS`) are pruned at load
 * so a crashed agent that comes back up an hour later doesn't drag old
 * timestamps forward.
 */
export function loadRateState(stateDir: string | undefined, now: number): RateLimitState | null {
  if (!stateDir) return null;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("[agent-mail] rate state clock must be a non-negative safe integer");
  }
  const path = statePath(stateDir);
  const parsed = readDurableJson(path, "agentMail rate state", 16 * 1024 * 1024);
  if (parsed === null) return null;

  if (!isPersistedRateState(parsed)) {
    throw new Error(`[agent-mail] state file ${path} failed validation; refusing to reset limits`);
  }

  const windowStart = now - HOUR_MS;
  const globalTimestamps = parsed.globalTimestamps
    .filter((t) => t > windowStart)
    .sort((a, b) => a - b);

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
export function saveRateState(stateDir: string, state: RateLimitState, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("[agent-mail] rate state clock must be a non-negative safe integer");
  }
  const path = statePath(stateDir);
  const payload: PersistedRateState = {
    version: STATE_VERSION,
    savedAt: new Date(now).toISOString(),
    globalTimestamps: [...state.globalTimestamps].sort((a, b) => a - b),
    lastByRecipient: Object.fromEntries(state.lastByRecipient),
    subjectHashes: Object.fromEntries(state.subjectHashes),
  };
  if (!isPersistedRateState(payload)) {
    throw new Error("[agent-mail] refusing to persist invalid rate-limit state");
  }
  writeDurableJson(path, payload, "agentMail rate state");
}
