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

import type { Statement } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type SqliteSchemaObject,
} from "../../../lib/sqlite";
import type {
  ConsumeTokenResult,
  IssueTokenArgs,
  OpenTokenForPeer,
  TokenStatus,
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
  // Permanent denylist of revoked visitor_ids. Survives unrevokeAndRotate which
  // rewrites the row's visitor_id — the old id disappears from verified_visitors
  // but must still be rejected at webTransport ingress.
  `CREATE TABLE IF NOT EXISTS revoked_visitor_ids (
    visitor_id     TEXT PRIMARY KEY,
    email          TEXT NOT NULL,
    revoked_at     INTEGER NOT NULL,
    revoked_reason TEXT
  )`,
];

export const VISITOR_AUTH_APPLICATION_ID = 0x56415554; // "VAUT"
export const VISITOR_AUTH_SCHEMA_VERSION = 1;
const EXPECTED_SCHEMA = new Map(
  SCHEMA_STATEMENTS.map((sql) => {
    const match = sql.match(/(?:TABLE|INDEX)\s+IF\s+NOT\s+EXISTS\s+([^\s(]+)/i);
    if (!match?.[1]) throw new Error("visitorAuth store: invalid schema declaration");
    return [match[1], canonicalSqliteSchemaSql(sql)] as const;
  }),
);

function hasExactVisitorAuthSchema(objects: readonly SqliteSchemaObject[]): boolean {
  return (
    objects.length === EXPECTED_SCHEMA.size &&
    objects.every(
      (object) => EXPECTED_SCHEMA.get(object.name) === canonicalSqliteSchemaSql(object.sql),
    )
  );
}

function validateVisitorAuthSchema(objects: readonly SqliteSchemaObject[]): void {
  if (!hasExactVisitorAuthSchema(objects)) {
    throw new Error(
      "visitorAuth store: database schema contains missing, incompatible, or unexpected objects",
    );
  }
}

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
  const database = openHardenedSqlite({
    path: config.dbPath,
    label: "visitorAuth store",
    prepare(db) {
      admitOwnedSqliteSchema(db, {
        label: "visitorAuth store",
        applicationId: VISITOR_AUTH_APPLICATION_ID,
        schemaVersion: VISITOR_AUTH_SCHEMA_VERSION,
        initialize(db) {
          for (const statement of SCHEMA_STATEMENTS) db.run(statement);
        },
        isLegacy(_db, objects) {
          return hasExactVisitorAuthSchema(objects);
        },
        validate(_db, objects) {
          validateVisitorAuthSchema(objects);
        },
      });
    },
  });
  const db = database.db;

  // Statements prepared lazily after initialize() runs.
  let issueStmt: Statement | null = null;
  let consumeStmt: Statement | null = null;
  let tokenStatusStmt: Statement | null = null;
  let findOpenStmt: Statement | null = null;
  let invalidateStmt: Statement | null = null;
  let invalidateOneStmt: Statement | null = null;
  let invalidateEmailStmt: Statement | null = null;
  let recordVerifiedStmt: Statement | null = null;
  let findVerifiedStmt: Statement | null = null;
  let touchVerifiedStmt: Statement | null = null;
  let listVerifiedStmt: Statement | null = null;
  let revokeStmt: Statement | null = null;
  let revokeCurrentStmt: Statement | null = null;
  let revokeReadStmt: Statement | null = null;
  let revokeCurrentReadStmt: Statement | null = null;
  let unrevokeAndRotateStmt: Statement | null = null;
  let findMostRecentStmt: Statement | null = null;
  let hasNotifiedStmt: Statement | null = null;
  let markNotifiedStmt: Statement | null = null;
  let findByIdStmt: Statement | null = null;
  let canPromoteThreadStmt: Statement | null = null;
  let addRevokedStmt: Statement | null = null;
  let advanceRevokedStmt: Statement | null = null;
  let isRevokedIdStmt: Statement | null = null;
  let listRevokedByEmailStmt: Statement | null = null;

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
       WHERE token = ? AND consumed = 0 AND expires_at > ?
       RETURNING email, peer_id, thread_id, issued_at`,
    );
    tokenStatusStmt = db.prepare(
      `SELECT consumed, expires_at FROM visitor_auth_tokens WHERE token = ?`,
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
    // Token-scoped variant — failure-path cleanup that must NOT touch a
    // sibling concurrent request's token (F3).
    invalidateOneStmt = db.prepare(
      `UPDATE visitor_auth_tokens
         SET consumed = 1, consumed_at = ?
       WHERE token = ? AND consumed = 0`,
    );
    invalidateEmailStmt = db.prepare(
      `UPDATE visitor_auth_tokens
         SET consumed = 1, consumed_at = ?
       WHERE email = ? AND consumed = 0`,
    );
    recordVerifiedStmt = db.prepare(
      `INSERT INTO verified_visitors
        (visitor_id, email, verified_at, last_seen_at, reverify_due_at, revoked, revoked_at, revoked_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    findVerifiedStmt = db.prepare(`SELECT * FROM verified_visitors WHERE email = ?`);
    touchVerifiedStmt = db.prepare(
      `UPDATE verified_visitors SET last_seen_at = ? WHERE email = ? AND revoked = 0`,
    );
    listVerifiedStmt = db.prepare(`SELECT * FROM verified_visitors ORDER BY verified_at DESC`);
    revokeStmt = db.prepare(
      `UPDATE verified_visitors
         SET revoked = 1, revoked_at = ?, revoked_reason = ?
       WHERE email = ? AND revoked = 0`,
    );
    revokeCurrentStmt = db.prepare(
      `UPDATE verified_visitors
         SET revoked = 1,
             revoked_reason = CASE
               WHEN revoked_at IS NULL OR ? >= revoked_at THEN ? ELSE revoked_reason END,
             revoked_at = CASE
               WHEN revoked_at IS NULL OR ? > revoked_at THEN ? ELSE revoked_at END
       WHERE email = ?`,
    );
    // Filter `revoked = 0` so a second revoke call returns null instead of
    // re-asserting success on an already-revoked row (callers test
    // `revokeByEmail(...) !== null` as the "did this revoke happen?" signal).
    revokeReadStmt = db.prepare(
      `SELECT visitor_id FROM verified_visitors WHERE email = ? AND revoked = 0`,
    );
    revokeCurrentReadStmt = db.prepare(
      `SELECT visitor_id, revoked FROM verified_visitors WHERE email = ?`,
    );
    // Un-revoke + rotate: single UPDATE that only matches revoked rows.
    // Returning false (changes === 0) when the row is not revoked prevents
    // accidental identity rotation on a live account.
    unrevokeAndRotateStmt = db.prepare(
      `UPDATE verified_visitors
         SET visitor_id = ?, verified_at = ?, last_seen_at = ?, reverify_due_at = ?,
             revoked = 0, revoked_at = NULL, revoked_reason = NULL
       WHERE email = ? AND revoked = 1`,
    );
    findMostRecentStmt = db.prepare(
      `SELECT email, expires_at, issued_at, consumed FROM visitor_auth_tokens
        WHERE peer_id = ? ORDER BY issued_at DESC LIMIT 1`,
    );
    hasNotifiedStmt = db.prepare(`SELECT email FROM first_verify_notifications WHERE email = ?`);
    markNotifiedStmt = db.prepare(
      `INSERT OR IGNORE INTO first_verify_notifications (email, notified_at) VALUES (?, ?)`,
    );
    findByIdStmt = db.prepare(`SELECT * FROM verified_visitors WHERE visitor_id = ?`);
    canPromoteThreadStmt = db.prepare(
      `SELECT 1
         FROM visitor_auth_tokens AS token
         JOIN verified_visitors AS visitor ON visitor.email = token.email
        WHERE visitor.visitor_id = ?
          AND visitor.revoked = 0
          AND token.thread_id = ?
          AND token.peer_id = ('anon-' || ?)
          AND token.consumed = 1
          AND token.consumed_at IS NOT NULL
          AND token.consumed_at >= visitor.verified_at
          AND NOT EXISTS (
            SELECT 1 FROM revoked_visitor_ids AS revoked
             WHERE revoked.visitor_id = visitor.visitor_id
          )
        LIMIT 1`,
    );
    addRevokedStmt = db.prepare(
      `INSERT OR IGNORE INTO revoked_visitor_ids (visitor_id, email, revoked_at, revoked_reason) VALUES (?, ?, ?, ?)`,
    );
    advanceRevokedStmt = db.prepare(
      `INSERT INTO revoked_visitor_ids
        (visitor_id, email, revoked_at, revoked_reason) VALUES (?, ?, ?, ?)
       ON CONFLICT(visitor_id) DO UPDATE SET
         revoked_reason = CASE
           WHEN excluded.revoked_at >= revoked_visitor_ids.revoked_at
           THEN excluded.revoked_reason ELSE revoked_visitor_ids.revoked_reason END,
         revoked_at = MAX(revoked_visitor_ids.revoked_at, excluded.revoked_at)
       WHERE revoked_visitor_ids.email = excluded.email`,
    );
    isRevokedIdStmt = db.prepare(`SELECT 1 FROM revoked_visitor_ids WHERE visitor_id = ?`);
    listRevokedByEmailStmt = db.prepare(
      `SELECT visitor_id FROM revoked_visitor_ids WHERE email = ? ORDER BY revoked_at, visitor_id`,
    );
  }

  return {
    initialize(): void {
      ensurePrepared();
    },
    issueToken(args: IssueTokenArgs): void {
      ensurePrepared();
      issueStmt!.run(
        args.token,
        args.email,
        args.peerId,
        args.threadId,
        args.issuedAt ?? Date.now(),
        args.expiresAt,
        args.sourceMessageId,
      );
    },
    consumeToken(token: string, now: number): ConsumeTokenResult {
      ensurePrepared();
      const row = consumeStmt!.get(now, token, now) as
        | { email: string; peer_id: string; thread_id: string; issued_at: number }
        | undefined;
      if (!row) return { consumed: false };
      return {
        consumed: true,
        email: row.email,
        peerId: row.peer_id,
        threadId: row.thread_id,
        issuedAt: row.issued_at,
      };
    },
    tokenStatus(token: string, now: number): TokenStatus {
      ensurePrepared();
      const row = tokenStatusStmt!.get(token) as
        | { consumed: number; expires_at: number }
        | undefined;
      if (!row) return "unknown";
      if (row.consumed === 1) return "consumed";
      if (row.expires_at <= now) return "expired";
      return "open";
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
    findMostRecentTokenForPeer(peerId: string, _now: number) {
      ensurePrepared();
      const row = findMostRecentStmt!.get(peerId) as
        | { email: string; expires_at: number; issued_at: number; consumed: number }
        | undefined;
      if (!row) return null;
      return {
        email: row.email,
        expiresAt: row.expires_at,
        issuedAt: row.issued_at,
        consumed: row.consumed === 1,
      };
    },
    invalidateOpenTokensForPeer(peerId: string, now: number): number {
      ensurePrepared();
      const result = invalidateStmt!.run(now, peerId);
      return result.changes;
    },
    invalidateTokenIfStillOpen(token: string, now: number): boolean {
      ensurePrepared();
      const result = invalidateOneStmt!.run(now, token);
      return result.changes > 0;
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
      let result: string | null = null;
      db.transaction(() => {
        const visRow = revokeReadStmt!.get(email) as { visitor_id: string } | undefined;
        if (!visRow) return;
        revokeStmt!.run(now, reason, email);
        invalidateEmailStmt!.run(now, email);
        // Permanently record the old visitor_id in the denylist so it stays
        // rejected even after unrevokeAndRotate rewrites the row's visitor_id.
        addRevokedStmt!.run(visRow.visitor_id, email, now, reason);
        result = visRow.visitor_id;
      })();
      return result;
    },
    revokeCurrentByEmail(
      email: string,
      reason: string,
      now: number,
    ): { visitorId: string; wasRevoked: boolean } | null {
      ensurePrepared();
      let result: { visitorId: string; wasRevoked: boolean } | null = null;
      db.transaction(() => {
        const row = revokeCurrentReadStmt!.get(email) as
          | { visitor_id: string; revoked: number }
          | undefined;
        if (!row) return;
        revokeCurrentStmt!.run(now, reason, now, now, email);
        invalidateEmailStmt!.run(now, email);
        const denylist = advanceRevokedStmt!.run(row.visitor_id, email, now, reason);
        if (denylist.changes !== 1) {
          throw new Error("visitorAuth store: revoked visitor id belongs to another email");
        }
        result = { visitorId: row.visitor_id, wasRevoked: row.revoked !== 0 };
      }).immediate();
      return result;
    },
    findVisitorById(visitorId: string): VerifiedVisitorRow | null {
      ensurePrepared();
      const row = findByIdStmt!.get(visitorId) as VerifiedRow | undefined;
      return row ? rowToVerified(row) : null;
    },
    canPromoteAnonymousThread(visitorId: string, threadId: string): boolean {
      ensurePrepared();
      return canPromoteThreadStmt!.get(visitorId, threadId, threadId) !== null;
    },
    unrevokeAndRotate(
      email: string,
      newVisitorId: string,
      verifiedAt: number,
      reverifyDueAt: number,
      tokenIssuedAt: number,
    ): string | null {
      ensurePrepared();
      let canonicalVisitorId: string | null = null;
      db.transaction(() => {
        // The immediate transaction makes the read/rotate decision one
        // serialized operation across processes. A stale concurrent caller
        // observes the winner's now-active row and adopts that identity.
        // If the row exists and is revoked, its old id must go into the denylist
        // so that stale tokens carrying the old id remain rejected after rotation.
        const oldRow = db
          .prepare(
            `SELECT visitor_id, email, revoked, revoked_at FROM verified_visitors WHERE email = ?`,
          )
          .get(email) as
          | { visitor_id: string; email: string; revoked: number; revoked_at: number | null }
          | undefined;
        if (!oldRow) return;
        const latestRevocation = db
          .query<{ revoked_at: number | null }, [string]>(
            "SELECT MAX(revoked_at) AS revoked_at FROM revoked_visitor_ids WHERE email = ?",
          )
          .get(email);
        if (
          latestRevocation?.revoked_at !== null &&
          latestRevocation?.revoked_at !== undefined &&
          tokenIssuedAt <= latestRevocation.revoked_at
        ) {
          return;
        }
        if (oldRow.revoked === 0) {
          canonicalVisitorId = oldRow.visitor_id;
          return;
        }
        if (oldRow.revoked_at === null || tokenIssuedAt <= oldRow.revoked_at) return;

        const result = unrevokeAndRotateStmt!.run(
          newVisitorId,
          verifiedAt,
          verifiedAt, // last_seen_at = verifiedAt
          reverifyDueAt,
          email,
        );

        if (result.changes === 1) {
          // The old visitor_id is now gone from verified_visitors; persist it in
          // the denylist so isVisitorIdRevoked() catches it forever.
          addRevokedStmt!.run(oldRow.visitor_id, oldRow.email, verifiedAt, "rotated-on-reverify");
          canonicalVisitorId = newVisitorId;
        }
      }).immediate();
      return canonicalVisitorId;
    },
    addRevokedVisitorId(visitorId: string, email: string, reason: string, now: number): void {
      ensurePrepared();
      addRevokedStmt!.run(visitorId, email, now, reason);
    },
    isVisitorIdRevoked(visitorId: string): boolean {
      ensurePrepared();
      return isRevokedIdStmt!.get(visitorId) !== null;
    },
    listRevokedVisitorIdsByEmail(email: string): string[] {
      ensurePrepared();
      return (listRevokedByEmailStmt!.all(email) as Array<{ visitor_id: string }>).map(
        (row) => row.visitor_id,
      );
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
      database.close();
    },
  };
}
