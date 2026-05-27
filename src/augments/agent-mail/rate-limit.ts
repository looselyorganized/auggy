/**
 * Rate-limit state for the agentMail augment.
 *
 * Three layers, evaluated in order:
 *   1. Global hourly cap — total sends across all recipients per rolling hour.
 *   2. Per-recipient cooldown — time-since-last-send to a specific address.
 *   3. Subject-hash dedup — block sends with the same normalized subject
 *      hash within a window (prevents accidental retry storms).
 *
 * Creator and null (system / scheduled) peers bypass all layers. The peer
 * gate is enforced one level up in `outbound.ts`; this module is purely
 * arithmetic and assumes the caller has already decided the peer is
 * subject to limits.
 *
 * Pure-ish: state is encapsulated; no IO. All time-sensitive calls take
 * `now: number` so tests can drive the clock deterministically.
 */

import type { AgentMailRateLimitOptions } from "../../types";

const HOUR_MS = 3_600_000;

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
}

export function createRateLimitState(): RateLimitState {
  return {
    globalTimestamps: [],
    lastByRecipient: new Map(),
    subjectHashes: new Map(),
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
 * Decide whether a send is allowed under current state. Does NOT mutate
 * state — call `recordSend` only after the actual HTTP call succeeds, so
 * a rejected/failed send doesn't burn the operator's quota.
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
  const recent = state.globalTimestamps.filter((t) => t > windowStart);
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
    const last = state.lastByRecipient.get(key);
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
    const firstSeen = state.subjectHashes.get(hash);
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

export function recordSend(
  state: RateLimitState,
  recipients: string[],
  subject: string,
  now: number,
): void {
  state.globalTimestamps.push(now);
  // Bound the array — keep at most 2x the largest realistic per-hour cap.
  // Prune anything older than 1h while we're at it.
  const windowStart = now - HOUR_MS;
  state.globalTimestamps = state.globalTimestamps.filter((t) => t > windowStart);

  for (const r of recipients) {
    state.lastByRecipient.set(r.toLowerCase(), now);
  }

  state.subjectHashes.set(hashSubject(subject), now);

  // Sweep stale subject hashes opportunistically (keeps map bounded).
  const dedupCutoff = now - HOUR_MS;
  for (const [hash, ts] of state.subjectHashes) {
    if (ts < dedupCutoff) state.subjectHashes.delete(hash);
  }
}
