/**
 * Rate-limit state for the agentMail augment.
 *
 * Three layers, evaluated in order:
 *   1. Global hourly cap — total sends across all recipients per rolling hour.
 *   2. Per-recipient cooldown — time-since-last-send to a specific address.
 *   3. Subject-hash dedup — block sends with the same normalized subject
 *      hash within a window (prevents accidental retry storms).
 *
 * Creator and null (system / scheduled) peers bypass rate layers, but their
 * provider calls are still journaled by the augment for duplicate safety.
 *
 * Pure-ish: state is encapsulated; no IO. All time-sensitive calls take
 * `now: number` so tests can drive the clock deterministically.
 */

import type { AgentMailRateLimitOptions } from "../../types";

const HOUR_MS = 3_600_000;
const ATTEMPT_RETENTION_MS = 30 * 24 * HOUR_MS;

export interface RateLimitDecision {
  allowed: boolean;
  /** Set when allowed === false. Operator-facing message. */
  reason?: string;
  /** Echoed back to model when 429-style. */
  retryAfterSec?: number;
}

export interface RateLimitState {
  /** Sliding-window timestamps of every send in the last hour. */
  globalTimestamps: number[];
  /** Last-send timestamp per recipient address (lowercased). */
  lastByRecipient: Map<string, number>;
  /** Subject-hash → first-seen timestamp within the dedup window. */
  subjectHashes: Map<string, number>;
  /** Provider-bound attempts that consume capacity until committed or definitively released. */
  reservations: Map<string, RateLimitReservation>;
  /** Recently committed attempt IDs used to make crash recovery idempotent. */
  accountedAttemptIds: Map<string, number>;
}

export interface RateLimitReservation {
  timestamp: number;
  recipients: string[];
  subject: string;
}

export function createRateLimitState(): RateLimitState {
  return {
    globalTimestamps: [],
    lastByRecipient: new Map(),
    subjectHashes: new Map(),
    reservations: new Map(),
    accountedAttemptIds: new Map(),
  };
}

/**
 * Cheap-and-stable subject hash. We don't need cryptographic strength —
 * just a normalized fingerprint so "Hello" and "  Hello  " collide, but
 * "Hello" and "Hello!" do not. Trim + lowercase + strip multiple spaces.
 */
export function hashSubject(subject: string): string {
  return subject.trim().toLowerCase().replace(/\s+/g, " ");
}

/**
 * Decide whether a send is allowed under committed state plus durable
 * in-flight reservations. Does not mutate state.
 */
export function checkRateLimit(
  state: RateLimitState,
  recipients: string[],
  subject: string,
  opts: AgentMailRateLimitOptions,
  now: number,
): RateLimitDecision {
  if (opts.enabled === false) return { allowed: true };

  const globalMax = opts.globalMaxPerHour ?? 10;
  const perRecipMs = opts.perRecipientCooldownMs ?? 300_000;
  const dedupMs = opts.dedupWindowMs ?? 300_000;

  // Global hourly cap. Sliding window — prune anything older than 1h then
  // compare. We prune lazily on every check to keep the array bounded.
  const windowStart = now - HOUR_MS;
  const recent = [
    ...state.globalTimestamps.filter((t) => t > windowStart),
    ...[...state.reservations.values()]
      .map((reservation) => reservation.timestamp)
      .filter((timestamp) => timestamp > windowStart),
  ].sort((a, b) => a - b);
  if (recent.length >= globalMax) {
    const oldest = recent[0]!;
    const retryAfterSec = Math.max(1, Math.ceil((oldest + HOUR_MS - now) / 1000));
    return {
      allowed: false,
      reason: `agentMail: global cap reached (${globalMax}/hour). Try again in ${retryAfterSec}s.`,
      retryAfterSec,
    };
  }

  // Per-recipient cooldown. Any single recipient in cooldown blocks the
  // entire send — we don't want to silently drop addresses from a list.
  for (const r of recipients) {
    const key = r.toLowerCase();
    const reserved = [...state.reservations.values()]
      .filter((reservation) => reservation.recipients.some((recipient) => recipient === key))
      .reduce<number | undefined>(
        (latest, reservation) =>
          latest === undefined || reservation.timestamp > latest ? reservation.timestamp : latest,
        undefined,
      );
    const committed = state.lastByRecipient.get(key);
    const last =
      committed === undefined
        ? reserved
        : reserved === undefined
          ? committed
          : Math.max(committed, reserved);
    if (last !== undefined && now - last < perRecipMs) {
      const retryAfterSec = Math.ceil((perRecipMs - (now - last)) / 1000);
      return {
        allowed: false,
        reason: `agentMail: cooldown active for ${r}. Try again in ${retryAfterSec}s.`,
        retryAfterSec,
      };
    }
  }

  // Subject-hash dedup. Skip when window is 0.
  if (dedupMs > 0) {
    const hash = hashSubject(subject);
    const reserved = [...state.reservations.values()]
      .filter((reservation) => hashSubject(reservation.subject) === hash)
      .reduce<number | undefined>(
        (latest, reservation) =>
          latest === undefined || reservation.timestamp > latest ? reservation.timestamp : latest,
        undefined,
      );
    const committed = state.subjectHashes.get(hash);
    const firstSeen =
      committed === undefined
        ? reserved
        : reserved === undefined
          ? committed
          : Math.max(committed, reserved);
    if (firstSeen !== undefined && now - firstSeen < dedupMs) {
      const retryAfterSec = Math.ceil((dedupMs - (now - firstSeen)) / 1000);
      return {
        allowed: false,
        reason: `agentMail: identical subject sent recently. Try again in ${retryAfterSec}s, or change the subject.`,
        retryAfterSec,
      };
    }
  }

  return { allowed: true };
}

