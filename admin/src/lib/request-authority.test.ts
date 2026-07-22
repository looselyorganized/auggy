import { describe, expect, it } from "bun:test";

import { createRequestAuthority } from "./request-authority";

describe("request authority", () => {
  it("makes the latest request authoritative within one scope", () => {
    const authority = createRequestAuthority();
    const first = authority.begin("thread:one");
    const second = authority.begin("thread:one");

    expect(authority.isCurrent(first)).toBe(false);
    expect(authority.isCurrent(second)).toBe(true);
  });

  it("keeps requests in independent scopes authoritative", () => {
    const authority = createRequestAuthority();
    const detail = authority.begin("thread:one:detail");
    const rename = authority.begin("thread:one:rename");

    expect(authority.isCurrent(detail)).toBe(true);
    expect(authority.isCurrent(rename)).toBe(true);
  });

  it("never accepts a lease issued by another authority", () => {
    const firstAuthority = createRequestAuthority();
    const secondAuthority = createRequestAuthority();
    const firstLease = firstAuthority.begin("thread:one");
    const secondLease = secondAuthority.begin("thread:one");

    expect(secondAuthority.isCurrent(firstLease)).toBe(false);
    expect(secondAuthority.finish(firstLease)).toBe(false);
    expect(secondAuthority.isCurrent(secondLease)).toBe(true);
    expect(firstAuthority.isCurrent(firstLease)).toBe(true);
  });

  it("does not let a stale request finish clear the current request", () => {
    const authority = createRequestAuthority();
    const stale = authority.begin("thread:one");
    const current = authority.begin("thread:one");

    expect(authority.finish(stale)).toBe(false);
    expect(authority.isCurrent(current)).toBe(true);
  });

  it("retires the current request exactly once when it finishes", () => {
    const authority = createRequestAuthority();
    const lease = authority.begin("thread:one");

    expect(authority.finish(lease)).toBe(true);
    expect(authority.isCurrent(lease)).toBe(false);
    expect(authority.finish(lease)).toBe(false);
  });

  it("invalidates only the requested scope", () => {
    const authority = createRequestAuthority();
    const invalidated = authority.begin("thread:one");
    const independent = authority.begin("thread:two");

    expect(authority.invalidate("thread:one")).toBe(true);
    expect(authority.isCurrent(invalidated)).toBe(false);
    expect(authority.isCurrent(independent)).toBe(true);
    expect(authority.invalidate("thread:missing")).toBe(false);
  });

  it("invalidates every active scope", () => {
    const authority = createRequestAuthority();
    const first = authority.begin("thread:one");
    const second = authority.begin("thread:two");

    authority.invalidateAll();

    expect(authority.isCurrent(first)).toBe(false);
    expect(authority.isCurrent(second)).toBe(false);
    expect(authority.finish(first)).toBe(false);
    expect(authority.finish(second)).toBe(false);
  });

  it("keeps a replacement lease current when stale effect cleanup finishes after invalidation", () => {
    const authority = createRequestAuthority();
    const leaseA = authority.begin("thread:one");
    const disposeEffectA = () => authority.finish(leaseA);

    authority.invalidateAll();
    const leaseB = authority.begin("thread:one");

    expect(disposeEffectA()).toBe(false);
    expect(authority.isCurrent(leaseB)).toBe(true);
    expect(authority.finish(leaseB)).toBe(true);
    expect(authority.isCurrent(leaseB)).toBe(false);
  });

  it("keeps repeated invalidation idempotent and permits fresh authority", () => {
    const authority = createRequestAuthority();
    const retired = authority.begin("thread:one");

    expect(authority.invalidate("thread:one")).toBe(true);
    expect(authority.invalidate("thread:one")).toBe(false);
    authority.invalidateAll();
    authority.invalidateAll();
    expect(authority.isCurrent(retired)).toBe(false);

    const fresh = authority.begin("thread:one");
    expect(authority.isCurrent(fresh)).toBe(true);
    expect(authority.finish(fresh)).toBe(true);
  });

  it("treats structurally similar and object-like scope strings as exact keys", () => {
    const authority = createRequestAuthority();
    const scopes = [
      "thread:1",
      "thread:10",
      "thread:1:detail",
      "thread:1/detail",
      "thread\0:1",
      "__proto__",
      "constructor",
    ];
    const leases = scopes.map((scope) => authority.begin(scope));

    expect(leases.every((lease) => authority.isCurrent(lease))).toBe(true);
    expect(authority.invalidate("thread:1")).toBe(true);

    expect(authority.isCurrent(leases[0]!)).toBe(false);
    for (const lease of leases.slice(1)) {
      expect(authority.isCurrent(lease)).toBe(true);
    }
  });
});
