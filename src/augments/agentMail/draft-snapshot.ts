import { createHash } from "node:crypto";
import type { AgentMailDraft } from "./provider";
import type { AgentMailProviderDraftKind } from "./store";

export interface AgentMailDraftSnapshot {
  kind: AgentMailProviderDraftKind;
  sourceMessageId?: string;
  providerRevision: string;
  providerUpdatedAt: number;
  materialHash: string;
  sendAt?: number;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`;
}

function digest(domain: string, value: unknown): string {
  return createHash("sha256")
    .update(`${domain}\0`, "utf8")
    .update(canonicalJson(value), "utf8")
    .digest("hex");
}

function sourceForKind(
  draft: AgentMailDraft,
  kind: AgentMailProviderDraftKind,
): string | undefined {
  if (draft.inReplyTo !== undefined && draft.forwardOf !== undefined) {
    throw new Error("AgentMail draft cannot be both a reply and a forward.");
  }
  if (kind === "new") {
    if (draft.inReplyTo !== undefined || draft.forwardOf !== undefined) {
      throw new Error("AgentMail new draft unexpectedly references a source message.");
    }
    return undefined;
  }
  if (kind === "forward") {
    if (!draft.forwardOf || draft.inReplyTo !== undefined) {
      throw new Error("AgentMail forward draft no longer preserves its source message.");
    }
    return draft.forwardOf;
  }
  if (!draft.inReplyTo || draft.forwardOf !== undefined) {
    throw new Error("AgentMail reply draft no longer preserves its source message.");
  }
  return draft.inReplyTo;
}

/**
 * Hash the exact provider-significant draft material without persisting it.
 * Provider timestamps, previews, and expiring URLs are deliberately excluded.
 */
export function snapshotAgentMailDraft(
  draft: AgentMailDraft,
  kind: AgentMailProviderDraftKind,
): AgentMailDraftSnapshot {
  if (!Number.isSafeInteger(draft.updatedAt) || draft.updatedAt < 0) {
    throw new Error("AgentMail draft has an invalid provider revision timestamp.");
  }
  const sourceMessageId = sourceForKind(draft, kind);
  const material = {
    version: 1,
    inboxId: draft.inboxId,
    draftId: draft.draftId,
    kind,
    sourceMessageId: sourceMessageId ?? null,
    clientId: draft.clientId ?? null,
    labels: [...(draft.labels ?? [])],
    replyTo: [...(draft.replyTo ?? [])],
    to: [...draft.to],
    cc: [...draft.cc],
    bcc: [...draft.bcc],
    subject: draft.subject ?? null,
    text: draft.text ?? null,
    html: draft.html ?? null,
    attachments: (draft.attachments ?? []).map((attachment) => ({
      attachmentId: attachment.attachmentId,
      filename: attachment.filename ?? null,
      size: attachment.size,
      contentType: attachment.contentType ?? null,
      contentDisposition: attachment.contentDisposition ?? null,
      contentId: attachment.contentId ?? null,
    })),
    inReplyTo: draft.inReplyTo ?? null,
    forwardOf: draft.forwardOf ?? null,
    references: [...(draft.references ?? [])],
    sendStatus: draft.sendStatus ?? null,
    sendAt: draft.sendAt ?? null,
  };
  const materialHash = digest("agentmail-draft-material/v1", material);
  const providerRevision = `sha256:${digest("agentmail-draft-revision/v1", {
    materialHash,
    updatedAt: draft.updatedAt,
  })}`;
  return {
    kind,
    ...(sourceMessageId === undefined ? {} : { sourceMessageId }),
    providerRevision,
    providerUpdatedAt: draft.updatedAt,
    materialHash,
    ...(draft.sendAt === undefined ? {} : { sendAt: draft.sendAt }),
  };
}

export function assertAgentMailDraftIdentity(
  draft: AgentMailDraft,
  input: {
    inboxId: string;
    draftId: string;
    kind: AgentMailProviderDraftKind;
    sourceMessageId?: string;
  },
): AgentMailDraftSnapshot {
  if (draft.inboxId !== input.inboxId || draft.draftId !== input.draftId) {
    throw new Error("AgentMail returned a draft outside the managed inbox boundary.");
  }
  const snapshot = snapshotAgentMailDraft(draft, input.kind);
  if (snapshot.sourceMessageId !== input.sourceMessageId) {
    throw new Error("AgentMail draft source identity changed.");
  }
  return snapshot;
}