function normalizedReservation(
  recipients: string[],
  subject: string,
  timestamp: number,
): RateLimitReservation {
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error("agentMail rate reservation: timestamp must be a non-negative safe integer");
  }
  if (recipients.length === 0) {
    throw new Error("agentMail rate reservation: recipients must not be empty");
  }
  return {
    timestamp,
    recipients: [...new Set(recipients.map((recipient) => recipient.toLowerCase()))].sort(),
    subject,
  };
}

export function hasRateAttempt(state: RateLimitState, attemptId: string): boolean {
  return state.reservations.has(attemptId) || state.accountedAttemptIds.has(attemptId);
}

/** Reserve capacity synchronously before the provider can observe the request. */
export function reserveSend(
  state: RateLimitState,
  attemptId: string,
  recipients: string[],
  subject: string,
  timestamp: number,
): boolean {
  if (!attemptId) throw new Error("agentMail rate reservation: attemptId is required");
  if (state.accountedAttemptIds.has(attemptId)) return false;
  const next = normalizedReservation(recipients, subject, timestamp);
  const existing = state.reservations.get(attemptId);
  if (existing) {
    if (JSON.stringify(existing) !== JSON.stringify(next)) {
      throw new Error(`agentMail rate reservation: attempt id "${attemptId}" payload mismatch`);
    }
    return false;
  }
  state.reservations.set(attemptId, next);
  return true;
}

/** Release capacity only when the provider definitively rejected the request. */
export function releaseReservation(state: RateLimitState, attemptId: string): boolean {
  if (state.accountedAttemptIds.has(attemptId)) {
    throw new Error(`agentMail rate reservation: attempt "${attemptId}" is already committed`);
  }
  return state.reservations.delete(attemptId);
}

/** Convert a reservation to committed history exactly once. */
export function commitReservation(
  state: RateLimitState,
  attemptId: string,
  opts: AgentMailRateLimitOptions = {},
  now: number = Date.now(),
): boolean {
  if (state.accountedAttemptIds.has(attemptId)) return false;
  if (!Number.isSafeInteger(now) || now < 0) {
    throw new Error("agentMail rate reservation: commit clock must be a non-negative safe integer");
  }
  const reservation = state.reservations.get(attemptId);
  if (!reservation) {
    throw new Error(`agentMail rate reservation: attempt "${attemptId}" is not reserved`);
  }
  recordSend(state, reservation.recipients, reservation.subject, reservation.timestamp, opts);
  state.reservations.delete(attemptId);
  state.accountedAttemptIds.set(attemptId, reservation.timestamp);
  const retentionMs = Math.max(
    ATTEMPT_RETENTION_MS,
    HOUR_MS,
    opts.perRecipientCooldownMs ?? 300_000,
    opts.dedupWindowMs ?? 300_000,
  );
  const cutoff = now - retentionMs;
  for (const [id, timestamp] of state.accountedAttemptIds) {
    // Keep the just-committed tombstone even for an exceptionally old
    // ambiguous attempt until its queue transition has a chance to persist.
    if (id !== attemptId && timestamp <= cutoff) state.accountedAttemptIds.delete(id);
  }
  return true;
}

export function recordSend(
  state: RateLimitState,
  recipients: string[],
  subject: string,
  now: number,
  opts: AgentMailRateLimitOptions = {},
): void {
  const perRecipMs = opts.perRecipientCooldownMs ?? 300_000;
  const dedupMs = opts.dedupWindowMs ?? 300_000;
  state.globalTimestamps.push(now);
  // Bound the array — keep at most 2x the largest realistic per-hour cap.
  // Prune anything older than 1h while we're at it.
  const windowStart = now - HOUR_MS;
  state.globalTimestamps = state.globalTimestamps.filter((t) => t > windowStart);

  for (const r of recipients) {
    state.lastByRecipient.set(r.toLowerCase(), now);
  }
  const recipientCutoff = now - perRecipMs;
  for (const [recipient, ts] of state.lastByRecipient) {
    if (ts < recipientCutoff) state.lastByRecipient.delete(recipient);
  }

  if (dedupMs > 0) state.subjectHashes.set(hashSubject(subject), now);

  // Sweep stale subject hashes opportunistically (keeps map bounded).
  const dedupCutoff = now - dedupMs;
  for (const [hash, ts] of state.subjectHashes) {
    if (ts < dedupCutoff) state.subjectHashes.delete(hash);
  }
}
