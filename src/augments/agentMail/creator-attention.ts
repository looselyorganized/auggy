/**
 * Durable creator-attention metadata for admitted AgentMail messages.
 *
 * The store intentionally persists no model response or provider error text.
 * The inbound ledger supplies the admitted database and transaction boundary;
 * its transaction wrapper hardens SQLite artifacts after each successful
 * commit.
 */

import type { Database } from "bun:sqlite";

export const AGENTMAIL_ATTENTION_DEFAULT_MAX_RECORDS = 1_000;
export const AGENTMAIL_ATTENTION_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;

export type AgentMailCreatorAttentionState =
  | "open"
  | "pending_review"
  | "sent"
  | "rejected"
  | "failed"
  | "ambiguous"
  | "dismissed";

export interface AgentMailCreatorAttentionRecord {
  inboxId: string;
  messageId: string;
  state: AgentMailCreatorAttentionState;
  version: number;
  reviewId?: string;
  createdAt: number;
  updatedAt: number;
  terminalAt?: number;
}

export interface AgentMailCreatorAttentionCounts {
  open: number;
  pendingReview: number;
  sent: number;
  rejected: number;
  failed: number;
  ambiguous: number;
  dismissed: number;
}

export type AgentMailCreatorAttentionReserveStatus = "created" | "active_duplicate" | "reopened";

export interface AgentMailCreatorAttentionTransitionResult {
  updated: boolean;
  record: AgentMailCreatorAttentionRecord | null;
}

export class AgentMailCreatorAttentionCapacityError extends Error {
  readonly code = "AGENTMAIL_ATTENTION_CAPACITY";

  constructor(maxRecords: number) {
    super(`agentMail attention: capacity ${maxRecords} reached; resolve or dismiss active records`);
    this.name = "AgentMailCreatorAttentionCapacityError";
  }
}

export interface AgentMailCreatorAttentionStore {
  /**
   * Reserve creator-attention capacity before a model turn can cause effects.
   *
   * Callers must explicitly decide whether a legitimate ledger retry may
   * reopen failed or dismissed metadata. Sent and rejected records are never
   * reopenable.
   */
  reserve(input: { inboxId: string; messageId: string; allowReopen: boolean }): {
    status: AgentMailCreatorAttentionReserveStatus;
    record: AgentMailCreatorAttentionRecord;
  };
  transition(input: {
    inboxId: string;
    messageId: string;
    expectedVersion: number;
    state: AgentMailCreatorAttentionState;
    reviewId?: string;
  }): AgentMailCreatorAttentionTransitionResult;
  /** CAS transition for restart/expiry reconciliation when only a review ID is available. */
  transitionByReviewId(input: {
    reviewId: string;
    expectedVersion: number;
    state: AgentMailCreatorAttentionState;
  }): AgentMailCreatorAttentionTransitionResult;
  get(inboxId: string, messageId: string): AgentMailCreatorAttentionRecord | null;
  getByReviewId(reviewId: string): AgentMailCreatorAttentionRecord | null;
  list(input?: {
    inboxId?: string;
    states?: readonly AgentMailCreatorAttentionState[];
    limit?: number;
  }): AgentMailCreatorAttentionRecord[];
  counts(inboxId?: string): AgentMailCreatorAttentionCounts;
  /**
   * Prune eligible terminal metadata.
   *
   * Records attached to an unresolved inbound incident are durable replay
   * evidence and remain protected regardless of age or capacity pressure.
   */
  prune(): { deleted: number };
}

export interface AgentMailCreatorAttentionStoreOptions {
  db: Database;
  now: () => number;
  assertOpen: () => void;
  immediate: <T>(fn: () => T) => T;
  maxRecords?: number;
  retentionMs?: number;
}

interface AttentionRow {
  inbox_id: string;
  message_id: string;
  state: AgentMailCreatorAttentionState;
  record_version: number;
  review_id: string | null;
  created_at: number;
  updated_at: number;
  terminal_at: number | null;
}

