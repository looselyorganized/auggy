/**
 * Durable creator-digest batching for completed or quarantined inbound mail.
 *
 * Batches and items are immutable metadata snapshots. Watermarks settle one
 * batch generation at a time; compact retirement ranges preserve continuity
 * when old batch snapshots are reclaimed. Email bodies, subjects,
 * sender/recipient fields, draft text, and raw settlement evidence are
 * intentionally not copied here.
 */

import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import type { AgentMailCreatorAttentionState } from "./creator-attention";

export const AGENTMAIL_DIGEST_DEFAULT_BATCH_SIZE = 20;
export const AGENTMAIL_DIGEST_MAX_BATCH_SIZE = 100;
export const AGENTMAIL_DIGEST_DEFAULT_MAX_BATCHES = 1_000;
export const AGENTMAIL_DIGEST_DEFAULT_MAX_ITEMS = 10_000;
export const AGENTMAIL_DIGEST_DEFAULT_RETENTION_MS = 30 * 24 * 60 * 60_000;

const MAX_MAINTENANCE_DELETE = 1_000;
const ATTENTION_STATES: readonly AgentMailCreatorAttentionState[] = [
  "open",
  "pending_review",
  "sent",
  "rejected",
  "failed",
  "ambiguous",
  "dismissed",
];
const ATTENTION_STATE_SET = new Set<AgentMailCreatorAttentionState>(ATTENTION_STATES);

export type AgentMailCreatorDigestDisposition = "presented" | "dismissed" | "confirmed-no-effect";

export interface AgentMailCreatorDigestItem {
  ordinal: number;
  inboxId: string;
  messageId: string;
  attentionVersion: number;
  attentionState?: AgentMailCreatorAttentionState;
  reviewId?: string;
  incidentId?: string;
  incidentVersion: number;
  incidentReasonCode?: string;
  sourceAt: number;
}

export interface AgentMailCreatorDigestBatch {
  id: string;
  inboxId: string;
  baseGeneration: number;
  /** Hash of the canonical notify augment identity + destination configuration. */
  deliveryTargetSha256: string;
  contentSha256: string;
  createdAt: number;
  items: AgentMailCreatorDigestItem[];
  settlement?: {
    generation: number;
    disposition: AgentMailCreatorDigestDisposition;
    evidenceSha256: string;
    advancedAt: number;
  };
}

export interface AgentMailCreatorDigestCounts {
  batches: number;
  items: number;
  pending: number;
}

export type AgentMailCreatorDigestSettleResult =
  | { status: "settled"; generation: number }
  | { status: "already_settled"; generation: number }
  | { status: "conflict"; generation: number };

export class AgentMailCreatorDigestCapacityError extends Error {
  readonly code = "AGENTMAIL_DIGEST_CAPACITY";

  constructor(maxBatches: number, maxItems: number) {
    super(`agentMail creator digest: capacity reached (${maxBatches} batches, ${maxItems} items)`);
    this.name = "AgentMailCreatorDigestCapacityError";
  }
}

export class AgentMailCreatorDigestTargetConflictError extends Error {
  readonly code = "AGENTMAIL_DIGEST_TARGET_CONFLICT";
  readonly pending: AgentMailCreatorDigestBatch;

  constructor(pending: AgentMailCreatorDigestBatch) {
    super(
      "agentMail creator digest: pending batch belongs to another delivery target; reconcile it before changing destinations",
    );
    this.name = "AgentMailCreatorDigestTargetConflictError";
    this.pending = pending;
  }
}

export interface AgentMailCreatorDigestStore {
  /**
   * Return the current immutable batch, or atomically create one from exact
   * source generations. A pending batch is never replaced implicitly.
   */
  prepare(input: {
    inboxId: string;
    /**
     * SHA-256 of a canonical delivery identity including, at minimum, the
     * notify augment instance and destination. A pending batch fails closed if
     * this changes across restart.
     */
    deliveryTargetSha256: string;
    limit?: number;
  }): AgentMailCreatorDigestBatch | null;
  get(batchId: string): AgentMailCreatorDigestBatch | null;
  getPending(inboxId: string): AgentMailCreatorDigestBatch | null;
  /** Bounded settled snapshots used to close the downstream delivery outbox. */
  listSettled(inboxId: string, limit?: number): AgentMailCreatorDigestBatch[];
  /** Whether every item still names the current eligible source generation. */
  isCurrent(batchId: string): boolean;
  /**
   * Append the next per-inbox watermark using compare-and-swap.
   *
   * `presented` and creator-only `dismissed` suppress the exact item snapshots.
   * `confirmed-no-effect` retires the batch without suppressing them so a
   * later prepare can retry.
   */
  settle(input: {
    batchId: string;
    expectedBaseGeneration: number;
    expectedDeliveryTargetSha256: string;
    expectedContentSha256: string;
    disposition: AgentMailCreatorDigestDisposition;
    evidence: string;
  }): AgentMailCreatorDigestSettleResult;
  counts(): AgentMailCreatorDigestCounts;
  prune(): { batches: number; items: number };
  /** Internal privacy-erasure primitive; callers must coordinate source deletion. */
  purgeInbox(inboxId: string): { batches: number; items: number };
}

export interface AgentMailCreatorDigestStoreOptions {
  db: Database;
  now: () => number;
  assertOpen: () => void;
  immediate: <T>(fn: () => T) => T;
  batchId?: () => string;
  maxBatches?: number;
  maxItems?: number;
  retentionMs?: number;
}

interface BatchRow {
  batch_id: string;
  inbox_id: string;
  base_generation: number;
  delivery_target_sha256: string;
  item_count: number;
  content_sha256: string;
  created_at: number;
}

interface ItemRow {
  batch_id: string;
  ordinal: number;
  inbox_id: string;
  message_id: string;
  attention_version: number;
  attention_state: AgentMailCreatorAttentionState | null;
  review_id: string | null;
  incident_id: string | null;
  incident_version: number;
  incident_reason_code: string | null;
  source_at: number;
}

