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
  | { allowed: false; reason: "cooldown" | "hourly" | "daily"; retryAfterSec: number };

export interface VisitorAuthRateLimiter {
  check(peerId: string, now: number): RateLimitDecision;
  record(peerId: string, now: number): void;
  forget(peerId: string): void;
  /**
   * Drop entries whose every timestamp is older than the 24h window. Returns
   * the number of keys evicted. Cheap when called periodically; without it
   * an entry for an inactive peer/email key sits in `windows` indefinitely
   * (F11). Per-call check/record paths already prune timestamps in-place,
   * so the only thing this adds is dropping the empty-list keys.
   */
  sweep(now: number): number;
}

export function createVisitorAuthRateLimiter(caps: VisitorAuthRateLimit): VisitorAuthRateLimiter {
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
      const blocked: Array<Exclude<RateLimitDecision, { allowed: true }>> = [];
      if (caps.minIntervalSeconds !== undefined && list.length > 0) {
        const mostRecent = Math.max(...list);
        const retryAfterSec = Math.ceil((mostRecent + caps.minIntervalSeconds * 1000 - now) / 1000);
        if (retryAfterSec > 0) {
          blocked.push({ allowed: false, reason: "cooldown", retryAfterSec });
        }
      }
      const inHour = list.filter((t) => t > now - HOUR_MS).length;
      if (inHour >= caps.perHour) {
        const oldestInHour = list
          .filter((t) => t > now - HOUR_MS)
          .reduce((a, b) => Math.min(a, b), now);
        const retryAfterSec = Math.ceil((oldestInHour + HOUR_MS - now) / 1000);
        blocked.push({
          allowed: false,
          reason: "hourly",
          retryAfterSec: Math.max(1, retryAfterSec),
        });
      }
      if (list.length >= caps.perDay) {
        const oldestInDay = list.reduce((a, b) => Math.min(a, b), now);
        const retryAfterSec = Math.ceil((oldestInDay + DAY_MS - now) / 1000);
        blocked.push({
          allowed: false,
          reason: "daily",
          retryAfterSec: Math.max(1, retryAfterSec),
        });
      }
      if (blocked.length > 0) {
        return blocked.reduce((longest, decision) =>
          decision.retryAfterSec > longest.retryAfterSec ? decision : longest,
        );
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
    sweep(now: number): number {
      const cutoff = now - DAY_MS;
      let evicted = 0;
      for (const [key, list] of windows) {
        const live = list.filter((t) => t > cutoff);
        if (live.length === 0) {
          windows.delete(key);
          evicted++;
        } else if (live.length !== list.length) {
          windows.set(key, live);
        }
      }
      return evicted;
    },
  };
}
