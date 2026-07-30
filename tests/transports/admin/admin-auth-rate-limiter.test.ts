import { describe, expect, it } from "bun:test";
import { createConsoleAuthFailureLimiter } from "@/transports/admin/admin-auth-rate-limiter";

describe("Console authentication failure limiter", () => {
  it("bounds active callers, expires stale state, and caps failures per caller", () => {
    let now = 1_000;
    const limiter = createConsoleAuthFailureLimiter({
      maxFailures: 2,
      maxCallers: 2,
      windowMs: 1_000,
      now: () => now,
    });

    expect(limiter.recordFailure("192.0.2.1")).toEqual({ allowed: true });
    expect(limiter.recordFailure("192.0.2.2")).toEqual({ allowed: true });
    expect(limiter.check("192.0.2.1")).toEqual({ allowed: true });
    expect(limiter.recordFailure("192.0.2.3")).toEqual({
      allowed: false,
      retryAfterSec: 1,
    });

    now = 2_001;
    expect(limiter.recordFailure("192.0.2.3")).toEqual({ allowed: true });
    expect(limiter.recordFailure("192.0.2.3")).toEqual({ allowed: true });
    expect(limiter.recordFailure("192.0.2.3")).toEqual({
      allowed: false,
      retryAfterSec: 1,
    });
  });

  it("blocks a later correct credential check without adding another failure", () => {
    const limiter = createConsoleAuthFailureLimiter({ maxFailures: 1 });

    expect(limiter.recordFailure("192.0.2.1")).toEqual({ allowed: true });
    expect(limiter.check("192.0.2.1")).toMatchObject({ allowed: false });
    expect(limiter.recordFailure("192.0.2.1")).toMatchObject({ allowed: false });
  });

  it("rejects non-positive and fractional limits", () => {
    for (const options of [{ maxFailures: 0 }, { maxCallers: -1 }, { windowMs: 1.5 }]) {
      expect(() => createConsoleAuthFailureLimiter(options)).toThrow(/positive integer/);
    }
  });
});