interface WatermarkRow {
  inbox_id: string;
  generation: number;
  batch_id: string;
  content_sha256: string;
  disposition: AgentMailCreatorDigestDisposition;
  evidence_sha256: string;
  advanced_at: number;
}

interface RetirementRangeRow {
  inbox_id: string;
  from_generation: number;
  through_generation: number;
  evidence_sha256: string;
  through_advanced_at: number;
  retired_at: number;
}

interface CandidateRow {
  inbox_id: string;
  message_id: string;
  attention_version: number;
  attention_state: AgentMailCreatorAttentionState | null;
  review_id: string | null;
  incident_id: string | null;
  incident_version: number;
  incident_reason_code: string | null;
  source_at: number;
}

export const AGENTMAIL_CREATOR_DIGEST_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS agentmail_creator_digest_batches (
    batch_id         TEXT PRIMARY KEY CHECK (length(batch_id) BETWEEN 1 AND 128),
    inbox_id         TEXT NOT NULL CHECK (length(inbox_id) BETWEEN 1 AND 256),
    base_generation  INTEGER NOT NULL CHECK (base_generation >= 0),
    delivery_target_sha256 TEXT NOT NULL CHECK (
      length(delivery_target_sha256) = 64
      AND delivery_target_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    item_count       INTEGER NOT NULL CHECK (item_count BETWEEN 1 AND 100),
    content_sha256   TEXT NOT NULL CHECK (
      length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    created_at       INTEGER NOT NULL CHECK (created_at >= 0),
    UNIQUE (inbox_id, base_generation)
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_creator_digest_items (
    batch_id             TEXT NOT NULL,
    ordinal              INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 99),
    inbox_id             TEXT NOT NULL CHECK (length(inbox_id) BETWEEN 1 AND 256),
    message_id           TEXT NOT NULL CHECK (length(message_id) BETWEEN 1 AND 256),
    attention_version    INTEGER NOT NULL CHECK (attention_version >= 0),
    attention_state      TEXT CHECK (attention_state IN (
      'open', 'pending_review', 'sent', 'rejected', 'failed', 'ambiguous', 'dismissed'
    )),
    review_id            TEXT,
    incident_id          TEXT,
    incident_version     INTEGER NOT NULL CHECK (incident_version >= 0),
    incident_reason_code TEXT,
    source_at            INTEGER NOT NULL CHECK (source_at >= 0),
    PRIMARY KEY (batch_id, ordinal),
    UNIQUE (batch_id, inbox_id, message_id),
    FOREIGN KEY (batch_id)
      REFERENCES agentmail_creator_digest_batches(batch_id)
      ON DELETE CASCADE,
    FOREIGN KEY (inbox_id, message_id)
      REFERENCES agentmail_inbound_messages(inbox_id, message_id)
      ON DELETE RESTRICT,
    CHECK (
      (attention_version = 0 AND attention_state IS NULL AND review_id IS NULL)
      OR
      (
        attention_version >= 1
        AND attention_state IS NOT NULL
        AND (attention_state != 'pending_review' OR review_id IS NOT NULL)
        AND (attention_state != 'open' OR review_id IS NULL)
      )
    ),
    CHECK (
      (incident_version = 0 AND incident_id IS NULL AND incident_reason_code IS NULL)
      OR
      (
        incident_version >= 1
        AND incident_id IS NOT NULL
        AND incident_reason_code IS NOT NULL
      )
    ),
    CHECK (attention_version >= 1 OR incident_version >= 1)
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_creator_digest_watermarks (
    inbox_id        TEXT NOT NULL CHECK (length(inbox_id) BETWEEN 1 AND 256),
    generation      INTEGER NOT NULL CHECK (generation >= 1),
    batch_id        TEXT NOT NULL UNIQUE,
    content_sha256  TEXT NOT NULL CHECK (
      length(content_sha256) = 64 AND content_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    disposition     TEXT NOT NULL CHECK (
      disposition IN ('presented', 'dismissed', 'confirmed-no-effect')
    ),
    evidence_sha256 TEXT NOT NULL CHECK (
      length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    advanced_at     INTEGER NOT NULL CHECK (advanced_at >= 0),
    PRIMARY KEY (inbox_id, generation),
    FOREIGN KEY (batch_id)
      REFERENCES agentmail_creator_digest_batches(batch_id)
      ON DELETE RESTRICT
  )`,
  `CREATE TABLE IF NOT EXISTS agentmail_creator_digest_retirement_ranges (
    inbox_id           TEXT NOT NULL CHECK (length(inbox_id) BETWEEN 1 AND 256),
    from_generation    INTEGER NOT NULL CHECK (from_generation >= 1),
    through_generation INTEGER NOT NULL CHECK (through_generation >= from_generation),
    evidence_sha256    TEXT NOT NULL CHECK (
      length(evidence_sha256) = 64 AND evidence_sha256 NOT GLOB '*[^0-9a-f]*'
    ),
    through_advanced_at INTEGER NOT NULL CHECK (through_advanced_at >= 0),
    retired_at         INTEGER NOT NULL CHECK (retired_at >= through_advanced_at),
    PRIMARY KEY (inbox_id, from_generation),
    UNIQUE (inbox_id, through_generation)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_creator_digest_item_source
     ON agentmail_creator_digest_items(
       inbox_id, message_id, attention_version, incident_version, incident_id, batch_id
     )`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_creator_digest_watermark_time
     ON agentmail_creator_digest_watermarks(advanced_at, batch_id)`,
  `CREATE INDEX IF NOT EXISTS idx_agentmail_creator_digest_retirement_end
     ON agentmail_creator_digest_retirement_ranges(inbox_id, through_generation)`,
  `CREATE TRIGGER IF NOT EXISTS trg_agentmail_creator_digest_batches_immutable
     BEFORE UPDATE ON agentmail_creator_digest_batches
     BEGIN
       SELECT RAISE(ABORT, 'agentMail creator digest batches are immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_agentmail_creator_digest_items_immutable
     BEFORE UPDATE ON agentmail_creator_digest_items
     BEGIN
       SELECT RAISE(ABORT, 'agentMail creator digest items are immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_agentmail_creator_digest_watermarks_immutable
     BEFORE UPDATE ON agentmail_creator_digest_watermarks
     BEGIN
       SELECT RAISE(ABORT, 'agentMail creator digest watermarks are immutable');
     END`,
  `CREATE TRIGGER IF NOT EXISTS trg_agentmail_creator_digest_retirement_ranges_immutable
     BEFORE UPDATE ON agentmail_creator_digest_retirement_ranges
     BEGIN
       SELECT RAISE(ABORT, 'agentMail creator digest retirement ranges are immutable');
     END`,
] as const;

function safeInteger(value: unknown, label: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`agentMail creator digest: ${label} is invalid`);
  }
  return value as number;
}

function boundedIdentity(value: unknown, label: string, max = 256): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) {
    throw new Error(`agentMail creator digest: ${label} is invalid`);
  }
  for (const character of value) {
    const codePoint = character.codePointAt(0) ?? 0;
    if (codePoint <= 31 || codePoint === 127) {
      throw new Error(`agentMail creator digest: ${label} contains control characters`);
    }
  }
  return value.trim();
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function storedSha256(value: unknown, label: string): string {
  const digest = boundedIdentity(value, label, 64);
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`agentMail creator digest: ${label} must be lowercase SHA-256`);
  }
  return digest;
}

