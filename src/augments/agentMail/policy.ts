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
  filename?: string;
  sha256: string;
  size: number;
  contentType: string;
  contentDisposition?: "inline" | "attachment";
  contentId?: string;
  /** Exact SDK base64 `content`, when this operation uploads bytes. Never persisted in a manifest. */
  contentBase64?: string;
  /** Hash of an externally fetched attachment URL; raw URLs never enter a manifest. */
  sourceUrlHash?: string;
  /** Runtime attestation that the descriptor was produced by trusted byte ingestion. */
  trustedBytes?: true;
}

export type AgentMailDraftKind = "new" | "reply" | "replyAll" | "forward";

export type AgentMailOperation =
  | "list_messages"
  | "list_threads"
  | "search_messages"
  | "search_threads"
  | "get_message"
  | "get_thread"
  | "update_message_labels"
  | "update_thread_labels"
  | "trash_message"
  | "restore_message"
  | "trash_thread"
  | "restore_thread"
  | "get_attachment"
  | "list_drafts"
  | "get_draft"
  | "adopt_draft"
  | "create_new_draft"
  | "create_reply_draft"
  | "create_reply_all_draft"
  | "create_forward_draft"
  | "update_draft"
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

/** Runtime-owned identity bindings. Tool arguments, skills, MCP, mail, and memory cannot supply these. */
export interface AgentMailTrustedAuthority {
  authority: AgentMailOperationAuthority;
  creatorPeerId: string;
  registeredAugment: string;
  now: number;
  /** Provider-derived single reply target for a direct reply operation. */
  derivedReplyRecipient?: string;
}

