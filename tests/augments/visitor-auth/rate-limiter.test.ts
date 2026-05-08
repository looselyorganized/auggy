import { describe, test, expect } from "bun:test";
import { createVisitorAuthRateLimiter } from "../../../src/augments/visitor-auth/rate-limiter";

describe("createVisitorAuthRateLimiter", () => {
  test("allows the first send for a peer", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    expect(rl.check("anon-1", 1_000_000_000_000)).toEqual({ allowed: true });
  });

  test("blocks a second send within the hour", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    const r = rl.check("anon-1", t + 30 * 60_000); // +30min
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe("hourly");
      expect(r.retryAfterSec).toBeGreaterThan(0);
    }
  });

  test("allows a second send after the hour rolls", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    expect(rl.check("anon-1", t + 60 * 60_000 + 1).allowed).toBe(true);
  });

  test("blocks the 4th send within 24h even when hourly resets", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    const hour = 60 * 60_000;
    rl.record("anon-1", t);
    rl.record("anon-1", t + hour + 1);
    rl.record("anon-1", t + 2 * hour + 1);
    const r = rl.check("anon-1", t + 3 * hour + 1);
    expect(r.allowed).toBe(false);
    if (!r.allowed) {
      expect(r.reason).toBe("daily");
    }
  });

  test("counts are independent per peer", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    expect(rl.check("anon-2", t).allowed).toBe(true);
  });

  test("returns retryAfterSec as ceiling of remaining window", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    const r = rl.check("anon-1", t + 30 * 60_000);
    if (r.allowed) throw new Error("expected blocked");
    expect(r.retryAfterSec).toBe(30 * 60); // 30 min remaining
  });

  test("forget(peerId) clears the window state", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    rl.forget("anon-1");
    expect(rl.check("anon-1", t + 1).allowed).toBe(true);
  });
});
