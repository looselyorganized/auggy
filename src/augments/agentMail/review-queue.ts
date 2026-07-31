/**
 * Durable, fail-closed review queue for AgentMail outbound actions.
 *
 * The generic kernel approval gate is skip-only in v1. AgentMail needs a
 * concrete queue because an email must not be sent until an operator has
 * reviewed the exact action, and that decision must survive a restart.
 */

import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { z } from "zod";
import type { TrustLevel } from "../../types";
import { readDurableJson, writeDurableJson } from "../../lib/durable-json";

const REVIEW_FILE = "agent-mail-reviews.json";
const REVIEW_VERSION = 1;
const MAX_RECORDS = 1_000;
const TERMINAL_RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_REVIEW_FILE_BYTES = 120 * 1024 * 1024;
const MAX_BODY_CHARS = 1024 * 1024;
const recipientSchema = z.string().min(1).max(320);
const recipientsSchema = z.array(recipientSchema).min(1).max(50);
const subjectSchema = z.string().max(1_000);
const messageIdSchema = z.string().min(1).max(256);
const labelsSchema = z.array(z.string().min(1).max(200)).max(100);
const bodySchema = z.string().max(MAX_BODY_CHARS);

const sendRequestSchema = z.object({
  kind: z.literal("send"),
  to: recipientsSchema,
  subject: subjectSchema,
  text: bodySchema,
  html: bodySchema.optional(),
  labels: labelsSchema.optional(),
});

const replyRequestSchema = z.object({
  kind: z.literal("reply"),
  messageId: messageIdSchema,
  /**
   * Explicit recipient binding for inbound replies. Legacy persisted reviews
   * may omit this and retain AgentMail's server-derived reply behavior.
   */
  to: recipientsSchema.optional(),
  /** Exact creator-attention generation that authorized an inbound reply. */
  attentionVersion: z.number().int().positive().optional(),
  text: bodySchema,
  html: bodySchema.optional(),
  replyAll: z.boolean().optional(),
  labels: labelsSchema.optional(),
});

const forwardRequestSchema = z.object({
  kind: z.literal("forward"),
  messageId: messageIdSchema,
  to: recipientsSchema,
  subject: subjectSchema.optional(),
  text: bodySchema.optional(),
  html: bodySchema.optional(),
  labels: labelsSchema.optional(),
});

export const agentMailReviewRequestSchema = z.discriminatedUnion("kind", [
  sendRequestSchema,
  replyRequestSchema,
  forwardRequestSchema,
]);

export type AgentMailReviewRequest = z.infer<typeof agentMailReviewRequestSchema>;
export type AgentMailReviewState =
  | "pending"
  | "sending"
  | "approved"
  | "rejected"
  | "expired"
  | "failed";

const recordSchema = z.object({
  id: z.string().min(1).max(128),
  state: z.enum(["pending", "sending", "approved", "rejected", "expired", "failed"]),
  trustLevel: z.enum(["creator", "agent", "public"]),
  createdAt: z.number().int().nonnegative(),
  attemptedAt: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().optional(),
  recipients: recipientsSchema,
  subject: subjectSchema,
  rateKey: z.string().min(1).max(4_096),
  fingerprint: z.string().min(1).max(256),
  request: agentMailReviewRequestSchema,
  detail: z.string().max(500).optional(),
  providerMessageId: z.string().min(1).max(256).optional(),
  providerThreadId: z.string().min(1).max(256).optional(),
});

const fileSchema = z.object({
  version: z.literal(REVIEW_VERSION),
  savedAt: z.string().max(64),
  records: z.array(recordSchema).max(MAX_RECORDS),
});

export interface AgentMailReviewRecord {
  id: string;
  state: AgentMailReviewState;
  trustLevel: TrustLevel;
  createdAt: number;
  /** Timestamp immediately before the durable attempt may reach the provider. */
  attemptedAt?: number;
  expiresAt: number;
  resolvedAt?: number;
  recipients: string[];
  subject: string;
  rateKey: string;
  fingerprint: string;
  request: AgentMailReviewRequest;
  detail?: string;
  providerMessageId?: string;
  providerThreadId?: string;
}

