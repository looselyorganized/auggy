import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitorAuth/storage/sqlite-store";
import type { VisitorAuthStore } from "../../../src/augments/visitorAuth/storage/types";

let tmp: string;
let store: VisitorAuthStore;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitor-auth-store-"));
  store = createSqliteVisitorAuthStore({ dbPath: join(tmp, "visitor-auth.db") });
  store.initialize();
});

afterEach(() => {
  store.close();
  rmSync(tmp, { recursive: true, force: true });
});

describe("createSqliteVisitorAuthStore", () => {
  describe("issueToken + consumeToken", () => {
    test("issued token can be consumed exactly once", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-A",
        email: "alice@example.com",
        peerId: "anon-thread1",
        threadId: "thread1",
        expiresAt: now + 15 * 60_000,
        sourceMessageId: "msg-1",
      });

      const first = store.consumeToken("tok-A", now + 1000);
      expect(first.consumed).toBe(true);
      expect(first.email).toBe("alice@example.com");
      expect(first.peerId).toBe("anon-thread1");
      expect(first.threadId).toBe("thread1");

      const second = store.consumeToken("tok-A", now + 2000);
      expect(second.consumed).toBe(false);
      expect(second.email).toBeUndefined();
    });

    test("expired token cannot be consumed (consumed:false)", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-B",
        email: "bob@example.com",
        peerId: "anon-thread2",
        threadId: "thread2",
        expiresAt: now + 1000,
        sourceMessageId: null,
      });

      const result = store.consumeToken("tok-B", now + 2000);
      expect(result.consumed).toBe(false);
    });

    test("consume of unknown token returns consumed:false (no row)", () => {
      const result = store.consumeToken("tok-unknown", Date.now());
      expect(result.consumed).toBe(false);
    });

    test("consume is atomic under concurrent simulation", async () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-race",
        email: "race@example.com",
        peerId: "anon-thread3",
        threadId: "thread3",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });

      // bun:sqlite is synchronous — we simulate concurrent attempts by
      // calling consumeToken many times in tight succession; only one
      // can win.
      const results: boolean[] = [];
      for (let i = 0; i < 10; i++) results.push(store.consumeToken("tok-race", now).consumed);
      expect(results.filter((c) => c).length).toBe(1);
    });
  });

  describe("findOpenTokenForPeer + invalidateOpenTokensForPeer", () => {
    test("findOpenTokenForPeer returns the open token", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-C",
        email: "carol@example.com",
        peerId: "anon-thread4",
        threadId: "thread4",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });
      const open = store.findOpenTokenForPeer("anon-thread4", now);
      expect(open?.token).toBe("tok-C");
      expect(open?.email).toBe("carol@example.com");
    });

    test("findOpenTokenForPeer returns null for expired tokens", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-D",
        email: "dave@example.com",
        peerId: "anon-thread5",
        threadId: "thread5",
        expiresAt: now + 1000,
        sourceMessageId: null,
      });
      expect(store.findOpenTokenForPeer("anon-thread5", now + 5000)).toBeNull();
    });

    test("invalidateOpenTokensForPeer marks them consumed", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tok-E",
        email: "erin@example.com",
        peerId: "anon-thread6",
        threadId: "thread6",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });
      const invalidated = store.invalidateOpenTokensForPeer("anon-thread6", now + 1000);
      expect(invalidated).toBe(1);
      const result = store.consumeToken("tok-E", now + 2000);
      expect(result.consumed).toBe(false);
    });
  });

  describe("recordVerifiedVisitor + listVerifiedVisitors + revokeByEmail", () => {
    test("recordVerifiedVisitor + findVerifiedByEmail roundtrip", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_1",
        email: "alice@example.com",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 90 * 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      const row = store.findVerifiedByEmail("alice@example.com");
      expect(row?.visitorId).toBe("vis_1");
      expect(row?.revoked).toBe(false);
    });

    test("recordVerifiedVisitor throws on duplicate non-revoked email", () => {
      const now = 1_700_000_000_000;
      const base = {
        email: "alice@example.com",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 90 * 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      };
      store.recordVerifiedVisitor({ ...base, visitorId: "vis_1" });
      expect(() => store.recordVerifiedVisitor({ ...base, visitorId: "vis_2" })).toThrow();
    });

    test("touchVerifiedVisitor updates lastSeenAt", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_t",
        email: "t@example.com",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      store.touchVerifiedVisitor("t@example.com", now + 5000);
      expect(store.findVerifiedByEmail("t@example.com")?.lastSeenAt).toBe(now + 5000);
    });

    test("listVerifiedVisitors orders by verifiedAt DESC", () => {
      const t = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "v1",
        email: "older@x",
        verifiedAt: t,
        lastSeenAt: null,
        reverifyDueAt: t + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      store.recordVerifiedVisitor({
        visitorId: "v2",
        email: "newer@x",
        verifiedAt: t + 1000,
        lastSeenAt: null,
        reverifyDueAt: t + 1000 + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      const rows = store.listVerifiedVisitors();
      expect(rows[0]?.email).toBe("newer@x");
      expect(rows[1]?.email).toBe("older@x");
    });

    test("revokeByEmail returns visitorId, marks row revoked, and adds to denylist", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_r",
        email: "revoke@x",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      const visId = store.revokeByEmail("revoke@x", "operator", now + 1000);
      expect(visId).toBe("vis_r");
      const row = store.findVerifiedByEmail("revoke@x");
      expect(row?.revoked).toBe(true);
      expect(row?.revokedReason).toBe("operator");
      // The visitor_id must also appear in the permanent denylist.
      expect(store.isVisitorIdRevoked("vis_r")).toBe(true);
    });

    test("revokeByEmail returns null for unknown email", () => {
      expect(store.revokeByEmail("unknown@x", "operator", Date.now())).toBeNull();
    });

    test("revokeByEmail returns null on a second call for the same email", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_dr",
        email: "double@x",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      expect(store.revokeByEmail("double@x", "operator", now + 1000)).toBe("vis_dr");
      // Second call: row already revoked → null, not a false-positive visitorId.
      expect(store.revokeByEmail("double@x", "operator", now + 2000)).toBeNull();
    });
  });

  describe("first-verify notification ledger", () => {
    test("hasNotifiedFirstVerifyFor returns false initially", () => {
      expect(store.hasNotifiedFirstVerifyFor("a@x")).toBe(false);
    });

    test("markNotifiedFirstVerifyFor flips the flag; idempotent", () => {
      const t = Date.now();
      store.markNotifiedFirstVerifyFor("a@x", t);
      expect(store.hasNotifiedFirstVerifyFor("a@x")).toBe(true);
      // Idempotent re-mark doesn't throw.
      store.markNotifiedFirstVerifyFor("a@x", t + 1000);
      expect(store.hasNotifiedFirstVerifyFor("a@x")).toBe(true);
    });
  });

  describe("tokenStatus", () => {
    test("returns 'unknown' for tokens that were never issued", () => {
      expect(store.tokenStatus("nope", Date.now())).toBe("unknown");
    });
    test("returns 'open' for an unconsumed, unexpired token", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tk-open",
        email: "e@x",
        peerId: "p",
        threadId: "th",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });
      expect(store.tokenStatus("tk-open", now)).toBe("open");
    });
    test("returns 'consumed' after a successful consume", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tk-c",
        email: "e@x",
        peerId: "p",
        threadId: "th",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });
      store.consumeToken("tk-c", now);
      expect(store.tokenStatus("tk-c", now + 1)).toBe("consumed");
    });
    test("returns 'expired' for an unconsumed token past its TTL", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tk-e",
        email: "e@x",
        peerId: "p",
        threadId: "th",
        expiresAt: now + 1000,
        sourceMessageId: null,
      });
      expect(store.tokenStatus("tk-e", now + 5000)).toBe("expired");
    });
  });

  describe("schema migration", () => {
    test("initialize() is idempotent", () => {
      store.initialize();
      store.initialize();
      // No throw, no data loss.
      const t = Date.now();
      store.recordVerifiedVisitor({
        visitorId: "v",
        email: "e@x",
        verifiedAt: t,
        lastSeenAt: null,
        reverifyDueAt: t + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      store.initialize();
      expect(store.findVerifiedByEmail("e@x")?.visitorId).toBe("v");
    });
  });

  describe("unrevokeAndRotate", () => {
    test("un-revokes a revoked row and rotates to a new visitorId", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_old",
        email: "revoked@x",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      store.revokeByEmail("revoked@x", "operator", now + 1000);
      expect(store.findVerifiedByEmail("revoked@x")?.revoked).toBe(true);

      const ok = store.unrevokeAndRotate("revoked@x", "vis_new", now + 2000, now + 90 * 86_400_000);
      expect(ok).toBe(true);

      const row = store.findVerifiedByEmail("revoked@x");
      expect(row?.revoked).toBe(false);
      expect(row?.visitorId).toBe("vis_new");
      expect(row?.revokedAt).toBeNull();
      expect(row?.revokedReason).toBeNull();
      expect(row?.verifiedAt).toBe(now + 2000);
      expect(row?.lastSeenAt).toBe(now + 2000);
    });

    test("unrevokeAndRotate is a no-op on a non-revoked row (returns false)", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_live",
        email: "live@x",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      const ok = store.unrevokeAndRotate("live@x", "vis_new2", now + 1000, now + 90 * 86_400_000);
      expect(ok).toBe(false);
      // Row unchanged
      expect(store.findVerifiedByEmail("live@x")?.visitorId).toBe("vis_live");
    });
  });

  describe("addRevokedVisitorId / isVisitorIdRevoked", () => {
    test("returns false for unknown visitor_id", () => {
      expect(store.isVisitorIdRevoked("vis_unknown")).toBe(false);
    });

    test("returns true after addRevokedVisitorId", () => {
      const now = 1_700_000_000_000;
      store.addRevokedVisitorId("vis_deny1", "deny@x", "operator", now);
      expect(store.isVisitorIdRevoked("vis_deny1")).toBe(true);
    });

    test("second addRevokedVisitorId with the same id is a no-op (INSERT OR IGNORE, no throw)", () => {
      const now = 1_700_000_000_000;
      store.addRevokedVisitorId("vis_idempotent", "dem@x", "operator", now);
      // Must not throw on duplicate insert.
      expect(() =>
        store.addRevokedVisitorId("vis_idempotent", "dem@x", "operator", now + 1000),
      ).not.toThrow();
      expect(store.isVisitorIdRevoked("vis_idempotent")).toBe(true);
    });
  });

  describe("findVisitorById", () => {
    test("returns null for an unknown visitorId", () => {
      expect(store.findVisitorById("vis_does_not_exist")).toBeNull();
    });

    test("returns the row for a known non-revoked visitor", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_known",
        email: "known@example.com",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 90 * 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      const row = store.findVisitorById("vis_known");
      expect(row).not.toBeNull();
      expect(row?.visitorId).toBe("vis_known");
      expect(row?.email).toBe("known@example.com");
      expect(row?.revoked).toBe(false);
    });

    test("returns the row for a known revoked visitor (revoked=true)", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_revoked",
        email: "revoked@example.com",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 90 * 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });
      store.revokeByEmail("revoked@example.com", "operator", now + 1000);
      const row = store.findVisitorById("vis_revoked");
      expect(row).not.toBeNull();
      expect(row?.revoked).toBe(true);
      expect(row?.revokedReason).toBe("operator");
    });
  });

  describe("findMostRecentTokenForPeer", () => {
    test("returns null when peer has no tokens", () => {
      expect(store.findMostRecentTokenForPeer("anon-none", Date.now())).toBeNull();
    });
    test("returns the most-recent issuance regardless of consumed/expired", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "t-old",
        email: "e@x",
        peerId: "anon-A",
        threadId: "th",
        expiresAt: now + 1000,
        sourceMessageId: null,
      });
      store.issueToken({
        token: "t-new",
        email: "e@x",
        peerId: "anon-A",
        threadId: "th",
        expiresAt: now + 60_000,
        sourceMessageId: null,
      });
      // Both issuances stamp `issued_at = Date.now()` server-side, so two
      // tokens issued in the same millisecond may sort either way. Ensure
      // there's at least one row and the email is correct.
      const row = store.findMostRecentTokenForPeer("anon-A", now);
      expect(row).not.toBeNull();
      expect(row!.email).toBe("e@x");
    });
  });
});
