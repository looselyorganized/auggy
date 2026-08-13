import { createHash } from "node:crypto";
import type { PeerIdentity, TrustLevel } from "../../types";
import { canonicalizeEmail, isWellFormedEmail } from "../visitorAuth/email-validation";
import type { ValidatedAgentMailConfig } from "./config";
import type { AgentMailMessageClassification } from "./provider";

export type AgentMailAdmissionDecision =
  | {
      admitted: true;
      sender: string;
      peer: PeerIdentity;
      replyDisposition: "none" | "review";
    }
  | {
      admitted: false;
      reason: "malformed_sender" | "classification_blocked" | "sender_not_allowed";
    };

export type AgentMailOutboundPolicyDecision =
  | { allowed: true; recipients: string[]; subject: string }
  | {
      allowed: false;
      reason:
        | "trust_not_allowed"
        | "recipient_malformed"
        | "recipient_not_allowed"
        | "recipient_limit_exceeded"
        | "subject_invalid"
        | "body_limit_exceeded";
    };

export interface AgentMailRecipients {
  to?: readonly string[];
  cc?: readonly string[];
  bcc?: readonly string[];
}

export interface NormalizedAgentMailRecipients {
  to: string[];
  cc: string[];
  bcc: string[];
}

export interface AgentMailPolicyAttachment {
  attachmentId?: string;
  sha256: string;
  size: number;
  contentType: string;
}

export type AgentMailOperation =
  | "list_messages"
  | "list_threads"
  | "search_messages"
  | "search_threads"
  | "get_message"
  | "get_thread"
  | "update_message_labels"
  | "update_thread_labels"
  | "get_attachment"
  | "create_new_draft"
  | "create_reply_draft"
  | "create_reply_all_draft"
  | "create_forward_draft"
  | "update_draft"
  | "schedule_draft"
  | "unschedule_draft"
  | "send_message"
  | "send_draft"
  | "reply"
  | "reply_all"
  | "forward"
  | "delete_message"
  | "delete_thread"
  | "delete_draft";

export interface AgentMailOperationAuthority {
  peerId: string;
  trustLevel: TrustLevel;
  /** `system` is reserved for the registered augment's inbound event worker. */
  origin: "creator" | "agent" | "inbound" | "system";
  sourceAugment?: string;
}

export interface AgentMailOperationInput {
  action: AgentMailOperation;
  authority: AgentMailOperationAuthority;
  creatorPeerId: string;
  registeredAugment: string;
  messageId?: string;
  threadId?: string;
  draftId?: string;
  attachmentId?: string;
  listLimit?: number;
  searchQuery?: string;
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  recipients?: AgentMailRecipients;
  subject?: string;
  text?: string;
  html?: string;
  attachments?: readonly AgentMailPolicyAttachment[];
  sendAt?: number;
  providerRevision?: string;
}

export type AgentMailOperationDenialReason =
  | "creator_required"
  | "inbound_origin_denied"
  | "system_source_invalid"
  | "operation_disabled"
  | "resource_invalid"
  | "list_limit_exceeded"
  | "search_query_invalid"
  | "label_mutation_disabled"
  | "label_not_allowed"
  | "attachment_access_disabled"
  | "trust_not_allowed"
  | "recipient_malformed"
  | "recipient_not_allowed"
  | "recipient_limit_exceeded"
  | "subject_invalid"
  | "body_limit_exceeded"
  | "html_not_allowed"
  | "attachment_limit_exceeded"
  | "attachment_too_large"
  | "attachment_total_exceeded"
  | "attachment_type_not_allowed"
  | "attachment_invalid"
  | "schedule_invalid";

export type AgentMailOperationDecision =
  | {
      allowed: true;
      recipients: NormalizedAgentMailRecipients;
      subject?: string;
      sendAt?: number;
    }
  | { allowed: false; reason: AgentMailOperationDenialReason };