function itemRecord(row: ItemRow): AgentMailCreatorDigestItem {
  return {
    ordinal: row.ordinal,
    inboxId: row.inbox_id,
    messageId: row.message_id,
    attentionVersion: row.attention_version,
    ...(row.attention_state ? { attentionState: row.attention_state } : {}),
    ...(row.review_id ? { reviewId: row.review_id } : {}),
    ...(row.incident_id ? { incidentId: row.incident_id } : {}),
    incidentVersion: row.incident_version,
    ...(row.incident_reason_code ? { incidentReasonCode: row.incident_reason_code } : {}),
    sourceAt: row.source_at,
  };
}

function canonicalBatchHash(input: {
  batchId: string;
  inboxId: string;
  baseGeneration: number;
  deliveryTargetSha256: string;
  items: readonly AgentMailCreatorDigestItem[];
}): string {
  return sha256(
    JSON.stringify({
      v: 1,
      batchId: input.batchId,
      inboxId: input.inboxId,
      baseGeneration: input.baseGeneration,
      deliveryTargetSha256: input.deliveryTargetSha256,
      items: input.items.map((item) => ({
        ordinal: item.ordinal,
        inboxId: item.inboxId,
        messageId: item.messageId,
        attentionVersion: item.attentionVersion,
        attentionState: item.attentionState ?? null,
        reviewId: item.reviewId ?? null,
        incidentId: item.incidentId ?? null,
        incidentVersion: item.incidentVersion,
        incidentReasonCode: item.incidentReasonCode ?? null,
        sourceAt: item.sourceAt,
      })),
    }),
  );
}

function validateItemRow(row: ItemRow): AgentMailCreatorDigestItem {
  safeInteger(row.ordinal, "stored item ordinal");
  boundedIdentity(row.inbox_id, "stored item inboxId");
  boundedIdentity(row.message_id, "stored item messageId");
  const attentionVersion = safeInteger(row.attention_version, "stored item attentionVersion");
  const incidentVersion = safeInteger(row.incident_version, "stored item incidentVersion");
  if (attentionVersion === 0) {
    if (row.attention_state !== null || row.review_id !== null) {
      throw new Error("agentMail creator digest: stored absent attention is inconsistent");
    }
  } else {
    if (!row.attention_state || !ATTENTION_STATE_SET.has(row.attention_state)) {
      throw new Error("agentMail creator digest: stored attention state is invalid");
    }
    if (row.attention_state === "pending_review" && row.review_id === null) {
      throw new Error("agentMail creator digest: stored pending review is missing reviewId");
    }
    if (row.attention_state === "open" && row.review_id !== null) {
      throw new Error("agentMail creator digest: stored open attention has a reviewId");
    }
  }
  if (row.review_id !== null) boundedIdentity(row.review_id, "stored item reviewId", 128);
  if (incidentVersion === 0) {
    if (row.incident_id !== null || row.incident_reason_code !== null) {
      throw new Error("agentMail creator digest: stored absent incident is inconsistent");
    }
  } else {
    boundedIdentity(row.incident_id, "stored item incidentId", 128);
    boundedIdentity(row.incident_reason_code, "stored item incident reason", 64);
  }
  if (attentionVersion === 0 && incidentVersion === 0) {
    throw new Error("agentMail creator digest: stored item has no source generation");
  }
  safeInteger(row.source_at, "stored item sourceAt");
  return itemRecord(row);
}

