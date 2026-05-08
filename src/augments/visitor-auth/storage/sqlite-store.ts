/**
 * SQLite-backed VisitorAuthStore.
 *
 * Tables:
 *   - visitor_auth_tokens — one-time tokens for the magic-link flow.
 *     Atomic consume: single UPDATE, decision in `changes()`.
 *   - verified_visitors — durable email-bound identities. Operator
 *     revocation cascades from `auggy visitors --revoke`.
 *   - first_verify_notifications — ledger for the optional
 *     "notify operator on first verify" feature. Separate table so
 *     adding/removing the optional config doesn't migrate primary tables.
 *
 * WAL mode is on (matches budgets/layered-memory pattern). Indexes on
 * peer_id and expires_at speed up the open-token lookup path.
 */

import { Database, type Statement } from "bun:sqlite";
import type {
  ConsumeTokenResult,
  IssueTokenArgs,
  OpenTokenForPeer,
  VerifiedVisitorRow,
  VisitorAuthStore,
} from "./types";

const SCHEMA_STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS visitor_auth_tokens (
    token             TEXT PRIMARY KEY,
    email             TEXT NOT NULL,
    peer_id           TEXT NOT NULL,
    thread_id         TEXT NOT NULL,
    issued_at         INTEGER NOT NULL,
    expires_at        INTEGER NOT NULL,
    consumed          INTEGER NOT NULL DEFAULT 0,
    consumed_at       INTEGER,
    source_message_id TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visitor_auth_tokens_peer ON visitor_auth_tokens(peer_id)`,
  `CREATE INDEX IF NOT EXISTS idx_visitor_auth_tokens_expires ON visitor_auth_tokens(expires_at)`,
  `CREATE TABLE IF NOT EXISTS verified_visitors (
    visitor_id        TEXT PRIMARY KEY,
    email             TEXT NOT NULL UNIQUE,
    verified_at       INTEGER NOT NULL,
    last_seen_at      INTEGER,
    reverify_due_at   INTEGER NOT NULL,
    revoked           INTEGER NOT NULL DEFAULT 0,
    revoked_at        INTEGER,
    revoked_reason    TEXT
  )`,
  `CREATE INDEX IF NOT EXISTS idx_verified_visitors_email ON verified_visitors(email)`,
  `CREATE TABLE IF NOT EXISTS first_verify_notifications (
    email            TEXT PRIMARY KEY,
    notified_at      INTEGER NOT NULL
  )`,
];

interface VerifiedRow {
  visitor_id: string;
  email: string;
  verified_at: number;
  last_seen_at: number | null;
  reverify_due_at: number;
  revoked: number;
  revoked_at: number | null;
  revoked_reason: string | null;
}

function rowToVerified(row: VerifiedRow): VerifiedVisitorRow {
  return {
    visitorId: row.visitor_id,
    email: row.email,
    verifiedAt: row.verified_at,
    lastSeenAt: row.last_seen_at,
    reverifyDueAt: row.reverify_due_at,
    revoked: row.revoked === 1,
    revokedAt: row.revoked_at,
    revokedReason: row.revoked_reason,
  };
}

export interface SqliteVisitorAuthStoreConfig {
  dbPath: string;
}

export function createSqliteVisitorAuthStore(
  config: SqliteVisitorAuthStoreConfig,
): VisitorAuthStore {
  const db = new Database(config.dbPath, { create: true });
  db.run("PRAGMA journal_mode = WAL");
  db.run("PRAGMA foreign_keys = ON");

  // Statements prepared lazily after initialize() runs.
  let issueStmt: Statement | null = null;
  let consumeStmt: Statement | null = null;
  let consumeReadStmt: Statement | null = null;
  let findOpenStmt: Statement | null = null;
  let invalidateStmt: Statement | null = null;
  let recordVerifiedStmt: Statement | null = null;
  let findVerifiedStmt: Statement | null = null;
  let touchVerifiedStmt: Statement | null = null;
  let listVerifiedStmt: Statement | null = null;
  let revokeStmt: Statement | null = null;
  let revokeReadStmt: Statement | null = null;
  let hasNotifiedStmt: Statement | null = null;
  let markNotifiedStmt: Statement | null = null;

  function ensurePrepared(): void {
    if (issueStmt) return;
    issueStmt = db.prepare(
      `INSERT INTO visitor_auth_tokens
        (token, email, peer_id, thread_id, issued_at, expires_at, consumed, source_message_id)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
    );
    // Atomic consume — single UPDATE, decision in changes().
    // Strict `expires_at > ?` (not `>=`) is the security-conservative choice:
    // a token whose expiry equals `now` is treated as expired, never as valid.
    // findOpenStmt below uses the same boundary for consistency.
    consumeStmt = db.prepare(
      `UPDATE visitor_auth_tokens
         SET consumed = 1, consumed_at = ?
       WHERE token = ? AND consumed = 0 AND expires_at > ?`,
    );
    consumeReadStmt = db.prepare(
      `SELECT email, peer_id, thread_id FROM visitor_auth_tokens WHERE token = ?`,
    );
    findOpenStmt = db.prepare(
      `SELECT token, email, expires_at, issued_at FROM visitor_auth_tokens
        WHERE peer_id = ? AND consumed = 0 AND expires_at > ?
        ORDER BY issued_at DESC LIMIT 1`,
    );
    // Marks all unconsumed tokens for the peer as consumed, including expired
    // ones. Sweeping expired-and-open is intentional cleanup — they're already
    // unredeemable; tidying them keeps the table consistent.
    invalidateStmt = db.prepare(
      `UPDATE visitor_auth_tokens
         SET consumed = 1, consumed_at = ?
       WHERE peer_id = ? AND consumed = 0`,
    );
    recordVerifiedStmt = db.prepare(
      `INSERT INTO verified_visitors
        (visitor_id, email, verified_at, last_seen_at, reverify_due_at, revoked, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    findVerifiedStmt = db.prepare(
      `SELECT * FROM verified_visitors WHERE email = ?`,
    );
    touchVerifiedStmt = db.prepare(
      `UPDATE verified_visitors SET last_seen_at = ? WHERE email = ? AND revoked = 0`,
    );
    listVerifiedStmt = db.prepare(`SELECT * FROM verified_visitors ORDER BY verified_at DESC`);
    revokeStmt = db.prepare(
      `UPDATE verified_visitors
         SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE email = ? AND revoked = 0`,
    );
    // Filter `revoked = 0` so a second revoke call returns null instead of
    // re-asserting success on an already-revoked row (callers test
    // `revokeByEmail(...) !== null` as the "did this revoke happen?" signal).
    revokeReadStmt = db.prepare(
      `SELECT visitor_id FROM verified_visitors WHERE email = ? AND revoked = 0`,
    );
    hasNotifiedStmt = db.prepare(
      `SELECT email FROM first_verify_notifications WHERE email = ?`,
    );
    markNotifiedStmt = db.prepare(
      `INSERT OR IGNORE INTO first_verify_notifications (email, notified_at) VALUES (?, ?)`,
    );
  }

  return {
    initialize(): void {
      for (const stmt of SCHEMA_STATEMENTS) db.run(stmt);
      ensurePrepared();
    },
    issueToken(args: IssueTokenArgs): void {
      ensurePrepared();
      issueStmt!.run(
        args.token,
        args.email,
        args.peerId,
        args.threadId,
        Date.now(),
        args.expiresAt,
        args.sourceMessageId,
      );
    },
    consumeToken(token: string, now: number): ConsumeTokenResult {
      ensurePrepared();
      const result = consumeStmt!.run(now, token, now);
      if (result.changes === 0) return { consumed: false };
      // changes === 1 proves the row exists and we just transitioned it.
      // The follow-up SELECT reads the row's bound email/peer_id/thread_id
      // for the caller; the `if (!row)` guard below is defensive against
      // an impossible-in-practice race (separate connection deleting the
      // row between UPDATE and SELECT) — Bun's single-connection sync
      // model rules it out, but the cost of the guard is one branch.
      const row = consumeReadStmt!.get(token) as
        | { email: string; peer_id: string; thread_id: string }
        | undefined;
      if (!row) return { consumed: false };
      return {
        consumed: true,
        email: row.email,
        peerId: row.peer_id,
        threadId: row.thread_id,
      };
    },
    findOpenTokenForPeer(peerId: string, now: number): OpenTokenForPeer | null {
      ensurePrepared();
      const row = findOpenStmt!.get(peerId, now) as
        | { token: string; email: string; expires_at: number; issued_at: number }
        | undefined;
      if (!row) return null;
      return {
        token: row.token,
        email: row.email,
        expiresAt: row.expires_at,
        issuedAt: row.issued_at,
      };
    },
    invalidateOpenTokensForPeer(peerId: string, now: number): number {
      ensurePrepared();
      const result = invalidateStmt!.run(now, peerId);
      return result.changes;
    },
    recordVerifiedVisitor(row: VerifiedVisitorRow): void {
      ensurePrepared();
      recordVerifiedStmt!.run(
        row.visitorId,
        row.email,
        row.verifiedAt,
        row.lastSeenAt,
        row.reverifyDueAt,
        row.revoked ? 1 : 0,
        row.revokedAt,
        row.revokedReason,
      );
    },
    findVerifiedByEmail(email: string): VerifiedVisitorRow | null {
      ensurePrepared();
      const row = findVerifiedStmt!.get(email) as VerifiedRow | undefined;
      return row ? rowToVerified(row) : null;
    },
    touchVerifiedVisitor(email: string, now: number): void {
      ensurePrepared();
      touchVerifiedStmt!.run(now, email);
    },
    listVerifiedVisitors(): VerifiedVisitorRow[] {
      ensurePrepared();
      const rows = listVerifiedStmt!.all() as VerifiedRow[];
      return rows.map(rowToVerified);
    },
    revokeByEmail(email: string, reason: string, now: number): string | null {
      ensurePrepared();
      const visRow = revokeReadStmt!.get(email) as { visitor_id: string } | undefined;
      if (!visRow) return null;
      revokeStmt!.run(now, reason, email);
      return visRow.visitor_id;
    },
    hasNotifiedFirstVerifyFor(email: string): boolean {
      ensurePrepared();
      return hasNotifiedStmt!.get(email) !== null;
    },
    markNotifiedFirstVerifyFor(email: string, now: number): void {
      ensurePrepared();
      markNotifiedStmt!.run(email, now);
    },
    close(): void {
      db.close();
    },
  };
}