export interface AgentMailOperationManifest {
  readonly version: 1;
  readonly action: AgentMailOperation;
  readonly inboxId: string;
  readonly resources: Readonly<{
    messageId: string | null;
    threadId: string | null;
    draftId: string | null;
    attachmentId: string | null;
  }>;
  readonly recipients: Readonly<{
    to: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
  }>;
  readonly body: Readonly<{
    subjectHash: string | null;
    textHash: string | null;
    htmlHash: string | null;
  }>;
  readonly attachments: readonly Readonly<{
    attachmentId: string | null;
    sha256: string;
    size: number;
    contentType: string;
  }>[];
  readonly source: Readonly<{
    origin: AgentMailOperationAuthority["origin"];
    peerId: string;
    trustLevel: TrustLevel;
    sourceAugment: string | null;
  }>;
  readonly sendAt: number | null;
  readonly providerRevision: string | null;
  readonly creatorPeerId: string;
  readonly policyGeneration: string;
}

export type AgentMailManifestDecision =
  | { allowed: true; manifest: AgentMailOperationManifest; hash: string }
  | { allowed: false; reason: AgentMailOperationDenialReason };

function matchesPattern(address: string, pattern: string): boolean {
  if (!pattern.startsWith("*@")) return address === pattern;
  return address.endsWith(pattern.slice(1));
}

function senderPeer(address: string, inboxId: string, sourceAugment: string): PeerIdentity {
  const digest = createHash("sha256").update(`${inboxId}\0${address}`).digest("hex");
  return {
    id: `mail_${digest.slice(0, 32)}`,
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment,
  };
}

/**
 * Admit one provider message without confusing a From address with Auggy
 * identity. Even an allowed sender remains a public, untrusted peer.
 */
export function evaluateAgentMailInbound(
  input: { sender: string; classification: AgentMailMessageClassification },
  config: ValidatedAgentMailConfig,
  sourceAugment: string,
): AgentMailAdmissionDecision {
  const sender = canonicalizeEmail(input.sender);
  if (!isWellFormedEmail(sender)) return { admitted: false, reason: "malformed_sender" };
  if (input.classification !== "received") {
    return { admitted: false, reason: "classification_blocked" };
  }
  const senderAllowed =
    config.inbound.senderPolicy === "any" ||
    config.inbound.allowedSenders.some((pattern) => matchesPattern(sender, pattern));
  if (config.inbound.mode === "none" || !senderAllowed) {
    return { admitted: false, reason: "sender_not_allowed" };
  }
  return {
    admitted: true,
    sender,
    peer: senderPeer(sender, config.inboxId, sourceAugment),
    replyDisposition: config.replies.mode === "review" ? "review" : "none",
  };
}

function trustAllowed(trustLevel: TrustLevel, allowed: readonly TrustLevel[]): boolean {
  return allowed.includes(trustLevel);
}

function normalizeRecipients(
  input: AgentMailRecipients | undefined,
  config: ValidatedAgentMailConfig,
  requireRecipient: boolean,
):
  | { allowed: true; recipients: NormalizedAgentMailRecipients }
  | { allowed: false; reason: Extract<AgentMailOperationDenialReason, `recipient_${string}`> } {
  const groups: NormalizedAgentMailRecipients = { to: [], cc: [], bcc: [] };
  const seen = new Set<string>();
  for (const group of ["to", "cc", "bcc"] as const) {
    const rawGroup = input?.[group] ?? [];
    if (!Array.isArray(rawGroup)) return { allowed: false, reason: "recipient_malformed" };
    for (const rawRecipient of rawGroup) {
      if (typeof rawRecipient !== "string") {
        return { allowed: false, reason: "recipient_malformed" };
      }
      const recipient = canonicalizeEmail(rawRecipient);
      if (!isWellFormedEmail(recipient) || seen.has(recipient)) {
        return { allowed: false, reason: "recipient_malformed" };
      }
      if (
        config.outbound.allowedRecipients !== undefined &&
        !config.outbound.allowedRecipients.some((pattern) => matchesPattern(recipient, pattern))
      ) {
        return { allowed: false, reason: "recipient_not_allowed" };
      }
      seen.add(recipient);
      groups[group].push(recipient);
    }
  }
  if ((requireRecipient && seen.size === 0) || seen.size > config.outbound.maxRecipients) {
    return { allowed: false, reason: "recipient_limit_exceeded" };
  }
  return { allowed: true, recipients: groups };
}