export interface AgentMailReviewQueue {
  enqueue(input: {
    trustLevel: TrustLevel;
    recipients: string[];
    subject: string;
    rateKey: string;
    fingerprint: string;
    request: AgentMailReviewRequest;
    expiresAt: number;
  }): { record: AgentMailReviewRecord; duplicate: boolean };
  list(): AgentMailReviewRecord[];
  get(id: string): AgentMailReviewRecord | undefined;
  /**
   * Compare-and-set a pending draft body. Recipient, kind, and provider
   * message bindings are immutable; callers must supply a new fingerprint
   * covering the revised request.
   */
  revise(input: {
    id: string;
    expectedFingerprint: string;
    request: AgentMailReviewRequest;
    fingerprint: string;
  }): AgentMailReviewRecord;
  beginApproval(id: string): AgentMailReviewRecord;
  approve(
    id: string,
    result: { messageId?: string; threadId?: string; detail?: string },
  ): AgentMailReviewRecord;
  reject(id: string, detail?: string): AgentMailReviewRecord;
  /** Cancel a still-pending action before an operator-approved inbound retry. */
  cancel(id: string, detail: string): AgentMailReviewRecord;
  fail(id: string, detail: string): AgentMailReviewRecord;
}

export interface AgentMailReviewQueueOptions {
  stateDir?: string;
  /** @deprecated Use stateDir. Retained for direct-call compatibility. */
  agentDir?: string;
  now?: () => number;
  id?: () => string;
}

function clone(record: AgentMailReviewRecord): AgentMailReviewRecord {
  return structuredClone(record);
}

function immutableRequestBinding(request: AgentMailReviewRequest): string {
  const { text: _text, html: _html, ...binding } = request;
  return JSON.stringify(binding);
}

function reviewPath(agentDir: string): string {
  return join(agentDir, REVIEW_FILE);
}