const STATES: readonly AgentMailCreatorAttentionState[] = [
  "open",
  "pending_review",
  "sent",
  "rejected",
  "failed",
  "ambiguous",
  "dismissed",
];
const STATE_SET = new Set<AgentMailCreatorAttentionState>(STATES);
const TERMINAL_STATES = new Set<AgentMailCreatorAttentionState>([
  "sent",
  "rejected",
  "failed",
  "dismissed",
]);
const REOPENABLE_STATES = new Set<AgentMailCreatorAttentionState>(["failed", "dismissed"]);
const TRANSITIONS: Readonly<
  Record<AgentMailCreatorAttentionState, ReadonlySet<AgentMailCreatorAttentionState>>
> = {
  open: new Set(["pending_review", "sent", "failed", "ambiguous", "dismissed"]),
  pending_review: new Set(["sent", "rejected", "failed", "ambiguous", "dismissed"]),
  sent: new Set(),
  rejected: new Set(),
  failed: new Set(),
  ambiguous: new Set(["sent", "failed", "dismissed"]),
  dismissed: new Set(),
};

function clock(now: () => number): number {
  const value = now();
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("agentMail attention: clock returned an invalid timestamp");
  }
  return value;
}

function positiveInteger(value: number, label: string, max: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > max) {
    throw new Error(`agentMail attention: ${label} must be between 1 and ${max}`);
  }
  return value;
}

function nonNegativeInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`agentMail attention: ${label} must be a non-negative safe integer`);
  }
  return value;
}

function boundedIdentity(value: string, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`agentMail attention: ${label} is invalid`);
  }
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code <= 31 || code === 127) {
      throw new Error(`agentMail attention: ${label} contains control characters`);
    }
  }
  return value.trim();
}

function reviewId(value: string | undefined): string | undefined {
  return value === undefined ? undefined : boundedIdentity(value, "reviewId", 128);
}

function rowRecord(row: AttentionRow): AgentMailCreatorAttentionRecord {
  return {
    inboxId: row.inbox_id,
    messageId: row.message_id,
    state: row.state,
    version: row.record_version,
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.terminal_at !== null ? { terminalAt: row.terminal_at } : {}),
  };
}

export function validateStoredCreatorAttentionRows(db: Database): void {
  const rows = db
    .query<AttentionRow, []>(
      "SELECT * FROM agentmail_creator_attention ORDER BY inbox_id, message_id",
    )
    .all();
  for (const row of rows) {
    boundedIdentity(row.inbox_id, "stored inboxId");
    boundedIdentity(row.message_id, "stored messageId");
    if (!STATE_SET.has(row.state)) throw new Error("agentMail attention: stored state is invalid");
    positiveInteger(row.record_version, "stored version", Number.MAX_SAFE_INTEGER);
    nonNegativeInteger(row.created_at, "stored createdAt");
    nonNegativeInteger(row.updated_at, "stored updatedAt");
    if (row.updated_at < row.created_at) {
      throw new Error("agentMail attention: stored timestamps are inconsistent");
    }
    if (row.review_id !== null) boundedIdentity(row.review_id, "stored reviewId", 128);
    if (row.state === "pending_review" && row.review_id === null) {
      throw new Error("agentMail attention: pending review is missing its reviewId");
    }
    if (TERMINAL_STATES.has(row.state)) {
      if (row.terminal_at === null) {
        throw new Error("agentMail attention: terminal record is missing terminalAt");
      }
      nonNegativeInteger(row.terminal_at, "stored terminalAt");
      if (row.terminal_at < row.created_at || row.terminal_at > row.updated_at) {
        throw new Error("agentMail attention: terminal timestamp is inconsistent");
      }
    } else if (row.terminal_at !== null) {
      throw new Error("agentMail attention: active record has a terminal timestamp");
    }
  }
}