function subjectAllowed(subject: string | undefined, required: boolean): boolean {
  if (subject === undefined) return !required;
  return subject.length > 0 && subject.length <= 998 && !/[\r\n\0]/.test(subject);
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((entry) => {
    if (!entry.endsWith("/*")) return entry === normalized;
    return normalized.startsWith(`${entry.slice(0, -1)}`);
  });
}

function evaluateComposition(
  input: Pick<AgentMailOperationInput, "recipients" | "subject" | "text" | "html" | "attachments">,
  config: ValidatedAgentMailConfig,
  options: { requireRecipient: boolean; requireSubject: boolean },
): AgentMailOperationDecision {
  const recipientDecision = normalizeRecipients(input.recipients, config, options.requireRecipient);
  if (!recipientDecision.allowed) return recipientDecision;
  if (!subjectAllowed(input.subject, options.requireSubject)) {
    return { allowed: false, reason: "subject_invalid" };
  }
  if (input.html !== undefined && input.html !== "" && !config.outbound.allowHtml) {
    return { allowed: false, reason: "html_not_allowed" };
  }
  const bodyBytes =
    Buffer.byteLength(input.text ?? "", "utf8") + Buffer.byteLength(input.html ?? "", "utf8");
  if (bodyBytes > config.outbound.bodyMaxBytes) {
    return { allowed: false, reason: "body_limit_exceeded" };
  }
  const attachments = input.attachments ?? [];
  if (!Array.isArray(attachments) || attachments.length > config.outbound.maxAttachments) {
    return { allowed: false, reason: "attachment_limit_exceeded" };
  }
  let totalAttachmentBytes = 0;
  for (const attachment of attachments) {
    if (
      !attachment ||
      typeof attachment !== "object" ||
      !/^[a-f0-9]{64}$/i.test(attachment.sha256) ||
      typeof attachment.size !== "number" ||
      !Number.isSafeInteger(attachment.size) ||
      attachment.size < 0 ||
      typeof attachment.contentType !== "string" ||
      attachment.contentType.trim() === ""
    ) {
      return { allowed: false, reason: "attachment_invalid" };
    }
    if (attachment.size > config.outbound.maxAttachmentBytes) {
      return { allowed: false, reason: "attachment_too_large" };
    }
    totalAttachmentBytes += attachment.size;
    if (totalAttachmentBytes > config.outbound.maxTotalAttachmentBytes) {
      return { allowed: false, reason: "attachment_total_exceeded" };
    }
    if (!contentTypeAllowed(attachment.contentType, config.outbound.allowedAttachmentTypes)) {
      return { allowed: false, reason: "attachment_type_not_allowed" };
    }
  }
  return {
    allowed: true,
    recipients: recipientDecision.recipients,
    ...(input.subject === undefined ? {} : { subject: input.subject }),
  };
}

function legacyCompositionReason(
  reason: AgentMailOperationDenialReason,
): Exclude<AgentMailOutboundPolicyDecision, { allowed: true }>["reason"] {
  switch (reason) {
    case "recipient_malformed":
    case "recipient_not_allowed":
    case "recipient_limit_exceeded":
    case "subject_invalid":
    case "body_limit_exceeded":
      return reason;
    default:
      return "body_limit_exceeded";
  }
}

const PROVIDER_ID_PATTERN = /^[A-Za-z0-9._~@+\-:]+$/;

function validProviderIdentifier(value: string | undefined): boolean {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 512 &&
    PROVIDER_ID_PATTERN.test(value)
  );
}

function validManifestIdentity(value: string | undefined): boolean {
  return (
    typeof value === "string" && value.length > 0 && value.length <= 512 && !/[\0\r\n]/.test(value)
  );
}

function requireResource(input: AgentMailOperationInput): boolean {
  switch (input.action) {
    case "get_message":
    case "update_message_labels":
    case "delete_message":
    case "create_reply_draft":
    case "create_reply_all_draft":
    case "create_forward_draft":
    case "reply":
    case "reply_all":
    case "forward":
      return validProviderIdentifier(input.messageId);
    case "get_thread":
    case "update_thread_labels":
    case "delete_thread":
      return validProviderIdentifier(input.threadId);
    case "get_attachment":
      return (
        validProviderIdentifier(input.messageId) && validProviderIdentifier(input.attachmentId)
      );
    case "update_draft":
    case "schedule_draft":
    case "unschedule_draft":
    case "send_draft":
    case "delete_draft":
      return validProviderIdentifier(input.draftId);
    default:
      return true;
  }
}