export function validateStoredCreatorDigestRows(db: Database): void {
  const orphan = db
    .query<{ batch_id: string }, []>(
      `SELECT item.batch_id
         FROM agentmail_creator_digest_items item
         LEFT JOIN agentmail_creator_digest_batches batch ON batch.batch_id = item.batch_id
         LEFT JOIN agentmail_inbound_messages message
           ON message.inbox_id = item.inbox_id AND message.message_id = item.message_id
        WHERE batch.batch_id IS NULL OR message.message_id IS NULL
        LIMIT 1`,
    )
    .get();
  if (orphan) {
    throw new Error("agentMail creator digest: stored item source ownership is inconsistent");
  }
  const batches = db
    .query<BatchRow, []>(
      "SELECT * FROM agentmail_creator_digest_batches ORDER BY inbox_id, base_generation",
    )
    .all();
  const batchById = new Map<string, BatchRow>();
  for (const batch of batches) {
    boundedIdentity(batch.batch_id, "stored batchId", 128);
    boundedIdentity(batch.inbox_id, "stored batch inboxId");
    safeInteger(batch.base_generation, "stored batch baseGeneration");
    storedSha256(batch.delivery_target_sha256, "stored batch delivery target hash");
    const itemCount = safeInteger(batch.item_count, "stored batch itemCount", 1);
    if (itemCount > AGENTMAIL_DIGEST_MAX_BATCH_SIZE) {
      throw new Error("agentMail creator digest: stored batch itemCount is too large");
    }
    storedSha256(batch.content_sha256, "stored batch content hash");
    safeInteger(batch.created_at, "stored batch createdAt");
    if (batchById.has(batch.batch_id)) {
      throw new Error("agentMail creator digest: stored batch identity is duplicated");
    }
    batchById.set(batch.batch_id, batch);

    const rows = db
      .query<ItemRow, [string]>(
        "SELECT * FROM agentmail_creator_digest_items WHERE batch_id = ? ORDER BY ordinal",
      )
      .all(batch.batch_id);
    if (rows.length !== itemCount) {
      throw new Error("agentMail creator digest: stored batch item count is inconsistent");
    }
    const items = rows.map((row, ordinal) => {
      if (row.ordinal !== ordinal) {
        throw new Error("agentMail creator digest: stored item ordinals are not contiguous");
      }
      if (row.inbox_id !== batch.inbox_id) {
        throw new Error("agentMail creator digest: stored item belongs to another inbox");
      }
      return validateItemRow(row);
    });
    if (
      canonicalBatchHash({
        batchId: batch.batch_id,
        inboxId: batch.inbox_id,
        baseGeneration: batch.base_generation,
        deliveryTargetSha256: batch.delivery_target_sha256,
        items,
      }) !== batch.content_sha256
    ) {
      throw new Error("agentMail creator digest: stored batch content hash is inconsistent");
    }
  }

  const watermarks = db
    .query<WatermarkRow, []>(
      "SELECT * FROM agentmail_creator_digest_watermarks ORDER BY inbox_id, generation",
    )
    .all();
  const settledBatches = new Set<string>();
  const generationSegments = new Map<
    string,
    Array<{ from: number; through: number; advancedAt: number }>
  >();
  for (const watermark of watermarks) {
    boundedIdentity(watermark.inbox_id, "stored watermark inboxId");
    safeInteger(watermark.generation, "stored watermark generation", 1);
    boundedIdentity(watermark.batch_id, "stored watermark batchId", 128);
    storedSha256(watermark.content_sha256, "stored watermark content hash");
    storedSha256(watermark.evidence_sha256, "stored watermark evidence hash");
    safeInteger(watermark.advanced_at, "stored watermark advancedAt");
    if (
      watermark.disposition !== "presented" &&
      watermark.disposition !== "dismissed" &&
      watermark.disposition !== "confirmed-no-effect"
    ) {
      throw new Error("agentMail creator digest: stored watermark disposition is invalid");
    }
    const batch = batchById.get(watermark.batch_id);
    if (
      !batch ||
      batch.inbox_id !== watermark.inbox_id ||
      batch.base_generation + 1 !== watermark.generation ||
      batch.content_sha256 !== watermark.content_sha256 ||
      watermark.advanced_at < batch.created_at
    ) {
      throw new Error("agentMail creator digest: stored watermark is inconsistent with its batch");
    }
    if (settledBatches.has(batch.batch_id)) {
      throw new Error("agentMail creator digest: stored batch has multiple watermarks");
    }
    settledBatches.add(batch.batch_id);
    const segments = generationSegments.get(watermark.inbox_id) ?? [];
    segments.push({
      from: watermark.generation,
      through: watermark.generation,
      advancedAt: watermark.advanced_at,
    });
    generationSegments.set(watermark.inbox_id, segments);
  }

  const retirementRanges = db
    .query<RetirementRangeRow, []>(
      `SELECT * FROM agentmail_creator_digest_retirement_ranges
        ORDER BY inbox_id, from_generation`,
    )
    .all();
  for (const range of retirementRanges) {
    boundedIdentity(range.inbox_id, "stored retirement inboxId");
    const from = safeInteger(range.from_generation, "stored retirement first generation", 1);
    const through = safeInteger(
      range.through_generation,
      "stored retirement final generation",
      from,
    );
    storedSha256(range.evidence_sha256, "stored retirement evidence hash");
    const throughAdvancedAt = safeInteger(
      range.through_advanced_at,
      "stored retirement generation timestamp",
    );
    const retiredAt = safeInteger(range.retired_at, "stored retirement timestamp");
    if (retiredAt < throughAdvancedAt) {
      throw new Error("agentMail creator digest: stored retirement timestamp is inconsistent");
    }
    const segments = generationSegments.get(range.inbox_id) ?? [];
    segments.push({ from, through, advancedAt: throughAdvancedAt });
    generationSegments.set(range.inbox_id, segments);
  }

  const currentGeneration = new Map<string, number>();
  for (const [inboxId, segments] of generationSegments) {
    segments.sort((left, right) => left.from - right.from);
    let expected = 1;
    let priorAdvancedAt = 0;
    for (const segment of segments) {
      if (segment.from !== expected || segment.advancedAt < priorAdvancedAt) {
        throw new Error(
          "agentMail creator digest: stored watermark generations are not contiguous",
        );
      }
      expected = segment.through + 1;
      priorAdvancedAt = segment.advancedAt;
    }
    currentGeneration.set(inboxId, expected - 1);
  }

  const pendingByInbox = new Set<string>();
  for (const batch of batches) {
    if (settledBatches.has(batch.batch_id)) continue;
    const generation = currentGeneration.get(batch.inbox_id) ?? 0;
    if (batch.base_generation !== generation || pendingByInbox.has(batch.inbox_id)) {
      throw new Error("agentMail creator digest: stored pending batch generation is inconsistent");
    }
    pendingByInbox.add(batch.inbox_id);
  }
}

