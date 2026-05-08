import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitor-auth/storage/sqlite-store";
import type { VisitorAuthStore } from "../../../src/augments/visitor-auth/storage/types";

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
        visitorId: "v1", email: "older@x", verifiedAt: t,
        lastSeenAt: null, reverifyDueAt: t + 86_400_000,
        revoked: false, revokedAt: null, revokedReason: null,
      });
      store.recordVerifiedVisitor({
        visitorId: "v2", email: "newer@x", verifiedAt: t + 1000,
        lastSeenAt: null, reverifyDueAt: t + 1000 + 86_400_000,
        revoked: false, revokedAt: null, revokedReason: null,
      });
      const rows = store.listVerifiedVisitors();
      expect(rows[0]?.email).toBe("newer@x");
      expect(rows[1]?.email).toBe("older@x");
    });

    test("revokeByEmail returns visitorId, marks row revoked", () => {
      const now = 1_700_000_000_000;
      store.recordVerifiedVisitor({
        visitorId: "vis_r",
        email: "revoke@x",
        verifiedAt: now,
        lastSeenAt: null,
        reverifyDueAt: now + 86_400_000,
        revoked: false, revokedAt: null, revokedReason: null,
      });
      const visId = store.revokeByEmail("revoke@x", "operator", now + 1000);
      expect(visId).toBe("vis_r");
      const row = store.findVerifiedByEmail("revoke@x");
      expect(row?.revoked).toBe(true);
      expect(row?.revokedReason).toBe("operator");
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
        revoked: false, revokedAt: null, revokedReason: null,
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
        token: "tk-open", email: "e@x", peerId: "p", threadId: "th",
        expiresAt: now + 60_000, sourceMessageId: null,
      });
      expect(store.tokenStatus("tk-open", now)).toBe("open");
    });
    test("returns 'consumed' after a successful consume", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tk-c", email: "e@x", peerId: "p", threadId: "th",
        expiresAt: now + 60_000, sourceMessageId: null,
      });
      store.consumeToken("tk-c", now);
      expect(store.tokenStatus("tk-c", now + 1)).toBe("consumed");
    });
    test("returns 'expired' for an unconsumed token past its TTL", () => {
      const now = 1_700_000_000_000;
      store.issueToken({
        token: "tk-e", email: "e@x", peerId: "p", threadId: "th",
        expiresAt: now + 1000, sourceMessageId: null,
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
        revoked: false, revokedAt: null, revokedReason: null,
      });
      store.initialize();
      expect(store.findVerifiedByEmail("e@x")?.visitorId).toBe("v");
    });
  });
});
