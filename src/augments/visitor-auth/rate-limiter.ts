/**
 * Per-anonymous-peer sliding-window rate limiter for `request_auth` calls.
 *
 * In-memory only — restart resets state. Rationale: the verified_visitors
 * UNIQUE-on-email constraint prevents accidental double-verification, and
 * an attacker can't trigger restart from outside. Documented behavior.
 *
 * State: Map<peerId, number[]> of timestamps in the past 24h. Pruned on
 * each check/record. No background cleanup required.
 */

import type { VisitorAuthRateLimit } from "./types";

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;

export type RateLimitDecision =
  | { allowed: true }
  | { allowed: false; reason: "hourly" | "daily"; retryAfterSec: number };

export interface VisitorAuthRateLimiter {
  check(peerId: string, now: number): RateLimitDecision;
  record(peerId: string, now: number): void;
  forget(peerId: string): void;
}

export function createVisitorAuthRateLimiter(
  caps: VisitorAuthRateLimit,
): VisitorAuthRateLimiter {
  const windows = new Map<string, number[]>();

  function pruneAndGet(peerId: string, now: number): number[] {
    const cutoff = now - DAY_MS;
    const list = (windows.get(peerId) ?? []).filter((t) => t > cutoff);
    if (list.length === 0) {
      windows.delete(peerId);
      return [];
    }
    windows.set(peerId, list);
    return list;
  }

  return {
    check(peerId: string, now: number): RateLimitDecision {
      const list = pruneAndGet(peerId, now);
      const inHour = list.filter((t) => t > now - HOUR_MS).length;
      if (inHour >= caps.perHour) {
        const oldestInHour = list
          .filter((t) => t > now - HOUR_MS)
          .reduce((a, b) => Math.min(a, b), now);
        const retryAfterSec = Math.ceil((oldestInHour + HOUR_MS - now) / 1000);
        return { allowed: false, reason: "hourly", retryAfterSec: Math.max(1, retryAfterSec) };
      }
      if (list.length >= caps.perDay) {
        const oldestInDay = list.reduce((a, b) => Math.min(a, b), now);
        const retryAfterSec = Math.ceil((oldestInDay + DAY_MS - now) / 1000);
        return { allowed: false, reason: "daily", retryAfterSec: Math.max(1, retryAfterSec) };
      }
      return { allowed: true };
    },
    record(peerId: string, now: number): void {
      const list = pruneAndGet(peerId, now);
      list.push(now);
      windows.set(peerId, list);
    },
    forget(peerId: string): void {
      windows.delete(peerId);
    },
  };
}