export function createAgentMailCreatorDigestStore(
  options: AgentMailCreatorDigestStoreOptions,
): AgentMailCreatorDigestStore {
  const db = options.db;
  const mintBatchId = options.batchId ?? randomUUID;
  const maxBatches = safeInteger(
    options.maxBatches ?? AGENTMAIL_DIGEST_DEFAULT_MAX_BATCHES,
    "maxBatches",
    1,
  );
  const maxItems = safeInteger(
    options.maxItems ?? AGENTMAIL_DIGEST_DEFAULT_MAX_ITEMS,
    "maxItems",
    1,
  );
  const retentionMs = safeInteger(
    options.retentionMs ?? AGENTMAIL_DIGEST_DEFAULT_RETENTION_MS,
    "retentionMs",
  );
  if (maxBatches > 100_000 || maxItems > 1_000_000) {
    throw new Error("agentMail creator digest: configured capacity exceeds the hard ceiling");
  }

  const selectBatch = db.query<BatchRow, [string]>(
    "SELECT * FROM agentmail_creator_digest_batches WHERE batch_id = ?",
  );
  const selectItems = db.query<ItemRow, [string]>(
    "SELECT * FROM agentmail_creator_digest_items WHERE batch_id = ? ORDER BY ordinal",
  );
  const selectWatermarkByBatch = db.query<WatermarkRow, [string]>(
    "SELECT * FROM agentmail_creator_digest_watermarks WHERE batch_id = ?",
  );
  const selectGeneration = db.query<{ generation: number; advanced_at: number }, [string, string]>(
    `SELECT generation, advanced_at FROM (
       SELECT generation, advanced_at
         FROM agentmail_creator_digest_watermarks
        WHERE inbox_id = ?
       UNION ALL
       SELECT through_generation AS generation, through_advanced_at AS advanced_at
         FROM agentmail_creator_digest_retirement_ranges
        WHERE inbox_id = ?
     )
      ORDER BY generation DESC LIMIT 1`,
  );
  const selectPending = db.query<BatchRow, [string, number]>(
    `SELECT b.*
       FROM agentmail_creator_digest_batches b
       LEFT JOIN agentmail_creator_digest_watermarks w ON w.batch_id = b.batch_id
      WHERE b.inbox_id = ? AND b.base_generation = ? AND w.batch_id IS NULL
      LIMIT 1`,
  );
  const selectCandidates = db.query<CandidateRow, [string, number]>(
    `SELECT
       m.inbox_id,
       m.message_id,
       COALESCE(a.record_version, 0) AS attention_version,
       a.state AS attention_state,
       a.review_id,
       q.incident_id,
       COALESCE(q.incident_version, 0) AS incident_version,
       q.reason_code AS incident_reason_code,
       MAX(COALESCE(a.updated_at, 0), COALESCE(q.quarantined_at, 0)) AS source_at
     FROM agentmail_inbound_messages m
     LEFT JOIN agentmail_creator_attention a
       ON a.inbox_id = m.inbox_id AND a.message_id = m.message_id
     LEFT JOIN agentmail_inbound_quarantines q
       ON q.inbox_id = m.inbox_id AND q.message_id = m.message_id
     WHERE m.inbox_id = ?
       AND (
         (
           m.state = 'processed'
           AND q.incident_id IS NULL
           AND a.state IN ('open', 'pending_review', 'ambiguous')
         )
         OR
         (m.state = 'processing' AND q.incident_id IS NOT NULL)
       )
       AND NOT EXISTS (
         SELECT 1
           FROM agentmail_creator_digest_items di
           JOIN agentmail_creator_digest_watermarks dw ON dw.batch_id = di.batch_id
          WHERE dw.disposition IN ('presented', 'dismissed')
            AND di.inbox_id = m.inbox_id
            AND di.message_id = m.message_id
            AND di.attention_version = COALESCE(a.record_version, 0)
            AND di.incident_version = COALESCE(q.incident_version, 0)
            AND COALESCE(di.incident_id, '') = COALESCE(q.incident_id, '')
       )
     ORDER BY
       CASE
         WHEN q.incident_id IS NOT NULL THEN 0
         WHEN a.state = 'ambiguous' THEN 1
         WHEN a.state = 'pending_review' THEN 2
         ELSE 3
       END,
       source_at ASC,
       m.message_ts_ms ASC,
       m.message_id ASC
     LIMIT ?`,
  );
  const insertBatch = db.query(
    `INSERT INTO agentmail_creator_digest_batches (
       batch_id, inbox_id, base_generation, delivery_target_sha256,
       item_count, content_sha256, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertItem = db.query(
    `INSERT INTO agentmail_creator_digest_items (
       batch_id, ordinal, inbox_id, message_id,
       attention_version, attention_state, review_id,
       incident_id, incident_version, incident_reason_code, source_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const insertWatermark = db.query(
    `INSERT INTO agentmail_creator_digest_watermarks (
       inbox_id, generation, batch_id, content_sha256,
       disposition, evidence_sha256, advanced_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );
  const countBatches = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM agentmail_creator_digest_batches",
  );
  const countItems = db.query<{ count: number }, []>(
    "SELECT COUNT(*) AS count FROM agentmail_creator_digest_items",
  );
  const countPending = db.query<{ count: number }, []>(
    `SELECT COUNT(*) AS count
       FROM agentmail_creator_digest_batches b
       LEFT JOIN agentmail_creator_digest_watermarks w ON w.batch_id = b.batch_id
      WHERE w.batch_id IS NULL`,
  );
  const settledForMaintenance = db.query<BatchRow & WatermarkRow, []>(
    `SELECT b.*, w.inbox_id, w.generation, w.batch_id, w.content_sha256,
            w.disposition, w.evidence_sha256, w.advanced_at
       FROM agentmail_creator_digest_watermarks w
       JOIN agentmail_creator_digest_batches b ON b.batch_id = w.batch_id
      ORDER BY w.advanced_at ASC, w.batch_id ASC`,
  );
  const settledByInbox = db.query<BatchRow & WatermarkRow, [string, number]>(
    `SELECT b.*, w.inbox_id, w.generation, w.batch_id, w.content_sha256,
            w.disposition, w.evidence_sha256, w.advanced_at
      FROM agentmail_creator_digest_watermarks w
       JOIN agentmail_creator_digest_batches b ON b.batch_id = w.batch_id
      WHERE w.inbox_id = ?
      ORDER BY w.generation DESC
      LIMIT ?`,
  );
  const exactItemIsCurrent = db.query<
    { present: number },
    [string, string, number, number, string]
  >(
    `SELECT 1 AS present
       FROM agentmail_inbound_messages m
       LEFT JOIN agentmail_creator_attention a
         ON a.inbox_id = m.inbox_id AND a.message_id = m.message_id
       LEFT JOIN agentmail_inbound_quarantines q
         ON q.inbox_id = m.inbox_id AND q.message_id = m.message_id
      WHERE m.inbox_id = ? AND m.message_id = ?
        AND COALESCE(a.record_version, 0) = ?
        AND COALESCE(q.incident_version, 0) = ?
        AND COALESCE(q.incident_id, '') = ?
        AND (
          (
            m.state = 'processed'
            AND q.incident_id IS NULL
            AND a.state IN ('open', 'pending_review', 'ambiguous')
          )
          OR
          (m.state = 'processing' AND q.incident_id IS NOT NULL)
        )
      LIMIT 1`,
  );
  const deleteWatermark = db.query(
    "DELETE FROM agentmail_creator_digest_watermarks WHERE batch_id = ?",
  );
  const selectRetirementBefore = db.query<RetirementRangeRow, [string, number]>(
    `SELECT * FROM agentmail_creator_digest_retirement_ranges
      WHERE inbox_id = ? AND through_generation = ?`,
  );
  const selectRetirementAfter = db.query<RetirementRangeRow, [string, number]>(
    `SELECT * FROM agentmail_creator_digest_retirement_ranges
      WHERE inbox_id = ? AND from_generation = ?`,
  );
  const insertRetirementRange = db.query(
    `INSERT INTO agentmail_creator_digest_retirement_ranges (
       inbox_id, from_generation, through_generation, evidence_sha256,
       through_advanced_at, retired_at
     ) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const deleteRetirementRange = db.query(
    `DELETE FROM agentmail_creator_digest_retirement_ranges
      WHERE inbox_id = ? AND from_generation = ?`,
  );
  const deleteInboxRetirementRanges = db.query(
    "DELETE FROM agentmail_creator_digest_retirement_ranges WHERE inbox_id = ?",
  );
  const deleteBatch = db.query("DELETE FROM agentmail_creator_digest_batches WHERE batch_id = ?");
  const countItemsByBatch = db.query<{ count: number }, [string]>(
    "SELECT COUNT(*) AS count FROM agentmail_creator_digest_items WHERE batch_id = ?",
  );
  const inboxBatches = db.query<{ batch_id: string }, [string]>(
    "SELECT batch_id FROM agentmail_creator_digest_batches WHERE inbox_id = ?",
  );

  function clock(): number {
    const value = options.now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("agentMail creator digest: clock returned an invalid timestamp");
    }
    return value;
  }

  function currentGeneration(inboxId: string): {
    generation: number;
    advancedAt: number;
  } {
    const row = selectGeneration.get(inboxId, inboxId);
    return row
      ? { generation: row.generation, advancedAt: row.advanced_at }
      : { generation: 0, advancedAt: 0 };
  }

  function batchRecord(batch: BatchRow): AgentMailCreatorDigestBatch {
    const items = selectItems.all(batch.batch_id).map(itemRecord);
    const watermark = selectWatermarkByBatch.get(batch.batch_id);
    return {
      id: batch.batch_id,
      inboxId: batch.inbox_id,
      baseGeneration: batch.base_generation,
      deliveryTargetSha256: batch.delivery_target_sha256,
      contentSha256: batch.content_sha256,
      createdAt: batch.created_at,
      items,
      ...(watermark
        ? {
            settlement: {
              generation: watermark.generation,
              disposition: watermark.disposition,
              evidenceSha256: watermark.evidence_sha256,
              advancedAt: watermark.advanced_at,
            },
          }
        : {}),
    };
  }

  function itemIsCurrent(item: ItemRow): boolean {
    return Boolean(
      exactItemIsCurrent.get(
        item.inbox_id,
        item.message_id,
        item.attention_version,
        item.incident_version,
        item.incident_id ?? "",
      ),
    );
  }

  function reclaimableBatches(
    now: number,
    pressure: boolean,
  ): Array<{
    batchId: string;
    itemCount: number;
    inboxId: string;
    generation: number;
    contentSha256: string;
    disposition: AgentMailCreatorDigestDisposition;
    evidenceSha256: string;
    advancedAt: number;
  }> {
    const rows = settledForMaintenance.all();
    const byInbox = new Map<string, Array<BatchRow & WatermarkRow>>();
    for (const row of rows) {
      const group = byInbox.get(row.inbox_id) ?? [];
      group.push(row);
      byInbox.set(row.inbox_id, group);
    }
    const cutoff = Math.max(0, now - retentionMs);
    const reclaimable: Array<{
      batchId: string;
      itemCount: number;
      advancedAt: number;
      inboxId: string;
      generation: number;
      contentSha256: string;
      disposition: AgentMailCreatorDigestDisposition;
      evidenceSha256: string;
    }> = [];
    for (const group of byInbox.values()) {
      group.sort((left, right) => left.generation - right.generation);
      for (const row of group.slice(0, -1)) {
        if (!pressure && row.advanced_at > cutoff) continue;
        const items = selectItems.all(row.batch_id);
        if (
          (row.disposition === "presented" || row.disposition === "dismissed") &&
          items.some(itemIsCurrent)
        ) {
          continue;
        }
        reclaimable.push({
          batchId: row.batch_id,
          itemCount: items.length,
          advancedAt: row.advanced_at,
          inboxId: row.inbox_id,
          generation: row.generation,
          contentSha256: row.content_sha256,
          disposition: row.disposition,
          evidenceSha256: row.evidence_sha256,
        });
      }
    }
    return reclaimable
      .sort(
        (left, right) =>
          left.advancedAt - right.advancedAt ||
          (left.inboxId < right.inboxId ? -1 : left.inboxId > right.inboxId ? 1 : 0) ||
          left.generation - right.generation,
      )
      .slice(0, MAX_MAINTENANCE_DELETE)
      .map((candidate) => candidate);
  }

  function deleteReclaimable(
    candidates: readonly {
      batchId: string;
      itemCount: number;
      inboxId: string;
      generation: number;
      contentSha256: string;
      disposition: AgentMailCreatorDigestDisposition;
      evidenceSha256: string;
      advancedAt: number;
    }[],
    requiredBatches = 0,
    requiredItems = 0,
  ): { batches: number; items: number } {
    let batchCount = countBatches.get()?.count ?? 0;
    let itemCount = countItems.get()?.count ?? 0;
    let deletedBatches = 0;
    let deletedItems = 0;
    for (const candidate of candidates) {
      if (
        requiredBatches > 0 || requiredItems > 0
          ? batchCount + requiredBatches <= maxBatches && itemCount + requiredItems <= maxItems
          : false
      ) {
        break;
      }
      const before = selectRetirementBefore.get(candidate.inboxId, candidate.generation - 1);
      const after = selectRetirementAfter.get(candidate.inboxId, candidate.generation + 1);
      if (before) deleteRetirementRange.run(before.inbox_id, before.from_generation);
      if (after) deleteRetirementRange.run(after.inbox_id, after.from_generation);
      const retiredAt = Math.max(
        clock(),
        candidate.advancedAt,
        before?.retired_at ?? 0,
        after?.retired_at ?? 0,
      );
      const evidenceSha256 = sha256(
        JSON.stringify([
          "agentmail-creator-digest-retirement/v1",
          before
            ? [
                before.from_generation,
                before.through_generation,
                before.evidence_sha256,
                before.through_advanced_at,
              ]
            : null,
          [
            candidate.generation,
            candidate.batchId,
            candidate.contentSha256,
            candidate.disposition,
            candidate.evidenceSha256,
            candidate.advancedAt,
          ],
          after
            ? [
                after.from_generation,
                after.through_generation,
                after.evidence_sha256,
                after.through_advanced_at,
              ]
            : null,
        ]),
      );
      insertRetirementRange.run(
        candidate.inboxId,
        before?.from_generation ?? candidate.generation,
        after?.through_generation ?? candidate.generation,
        evidenceSha256,
        after?.through_advanced_at ?? candidate.advancedAt,
        retiredAt,
      );
      if (deleteWatermark.run(candidate.batchId).changes !== 1) {
        throw new Error(
          `agentMail creator digest: failed to retire watermark ${candidate.batchId}`,
        );
      }
      const actualItems = countItemsByBatch.get(candidate.batchId)?.count ?? candidate.itemCount;
      const deleted = deleteBatch.run(candidate.batchId).changes;
      if (deleted < 1) {
        throw new Error(
          `agentMail creator digest: failed to prune settled batch ${candidate.batchId} (${deleted} changes)`,
        );
      }
      batchCount--;
      itemCount -= actualItems;
      deletedBatches++;
      deletedItems += actualItems;
    }
    return { batches: deletedBatches, items: deletedItems };
  }

  function pruneInTransaction(timestamp: number): { batches: number; items: number } {
    return deleteReclaimable(reclaimableBatches(timestamp, false));
  }

  function ensureCapacity(timestamp: number, requiredItems: number): void {
    let batches = countBatches.get()?.count ?? 0;
    let items = countItems.get()?.count ?? 0;
    if (batches + 1 <= maxBatches && items + requiredItems <= maxItems) return;
    deleteReclaimable(reclaimableBatches(timestamp, true), 1, requiredItems);
    batches = countBatches.get()?.count ?? 0;
    items = countItems.get()?.count ?? 0;
    if (batches + 1 > maxBatches || items + requiredItems > maxItems) {
      throw new AgentMailCreatorDigestCapacityError(maxBatches, maxItems);
    }
  }

  return {
    prepare(input) {
      options.assertOpen();
      const inboxId = boundedIdentity(input.inboxId, "inboxId");
      const deliveryTargetSha256 = storedSha256(input.deliveryTargetSha256, "deliveryTargetSha256");
      const limit = safeInteger(input.limit ?? AGENTMAIL_DIGEST_DEFAULT_BATCH_SIZE, "limit", 1);
      if (limit > AGENTMAIL_DIGEST_MAX_BATCH_SIZE) {
        throw new Error(
          `agentMail creator digest: limit must be between 1 and ${AGENTMAIL_DIGEST_MAX_BATCH_SIZE}`,
        );
      }
      const timestamp = clock();
      return options.immediate(() => {
        pruneInTransaction(timestamp);
        const current = currentGeneration(inboxId);
        const pending = selectPending.get(inboxId, current.generation);
        if (pending) {
          const record = batchRecord(pending);
          if (record.deliveryTargetSha256 !== deliveryTargetSha256) {
            throw new AgentMailCreatorDigestTargetConflictError(record);
          }
          return record;
        }

        const candidates = selectCandidates.all(inboxId, limit);
        if (candidates.length === 0) return null;
        ensureCapacity(timestamp, candidates.length);
        const batchId = boundedIdentity(mintBatchId(), "generated batchId", 128);
        const createdAt = Math.max(timestamp, current.advancedAt);
        const items = candidates.map((candidate, ordinal) =>
          itemRecord({
            batch_id: batchId,
            ordinal,
            ...candidate,
          }),
        );
        const contentSha256 = canonicalBatchHash({
          batchId,
          inboxId,
          baseGeneration: current.generation,
          deliveryTargetSha256,
          items,
        });
        insertBatch.run(
          batchId,
          inboxId,
          current.generation,
          deliveryTargetSha256,
          items.length,
          contentSha256,
          createdAt,
        );
        for (const item of items) {
          insertItem.run(
            batchId,
            item.ordinal,
            item.inboxId,
            item.messageId,
            item.attentionVersion,
            item.attentionState ?? null,
            item.reviewId ?? null,
            item.incidentId ?? null,
            item.incidentVersion,
            item.incidentReasonCode ?? null,
            item.sourceAt,
          );
        }
        return batchRecord(selectBatch.get(batchId)!);
      });
    },

    get(batchIdInput) {
      options.assertOpen();
      const batchId = boundedIdentity(batchIdInput, "batchId", 128);
      const batch = selectBatch.get(batchId);
      return batch ? batchRecord(batch) : null;
    },

    getPending(inboxIdInput) {
      options.assertOpen();
      const inboxId = boundedIdentity(inboxIdInput, "inboxId");
      const current = currentGeneration(inboxId);
      const batch = selectPending.get(inboxId, current.generation);
      return batch ? batchRecord(batch) : null;
    },

    listSettled(inboxIdInput, limitInput = 100) {
      options.assertOpen();
      const inboxId = boundedIdentity(inboxIdInput, "inboxId");
      const limit = safeInteger(limitInput, "settled batch limit", 1);
      if (limit > 100_000) {
        throw new Error(
          "agentMail creator digest: settled batch limit must be between 1 and 100000",
        );
      }
      return settledByInbox.all(inboxId, limit).map(batchRecord);
    },

    isCurrent(batchIdInput) {
      options.assertOpen();
      const batchId = boundedIdentity(batchIdInput, "batchId", 128);
      const batch = selectBatch.get(batchId);
      if (!batch || selectWatermarkByBatch.get(batchId)) return false;
      const generation = currentGeneration(batch.inbox_id).generation;
      return batch.base_generation === generation && selectItems.all(batchId).every(itemIsCurrent);
    },

    settle(input) {
      options.assertOpen();
      const batchId = boundedIdentity(input.batchId, "batchId", 128);
      const expectedBaseGeneration = safeInteger(
        input.expectedBaseGeneration,
        "expectedBaseGeneration",
      );
      const expectedDeliveryTargetSha256 = storedSha256(
        input.expectedDeliveryTargetSha256,
        "expectedDeliveryTargetSha256",
      );
      const expectedContentSha256 = storedSha256(
        input.expectedContentSha256,
        "expectedContentSha256",
      );
      if (
        input.disposition !== "presented" &&
        input.disposition !== "dismissed" &&
        input.disposition !== "confirmed-no-effect"
      ) {
        throw new Error("agentMail creator digest: disposition is invalid");
      }
      const evidence = boundedIdentity(input.evidence, "settlement evidence", 400);
      const evidenceSha256 = sha256(evidence);
      const timestamp = clock();
      return options.immediate(() => {
        const batch = selectBatch.get(batchId);
        if (!batch) return { status: "conflict", generation: 0 } as const;
        const current = currentGeneration(batch.inbox_id);
        const existing = selectWatermarkByBatch.get(batchId);
        if (existing) {
          if (
            existing.generation === batch.base_generation + 1 &&
            batch.delivery_target_sha256 === expectedDeliveryTargetSha256 &&
            existing.content_sha256 === expectedContentSha256 &&
            existing.disposition === input.disposition &&
            existing.evidence_sha256 === evidenceSha256
          ) {
            return { status: "already_settled", generation: existing.generation } as const;
          }
          return { status: "conflict", generation: current.generation } as const;
        }
        if (
          batch.base_generation !== expectedBaseGeneration ||
          batch.delivery_target_sha256 !== expectedDeliveryTargetSha256 ||
          batch.content_sha256 !== expectedContentSha256 ||
          current.generation !== batch.base_generation
        ) {
          return { status: "conflict", generation: current.generation } as const;
        }
        const items = selectItems.all(batchId).map(itemRecord);
        if (
          items.length !== batch.item_count ||
          canonicalBatchHash({
            batchId,
            inboxId: batch.inbox_id,
            baseGeneration: batch.base_generation,
            deliveryTargetSha256: batch.delivery_target_sha256,
            items,
          }) !== batch.content_sha256
        ) {
          throw new Error("agentMail creator digest: batch content changed before settlement");
        }
        const generation = batch.base_generation + 1;
        if (!Number.isSafeInteger(generation)) {
          throw new Error("agentMail creator digest: generation exceeds the safe integer range");
        }
        insertWatermark.run(
          batch.inbox_id,
          generation,
          batchId,
          batch.content_sha256,
          input.disposition,
          evidenceSha256,
          Math.max(timestamp, current.advancedAt, batch.created_at),
        );
        return { status: "settled", generation } as const;
      });
    },

    counts() {
      options.assertOpen();
      return {
        batches: countBatches.get()?.count ?? 0,
        items: countItems.get()?.count ?? 0,
        pending: countPending.get()?.count ?? 0,
      };
    },

    prune() {
      options.assertOpen();
      const timestamp = clock();
      return options.immediate(() => pruneInTransaction(timestamp));
    },

    purgeInbox(inboxIdInput) {
      options.assertOpen();
      const inboxId = boundedIdentity(inboxIdInput, "inboxId");
      return options.immediate(() => {
        const batches = inboxBatches.all(inboxId);
        let deletedBatches = 0;
        let deletedItems = 0;
        for (const batch of batches) {
          deletedItems += countItemsByBatch.get(batch.batch_id)?.count ?? 0;
          deleteWatermark.run(batch.batch_id);
          if (deleteBatch.run(batch.batch_id).changes > 0) deletedBatches++;
        }
        deleteInboxRetirementRanges.run(inboxId);
        return { batches: deletedBatches, items: deletedItems };
      });
    },
  };
}