function requiresProviderRevision(action: AgentMailOperation): boolean {
  return [
    "update_message_labels",
    "update_thread_labels",
    "create_reply_draft",
    "create_reply_all_draft",
    "create_forward_draft",
    "update_draft",
    "schedule_draft",
    "unschedule_draft",
    "send_draft",
    "reply",
    "reply_all",
    "forward",
    "delete_message",
    "delete_thread",
    "delete_draft",
  ].includes(action);
}

function creatorAuthorized(input: AgentMailOperationInput): boolean {
  return (
    input.authority.origin === "creator" &&
    input.authority.trustLevel === "creator" &&
    input.authority.peerId === input.creatorPeerId
  );
}

function systemDraftAuthorized(input: AgentMailOperationInput): boolean {
  return (
    input.authority.origin === "system" && input.authority.sourceAugment === input.registeredAugment
  );
}

function operationRequiresComposition(action: AgentMailOperation): boolean {
  return [
    "create_new_draft",
    "create_reply_draft",
    "create_reply_all_draft",
    "create_forward_draft",
    "update_draft",
    "schedule_draft",
    "send_message",
    "send_draft",
    "reply",
    "reply_all",
    "forward",
  ].includes(action);
}

/**
 * Central authorization and content policy for provider-native mail operations.
 * Provider labels, model memory, skills, and MCP arguments are deliberately not
 * authority inputs; authorization comes only from validated config and runtime
 * identity established by Auggy.
 */