export interface AgentMailOperationInput {
  action: AgentMailOperation;
  messageId?: string;
  sourceMessageId?: string;
  threadId?: string;
  draftId?: string;
  draftKind?: AgentMailDraftKind;
  attachmentId?: string;
  listLimit?: number;
  pageToken?: string;
  includeTrash?: boolean;
  searchQuery?: string;
  addLabels?: readonly string[];
  removeLabels?: readonly string[];
  recipients?: AgentMailRecipients;
  replyTo?: readonly string[];
  labels?: readonly string[];
  subject?: string;
  text?: string;
  html?: string;
  attachments?: readonly AgentMailPolicyAttachment[];
  providerRevision?: string;
  materialHash?: string;
  clientId?: string;
  operationId?: string;
  idempotencyKey?: string;
  removeAttachmentIds?: readonly string[];
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
  | "body_required"
  | "body_limit_exceeded"
  | "html_not_allowed"
  | "attachment_limit_exceeded"
  | "attachment_too_large"
  | "attachment_total_exceeded"
  | "attachment_type_not_allowed"
  | "attachment_invalid";

export type AgentMailOperationDecision =
  | {
      allowed: true;
      recipients: NormalizedAgentMailRecipients;
      subject?: string;
      addLabels?: string[];
      removeLabels?: string[];
      replyTo?: string[];
      labels?: string[];
      draftKind?: AgentMailDraftKind;
    }
  | { allowed: false; reason: AgentMailOperationDenialReason };

export interface AgentMailOperationManifest {
  readonly version: 2;
  readonly action: AgentMailOperation;
  readonly inboxId: string;
  readonly resources: Readonly<{
    messageId: string | null;
    sourceMessageId: string | null;
    threadId: string | null;
    draftId: string | null;
    attachmentId: string | null;
  }>;
  readonly recipients: Readonly<{
    to: readonly string[];
    cc: readonly string[];
    bcc: readonly string[];
    supplied: Readonly<{ to: boolean; cc: boolean; bcc: boolean }>;
  }>;
  readonly body: Readonly<{
    subjectHash: string | null;
    textHash: string | null;
    htmlHash: string | null;
    supplied: Readonly<{ subject: boolean; text: boolean; html: boolean }>;
  }>;
  readonly draft: Readonly<{
    kind: AgentMailDraftKind | null;
    replyTo: readonly string[];
    replyToSupplied: boolean;
    labels: readonly string[];
    labelsSupplied: boolean;
    attachmentsSupplied: boolean;
    removeAttachmentIds: readonly string[];
  }>;
  readonly mailbox: Readonly<{
    listLimit: number | null;
    pageTokenHash: string | null;
    includeTrash: boolean | null;
    searchQueryHash: string | null;
    addLabels: readonly string[];
    removeLabels: readonly string[];
  }>;
  readonly attachments: readonly Readonly<{
    attachmentId: string | null;
    sha256: string;
    size: number;
    contentType: string;
    filenameHash: string | null;
    contentDisposition: "inline" | "attachment" | null;
    contentIdHash: string | null;
    sourceUrlHash: string | null;
  }>[];
  readonly source: Readonly<{
    origin: AgentMailOperationAuthority["origin"];
    peerId: string;
    trustLevel: TrustLevel;
    sourceAugment: string | null;
  }>;
  readonly providerRevision: string | null;
  readonly materialHash: string | null;
  readonly execution: Readonly<{
    clientId: string | null;
    operationId: string | null;
    idempotencyKey: string | null;
  }>;
  readonly delivery: Readonly<{
    endpoint: "none" | "drafts.send" | "messages.send" | "messages.reply" | "messages.forward";
    requestHash: string;
  }>;
  readonly trustedAuthority: Readonly<{
    creatorPeerId: string;
    registeredAugment: string;
    derivedReplyRecipient: string | null;
  }>;
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

function prefixedSubject(subject: string, prefix: string): string {
  return subject.startsWith(prefix) ? subject : `${prefix}${subject}`;
}

function hasExactlyOnePrefix(subject: string | undefined, prefix: string): boolean {
  if (subject === undefined || !subject.startsWith(prefix)) return false;
  return !subject.slice(prefix.length).startsWith(prefix);
}

function normalizeAddressList(
  values: readonly string[] | undefined,
  maximum: number,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > maximum) return undefined;
  const normalized = values.map((value) =>
    typeof value === "string" ? canonicalizeEmail(value) : "",
  );
  if (
    normalized.some((value) => !isWellFormedEmail(value)) ||
    new Set(normalized).size !== normalized.length
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeDraftLabels(
  values: readonly string[] | undefined,
  config: ValidatedAgentMailConfig,
): string[] | undefined {
  if (values === undefined) return undefined;
  if (!Array.isArray(values) || values.length > 50) return undefined;
  const normalized = values.map((value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "",
  );
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => !config.mailbox.allowedLabels.includes(value))
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeObservedLabels(values: readonly string[] | undefined): string[] | undefined {
  if (values === undefined || !Array.isArray(values) || values.length > 50) return undefined;
  const normalized = values.map((value) =>
    typeof value === "string" ? value.trim().toLowerCase() : "",
  );
  if (
    new Set(normalized).size !== normalized.length ||
    normalized.some((value) => !/^[a-z0-9][a-z0-9._:/-]{0,127}$/.test(value))
  ) {
    return undefined;
  }
  return normalized;
}

function normalizeLabelChanges(
  add: readonly string[] | undefined,
  remove: readonly string[] | undefined,
  config: ValidatedAgentMailConfig,
): { add: string[]; remove: string[] } | undefined {
  const normalizedAdd = normalizeDraftLabels(add, config) ?? (add === undefined ? [] : undefined);
  const normalizedRemove =
    normalizeDraftLabels(remove, config) ?? (remove === undefined ? [] : undefined);
  if (
    normalizedAdd === undefined ||
    normalizedRemove === undefined ||
    new Set([...normalizedAdd, ...normalizedRemove]).size !==
      normalizedAdd.length + normalizedRemove.length
  ) {
    return undefined;
  }
  return { add: normalizedAdd, remove: normalizedRemove };
}

function decodedBase64(value: string): Buffer | undefined {
  if (value.length === 0 || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    return undefined;
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) return undefined;
  return decoded;
}

function contentTypeAllowed(contentType: string, allowed: readonly string[]): boolean {
  const normalized = contentType.toLowerCase();
  return allowed.some((entry) => {
    if (!entry.endsWith("/*")) return entry === normalized;
    return normalized.startsWith(`${entry.slice(0, -1)}`);
  });
}

function evaluateComposition(
  input: Pick<
    AgentMailOperationInput,
    "recipients" | "replyTo" | "labels" | "subject" | "text" | "html" | "attachments"
  >,
  config: ValidatedAgentMailConfig,
  options: {
    requireRecipient: boolean;
    requireSubject: boolean;
    requireBody: boolean;
    applySubjectPrefix: boolean;
    observedLabels: boolean;
  },
): AgentMailOperationDecision {
  const recipientDecision = normalizeRecipients(input.recipients, config, options.requireRecipient);
  if (!recipientDecision.allowed) return recipientDecision;
  const effectiveSubject =
    input.subject === undefined
      ? undefined
      : options.applySubjectPrefix
        ? prefixedSubject(input.subject, config.outbound.subjectPrefix)
        : input.subject;
  if (!subjectAllowed(effectiveSubject, options.requireSubject)) {
    return { allowed: false, reason: "subject_invalid" };
  }
  const replyTo = normalizeAddressList(input.replyTo, 50);
  if (input.replyTo !== undefined && replyTo === undefined) {
    return { allowed: false, reason: "recipient_malformed" };
  }
  const labels = options.observedLabels
    ? normalizeObservedLabels(input.labels)
    : normalizeDraftLabels(input.labels, config);
  if (input.labels !== undefined && labels === undefined) {
    return { allowed: false, reason: "label_not_allowed" };
  }
  if (input.html !== undefined && input.html !== "" && !config.outbound.allowHtml) {
    return { allowed: false, reason: "html_not_allowed" };
  }
  const bodyBytes =
    Buffer.byteLength(input.text ?? "", "utf8") + Buffer.byteLength(input.html ?? "", "utf8");
  if (options.requireBody && (input.text ?? "") === "" && (input.html ?? "") === "") {
    return { allowed: false, reason: "body_required" };
  }
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
      attachment.contentType.trim() === "" ||
      (attachment.filename !== undefined &&
        (typeof attachment.filename !== "string" ||
          attachment.filename.length < 1 ||
          attachment.filename.length > 512 ||
          /[\0\r\n]/.test(attachment.filename))) ||
      (attachment.contentDisposition !== undefined &&
        attachment.contentDisposition !== "inline" &&
        attachment.contentDisposition !== "attachment") ||
      (attachment.contentId !== undefined &&
        (typeof attachment.contentId !== "string" ||
          attachment.contentId.length < 1 ||
          attachment.contentId.length > 512 ||
          /[\0\r\n]/.test(attachment.contentId))) ||
      (attachment.sourceUrlHash !== undefined && !/^[a-f0-9]{64}$/i.test(attachment.sourceUrlHash))
    ) {
      return { allowed: false, reason: "attachment_invalid" };
    }
    if (attachment.sourceUrlHash !== undefined || attachment.trustedBytes !== true) {
      return { allowed: false, reason: "attachment_invalid" };
    }
    if (attachment.size > config.outbound.maxAttachmentBytes) {
      return { allowed: false, reason: "attachment_too_large" };
    }
    if (attachment.contentBase64 !== undefined) {
      if (
        typeof attachment.contentBase64 !== "string" ||
        attachment.contentBase64.length > 4 * Math.ceil(config.outbound.maxAttachmentBytes / 3)
      ) {
        return { allowed: false, reason: "attachment_too_large" };
      }
      const decoded = decodedBase64(attachment.contentBase64);
      if (
        decoded === undefined ||
        decoded.byteLength !== attachment.size ||
        createHash("sha256").update(decoded).digest("hex") !== attachment.sha256.toLowerCase()
      ) {
        return { allowed: false, reason: "attachment_invalid" };
      }
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
    ...(effectiveSubject === undefined ? {} : { subject: effectiveSubject }),
    ...(replyTo === undefined ? {} : { replyTo }),
    ...(labels === undefined ? {} : { labels }),
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
    case "trash_message":
    case "restore_message":
    case "delete_message":
      return validProviderIdentifier(input.messageId);
    case "reply":
    case "forward":
      return validProviderIdentifier(input.messageId) && validProviderIdentifier(input.threadId);
    case "create_reply_draft":
    case "create_reply_all_draft":
    case "create_forward_draft":
      return validProviderIdentifier(input.sourceMessageId);
    case "get_thread":
    case "update_thread_labels":
    case "trash_thread":
    case "restore_thread":
    case "delete_thread":
      return validProviderIdentifier(input.threadId);
    case "get_attachment":
      return (
        validProviderIdentifier(input.messageId) && validProviderIdentifier(input.attachmentId)
      );
    case "get_draft":
    case "adopt_draft":
    case "update_draft":
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
    "trash_message",
    "restore_message",
    "trash_thread",
    "restore_thread",
    "create_reply_draft",
    "create_reply_all_draft",
    "create_forward_draft",
    "adopt_draft",
    "update_draft",
    "send_draft",
    "reply",
    "reply_all",
    "forward",
    "delete_message",
    "delete_thread",
    "delete_draft",
  ].includes(action);
}

function creatorAuthorized(trusted: AgentMailTrustedAuthority): boolean {
  const authority = trusted.authority;
  return (
    authority.origin === "creator" &&
    authority.trustLevel === "creator" &&
    authority.peerId === trusted.creatorPeerId
  );
}

function systemDraftAuthorized(trusted: AgentMailTrustedAuthority): boolean {
  return (
    trusted.authority.origin === "system" &&
    trusted.authority.sourceAugment === trusted.registeredAugment
  );
}

function validTrustedAuthority(value: AgentMailTrustedAuthority): boolean {
  return (
    validManifestIdentity(value.creatorPeerId) &&
    validManifestIdentity(value.registeredAugment) &&
    validManifestIdentity(value.authority.peerId) &&
    (value.authority.sourceAugment === undefined ||
      validManifestIdentity(value.authority.sourceAugment)) &&
    (value.derivedReplyRecipient === undefined ||
      isWellFormedEmail(canonicalizeEmail(value.derivedReplyRecipient))) &&
    Number.isSafeInteger(value.now) &&
    value.now >= 0
  );
}

function expectedDraftKind(action: AgentMailOperation): AgentMailDraftKind | undefined {
  switch (action) {
    case "create_new_draft":
      return "new";
    case "create_reply_draft":
      return "reply";
    case "create_reply_all_draft":
      return "replyAll";
    case "create_forward_draft":
      return "forward";
    default:
      return undefined;
  }
}

function validateDraftIdentity(input: AgentMailOperationInput): boolean {
  const expected = expectedDraftKind(input.action);
  if (expected !== undefined && input.draftKind !== undefined && input.draftKind !== expected) {
    return false;
  }
  const kind = expected ?? input.draftKind;
  const needsKnownKind = ["adopt_draft", "update_draft", "send_draft", "delete_draft"].includes(
    input.action,
  );
  const directMessageSource = input.action === "reply" || input.action === "forward";
  const acceptsDraftIdentity = needsKnownKind || expected !== undefined || directMessageSource;
  if (
    !acceptsDraftIdentity &&
    (input.draftKind !== undefined || input.sourceMessageId !== undefined)
  ) {
    return false;
  }
  if (needsKnownKind && kind === undefined) return false;
  if (directMessageSource) return validProviderIdentifier(input.sourceMessageId);
  if (kind === "new") return input.sourceMessageId === undefined;
  if (kind === "reply" || kind === "replyAll" || kind === "forward") {
    return validProviderIdentifier(input.sourceMessageId);
  }
  return input.sourceMessageId === undefined;
}

function validHash(value: string | undefined): boolean {
  return value === undefined || /^[a-f0-9]{64}$/i.test(value);
}

function validateOperationIdentities(input: AgentMailOperationInput): boolean {
  for (const value of [input.clientId, input.operationId, input.idempotencyKey]) {
    if (value !== undefined && !validManifestIdentity(value)) return false;
  }
  if (expectedDraftKind(input.action) !== undefined && !validManifestIdentity(input.clientId)) {
    return false;
  }
  if (
    ["send_message", "send_draft", "reply", "reply_all", "forward"].includes(input.action) &&
    (!validManifestIdentity(input.idempotencyKey) || !validManifestIdentity(input.operationId))
  ) {
    return false;
  }
  if (!validHash(input.materialHash)) return false;
  if (requiresProviderRevision(input.action) && input.materialHash === undefined) return false;
  if (
    input.removeAttachmentIds !== undefined &&
    (!Array.isArray(input.removeAttachmentIds) ||
      input.removeAttachmentIds.length > 50 ||
      new Set(input.removeAttachmentIds).size !== input.removeAttachmentIds.length ||
      input.removeAttachmentIds.some((value) => !validProviderIdentifier(value)))
  ) {
    return false;
  }
  return true;
}

function draftCapabilityEnabled(
  kind: AgentMailDraftKind | undefined,
  config: ValidatedAgentMailConfig,
): boolean {
  switch (kind) {
    case "new":
      return config.drafts.allowNew;
    case "reply":
      return config.drafts.allowReply || config.replies.mode === "review";
    case "replyAll":
      return (
        (config.drafts.allowReply && config.drafts.allowReplyAll) ||
        (config.replies.mode === "review" && config.replies.allowReplyAll)
      );
    case "forward":
      return config.drafts.allowForward;
    default:
      return false;
  }
}

function deliveryEndpoint(
  action: AgentMailOperation,
): AgentMailOperationManifest["delivery"]["endpoint"] {
  switch (action) {
    case "send_draft":
      return "drafts.send";
    case "send_message":
      return "messages.send";
    case "reply":
      return "messages.reply";
    case "forward":
      return "messages.forward";
    default:
      return "none";
  }
}

function deliveryRequestHash(
  input: AgentMailOperationInput,
  decision: Extract<AgentMailOperationDecision, { allowed: true }>,
  config: ValidatedAgentMailConfig,
  attachments: AgentMailOperationManifest["attachments"],
): string {
  const endpoint = deliveryEndpoint(input.action);
  const common = {
    endpoint,
    inboxId: config.inboxId,
  };
  if (endpoint === "drafts.send") {
    return sha256(canonicalJson({ ...common, draftId: input.draftId ?? null }));
  }
  if (endpoint === "none") return sha256(canonicalJson(common));
  return sha256(
    canonicalJson({
      ...common,
      ...(endpoint === "messages.send" ? {} : { messageId: input.messageId ?? null }),
      to: decision.recipients.to,
      cc: decision.recipients.cc,
      bcc: decision.recipients.bcc,
      replyTo: decision.replyTo ?? [],
      labels: decision.labels ?? [],
      subject: decision.subject ?? null,
      textHash: input.text === undefined ? null : sha256(input.text),
      htmlHash: input.html === undefined ? null : sha256(input.html),
      attachments,
    }),
  );
}

function operationRequiresComposition(action: AgentMailOperation): boolean {
  return [
    "create_new_draft",
    "create_reply_draft",
    "create_reply_all_draft",
    "create_forward_draft",
    "update_draft",
    "send_message",
    "send_draft",
    "reply",
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
  trusted: AgentMailTrustedAuthority,
): AgentMailOperationDecision {
  if (!validTrustedAuthority(trusted)) return { allowed: false, reason: "resource_invalid" };
  if (input.action === "reply_all") {
    // AgentMail alone derives reply-all recipients. Auggy only permits this via
    // a provider-native reply-all draft that the creator reviews before send.
    return { allowed: false, reason: "operation_disabled" };
  }
  if (trusted.authority.origin === "inbound") {
    return { allowed: false, reason: "inbound_origin_denied" };
  }
  const systemDraft =
    systemDraftAuthorized(trusted) &&
    (input.action === "create_reply_draft" || input.action === "create_reply_all_draft");
  if (trusted.authority.origin === "system" && !systemDraft) {
    return { allowed: false, reason: "system_source_invalid" };
  }
  if (!systemDraft && !creatorAuthorized(trusted)) {
    return { allowed: false, reason: "creator_required" };
  }
  if (!requireResource(input)) return { allowed: false, reason: "resource_invalid" };
  if (
    (input.action === "reply" || input.action === "forward") &&
    input.sourceMessageId !== input.messageId
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  if (!validateDraftIdentity(input) || !validateOperationIdentities(input)) {
    return { allowed: false, reason: "resource_invalid" };
  }
  if (requiresProviderRevision(input.action) && !validManifestIdentity(input.providerRevision)) {
    return { allowed: false, reason: "resource_invalid" };
  }

  if (
    input.action === "list_messages" ||
    input.action === "list_threads" ||
    input.action === "list_drafts"
  ) {
    const limit = input.listLimit ?? config.mailbox.maxListResults;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > config.mailbox.maxListResults) {
      return { allowed: false, reason: "list_limit_exceeded" };
    }
  }
  if (
    input.pageToken !== undefined &&
    (typeof input.pageToken !== "string" ||
      input.pageToken.length < 1 ||
      input.pageToken.length > 4_096 ||
      /[\0\r\n]/.test(input.pageToken))
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  if (input.includeTrash !== undefined && typeof input.includeTrash !== "boolean") {
    return { allowed: false, reason: "resource_invalid" };
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
    const addCount = add.length;
    return {
      allowed: true,
      recipients: { to: [], cc: [], bcc: [] },
      addLabels: normalized.slice(0, addCount),
      removeLabels: normalized.slice(addCount),
    };
  }
  if (
    input.action === "trash_message" ||
    input.action === "restore_message" ||
    input.action === "trash_thread" ||
    input.action === "restore_thread"
  ) {
    if (!config.mailbox.allowTrashRestore) {
      return { allowed: false, reason: "operation_disabled" };
    }
    const trash = input.action === "trash_message" || input.action === "trash_thread";
    return {
      allowed: true,
      recipients: { to: [], cc: [], bcc: [] },
      addLabels: trash ? ["trash"] : [],
      removeLabels: trash ? [] : ["trash"],
    };
  }
  if (input.action === "get_attachment" && !config.mailbox.allowAttachmentAccess) {
    return { allowed: false, reason: "attachment_access_disabled" };
  }
  let draftLabelChanges: { add: string[]; remove: string[] } | undefined;
  if (
    input.action === "update_draft" &&
    (input.addLabels !== undefined || input.removeLabels !== undefined)
  ) {
    if (!config.mailbox.allowLabelMutation) {
      return { allowed: false, reason: "label_mutation_disabled" };
    }
    draftLabelChanges = normalizeLabelChanges(input.addLabels, input.removeLabels, config);
    if (draftLabelChanges === undefined) {
      return { allowed: false, reason: "label_not_allowed" };
    }
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
      case "adopt_draft":
        return draftCapabilityEnabled(input.draftKind, config);
      case "update_draft":
        return (
          config.drafts.allowNew ||
          config.drafts.allowReply ||
          config.drafts.allowForward ||
          config.replies.mode === "review"
        );
      case "send_draft":
        return draftCapabilityEnabled(input.draftKind, config);
      case "send_message":
      case "reply":
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
  if (input.action === "forward" && !config.drafts.allowForward) {
    return { allowed: false, reason: "operation_disabled" };
  }
  if (operationRequiresComposition(input.action)) {
    const requireRecipient = [
      "send_message",
      "send_draft",
      "create_new_draft",
      "create_forward_draft",
      "forward",
    ].includes(input.action);
    const requireSubject = ["send_message", "send_draft", "create_new_draft"].includes(
      input.action,
    );
    const requireBody = ["send_message", "send_draft", "reply", "reply_all", "forward"].includes(
      input.action,
    );
    const applySubjectPrefix = [
      "send_message",
      "forward",
      "create_new_draft",
      "create_reply_draft",
      "create_reply_all_draft",
      "create_forward_draft",
    ].includes(input.action);
    if (
      input.action === "send_draft" &&
      !hasExactlyOnePrefix(input.subject, config.outbound.subjectPrefix)
    ) {
      return { allowed: false, reason: "subject_invalid" };
    }
    if (input.action === "reply" && input.subject !== undefined) {
      return { allowed: false, reason: "subject_invalid" };
    }
    if (
      input.action === "send_draft" &&
      (input.recipients?.to === undefined ||
        input.recipients.cc === undefined ||
        input.recipients.bcc === undefined ||
        input.replyTo === undefined ||
        input.labels === undefined ||
        input.attachments === undefined ||
        (input.draftKind !== "new" && !validProviderIdentifier(input.threadId)))
    ) {
      return { allowed: false, reason: "resource_invalid" };
    }
    if (input.action === "reply") {
      if (
        !validProviderIdentifier(input.sourceMessageId) ||
        input.sourceMessageId !== input.messageId ||
        input.recipients?.to === undefined ||
        input.recipients.to.length !== 1 ||
        trusted.derivedReplyRecipient === undefined ||
        canonicalizeEmail(input.recipients.to[0] ?? "") !==
          canonicalizeEmail(trusted.derivedReplyRecipient) ||
        (input.recipients.cc?.length ?? 0) > 0 ||
        (input.recipients.bcc?.length ?? 0) > 0
      ) {
        return { allowed: false, reason: "recipient_malformed" };
      }
    }
    const composition = evaluateComposition(input, config, {
      requireRecipient,
      requireSubject,
      requireBody,
      applySubjectPrefix,
      observedLabels: input.action === "update_draft" || input.action === "send_draft",
    });
    if (!composition.allowed) return composition;
    return {
      ...composition,
      ...(draftLabelChanges === undefined
        ? {}
        : { addLabels: draftLabelChanges.add, removeLabels: draftLabelChanges.remove }),
      ...(expectedDraftKind(input.action) === undefined
        ? input.draftKind === undefined
          ? {}
          : { draftKind: input.draftKind }
        : { draftKind: expectedDraftKind(input.action) }),
    };
  }
  return {
    allowed: true,
    recipients: { to: [], cc: [], bcc: [] },
    ...(input.draftKind === undefined ? {} : { draftKind: input.draftKind }),
  };
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
    .update("agentmail-operation-manifest/v2\0", "utf8")
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
  trusted: AgentMailTrustedAuthority,
): AgentMailManifestDecision {
  const decision = evaluateAgentMailOperation(input, config, trusted);
  if (!decision.allowed) return decision;
  if (
    !validManifestIdentity(trusted.creatorPeerId) ||
    !validManifestIdentity(trusted.registeredAugment)
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  if (
    input.providerRevision !== undefined &&
    (!validManifestIdentity(input.providerRevision) || input.providerRevision.length > 256)
  ) {
    return { allowed: false, reason: "resource_invalid" };
  }
  const attachments = (input.attachments ?? []).map((attachment) => ({
    attachmentId: normalizeOptionalIdentifier(attachment.attachmentId),
    sha256: attachment.sha256.toLowerCase(),
    size: attachment.size,
    contentType: attachment.contentType.toLowerCase(),
    filenameHash: attachment.filename === undefined ? null : sha256(attachment.filename),
    contentDisposition: attachment.contentDisposition ?? null,
    contentIdHash: attachment.contentId === undefined ? null : sha256(attachment.contentId),
    sourceUrlHash: null,
  }));
  const endpoint = deliveryEndpoint(input.action);
  const requestHash = deliveryRequestHash(input, decision, config, attachments);
  const manifest = deepFreeze<AgentMailOperationManifest>({
    version: 2,
    action: input.action,
    inboxId: config.inboxId,
    resources: {
      messageId: normalizeOptionalIdentifier(input.messageId),
      sourceMessageId: normalizeOptionalIdentifier(input.sourceMessageId),
      threadId: normalizeOptionalIdentifier(input.threadId),
      draftId: normalizeOptionalIdentifier(input.draftId),
      attachmentId: normalizeOptionalIdentifier(input.attachmentId),
    },
    recipients: {
      to: [...decision.recipients.to],
      cc: [...decision.recipients.cc],
      bcc: [...decision.recipients.bcc],
      supplied: {
        to: input.recipients?.to !== undefined,
        cc: input.recipients?.cc !== undefined,
        bcc: input.recipients?.bcc !== undefined,
      },
    },
    body: {
      subjectHash: decision.subject === undefined ? null : sha256(decision.subject),
      textHash: input.text === undefined ? null : sha256(input.text),
      htmlHash: input.html === undefined ? null : sha256(input.html),
      supplied: {
        subject: input.subject !== undefined,
        text: input.text !== undefined,
        html: input.html !== undefined,
      },
    },
    draft: {
      kind: decision.draftKind ?? null,
      replyTo: [...(decision.replyTo ?? [])],
      replyToSupplied: input.replyTo !== undefined,
      labels: [...(decision.labels ?? [])],
      labelsSupplied: input.labels !== undefined,
      attachmentsSupplied: input.attachments !== undefined,
      removeAttachmentIds: [...(input.removeAttachmentIds ?? [])],
    },
    mailbox: {
      listLimit: input.listLimit ?? null,
      pageTokenHash: input.pageToken === undefined ? null : sha256(input.pageToken),
      includeTrash: input.includeTrash ?? null,
      searchQueryHash: input.searchQuery === undefined ? null : sha256(input.searchQuery),
      addLabels: [...(decision.addLabels ?? [])],
      removeLabels: [...(decision.removeLabels ?? [])],
    },
    attachments,
    source: {
      origin: trusted.authority.origin,
      peerId: trusted.authority.peerId,
      trustLevel: trusted.authority.trustLevel,
      sourceAugment: trusted.authority.sourceAugment ?? null,
    },
    providerRevision: input.providerRevision ?? null,
    materialHash: input.materialHash?.toLowerCase() ?? null,
    execution: {
      clientId: input.clientId ?? null,
      operationId: input.operationId ?? null,
      idempotencyKey: input.idempotencyKey ?? null,
    },
    delivery: { endpoint, requestHash },
    trustedAuthority: {
      creatorPeerId: trusted.creatorPeerId,
      registeredAugment: trusted.registeredAugment,
      derivedReplyRecipient:
        trusted.derivedReplyRecipient === undefined
          ? null
          : canonicalizeEmail(trusted.derivedReplyRecipient),
    },
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
    {
      requireRecipient: true,
      requireSubject: true,
      requireBody: true,
      applySubjectPrefix: true,
      observedLabels: false,
    },
  );
  if (!composition.allowed) {
    return { allowed: false, reason: legacyCompositionReason(composition.reason) };
  }
  return {
    allowed: true,
    recipients: composition.recipients.to,
    subject: composition.subject ?? "",
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
    {
      requireRecipient: true,
      requireSubject: true,
      requireBody: true,
      applySubjectPrefix: false,
      observedLabels: true,
    },
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
