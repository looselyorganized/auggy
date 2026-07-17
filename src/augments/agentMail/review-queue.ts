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

const sendRequestSchema = z.object({
  kind: z.literal("send"),
  to: z.array(z.string()).min(1),
  subject: z.string(),
  text: z.string(),
  html: z.string().optional(),
  labels: z.array(z.string()).optional(),
});

const replyRequestSchema = z.object({
  kind: z.literal("reply"),
  messageId: z.string().min(1),
  text: z.string(),
  html: z.string().optional(),
  replyAll: z.boolean().optional(),
  labels: z.array(z.string()).optional(),
});

const forwardRequestSchema = z.object({
  kind: z.literal("forward"),
  messageId: z.string().min(1),
  to: z.array(z.string()).min(1),
  subject: z.string().optional(),
  text: z.string().optional(),
  html: z.string().optional(),
  labels: z.array(z.string()).optional(),
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
  id: z.string().min(1),
  state: z.enum(["pending", "sending", "approved", "rejected", "expired", "failed"]),
  trustLevel: z.enum(["creator", "agent", "public"]),
  createdAt: z.number().int().nonnegative(),
  attemptedAt: z.number().int().nonnegative().optional(),
  expiresAt: z.number().int().nonnegative(),
  resolvedAt: z.number().int().nonnegative().optional(),
  recipients: z.array(z.string()).min(1),
  subject: z.string(),
  rateKey: z.string(),
  fingerprint: z.string().min(1),
  request: agentMailReviewRequestSchema,
  detail: z.string().optional(),
  providerMessageId: z.string().optional(),
  providerThreadId: z.string().optional(),
});

const fileSchema = z.object({
  version: z.literal(REVIEW_VERSION),
  savedAt: z.string(),
  records: z.array(recordSchema),
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
  beginApproval(id: string): AgentMailReviewRecord;
  approve(
    id: string,
    result: { messageId?: string; threadId?: string; detail?: string },
  ): AgentMailReviewRecord;
  reject(id: string, detail?: string): AgentMailReviewRecord;
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
    const raw = readDurableJson(path, "agentMail review queue");
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

  function persist(): void {
    if (!path) return;
    writeDurableJson(
      path,
      {
        version: REVIEW_VERSION,
        savedAt: new Date(clock()).toISOString(),
        records,
      },
      "agentMail review queue",
    );
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
      const record: AgentMailReviewRecord = {
        id: nextId(),
        state: "pending",
        trustLevel: input.trustLevel,
        createdAt,
        expiresAt: input.expiresAt,
        recipients: [...input.recipients],
        subject: input.subject,
        rateKey: input.rateKey,
        fingerprint: input.fingerprint,
        request,
      };
      records.push(record);
      persist();
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
      record.providerMessageId = result.messageId;
      record.providerThreadId = result.threadId;
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
