import { describe, test, expect } from "bun:test";
import { createVisitorAuthRateLimiter } from "../../../src/augments/visitorAuth/rate-limiter";

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

  test("allows a second send at the exact hourly boundary", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    expect(rl.check("anon-1", t + 60 * 60_000)).toEqual({ allowed: true });
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

  test("allows another send at the exact daily boundary", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 3, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    rl.record("anon-1", t + 1);
    rl.record("anon-1", t + 2);
    expect(rl.check("anon-1", t + 24 * 60 * 60_000)).toEqual({ allowed: true });
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

  test("enforces an exact minimum interval boundary", () => {
    const rl = createVisitorAuthRateLimiter({
      perHour: 360,
      perDay: 8_640,
      minIntervalSeconds: 10,
    });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);

    const immediate = rl.check("anon-1", t);
    expect(immediate).toEqual({
      allowed: false,
      reason: "cooldown",
      retryAfterSec: 10,
    });
    const atNineSeconds = rl.check("anon-1", t + 9_000);
    expect(atNineSeconds).toEqual({
      allowed: false,
      reason: "cooldown",
      retryAfterSec: 1,
    });
    expect(rl.check("anon-1", t + 10_000)).toEqual({ allowed: true });
  });

  test("allows an explicit zero cooldown", () => {
    const rl = createVisitorAuthRateLimiter({
      perHour: 2,
      perDay: 3,
      minIntervalSeconds: 0,
    });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    expect(rl.check("anon-1", t)).toEqual({ allowed: true });
  });

  test("reports the longest active retry window when policies overlap", () => {
    const rl = createVisitorAuthRateLimiter({
      perHour: 1,
      perDay: 3,
      minIntervalSeconds: 10,
    });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    expect(rl.check("anon-1", t)).toEqual({
      allowed: false,
      reason: "hourly",
      retryAfterSec: 3_600,
    });
  });

  test("forget(peerId) clears the window state", () => {
    const rl = createVisitorAuthRateLimiter({ perHour: 1, perDay: 3 });
    const t = 1_000_000_000_000;
    rl.record("anon-1", t);
    rl.forget("anon-1");
    expect(rl.check("anon-1", t + 1).allowed).toBe(true);
  });
});