export function createAgentMailCreatorAttentionStore(
  options: AgentMailCreatorAttentionStoreOptions,
): AgentMailCreatorAttentionStore {
  const maxRecords = positiveInteger(
    options.maxRecords ?? AGENTMAIL_ATTENTION_DEFAULT_MAX_RECORDS,
    "maxRecords",
    100_000,
  );
  const retentionMs = nonNegativeInteger(
    options.retentionMs ?? AGENTMAIL_ATTENTION_DEFAULT_RETENTION_MS,
    "retentionMs",
  );
  const db = options.db;
  const selectOne = db.prepare<AttentionRow, [string, string]>(
    "SELECT * FROM agentmail_creator_attention WHERE inbox_id = ? AND message_id = ?",
  );
  const selectByReviewId = db.prepare<AttentionRow, [string]>(
    "SELECT * FROM agentmail_creator_attention WHERE review_id = ?",
  );
  const insert = db.prepare<AttentionRow, [string, string, number, number, string, string]>(
    `INSERT INTO agentmail_creator_attention (
       inbox_id, message_id, state, record_version, review_id,
       created_at, updated_at, terminal_at
     )
     SELECT ?, ?, 'open', 1, NULL, ?, ?, NULL
      WHERE EXISTS (
        SELECT 1 FROM agentmail_inbound_messages WHERE inbox_id = ? AND message_id = ?
      )
     ON CONFLICT(inbox_id, message_id) DO NOTHING
     RETURNING *`,
  );
  const countAll = db.prepare<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM agentmail_creator_attention",
  );
  const agedTerminal = db.prepare<{ inbox_id: string; message_id: string }, [number]>(
    `SELECT attention.inbox_id, attention.message_id
       FROM agentmail_creator_attention AS attention
      WHERE attention.terminal_at IS NOT NULL
        AND attention.terminal_at <= ?
        AND NOT EXISTS (
          SELECT 1 FROM agentmail_inbound_quarantines AS quarantine
           WHERE quarantine.inbox_id = attention.inbox_id
             AND quarantine.message_id = attention.message_id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM agentmail_creator_digest_items AS digest_item
            JOIN agentmail_creator_digest_watermarks AS digest_watermark
              ON digest_watermark.batch_id = digest_item.batch_id
           WHERE digest_watermark.disposition IN ('presented', 'dismissed')
             AND digest_item.inbox_id = attention.inbox_id
             AND digest_item.message_id = attention.message_id
        )
      ORDER BY attention.terminal_at ASC, attention.inbox_id ASC, attention.message_id ASC`,
  );
  const oldestTerminal = db.prepare<{ inbox_id: string; message_id: string }, [number]>(
    `SELECT attention.inbox_id, attention.message_id
       FROM agentmail_creator_attention AS attention
      WHERE attention.terminal_at IS NOT NULL
        AND NOT EXISTS (
          SELECT 1 FROM agentmail_inbound_quarantines AS quarantine
           WHERE quarantine.inbox_id = attention.inbox_id
             AND quarantine.message_id = attention.message_id
        )
        AND NOT EXISTS (
          SELECT 1
            FROM agentmail_creator_digest_items AS digest_item
            JOIN agentmail_creator_digest_watermarks AS digest_watermark
              ON digest_watermark.batch_id = digest_item.batch_id
           WHERE digest_watermark.disposition IN ('presented', 'dismissed')
             AND digest_item.inbox_id = attention.inbox_id
             AND digest_item.message_id = attention.message_id
        )
      ORDER BY attention.terminal_at ASC, attention.inbox_id ASC, attention.message_id ASC
      LIMIT ?`,
  );
  const deleteOne = db.prepare(
    "DELETE FROM agentmail_creator_attention WHERE inbox_id = ? AND message_id = ?",
  );
  const update = db.prepare<
    AttentionRow,
    [string, string | null, number | null, number, string, string, number, string]
  >(
    `UPDATE agentmail_creator_attention
        SET state = ?, review_id = ?, terminal_at = ?, updated_at = ?,
            record_version = record_version + 1
      WHERE inbox_id = ? AND message_id = ? AND record_version = ? AND state = ?
      RETURNING *`,
  );
  const reopen = db.prepare<AttentionRow, [number, string, string, number, string]>(
    `UPDATE agentmail_creator_attention
        SET state = 'open', review_id = NULL, terminal_at = NULL, updated_at = ?,
            record_version = record_version + 1
      WHERE inbox_id = ? AND message_id = ? AND record_version = ? AND state = ?
      RETURNING *`,
  );

  function pruneInTransaction(timestamp: number, requiredSlots = 0): number {
    let deleted = 0;
    const cutoff = Math.max(0, timestamp - retentionMs);
    // An unresolved incident means model/tool effects may already exist.
    // Its terminal attention row is safety evidence, not reclaimable cache.
    for (const candidate of agedTerminal.all(cutoff)) {
      deleted += deleteOne.run(candidate.inbox_id, candidate.message_id).changes;
    }
    const count = countAll.get()?.count ?? 0;
    const excess = Math.max(0, count + requiredSlots - maxRecords);
    if (excess > 0) {
      for (const candidate of oldestTerminal.all(excess)) {
        deleted += deleteOne.run(candidate.inbox_id, candidate.message_id).changes;
      }
    }
    if ((countAll.get()?.count ?? 0) + requiredSlots > maxRecords) {
      throw new AgentMailCreatorAttentionCapacityError(maxRecords);
    }
    return deleted;
  }

  function transitionCurrent(input: {
    current: AttentionRow;
    expectedVersion: number;
    state: AgentMailCreatorAttentionState;
    suppliedReviewId?: string;
  }): AgentMailCreatorAttentionTransitionResult {
    const { current, expectedVersion, state, suppliedReviewId } = input;
    if (current.record_version !== expectedVersion) {
      return { updated: false, record: rowRecord(current) };
    }
    if (
      current.state === state &&
      (suppliedReviewId === undefined || current.review_id === suppliedReviewId)
    ) {
      return { updated: false, record: rowRecord(current) };
    }
    if (!TRANSITIONS[current.state].has(state)) {
      throw new Error(`agentMail attention: invalid transition ${current.state} -> ${state}`);
    }
    const nextReviewId = suppliedReviewId ?? current.review_id ?? undefined;
    if (state === "pending_review" && !nextReviewId) {
      throw new Error("agentMail attention: pending_review requires reviewId");
    }
    if (suppliedReviewId && state !== "pending_review" && suppliedReviewId !== current.review_id) {
      throw new Error("agentMail attention: reviewId may only change for pending_review");
    }
    const reviewOwner = nextReviewId ? selectByReviewId.get(nextReviewId) : null;
    if (
      reviewOwner &&
      (reviewOwner.inbox_id !== current.inbox_id || reviewOwner.message_id !== current.message_id)
    ) {
      throw new Error("agentMail attention: reviewId already belongs to another message");
    }
    const timestamp = clock(options.now);
    const terminalAt = TERMINAL_STATES.has(state) ? timestamp : null;
    const row = update.get(
      state,
      nextReviewId ?? null,
      terminalAt,
      timestamp,
      current.inbox_id,
      current.message_id,
      expectedVersion,
      current.state,
    );
    if (row) return { updated: true, record: rowRecord(row) };
    const latest = selectOne.get(current.inbox_id, current.message_id);
    return { updated: false, record: latest ? rowRecord(latest) : null };
  }

  return {
    reserve(input) {
      options.assertOpen();
      const inboxId = boundedIdentity(input.inboxId, "inboxId");
      const messageId = boundedIdentity(input.messageId, "messageId");
      if (typeof input.allowReopen !== "boolean") {
        throw new Error("agentMail attention: allowReopen must be an explicit boolean");
      }
      const timestamp = clock(options.now);
      return options.immediate(() => {
        const existing = selectOne.get(inboxId, messageId);
        if (existing && !TERMINAL_STATES.has(existing.state)) {
          pruneInTransaction(timestamp);
          return { status: "active_duplicate" as const, record: rowRecord(existing) };
        }
        if (existing) {
          if (!input.allowReopen || !REOPENABLE_STATES.has(existing.state)) {
            throw new Error(
              `agentMail attention: terminal ${existing.state} record cannot be reserved without an authorized retry`,
            );
          }
          const row = reopen.get(
            timestamp,
            inboxId,
            messageId,
            existing.record_version,
            existing.state,
          );
          if (!row) throw new Error("agentMail attention: record changed while reopening");
          pruneInTransaction(timestamp);
          return { status: "reopened" as const, record: rowRecord(row) };
        }

        pruneInTransaction(timestamp, 1);
        const row = insert.get(inboxId, messageId, timestamp, timestamp, inboxId, messageId);
        if (!row) {
          throw new Error(
            "agentMail attention: message must be admitted to the inbound ledger first",
          );
        }
        return { status: "created" as const, record: rowRecord(row) };
      });
    },

    transition(input) {
      options.assertOpen();
      const inboxId = boundedIdentity(input.inboxId, "inboxId");
      const messageId = boundedIdentity(input.messageId, "messageId");
      const expectedVersion = positiveInteger(
        input.expectedVersion,
        "expectedVersion",
        Number.MAX_SAFE_INTEGER,
      );
      if (!STATE_SET.has(input.state)) {
        throw new Error("agentMail attention: transition state is invalid");
      }
      const suppliedReviewId = reviewId(input.reviewId);
      return options.immediate(() => {
        const current = selectOne.get(inboxId, messageId);
        if (!current) return { updated: false, record: null };
        return transitionCurrent({
          current,
          expectedVersion,
          state: input.state,
          ...(suppliedReviewId ? { suppliedReviewId } : {}),
        });
      });
    },

    transitionByReviewId(input) {
      options.assertOpen();
      const linkedReviewId = reviewId(input.reviewId)!;
      const expectedVersion = positiveInteger(
        input.expectedVersion,
        "expectedVersion",
        Number.MAX_SAFE_INTEGER,
      );
      if (!STATE_SET.has(input.state)) {
        throw new Error("agentMail attention: transition state is invalid");
      }
      return options.immediate(() => {
        const current = selectByReviewId.get(linkedReviewId);
        if (!current) return { updated: false, record: null };
        return transitionCurrent({
          current,
          expectedVersion,
          state: input.state,
        });
      });
    },

    get(inboxIdInput, messageIdInput) {
      options.assertOpen();
      const row = selectOne.get(
        boundedIdentity(inboxIdInput, "inboxId"),
        boundedIdentity(messageIdInput, "messageId"),
      );
      return row ? rowRecord(row) : null;
    },

    getByReviewId(reviewIdInput) {
      options.assertOpen();
      const row = selectByReviewId.get(reviewId(reviewIdInput)!);
      return row ? rowRecord(row) : null;
    },

    list(input = {}) {
      options.assertOpen();
      const limit = positiveInteger(input.limit ?? 50, "limit", 100);
      const clauses: string[] = [];
      const values: Array<string | number> = [];
      if (input.inboxId !== undefined) {
        clauses.push("inbox_id = ?");
        values.push(boundedIdentity(input.inboxId, "inboxId"));
      }
      if (input.states !== undefined) {
        if (input.states.length < 1 || input.states.length > STATES.length) {
          throw new Error("agentMail attention: states must contain between 1 and 7 entries");
        }
        const unique = [...new Set(input.states)];
        if (
          unique.length !== input.states.length ||
          unique.some((state) => !STATE_SET.has(state))
        ) {
          throw new Error("agentMail attention: states contains duplicates or invalid values");
        }
        clauses.push(`state IN (${unique.map(() => "?").join(", ")})`);
        values.push(...unique);
      }
      values.push(limit);
      const rows = db
        .query<AttentionRow, Array<string | number>>(
          `SELECT * FROM agentmail_creator_attention
           ${clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : ""}
           ORDER BY updated_at DESC, inbox_id ASC, message_id ASC LIMIT ?`,
        )
        .all(...values);
      return rows.map(rowRecord);
    },

    counts(inboxIdInput) {
      options.assertOpen();
      const values: string[] = [];
      let where = "";
      if (inboxIdInput !== undefined) {
        values.push(boundedIdentity(inboxIdInput, "inboxId"));
        where = "WHERE inbox_id = ?";
      }
      const rows = db
        .query<{ state: AgentMailCreatorAttentionState; count: number }, string[]>(
          `SELECT state, COUNT(*) AS count FROM agentmail_creator_attention
           ${where} GROUP BY state`,
        )
        .all(...values);
      const counts: AgentMailCreatorAttentionCounts = {
        open: 0,
        pendingReview: 0,
        sent: 0,
        rejected: 0,
        failed: 0,
        ambiguous: 0,
        dismissed: 0,
      };
      for (const row of rows) {
        if (row.state === "pending_review") counts.pendingReview = row.count;
        else counts[row.state] = row.count;
      }
      return counts;
    },

    prune() {
      options.assertOpen();
      const deleted = options.immediate(() => pruneInTransaction(clock(options.now)));
      return { deleted };
    },
  };
}
