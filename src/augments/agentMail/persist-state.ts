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
 *     "version": 2,
 *     "savedAt": "<ISO8601>",
 *     "globalTimestamps": [<ms>, ...],
 *     "lastByRecipient": { "<email lowercased>": <ms>, ... },
 *     "subjectHashes": { "<normalized hash>": <ms>, ... },
 *     "reservations": { "<attempt id>": { ... } },
 *     "accountedAttemptIds": { "<attempt id>": <ms>, ... }
 *   }
 *
 * Write semantics:
 *   - Synchronous atomic write (tmp + rename) with mode 0o600
 *   - Called before provider delivery to reserve capacity, then again to
 *     commit success or release a definitive rejection.
 *
 * Load semantics:
 *   - Read once at `onBoot`
 *   - Stale committed entries are pruned according to their configured windows
 *   - Version 1 state migrates in memory without resetting prior limits
 *   - Missing file → start fresh
 *   - Corrupt, invalid, or newer state → throw and fail closed
 *
 * Scope:
 *   - One namespaced state directory per augment instance on Railway.
 *   - Multi-process writers are not supported.
 */

import { join } from "node:path";
import { readDurableJson, writeDurableJson } from "../../lib/durable-json";
import type { AgentMailRateLimitOptions } from "../../types";
import type { RateLimitReservation, RateLimitState } from "./rate-limit";

const HOUR_MS = 3_600_000;
const STATE_VERSION = 2;
const STATE_FILENAME = "agent-mail-state.json";
const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

interface PersistedRateStateV1 {
  version: 1;
  savedAt: string;
  globalTimestamps: number[];
  lastByRecipient: Record<string, number>;
  subjectHashes: Record<string, number>;
}

interface PersistedRateStateV2 {
  version: 2;
  savedAt: string;
  globalTimestamps: number[];
  lastByRecipient: Record<string, number>;
  subjectHashes: Record<string, number>;
  reservations: Record<string, RateLimitReservation>;
  accountedAttemptIds: Record<string, number>;
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
    Object.entries(v).every(([key, value]) => key.length > 0 && isSafeTimestamp(value))
  );
}

function hasBaseRateState(x: Record<string, unknown>): boolean {
  return (
    typeof x.savedAt === "string" &&
    !Number.isNaN(Date.parse(x.savedAt)) &&
    Array.isArray(x.globalTimestamps) &&
    x.globalTimestamps.every(isSafeTimestamp) &&
    isTimestampRecord(x.lastByRecipient) &&
    isTimestampRecord(x.subjectHashes)
  );
}

function isReservationRecord(v: unknown): v is Record<string, RateLimitReservation> {
  return (
    typeof v === "object" &&
    v !== null &&
    !Array.isArray(v) &&
    Object.entries(v).every(
      ([attemptId, reservation]) =>
        attemptId.length > 0 &&
        typeof reservation === "object" &&
        reservation !== null &&
        isSafeTimestamp((reservation as Record<string, unknown>).timestamp) &&
        Array.isArray((reservation as Record<string, unknown>).recipients) &&
        ((reservation as Record<string, unknown>).recipients as unknown[]).length > 0 &&
        ((reservation as Record<string, unknown>).recipients as unknown[]).every(
          (recipient) => typeof recipient === "string" && recipient.length > 0,
        ) &&
        typeof (reservation as Record<string, unknown>).subject === "string",
    )
  );
}

function isPersistedRateStateV1(v: unknown): v is PersistedRateStateV1 {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Record<string, unknown>;
  return x.version === 1 && hasBaseRateState(x);
}

function isPersistedRateStateV2(v: unknown): v is PersistedRateStateV2 {
  if (typeof v !== "object" || v === null) return false;
  const x = v as Record<string, unknown>;
  return (
    x.version === STATE_VERSION &&
    hasBaseRateState(x) &&
    isReservationRecord(x.reservations) &&
    isTimestampRecord(x.accountedAttemptIds)
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
export function loadRateState(
  stateDir: string | undefined,
  now: number,
  options: AgentMailRateLimitOptions = {},
): RateLimitState | null {
  if (!stateDir) return null;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("[agent-mail] rate state clock must be a non-negative safe integer");
  }
  const path = statePath(stateDir);
  const parsed = readDurableJson(path, "agentMail rate state", 16 * 1024 * 1024);
  if (parsed === null) return null;

  if (!isPersistedRateStateV1(parsed) && !isPersistedRateStateV2(parsed)) {
    throw new Error(`[agent-mail] state file ${path} failed validation; refusing to reset limits`);
  }

  const windowStart = now - HOUR_MS;
  const recipientWindowStart = now - (options.perRecipientCooldownMs ?? 300_000);
  const dedupWindowStart = now - (options.dedupWindowMs ?? 300_000);
  const globalTimestamps = parsed.globalTimestamps
    .filter((t) => t > windowStart)
    .sort((a, b) => a - b);

  const lastByRecipient = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed.lastByRecipient)) {
    if (typeof v === "number" && v > recipientWindowStart) lastByRecipient.set(k, v);
  }

  const subjectHashes = new Map<string, number>();
  for (const [k, v] of Object.entries(parsed.subjectHashes)) {
    if (typeof v === "number" && v > dedupWindowStart) subjectHashes.set(k, v);
  }

  const retentionMs = Math.max(
    ATTEMPT_RETENTION_MS,
    HOUR_MS,
    options.perRecipientCooldownMs ?? 300_000,
    options.dedupWindowMs ?? 300_000,
  );
  const reservations = new Map<string, RateLimitReservation>();
  const accountedAttemptIds = new Map<string, number>();
  if (isPersistedRateStateV2(parsed)) {
    for (const [attemptId, reservation] of Object.entries(parsed.reservations)) {
      reservations.set(attemptId, {
        timestamp: reservation.timestamp,
        recipients: [...reservation.recipients],
        subject: reservation.subject,
      });
    }
    for (const [attemptId, timestamp] of Object.entries(parsed.accountedAttemptIds)) {
      if (timestamp > now - retentionMs) accountedAttemptIds.set(attemptId, timestamp);
    }
  }

  return { globalTimestamps, lastByRecipient, subjectHashes, reservations, accountedAttemptIds };
}

/**
 * Atomic write of the current rate-limit state. Mirrors the
 * `lib/admin-overrides.ts` pattern: write to a uniquely-named temp file
 * then rename. Mode 0o600 because the file contains recipient email
 * timestamps — minor PII that shouldn't be world-readable on multi-user
 * hosts.
 *
 * Synchronous on purpose: reservation durability must be established before
 * the provider call, and commit durability before returning "sent".
 */
export function saveRateState(stateDir: string, state: RateLimitState, now: number): void {
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("[agent-mail] rate state clock must be a non-negative safe integer");
  }
  const path = statePath(stateDir);
  const payload: PersistedRateStateV2 = {
    version: STATE_VERSION,
    savedAt: new Date(now).toISOString(),
    globalTimestamps: [...state.globalTimestamps].sort((a, b) => a - b),
    lastByRecipient: Object.fromEntries(state.lastByRecipient),
    subjectHashes: Object.fromEntries(state.subjectHashes),
    reservations: Object.fromEntries(state.reservations),
    accountedAttemptIds: Object.fromEntries(state.accountedAttemptIds),
  };
  if (!isPersistedRateStateV2(payload)) {
    throw new Error("[agent-mail] refusing to persist invalid rate-limit state");
  }
  writeDurableJson(path, payload, "agentMail rate state");
}