export function createAgentMailReviewQueue(
  options: AgentMailReviewQueueOptions = {},
): AgentMailReviewQueue {
  const now = options.now ?? Date.now;
  const nextId = options.id ?? randomUUID;
  const stateDir = options.stateDir ?? options.agentDir;
  const path = stateDir ? reviewPath(stateDir) : undefined;
  let records: AgentMailReviewRecord[] = [];

  if (path) {
    const raw = readDurableJson(path, "agentMail review queue", MAX_REVIEW_FILE_BYTES);
    if (raw !== null) {
      const parsed = fileSchema.safeParse(raw);
      if (!parsed.success) {
        throw new Error(`agentMail review queue: ${path} failed validation`);
      }
      records = parsed.data.records;
    }
  }

  function clock(): number {
    const value = now();
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("agentMail review queue: clock returned an invalid timestamp");
    }
    return value;
  }

  function persist(nextRecords = records): void {
    if (!path) return;
    const payload = {
      version: REVIEW_VERSION,
      savedAt: new Date(clock()).toISOString(),
      records: nextRecords,
    };
    if (Buffer.byteLength(JSON.stringify(payload), "utf8") > MAX_REVIEW_FILE_BYTES) {
      throw new Error(
        `agentMail review queue: durable payload exceeds ${MAX_REVIEW_FILE_BYTES} bytes; resolve pending reviews before adding mail`,
      );
    }
    writeDurableJson(path, payload, "agentMail review queue");
  }

  function expire(): void {
    const timestamp = clock();
    let changed = false;
    for (const record of records) {
      if (record.state === "pending" && record.expiresAt <= timestamp) {
        record.state = "expired";
        record.resolvedAt = timestamp;
        record.detail = "review window expired";
        changed = true;
      }
    }
    if (changed) persist();
  }

  function pruneForEnqueue(): void {
    const cutoff = clock() - TERMINAL_RETENTION_MS;
    const before = records.length;
    records = records.filter(
      (record) =>
        record.state === "pending" ||
        record.state === "sending" ||
        record.resolvedAt === undefined ||
        record.resolvedAt > cutoff,
    );
    if (records.length >= MAX_RECORDS) {
      const terminal = records
        .filter((record) => record.state !== "pending" && record.state !== "sending")
        .sort((a, b) => (a.resolvedAt ?? a.createdAt) - (b.resolvedAt ?? b.createdAt));
      for (const candidate of terminal) {
        if (records.length < MAX_RECORDS) break;
        records = records.filter((record) => record.id !== candidate.id);
      }
    }
    if (records.length !== before) persist();
    if (records.length >= MAX_RECORDS) {
      throw new Error(
        `agentMail review queue: capacity ${MAX_RECORDS} reached; resolve pending reviews before adding mail`,
      );
    }
  }

  function requireRecord(id: string): AgentMailReviewRecord {
    expire();
    const record = records.find((candidate) => candidate.id === id);
    if (!record) throw new Error(`agentMail review queue: unknown review id "${id}"`);
    return record;
  }

  function requireState(id: string, state: AgentMailReviewState): AgentMailReviewRecord {
    const record = requireRecord(id);
    if (record.state !== state) {
      throw new Error(
        `agentMail review queue: review "${id}" is ${record.state}, expected ${state}`,
      );
    }
    return record;
  }

  return {
    enqueue(input) {
      expire();
      const ambiguous = records.find(
        (record) => record.state === "sending" && record.fingerprint === input.fingerprint,
      );
      if (ambiguous) {
        throw new Error(
          `agentMail review queue: matching review "${ambiguous.id}" has ambiguous sending state; operator reconciliation is required`,
        );
      }
      const existing = records.find(
        (record) => record.state === "pending" && record.fingerprint === input.fingerprint,
      );
      if (existing) return { record: clone(existing), duplicate: true };
      pruneForEnqueue();

      const createdAt = clock();
      if (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= createdAt) {
        throw new Error("agentMail review queue: expiresAt must be in the future");
      }
      const request = agentMailReviewRequestSchema.parse(input.request);
      const record = recordSchema.parse({
        id: nextId(),
        state: "pending",
        trustLevel: input.trustLevel,
        createdAt,
        expiresAt: input.expiresAt,
        recipients: input.recipients,
        subject: input.subject,
        rateKey: input.rateKey,
        fingerprint: input.fingerprint,
        request,
      }) as AgentMailReviewRecord;
      const nextRecords = [...records, record];
      persist(nextRecords);
      records = nextRecords;
      return { record: clone(record), duplicate: false };
    },

    list() {
      expire();
      return records.map(clone);
    },

    get(id) {
      const record = records.find((candidate) => candidate.id === id);
      if (!record) return undefined;
      expire();
      return clone(record);
    },

    revise(input) {
      const record = requireState(input.id, "pending");
      if (record.fingerprint !== input.expectedFingerprint) {
        throw new Error(
          `agentMail review queue: review "${input.id}" fingerprint changed before revision`,
        );
      }
      const request = agentMailReviewRequestSchema.parse(input.request);
      if (immutableRequestBinding(record.request) !== immutableRequestBinding(request)) {
        throw new Error(
          `agentMail review queue: review "${input.id}" immutable delivery binding changed`,
        );
      }
      if (!input.fingerprint) {
        throw new Error("agentMail review queue: revised fingerprint is required");
      }
      const revised = {
        ...record,
        request,
        fingerprint: z.string().min(1).max(256).parse(input.fingerprint),
      };
      const nextRecords = records.map((candidate) =>
        candidate.id === record.id ? revised : candidate,
      );
      persist(nextRecords);
      records = nextRecords;
      return clone(revised);
    },

    beginApproval(id) {
      const record = requireState(id, "pending");
      record.state = "sending";
      record.attemptedAt = clock();
      persist();
      return clone(record);
    },

    approve(id, result) {
      const record = requireState(id, "sending");
      record.state = "approved";
      record.resolvedAt = clock();
      record.providerMessageId = result.messageId
        ? messageIdSchema.parse(result.messageId)
        : undefined;
      record.providerThreadId = result.threadId
        ? messageIdSchema.parse(result.threadId)
        : undefined;
      record.detail = result.detail?.slice(0, 500);
      persist();
      return clone(record);
    },

    reject(id, detail = "rejected by operator") {
      const record = requireState(id, "pending");
      record.state = "rejected";
      record.resolvedAt = clock();
      record.detail = detail.slice(0, 500);
      persist();
      return clone(record);
    },

    cancel(id, detail) {
      const record = requireState(id, "pending");
      record.state = "failed";
      record.resolvedAt = clock();
      record.detail = detail.slice(0, 500);
      persist();
      return clone(record);
    },

    fail(id, detail) {
      const record = requireState(id, "sending");
      record.state = "failed";
      record.resolvedAt = clock();
      record.detail = detail.slice(0, 500);
      persist();
      return clone(record);
    },
  };
}