export function evaluateAgentMailOperation(
  input: AgentMailOperationInput,
  config: ValidatedAgentMailConfig,
): AgentMailOperationDecision {
  if (input.authority.origin === "inbound") {
    return { allowed: false, reason: "inbound_origin_denied" };
  }
  const systemDraft =
    systemDraftAuthorized(input) &&
    (input.action === "create_reply_draft" || input.action === "create_reply_all_draft");
  if (input.authority.origin === "system" && !systemDraft) {
    return { allowed: false, reason: "system_source_invalid" };
  }
  if (!systemDraft && !creatorAuthorized(input)) {
    return { allowed: false, reason: "creator_required" };
  }
  if (!requireResource(input)) return { allowed: false, reason: "resource_invalid" };
  if (requiresProviderRevision(input.action) && !validManifestIdentity(input.providerRevision)) {
    return { allowed: false, reason: "resource_invalid" };
  }

  if (input.action === "list_messages" || input.action === "list_threads") {
    const limit = input.listLimit ?? config.mailbox.maxListResults;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.mailbox.maxListResults) {
      return { allowed: false, reason: "list_limit_exceeded" };
    }
  }
  if (input.action === "search_messages" || input.action === "search_threads") {
    const limit = input.listLimit ?? config.mailbox.maxListResults;
    if (
      !Number.isSafeInteger(limit) ||
      limit < 1 ||
      limit > config.mailbox.maxListResults ||
      typeof input.searchQuery !== "string" ||
      input.searchQuery.trim() === "" ||
      /[\0\r\n]/.test(input.searchQuery) ||
      Buffer.byteLength(input.searchQuery, "utf8") > config.mailbox.maxSearchQueryBytes
    ) {
      return { allowed: false, reason: "search_query_invalid" };
    }
  }
  if (input.action === "update_message_labels" || input.action === "update_thread_labels") {
    if (!config.mailbox.allowLabelMutation) {
      return { allowed: false, reason: "label_mutation_disabled" };
    }
    const add = input.addLabels ?? [];
    const remove = input.removeLabels ?? [];
    if (!Array.isArray(add) || !Array.isArray(remove)) {
      return { allowed: false, reason: "label_not_allowed" };
    }
    if (add.length + remove.length === 0) return { allowed: false, reason: "label_not_allowed" };
    if ([...add, ...remove].some((label) => typeof label !== "string")) {
      return { allowed: false, reason: "label_not_allowed" };
    }
    const normalized = [...add, ...remove].map((label) => label.trim().toLowerCase());
    if (
      normalized.some((label) => !config.mailbox.allowedLabels.includes(label)) ||
      new Set(normalized).size !== normalized.length
    ) {
      return { allowed: false, reason: "label_not_allowed" };
    }
  }
  if (input.action === "get_attachment" && !config.mailbox.allowAttachmentAccess) {
    return { allowed: false, reason: "attachment_access_disabled" };
  }

  const operationEnabled = (() => {
    switch (input.action) {
      case "create_new_draft":
        return config.drafts.allowNew;
      case "create_reply_draft":
        return systemDraft ? config.replies.mode === "review" : config.drafts.allowReply;
      case "create_reply_all_draft":
        return systemDraft
          ? config.replies.mode === "review" && config.replies.allowReplyAll
          : config.drafts.allowReply && config.drafts.allowReplyAll;
      case "create_forward_draft":
        return config.drafts.allowForward;
      case "update_draft":
        return config.drafts.allowNew || config.drafts.allowReply || config.drafts.allowForward;
      case "schedule_draft":
        return config.drafts.allowScheduling;
      case "send_message":
      case "reply":
      case "reply_all":
      case "forward":
        return config.outbound.allowDirectDelivery;
      case "delete_message":
      case "delete_thread":
      case "delete_draft":
        return config.destructive.allowPermanentDelete;
      default:
        return true;
    }
  })();
  if (!operationEnabled) return { allowed: false, reason: "operation_disabled" };

  if (
    ["send_message", "send_draft", "reply", "reply_all", "forward"].includes(input.action) &&
    !trustAllowed("creator", config.outbound.allowedTrustLevels)
  ) {
    return { allowed: false, reason: "trust_not_allowed" };
  }
  if (input.action === "reply_all" && !config.drafts.allowReplyAll) {
    return { allowed: false, reason: "operation_disabled" };
  }
  if (input.action === "forward" && !config.drafts.allowForward) {
    return { allowed: false, reason: "operation_disabled" };
  }
  if (
    (input.action === "schedule_draft" && input.sendAt === undefined) ||
    (input.sendAt !== undefined &&
      (typeof input.sendAt !== "number" || !Number.isFinite(input.sendAt) || input.sendAt < 0))
  ) {
    return { allowed: false, reason: "schedule_invalid" };
  }

  if (operationRequiresComposition(input.action)) {
    const requireRecipient = [
      "send_message",
      "send_draft",
      "schedule_draft",
      "create_new_draft",
    ].includes(input.action);
    const requireSubject = requireRecipient;
    const composition = evaluateComposition(input, config, { requireRecipient, requireSubject });
    if (!composition.allowed) return composition;
    if (
      composition.subject !== undefined &&
      (input.action === "send_message" || input.action === "create_new_draft")
    ) {
      return {
        ...composition,
        subject: `${config.outbound.subjectPrefix}${composition.subject}`,
      };
    }
    return composition;
  }
  return { allowed: true, recipients: { to: [], cc: [], bcc: [] } };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function normalizeOptionalIdentifier(value: string | undefined): string | null {
  if (value === undefined) return null;
  if (!validProviderIdentifier(value)) throw new Error("invalid operation manifest identifier");
  return value;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const object = value as Record<string, unknown>;
  return `{${Object.keys(object)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(object[key])}`)
    .join(",")}}`;
}

/** Hash an immutable, canonical operation manifest before provider execution. */
export function hashAgentMailOperationManifest(manifest: AgentMailOperationManifest): string {
  return createHash("sha256")
    .update("agentmail-operation-manifest/v1\0", "utf8")
    .update(canonicalJson(manifest), "utf8")
    .digest("hex");
}

/**
 * Authorize an operation and bind every provider-significant value into one
 * immutable manifest. Rebuild and compare the hash after any provider read or
 * human-review boundary; a changed hash invalidates the prior authorization.
 */
export function createAgentMailOperationManifest(
  input: AgentMailOperationInput,
  config: ValidatedAgentMailConfig,
): AgentMailManifestDecision {
  const decision = evaluateAgentMailOperation(input, config);
  if (!decision.allowed) return decision;
  if (
    !validManifestIdentity(input.creatorPeerId) ||
    !validManifestIdentity(input.registeredAugment)
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  if (
    input.providerRevision !== undefined &&
    (!validManifestIdentity(input.providerRevision) || input.providerRevision.length > 256)
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  const sendAt = input.sendAt ?? null;
  const attachments = (input.attachments ?? []).map((attachment) => ({
    attachmentId: normalizeOptionalIdentifier(attachment.attachmentId),
    sha256: attachment.sha256.toLowerCase(),
    size: attachment.size,
    contentType: attachment.contentType.toLowerCase(),
  }));
  const manifest = deepFreeze<AgentMailOperationManifest>({
    version: 1,
    action: input.action,
    inboxId: config.inboxId,
    resources: {
      messageId: normalizeOptionalIdentifier(input.messageId),
      threadId: normalizeOptionalIdentifier(input.threadId),
      draftId: normalizeOptionalIdentifier(input.draftId),
      attachmentId: normalizeOptionalIdentifier(input.attachmentId),
    },
    recipients: {
      to: [...decision.recipients.to],
      cc: [...decision.recipients.cc],
      bcc: [...decision.recipients.bcc],
    },
    body: {
      subjectHash: decision.subject === undefined ? null : sha256(decision.subject),
      textHash: input.text === undefined ? null : sha256(input.text),
      htmlHash: input.html === undefined ? null : sha256(input.html),
    },
    attachments,
    source: {
      origin: input.authority.origin,
      peerId: input.authority.peerId,
      trustLevel: input.authority.trustLevel,
      sourceAugment: input.authority.sourceAugment ?? null,
    },
    sendAt,
    providerRevision: input.providerRevision ?? null,
    creatorPeerId: input.creatorPeerId,
    policyGeneration: config.policyGeneration,
  });
  return { allowed: true, manifest, hash: hashAgentMailOperationManifest(manifest) };
}

/** Validate and normalize a direct outbound request before provider access. */
export function evaluateAgentMailOutbound(
  input: { trustLevel: TrustLevel; recipients: readonly string[]; subject: string; text: string },
  config: ValidatedAgentMailConfig,
): AgentMailOutboundPolicyDecision {
  if (!trustAllowed(input.trustLevel, config.outbound.allowedTrustLevels)) {
    return { allowed: false, reason: "trust_not_allowed" };
  }
  const composition = evaluateComposition(
    {
      recipients: { to: input.recipients },
      subject: input.subject,
      text: input.text,
    },
    config,
    { requireRecipient: true, requireSubject: true },
  );
  if (!composition.allowed) {
    return { allowed: false, reason: legacyCompositionReason(composition.reason) };
  }
  return {
    allowed: true,
    recipients: composition.recipients.to,
    subject: `${config.outbound.subjectPrefix}${input.subject}`,
  };
}

/** Revalidate a provider-native draft immediately before creator revision/send. */
export function evaluateAgentMailPreparedDraft(
  input: {
    recipients: readonly string[];
    subject?: string;
    text?: string;
    html?: string;
  },
  config: ValidatedAgentMailConfig,
): AgentMailOutboundPolicyDecision {
  if (!trustAllowed("creator", config.outbound.allowedTrustLevels)) {
    return { allowed: false, reason: "trust_not_allowed" };
  }
  const composition = evaluateComposition(
    {
      recipients: { to: input.recipients },
      subject: input.subject,
      text: input.text,
      html: input.html,
    },
    config,
    { requireRecipient: true, requireSubject: true },
  );
  if (!composition.allowed) {
    return { allowed: false, reason: legacyCompositionReason(composition.reason) };
  }
  return {
    allowed: true,
    recipients: composition.recipients.to,
    subject: input.subject ?? "",
  };
}

/** Sending a provider-native reply draft is always a fresh creator action. */
export function maySendAgentMailDraft(trustLevel: TrustLevel): boolean {
  return trustLevel === "creator";
}
