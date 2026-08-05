/**
 * agentMail augment — policy-gated outbound and inbound email.
 *
 * Exposes three model-facing tools (`send_message`, `reply_to_message`,
 * `forward_message`) aligned with AgentMail's MCP tool-name standard, plus
 * an `adminInfo` surface with ring-buffer dispatch log + cap-adjust action.
 *
 * Inbound polling, WebSocket, and Svix webhook modes share a durable ledger,
 * sender/classification policy, and normal transport admission path.
 *
 * Design notes:
 *   - Trust-level gate: by default only `creator` (and null/system) peers
 *     can send. `agent` and `public` are rejected unless the operator
 *     explicitly opts in via `outbound.allowedTrustLevels`.
 *   - `messageId` exposed to the model is the AgentMail message_id. The
 *     turn-scoped `seenMessages` map guards `reply_to_message` /
 *     `forward_message` from reaching arbitrary IDs. The map carries the
 *     inbound envelope (from, replyAllTo)
 *     so `reply_to_message` can apply the full outbound policy
 *     (allowlist, rate-limit, dedup) against the REAL recipients —
 *     Codex finding #1.
 *   - Outbound rate-limit state uses its existing compact persisted state;
 *     the inbound SQLite ledger is separate and stores message work.
 *   - The augment does not duplicate AgentMail's REST client; it imports
 *     `createAgentMailClient` from `src/agentmail-client.ts` (shared with
 *     notify's agentmail adapter and visitor-auth's magic-link flow).
 */

import { z } from "zod";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { defineRoute, defineTool } from "../../helpers";
import {
  createAgentMailClient,
  type AgentMailClient,
  type AgentMailInboxError,
  type SendMessageResult,
  type SendMessageError,
} from "../../agentmail-client";
import { isAmbiguousMutationStatus } from "../../outcome-unknown";
import { createRingBuffer } from "../../lib/ring-buffer";
import {
  readOverrides,
  releaseAdminOverrideRoot,
  retainAdminOverrideRoot,
  writeOverrides,
  type AdminOverrides,
} from "../../lib/admin-overrides";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  ContextBlock,
  ToolResult,
  ToolExecuteContext,
  TransportKernel,
  TrustLevel,
  TurnState,
} from "../../types";
import type { AgentMailAugmentInternalOptions, DispatchRecord } from "./types";
import { redactRecipients, scanForSensitive, validateOutbound } from "./outbound";
import { canonicalizeEmail, isWellFormedEmail } from "../visitorAuth/email-validation";
import {
  checkRateLimit,
  commitReservation,
  createRateLimitState,
  hasRateAttempt,
  releaseReservation,
  reserveSend,
} from "./rate-limit";
import { loadRateState, saveRateState } from "./persist-state";
import { createAgentMailInboundLedger, type AgentMailInboundLedger } from "./inbound-ledger";
import {
  agentMailRuntimeThreadId,
  createAgentMailInboundWorker,
  type AgentMailInboundWorker,
} from "./inbound-worker";
import {
  createAgentMailSdkAdapters,
  runAgentMailCatchUp,
  type AgentMailSdkAdapters,
} from "./sdk-provider";
import type { AgentMailEventSubscription } from "./provider";
import {
  AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR,
  processedAgentMailEventTypes,
  validateAgentMailEffectiveHourlyCap,
  validateAgentMailInboundConfig,
} from "./inbound-policy";
import type {
  AgentMailCreatorAttentionRecord,
  AgentMailCreatorAttentionState,
} from "./creator-attention";
import { AgentMailCreatorAttentionCapacityError } from "./creator-attention";
import { createAgentMailWebhookRoute } from "./webhook-provider";
import {
  createAgentMailReviewQueue,
  type AgentMailReviewQueue,
  type AgentMailReviewRecord,
  type AgentMailReviewRequest,
} from "./review-queue";
import {
  AGENTMAIL_CREATOR_DIGEST_SOURCE,
  type AgentMailCreatorDigestController,
  type AgentMailCreatorDigestSource,
} from "./creator-digest-bridge";

const DEFAULT_ALLOWED_TRUST_LEVELS: TrustLevel[] = ["creator"];
const DEFAULT_REVIEW_TRUST_LEVELS: TrustLevel[] = ["public"];
const DEFAULT_REVIEW_EXPIRY_MS = 24 * 60 * 60_000;
const MAX_REVIEW_EXPIRY_MS = 30 * 24 * 60 * 60_000;
const RING_BUFFER_SIZE = 100;
const DEFAULT_INSTANCE_ID = "agent-mail";
const AGENTMAIL_CONSOLE_URL = "https://console.agentmail.to";
const SAFE_INSTANCE_ID = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;
const MAX_MAIL_BODY_BYTES = 1024 * 1024;
const MAX_MAIL_BODY_CHARS = 1024 * 1024;
const MAX_INBOUND_DETAIL_BYTES = MAX_MAIL_BODY_BYTES;
const MAX_TOOL_NAME_LENGTH = 64;
const LONGEST_AGENTMAIL_TOOL_NAME = "reply_to_message";
const MAX_NAMESPACED_INSTANCE_ID_LENGTH =
  MAX_TOOL_NAME_LENGTH - LONGEST_AGENTMAIL_TOOL_NAME.length - "__".length;
const MAX_RECIPIENTS = 50;
const MAX_EMAIL_CHARS = 320;
const MAX_SUBJECT_CHARS = 1_000;
const MAX_MESSAGE_ID_CHARS = 256;
const MAX_LABELS = 100;
const MAX_LABEL_CHARS = 200;

const toolRecipientsSchema = z
  .array(z.string().min(1).max(MAX_EMAIL_CHARS))
  .min(1)
  .max(MAX_RECIPIENTS);
const toolBodySchema = z.string().max(MAX_MAIL_BODY_CHARS);
const toolLabelsSchema = z.array(z.string().min(1).max(MAX_LABEL_CHARS)).max(MAX_LABELS);

function looksLikePlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

const TRANSIENT_INBOX_HEALTH_STATUSES = new Set([408, 425, 429]);

function isTransientInboxHealthFailure(failure: AgentMailInboxError): boolean {
  if (failure.httpStatus === undefined) return true;
  return failure.httpStatus >= 500 || TRANSIENT_INBOX_HEALTH_STATUSES.has(failure.httpStatus);
}

function validateOptions(opts: AgentMailAugmentInternalOptions): void {
  if (!opts.apiKey || typeof opts.apiKey !== "string") {
    throw new Error("agentMail: apiKey is required (set AGENTMAIL_API_KEY in .env)");
  }
  if (!opts.inboxId || typeof opts.inboxId !== "string") {
    throw new Error("agentMail: inboxId is required (set AGENTMAIL_INBOX_ID in .env)");
  }
  if (
    opts.instanceId !== undefined &&
    (typeof opts.instanceId !== "string" ||
      !SAFE_INSTANCE_ID.test(opts.instanceId) ||
      opts.instanceId.length > 128)
  ) {
    throw new Error(
      "agentMail: instanceId must be 1 to 128 alphanumeric, hyphen, or underscore characters",
    );
  }
  if (
    opts.namespaceTools &&
    opts.instanceId !== undefined &&
    opts.instanceId.length > MAX_NAMESPACED_INSTANCE_ID_LENGTH
  ) {
    throw new Error(
      `agentMail: instanceId must be at most ${MAX_NAMESPACED_INSTANCE_ID_LENGTH} characters when namespaceTools is enabled so every provider tool name is at most ${MAX_TOOL_NAME_LENGTH} characters`,
    );
  }
  if (
    opts.emailAddress !== undefined &&
    !looksLikePlaceholder(opts.emailAddress) &&
    !isWellFormedEmail(opts.emailAddress)
  ) {
    throw new Error("agentMail: emailAddress must be a well-formed email address");
  }
  if (
    opts.addressVisibility !== undefined &&
    opts.addressVisibility !== "creator" &&
    opts.addressVisibility !== "public"
  ) {
    throw new Error('agentMail: addressVisibility must be "creator" or "public"');
  }
  // Subject prefix non-empty when explicitly set.
  if (opts.outbound?.subjectPrefix !== undefined && opts.outbound.subjectPrefix.length === 0) {
    throw new Error("agentMail: outbound.subjectPrefix cannot be the empty string");
  }
  const bodyMaxBytes = opts.outbound?.bodyMaxBytes;
  if (
    bodyMaxBytes !== undefined &&
    (!Number.isSafeInteger(bodyMaxBytes) || bodyMaxBytes <= 0 || bodyMaxBytes > MAX_MAIL_BODY_BYTES)
  ) {
    throw new Error(
      `agentMail: outbound.bodyMaxBytes must be an integer between 1 and ${MAX_MAIL_BODY_BYTES}`,
    );
  }
  const inbound = opts.inbound;
  if (inbound !== undefined) {
    validateAgentMailInboundConfig(inbound, opts.outbound);
  }
  const reviewExpiry = opts.outbound?.humanReview?.expiresAfterMs;
  if (
    reviewExpiry !== undefined &&
    (!Number.isSafeInteger(reviewExpiry) ||
      reviewExpiry <= 0 ||
      reviewExpiry > MAX_REVIEW_EXPIRY_MS)
  ) {
    throw new Error(
      `agentMail: outbound.humanReview.expiresAfterMs must be between 1 and ${MAX_REVIEW_EXPIRY_MS}`,
    );
  }
}

function timestampHHMMSS(now: number): string {
  return new Date(now).toISOString().slice(11, 19);
}

function isToolResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

function privateJsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}

function reviewDetailRequest(request: AgentMailReviewRequest) {
  return {
    kind: request.kind,
    ...("text" in request && request.text !== undefined
      ? { text: request.text.slice(0, MAX_MAIL_BODY_CHARS) }
      : {}),
    ...(request.html !== undefined ? { html: request.html.slice(0, MAX_MAIL_BODY_CHARS) } : {}),
    ...("messageId" in request
      ? { messageId: request.messageId.slice(0, MAX_MESSAGE_ID_CHARS) }
      : {}),
    ...(request.kind === "reply" && request.replyAll !== undefined
      ? { replyAll: request.replyAll }
      : {}),
    ...(request.labels
      ? {
          labels: request.labels
            .slice(0, MAX_LABELS)
            .map((label) => label.slice(0, MAX_LABEL_CHARS)),
        }
      : {}),
  };
}

export function agentMail(opts: AgentMailAugmentInternalOptions): Augment {
  const shutdownTimeoutMs = opts._shutdownTimeoutMs ?? 4_000;
  if (
    !Number.isSafeInteger(shutdownTimeoutMs) ||
    shutdownTimeoutMs <= 0 ||
    shutdownTimeoutMs >= 5_000
  ) {
    throw new Error("agentMail: shutdown timeout must be an integer between 1 and 4999ms");
  }
  validateOptions(opts);

  const instanceId = opts.instanceId ?? DEFAULT_INSTANCE_ID;
  const hasExplicitInstanceId = opts.instanceId !== undefined;
  const legacySingletonCompatibility = opts.legacySingletonCompatibility ?? !hasExplicitInstanceId;
  const instanceRouteBase = legacySingletonCompatibility
    ? "/agentmail"
    : `/agentmail/${instanceId}`;
  const toolName = (base: "send_message" | "reply_to_message" | "forward_message") =>
    opts.namespaceTools ? `${base}__${instanceId}` : base;
  const now = opts._now ?? (() => Date.now());
  const stateDir = opts.stateDir ?? opts.agentDir;
  const overrideDir = opts.overrideDir ?? opts.agentDir;
  let overrideRootRetained = false;

  const outboundOpts = opts.outbound ?? {};
  const allowedTrustLevels = outboundOpts.allowedTrustLevels ?? DEFAULT_ALLOWED_TRUST_LEVELS;
  const reviewTrustLevels =
    outboundOpts.humanReview?.requiredForTrustLevels ?? DEFAULT_REVIEW_TRUST_LEVELS;
  const reviewExpiryMs = outboundOpts.humanReview?.expiresAfterMs ?? DEFAULT_REVIEW_EXPIRY_MS;
  const rateLimitOpts = outboundOpts.rateLimit ?? {};
  const yamlGlobalMaxPerHour = rateLimitOpts.globalMaxPerHour ?? 10;

  // Mutable runtime ceiling (admin-override aware). YAML value is the floor
  // we reset back to on `agentmail-cap-reset`.
  let globalMaxPerHour = yamlGlobalMaxPerHour;
  let globalMaxSource: "yaml" | "override" = "yaml";

  // Load persisted rate-limit / dedup state from the per-instance state
  // directory. Missing state starts fresh; corrupt/newer state fails closed.
  const rateState =
    (stateDir && loadRateState(stateDir, now(), rateLimitOpts)) || createRateLimitState();
  const dispatches = createRingBuffer<DispatchRecord>(RING_BUFFER_SIZE);
  const dispatchCounts: Record<DispatchRecord["status"], number> = {
    sent: 0,
    pending_review: 0,
    rate_limited: 0,
    blocked: 0,
    failed: 0,
  };
  const reviewQueue: AgentMailReviewQueue =
    opts._reviewQueue ?? createAgentMailReviewQueue({ stateDir, now });
  let ratePersistenceFailure: string | undefined;

  // AMIL/v1 reply reviews could delegate recipient expansion to the provider.
  // New replies are always explicitly bound. A pending legacy action has not
  // reached the provider and is therefore safe to fail closed; a `sending`
  // record remains ambiguous and must be operator-reconciled.
  for (const record of reviewQueue.list()) {
    if (record.state === "pending" && record.request.kind === "reply" && !record.request.to) {
      reviewQueue.cancel(record.id, "legacy reply review has no explicit recipient binding");
    }
  }

  /**
   * Persist rate-limit state after a successful send. No-op when no
   * `stateDir` is configured (the augment is running in a test fixture
   * or pre-scaffold dev context). Errors during persistence are logged
   * but swallowed — losing durability is a degraded mode, not a reason
   * to fail the send the model just received "sent" for.
   */
  function persistRateStateIfConfigured(): boolean {
    if (!stateDir) return true;
    try {
      saveRateState(stateDir, rateState, now());
      return true;
    } catch (err) {
      ratePersistenceFailure = (err as Error).message;
      console.warn(
        `[agent-mail] failed to persist rate-limit state: ${(err as Error).message}. ` +
          `State remains in memory; subsequent non-creator mail is blocked until restart/operator repair.`,
      );
      return false;
    }
  }

  function checkOutboundRateLimit(
    recipients: string[],
    rateKey: string,
    hardGlobalMaxPerHour?: number,
  ): ReturnType<typeof checkRateLimit> {
    if (ratePersistenceFailure) {
      return {
        allowed: false,
        reason:
          "agentMail: durable rate-limit state is unavailable; non-creator mail is blocked until restart/operator repair.",
      };
    }
    const effective = effectiveRateLimit();
    return checkRateLimit(
      rateState,
      recipients,
      rateKey,
      hardGlobalMaxPerHour === undefined
        ? effective
        : {
            ...effective,
            globalMaxPerHour: Math.min(effective.globalMaxPerHour, hardGlobalMaxPerHour),
          },
      now(),
    );
  }

  function attemptUsesRate(record: AgentMailReviewRecord): boolean {
    return record.trustLevel !== "creator" && effectiveRateLimit().enabled !== false;
  }

  function reserveRateForAttempt(record: AgentMailReviewRecord): boolean {
    if (!attemptUsesRate(record) || hasRateAttempt(rateState, record.id)) return true;
    reserveSend(
      rateState,
      record.id,
      record.recipients,
      record.rateKey,
      record.attemptedAt ?? record.createdAt,
    );
    return persistRateStateIfConfigured();
  }

  function releaseRateForAttempt(record: AgentMailReviewRecord): boolean {
    if (!attemptUsesRate(record)) return true;
    if (!rateState.reservations.has(record.id))
      return !rateState.accountedAttemptIds.has(record.id);
    releaseReservation(rateState, record.id);
    return persistRateStateIfConfigured();
  }

  function commitRateForAttempt(record: AgentMailReviewRecord): boolean {
    if (!attemptUsesRate(record)) return true;
    if (!hasRateAttempt(rateState, record.id)) {
      reserveSend(
        rateState,
        record.id,
        record.recipients,
        record.rateKey,
        record.attemptedAt ?? record.createdAt,
      );
    }
    commitReservation(rateState, record.id, effectiveRateLimit(), now());
    return persistRateStateIfConfigured();
  }

  // A crash can occur after the review queue reaches `sending` but before
  // its rate reservation is flushed. Restore that reservation at startup;
  // already-committed attempt IDs make the repair idempotent.
  for (const record of reviewQueue.list()) {
    if (
      record.state === "sending" &&
      attemptUsesRate(record) &&
      !hasRateAttempt(rateState, record.id)
    ) {
      reserveSend(
        rateState,
        record.id,
        record.recipients,
        record.rateKey,
        record.attemptedAt ?? record.createdAt,
      );
      persistRateStateIfConfigured();
    }
  }

  /**
   * Turn-scoped seen map for reply/forward validation. The inbound worker
   * populates only the turn it is about to admit and removes the scope when
   * kernel dispatch settles.
   *
   * The map carries the inbound envelope so the reply path can apply the
   * SAME outbound policy (allowlist, rate-limit, dedup) against the actual
   * recipients it would reach — not against a placeholder. Codex #1: the
   * earlier Set<string> shape forced reply_to_message to bypass the
   * allowlist + rate-limit entirely.
   */
  interface SeenMessageMeta {
    /** Original sender email — primary reply recipient. */
    from: string;
    /** Provider-normalized Reply-To recipients, if the message supplied them. */
    replyTo?: string[];
    /** Other original recipients — used when the model passes replyAll: true. */
    replyAllTo?: string[];
  }
  const legacySeenMessages = new Map<string, SeenMessageMeta>();
  const seenMessagesByTurn = new Map<string, Map<string, SeenMessageMeta>>();
  interface InboundTurnScope {
    inboxId: string;
    messageId: string;
    threadId: string;
    peerId: string;
    sourceAugment: string;
    attentionVersion: number;
    replyAttempted: boolean;
    outcome?:
      | { state: "pending_review"; reviewId: string }
      | { state: "sent" | "failed" | "ambiguous"; reviewId?: string };
  }
  const inboundTurnsByTurn = new Map<string, InboundTurnScope>();

  function seenMessagesFor(context: ToolExecuteContext | undefined): Map<string, SeenMessageMeta> {
    return (context ? seenMessagesByTurn.get(context.turnId) : undefined) ?? legacySeenMessages;
  }

  function uniqueReplyRecipients(values: readonly string[], exclude?: string): string[] {
    const excluded = exclude?.toLowerCase();
    const seen = new Set<string>();
    const recipients: string[] = [];
    for (const value of values) {
      const key = value.toLowerCase();
      if (key === excluded || seen.has(key)) continue;
      seen.add(key);
      recipients.push(value);
    }
    return recipients;
  }

  function replyRecipients(
    meta: SeenMessageMeta,
    replyAll: boolean,
  ): { ok: true; recipients: string[]; replyToMismatch: boolean } | { ok: false; reason: string } {
    const replyTo = uniqueReplyRecipients(
      meta.replyTo && meta.replyTo.length > 0 ? meta.replyTo : [meta.from],
    );
    const sender = meta.from.toLowerCase();
    const replyToMismatch = replyTo.length !== 1 || replyTo[0]?.toLowerCase() !== sender;

    if (!replyAll) {
      if (replyTo.length === 0) {
        return { ok: false, reason: "agentMail: inbound message has no valid reply recipient." };
      }
      return { ok: true, recipients: replyTo, replyToMismatch };
    }
    if (!resolvedInboxEmail) {
      return {
        ok: false,
        reason:
          "agentMail: replyAll is unavailable until the canonical inbox email has been verified.",
      };
    }
    const recipients = uniqueReplyRecipients(
      [...replyTo, meta.from, ...(meta.replyAllTo ?? [])],
      resolvedInboxEmail,
    );
    if (recipients.length === 0) {
      return {
        ok: false,
        reason: "agentMail: replyAll produced no external recipients after removing this inbox.",
      };
    }
    return { ok: true, recipients, replyToMismatch };
  }

  function exactInboundTurn(
    context: ToolExecuteContext | undefined,
    messageId: string,
  ): InboundTurnScope | undefined {
    if (inboundStopping || !context?.peer) return undefined;
    const scope = inboundTurnsByTurn.get(context.turnId);
    if (
      !scope ||
      scope.messageId !== messageId ||
      scope.threadId !== context.threadId ||
      scope.peerId !== context.peer.id ||
      scope.sourceAugment !== context.peer.sourceAugment
    ) {
      return undefined;
    }
    return scope;
  }

  function mismatchedClaimedInboundTurn(
    context: ToolExecuteContext | undefined,
    messageId: string,
  ): boolean {
    if (!context) return false;
    const scope = inboundTurnsByTurn.get(context.turnId);
    if (!scope) return false;
    return (
      inboundStopping ||
      scope.messageId !== messageId ||
      scope.threadId !== context.threadId ||
      scope.peerId !== context.peer?.id ||
      scope.sourceAugment !== context.peer?.sourceAugment
    );
  }

  function setInboundReplyOutcome(
    scope: InboundTurnScope | undefined,
    outcome: NonNullable<InboundTurnScope["outcome"]>,
  ): void {
    if (!scope) return;
    // One admitted message may yield at most one actionable reply. Preserve
    // the first provider/review outcome even if the model loops again.
    scope.outcome ??= outcome;
  }

  const inboundMode = opts.inbound?.mode ?? "none";
  const validatedInbound = validateAgentMailInboundConfig(
    opts.inbound ?? { mode: "none" },
    outboundOpts,
  );
  const inboundReplies = validatedInbound.replies;
  const creatorDigestConfig = validatedInbound.creatorDigest;
  const inboundRateLimit = validatedInbound.config.rateLimit;
  const inboundSenderPolicy =
    inboundMode === "none"
      ? ("disabled" as const)
      : validatedInbound.config.allowAnySender === true
        ? ("any" as const)
        : ("allowlist" as const);
  const inboundAllowedSenderCount = validatedInbound.config.allowedSenders?.length ?? 0;
  if (inboundReplies.mode !== "disabled" && !stateDir && opts._reviewQueue === undefined) {
    throw new Error(
      "agentMail: enabled inbound replies require durable review storage; set agentDir/stateDir or provide the test-only _reviewQueue seam",
    );
  }

  const client: AgentMailClient =
    opts._client ??
    createAgentMailClient({
      apiKey: opts.apiKey,
      apiBaseUrl: opts.apiBaseUrl,
      allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
    });
  if (overrideDir) {
    overrideRootRetained = retainAdminOverrideRoot(overrideDir);
    try {
      const overrides = readOverrides(overrideDir);
      const overrideVal =
        (overrides?.version === 2
          ? overrides.overrides.agentMail?.instances?.[instanceId]?.globalMaxPerHour
          : undefined) ??
        (legacySingletonCompatibility
          ? overrides?.overrides.agentMail?.globalMaxPerHour
          : undefined);
      if (overrideVal !== undefined) {
        globalMaxPerHour = validateAgentMailEffectiveHourlyCap(
          overrideVal,
          inboundReplies.mode,
          "admin override globalMaxPerHour",
        );
        globalMaxSource = "override";
      }
    } catch (error) {
      if (overrideRootRetained) {
        releaseAdminOverrideRoot(overrideDir);
        overrideRootRetained = false;
      }
      throw error;
    }
  }

  const addressVisibility = opts.addressVisibility ?? "creator";
  let resolvedInboxEmail =
    opts.emailAddress && !looksLikePlaceholder(opts.emailAddress)
      ? canonicalizeEmail(opts.emailAddress)
      : undefined;
  let inboxIdentitySource: "configured" | "provider" | "unavailable" = resolvedInboxEmail
    ? "configured"
    : "unavailable";
  const agentMailRoutes: NonNullable<Augment["httpRoutes"]> = [
    defineRoute.get(`${instanceRouteBase}/reviews/:reviewId`, {
      auth: "creator",
      params: z.object({ reviewId: z.string().min(1).max(128) }),
      handler: ({ params }) => {
        const record = reviewQueue.get(params.reviewId);
        if (!record) return privateJsonResponse({ error: "review-not-found" }, 404);
        if (record.state !== "pending" && record.state !== "sending") {
          return privateJsonResponse(
            { error: "review-no-longer-inspectable", state: record.state },
            410,
          );
        }
        return privateJsonResponse({
          kind: "review",
          reviewId: record.id,
          fingerprint: record.fingerprint,
          state: record.state,
          trustLevel: record.trustLevel,
          expiresAt: new Date(record.expiresAt).toISOString(),
          recipients: record.recipients
            .slice(0, MAX_RECIPIENTS)
            .map((recipient) => recipient.slice(0, MAX_EMAIL_CHARS)),
          subject: record.subject.slice(0, MAX_SUBJECT_CHARS),
          request: reviewDetailRequest(record.request),
        });
      },
    }),
    defineRoute.get(`${instanceRouteBase}/messages/:messageId`, {
      auth: "creator",
      params: z.object({ messageId: z.string().min(1).max(256) }),
      handler: ({ params }) => {
        if (!inboundLedger) return privateJsonResponse({ error: "inbound-not-ready" }, 503);
        const attention = inboundLedger.creatorAttention.get(opts.inboxId, params.messageId);
        const activeIncident = inboundLedger
          .listIncidents(100, opts.inboxId)
          .some((incident) => incident.messageId === params.messageId);
        if (!attention && !activeIncident) {
          return privateJsonResponse({ error: "attention-not-found" }, 404);
        }
        if (
          !activeIncident &&
          attention?.state !== "open" &&
          attention?.state !== "pending_review" &&
          attention?.state !== "ambiguous"
        ) {
          return privateJsonResponse(
            { error: "attention-no-longer-inspectable", state: attention?.state },
            410,
          );
        }
        const record = inboundLedger.get(opts.inboxId, params.messageId);
        if (!record) return privateJsonResponse({ error: "message-not-found" }, 404);
        const message = record.envelope.message;
        const sourceText =
          message.extractedText ?? message.text ?? message.preview ?? "(no plain-text body)";
        const bodyBytes = Buffer.from(sourceText, "utf8");
        const truncated = bodyBytes.byteLength > MAX_INBOUND_DETAIL_BYTES;
        const textBody = truncated
          ? bodyBytes.subarray(0, MAX_INBOUND_DETAIL_BYTES).toString("utf8")
          : sourceText;
        return new Response(
          JSON.stringify({
            instanceId,
            inboxId: opts.inboxId,
            messageId: message.messageId,
            threadId: message.threadId,
            classification: record.envelope.eventType,
            state: record.state,
            from: message.from.slice(0, 320),
            to: message.to.slice(0, 100),
            cc: message.cc.slice(0, 100),
            subject: message.subject.slice(0, 500),
            receivedAt: message.timestamp,
            text: textBody,
            truncated,
            attachments: message.attachments.slice(0, 100).map((attachment) => ({
              attachmentId: attachment.attachmentId,
              filename: attachment.filename.slice(0, 500),
              contentType: attachment.contentType.slice(0, 200),
              size: attachment.size,
            })),
          }),
          {
            status: 200,
            headers: {
              "content-type": "application/json; charset=utf-8",
              "cache-control": "no-store",
              "x-content-type-options": "nosniff",
            },
          },
        );
      },
    }),
  ];
  let webhookRouteInstalled = false;
  let inboundLedger: AgentMailInboundLedger | undefined = opts._inboundLedger;
  let ownsInboundLedger = false;
  let sdkAdapters: AgentMailSdkAdapters | undefined = opts._sdkAdapters;
  let inboundKernel: TransportKernel | undefined;
  let inboundRegisteredName = instanceId;
  let inboundWorker: AgentMailInboundWorker | undefined;
  let liveSubscription: AgentMailEventSubscription | undefined;
  let reconciliationTimer: ReturnType<typeof setInterval> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  let drainKickTimer: ReturnType<typeof setTimeout> | undefined;
  let drainKickAt: number | undefined;
  let reconciliationController: AbortController | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let deferredInboundRelease: Promise<void> | undefined;
  let activeCatchUp: Promise<void> | undefined;
  let activeDrain: Promise<void> | undefined;
  let drainScheduled = false;
  let inboundStopping = false;
  let inboundReady = false;
  let liveState: "disabled" | "starting" | "ready" | "subscribed" | "degraded" | "stopped" =
    inboundMode === "none" ? "disabled" : "stopped";
  let lastCatchUpAt: number | undefined;
  let lastCatchUpSummary: string | undefined;
  let lastInboundEventAt: number | undefined;
  let lastWorkerOutcome: string | undefined;
  let lastProviderError: string | undefined;
  let creatorDigestController: AgentMailCreatorDigestController | undefined;

  const creatorDigestSource: AgentMailCreatorDigestSource = {
    inboxId: opts.inboxId,
    config: creatorDigestConfig,
    attach: (controller) => {
      if (!creatorDigestConfig.enabled) {
        throw new Error("agentMail: creator digest is disabled");
      }
      if (creatorDigestController) {
        throw new Error("agentMail: creator digest is already attached to a Notify bridge");
      }
      creatorDigestController = controller;
    },
    store: () => {
      if (!inboundLedger) {
        throw new Error("agentMail: creator digest store is unavailable before inbound boot");
      }
      return inboundLedger.creatorDigest;
    },
  };

  function recordProviderError(error: unknown): void {
    lastProviderError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }

  function reviewAttentionState(
    review: AgentMailReviewRecord,
  ): Exclude<AgentMailCreatorAttentionState, "open" | "dismissed"> {
    if (review.state === "pending") return "pending_review";
    if (review.state === "sending") return "ambiguous";
    if (review.state === "approved") return "sent";
    if (review.state === "rejected") return "rejected";
    return "failed";
  }

  function ensureAttentionState(
    current: AgentMailCreatorAttentionRecord,
    state: AgentMailCreatorAttentionState,
    reviewId?: string,
  ): AgentMailCreatorAttentionRecord {
    if (current.state === state && (reviewId === undefined || current.reviewId === reviewId)) {
      return current;
    }
    const transitioned = inboundLedger!.creatorAttention.transition({
      inboxId: current.inboxId,
      messageId: current.messageId,
      expectedVersion: current.version,
      state,
      ...(reviewId ? { reviewId } : {}),
    });
    if (
      transitioned.record?.state === state &&
      (reviewId === undefined || transitioned.record.reviewId === reviewId)
    ) {
      return transitioned.record;
    }
    throw new Error(
      `agentMail: creator attention changed while transitioning ${current.messageId} to ${state}`,
    );
  }

  function finalizeCreatorAttention(scope: InboundTurnScope): void {
    const ledger = inboundLedger;
    if (!ledger) throw new Error("agentMail: inbound attention ledger is unavailable");

    let desiredState: AgentMailCreatorAttentionState = scope.outcome?.state ?? "open";
    const linkedReviewId = scope.outcome?.reviewId;
    if (linkedReviewId) {
      const review = reviewQueue.get(linkedReviewId);
      if (
        review?.request.kind !== "reply" ||
        review.request.messageId !== scope.messageId ||
        review.request.attentionVersion !== scope.attentionVersion
      ) {
        throw new Error("agentMail: creator attention references an invalid reply review");
      }
      desiredState = reviewAttentionState(review);
    }

    let current = ledger.creatorAttention.get(scope.inboxId, scope.messageId);
    if (!current || current.version !== scope.attentionVersion) {
      throw new Error("agentMail: reserved creator attention changed before turn completion");
    }
    // Review IDs may only be introduced while entering pending_review. Stage
    // that durable link first even when the provider attempt already reached a
    // terminal state during the model turn.
    if (linkedReviewId && current.reviewId === undefined) {
      current = ensureAttentionState(current, "pending_review", linkedReviewId);
    }
    ensureAttentionState(current, desiredState, linkedReviewId);
  }

  function transitionReviewAttention(
    review: AgentMailReviewRecord,
    state: AgentMailCreatorAttentionState,
  ): boolean {
    if (review.request.kind !== "reply" || !inboundLedger) return true;
    const current = inboundLedger.creatorAttention.getByReviewId(review.id);
    // Review approval can race the still-running inbound turn. The successful
    // post-turn callback reconciles the queue's current state before completing
    // the ledger claim, so absence here is safe and expected.
    if (!current) return true;
    // Dismissal acknowledges the creator-attention item; it does not cancel or
    // mutate a separately queued review. Preserve that terminal acknowledgement
    // while allowing the review queue to complete its own state transition.
    if (current.state === "dismissed") return true;
    try {
      const transitioned = inboundLedger.creatorAttention.transitionByReviewId({
        reviewId: review.id,
        expectedVersion: current.version,
        state,
      });
      const updated =
        transitioned.record?.state === state || transitioned.record?.state === "dismissed";
      if (updated && state !== "pending_review" && state !== "ambiguous" && state !== "open") {
        scheduleDrain();
      }
      return updated;
    } catch (error) {
      recordProviderError(error);
      return false;
    }
  }

  function reconcileLinkedReviewAttention(): void {
    for (const review of reviewQueue.list()) {
      if (review.request.kind !== "reply") continue;
      let current = inboundLedger?.creatorAttention.getByReviewId(review.id);
      // New inbound replies persist the exact creator-attention generation
      // that authorized them. If the process stopped after queue persistence
      // but before the post-turn link, repair only that one generation.
      // Legacy and non-inbound reviews omit the generation and never auto-link.
      if (!current && review.request.attentionVersion !== undefined) {
        const unlinked = inboundLedger?.creatorAttention.get(
          opts.inboxId,
          review.request.messageId,
        );
        if (
          unlinked?.state === "open" &&
          unlinked.reviewId === undefined &&
          unlinked.version === review.request.attentionVersion
        ) {
          const linked = inboundLedger!.creatorAttention.transition({
            inboxId: unlinked.inboxId,
            messageId: unlinked.messageId,
            expectedVersion: unlinked.version,
            state: "pending_review",
            reviewId: review.id,
          });
          current = linked.record;
        }
      }
      if (!current || current.state === "dismissed") continue;
      const expected = reviewAttentionState(review);
      if (current.state === expected) continue;
      const transitioned = inboundLedger!.creatorAttention.transitionByReviewId({
        reviewId: review.id,
        expectedVersion: current.version,
        state: expected,
      });
      if (transitioned.record?.state !== expected) {
        throw new Error(
          `agentMail: creator attention for review ${review.id} could not be reconciled`,
        );
      }
    }
  }

  function inboundPolicy() {
    const config = opts.inbound!;
    return {
      allowedSenders: config.allowedSenders ?? [],
      allowAnySender: config.allowAnySender,
      rateLimit: config.rateLimit,
      classifications: {
        "message.received": config.classifications?.received,
        "message.received.spam": config.classifications?.spam,
        "message.received.blocked": config.classifications?.blocked,
        "message.received.unauthenticated": config.classifications?.unauthenticated,
      },
      maxPromptBytes: config.maxPromptBytes,
      maxAttempts: config.maxAttempts,
    };
  }

  const processedInboundEventTypes =
    inboundMode === "none" ? [] : processedAgentMailEventTypes(opts.inbound?.classifications);

  function catchUpInbound(): Promise<void> {
    if (activeCatchUp) return activeCatchUp;
    const ledger = inboundLedger;
    const adapters = sdkAdapters;
    const controller = reconciliationController;
    if (!ledger || !adapters || !controller) {
      return Promise.reject(new Error("agentMail: inbound runtime is not booted"));
    }
    if (controller.signal.aborted) {
      return Promise.reject(new Error("agentMail: inbound reconciliation is stopping"));
    }

    const catchUp = (async () => {
      try {
        const result = await runAgentMailCatchUp({
          reader: adapters.catchUp,
          ledger,
          inboxId: opts.inboxId,
          processedEventTypes: processedInboundEventTypes,
          signal: controller.signal,
        });
        lastCatchUpAt = now();
        lastCatchUpSummary =
          `${result.pages} page(s), ${result.scanned} scanned, ` +
          `${result.enqueued} enqueued, ${result.duplicates} duplicate(s)`;
        if (result.enqueued > 0) lastInboundEventAt = lastCatchUpAt;
        lastProviderError = undefined;
      } catch (error) {
        recordProviderError(error);
        throw error;
      }
    })().finally(() => {
      if (activeCatchUp === catchUp) activeCatchUp = undefined;
    });
    activeCatchUp = catchUp;
    return catchUp;
  }

  function reconcileOnSchedule(): void {
    if (!inboundReady || reconciliationController?.signal.aborted) return;
    void catchUpInbound()
      .then(() => {
        if (inboundReady) scheduleDrain();
      })
      .catch((error) => {
        if (!reconciliationController?.signal.aborted) {
          console.warn(`[agent-mail] catch-up failed: ${(error as Error).message}`);
        }
      });
  }

  function drainInbound(): Promise<void> {
    if (activeDrain) return activeDrain;
    const worker = inboundWorker;
    if (!worker) return Promise.resolve();
    const drain = (async () => {
      try {
        for (let i = 0; i < 100; i++) {
          const result = await worker.processNext();
          if (result.status !== "idle") {
            lastWorkerOutcome = `${result.status}:${result.messageId}`;
          }
          if (result.status === "deferred") {
            scheduleDrain(Math.max(0, result.availableAt - now()));
            return;
          }
          if (
            result.status === "idle" ||
            result.status === "retried" ||
            result.status === "lease-lost"
          ) {
            return;
          }
        }
      } catch (error) {
        console.warn(`[agent-mail] inbound worker failed: ${(error as Error).message}`);
      }
    })().finally(() => {
      if (activeDrain === drain) activeDrain = undefined;
    });
    activeDrain = drain;
    return drain;
  }

  function scheduleDrain(delayMs = 0): void {
    if (!inboundReady || reconciliationController?.signal.aborted) return;
    const boundedDelay = Math.max(0, Math.min(delayMs, 60_000));
    const targetAt = Date.now() + boundedDelay;
    if (drainScheduled && drainKickAt !== undefined && drainKickAt <= targetAt) return;
    if (drainKickTimer) clearTimeout(drainKickTimer);
    drainScheduled = true;
    drainKickAt = targetAt;
    drainKickTimer = setTimeout(() => {
      drainScheduled = false;
      drainKickTimer = undefined;
      drainKickAt = undefined;
      void drainInbound();
    }, boundedDelay);
  }

  const inboundTransport: Augment["transport"] =
    inboundMode === "none"
      ? undefined
      : {
          async register(kernel, augmentName) {
            inboundKernel = kernel;
            inboundRegisteredName = augmentName;
          },
          async ready() {
            if (inboundReady) return;
            if (!inboundKernel || !inboundLedger || !sdkAdapters) {
              throw new Error("agentMail: inbound transport was not registered or booted");
            }
            const incidentThreads = inboundLedger.listIncidentThreads(opts.inboxId);
            for (const providerThreadId of incidentThreads) {
              inboundKernel.quarantineThread(
                agentMailRuntimeThreadId(opts.inboxId, providerThreadId),
              );
            }
            inboundWorker = createAgentMailInboundWorker({
              ledger: inboundLedger,
              kernel: inboundKernel,
              inboxId: opts.inboxId,
              sourceAugment: inboundRegisteredName,
              policy: inboundPolicy(),
              now,
              onTurnPrepared: ({ envelope, trigger }) => {
                reconcileLinkedReviewAttention();
                const ledgerRecord = inboundLedger!.get(
                  envelope.message.inboxId,
                  envelope.message.messageId,
                );
                const allowReopen =
                  ledgerRecord?.state === "processing" &&
                  ledgerRecord.lastError === "operator confirmed no external effect";
                let reservation: ReturnType<AgentMailInboundLedger["creatorAttention"]["reserve"]>;
                try {
                  reservation = inboundLedger!.creatorAttention.reserve({
                    inboxId: envelope.message.inboxId,
                    messageId: envelope.message.messageId,
                    allowReopen,
                  });
                } catch (error) {
                  if (error instanceof AgentMailCreatorAttentionCapacityError) {
                    return {
                      status: "deferred" as const,
                      reason: "creator-attention-capacity",
                    };
                  }
                  throw error;
                }
                if (
                  reservation.status === "active_duplicate" &&
                  reservation.record.state !== "open"
                ) {
                  throw new Error(
                    `agentMail: active ${reservation.record.state} creator attention prevents replay`,
                  );
                }
                seenMessagesByTurn.set(
                  trigger.turnId,
                  new Map([
                    [
                      envelope.message.messageId,
                      {
                        from: envelope.message.from,
                        replyTo: [...envelope.message.replyTo],
                        replyAllTo: [...envelope.message.to, ...envelope.message.cc],
                      },
                    ],
                  ]),
                );
                const peer = trigger.peer;
                if (!peer || !trigger.threadId) {
                  throw new Error("agentMail: inbound trigger is missing its resolved identity");
                }
                inboundTurnsByTurn.set(trigger.turnId, {
                  inboxId: envelope.message.inboxId,
                  messageId: envelope.message.messageId,
                  threadId: trigger.threadId,
                  peerId: peer.id,
                  sourceAugment: peer.sourceAugment,
                  attentionVersion: reservation.record.version,
                  replyAttempted: false,
                });
              },
              onTurnEffectsObserved: ({ trigger }) => {
                const scope = inboundTurnsByTurn.get(trigger.turnId);
                if (!scope) {
                  throw new Error("agentMail: inbound creator-attention scope is unavailable");
                }
                finalizeCreatorAttention(scope);
                return scope.outcome !== undefined;
              },
              onTerminalFailure: ({ envelope }) => {
                const current = inboundLedger!.creatorAttention.get(
                  envelope.message.inboxId,
                  envelope.message.messageId,
                );
                if (current?.state !== "open") return;
                const transitioned = inboundLedger!.creatorAttention.transition({
                  inboxId: current.inboxId,
                  messageId: current.messageId,
                  expectedVersion: current.version,
                  state: "failed",
                });
                if (transitioned.record?.state !== "failed") {
                  throw new Error(
                    "agentMail: terminal inbound failure could not finalize creator attention",
                  );
                }
              },
              onTurnSettled: ({ trigger }) => {
                seenMessagesByTurn.delete(trigger.turnId);
                inboundTurnsByTurn.delete(trigger.turnId);
              },
            });

            if (inboundMode === "websocket") {
              liveState = "starting";
              try {
                liveSubscription = await sdkAdapters.live.subscribe({
                  inboxId: opts.inboxId,
                  eventTypes: processedInboundEventTypes,
                  onSubscribed: async () => {
                    await catchUpInbound();
                    liveState = "subscribed";
                  },
                  onEvent: async (envelope) => {
                    inboundLedger!.enqueue(envelope);
                    lastInboundEventAt = now();
                    scheduleDrain();
                  },
                  onError: (error) => {
                    liveState = "degraded";
                    recordProviderError(error);
                    console.warn(`[agent-mail] WebSocket: ${error.message}`);
                  },
                });
                const subscription = liveSubscription;
                void subscription.closed
                  .then(() => {
                    if (inboundReady && liveSubscription === subscription) {
                      liveState = "degraded";
                      recordProviderError("WebSocket subscription closed unexpectedly");
                    }
                  })
                  .catch((error) => {
                    if (inboundReady && liveSubscription === subscription) {
                      liveState = "degraded";
                      recordProviderError(error);
                    }
                  });
              } catch (error) {
                liveState = "degraded";
                recordProviderError(error);
                throw error;
              }
            } else {
              await catchUpInbound();
            }

            const pollIntervalMs = opts.inbound?.pollIntervalMs ?? 60_000;
            drainTimer = setInterval(() => void drainInbound(), 1_000);
            drainTimer.unref?.();
            inboundReady = true;
            if (inboundMode !== "websocket") liveState = "ready";
            reconciliationTimer = setInterval(reconcileOnSchedule, pollIntervalMs);
            reconciliationTimer.unref?.();
            scheduleDrain();
          },
          identify: () => null,
          concurrency: 1,
          maxQueueDepth: 50,
        };

  function effectiveRateLimit() {
    return { ...rateLimitOpts, globalMaxPerHour };
  }

  function recordDispatch(record: DispatchRecord): void {
    dispatches.push(record);
    dispatchCounts[record.status]++;
  }

  function trustLevelOf(context: ToolExecuteContext | undefined): TrustLevel {
    // Null peer = internal trigger (scheduled / system) — treated as creator.
    return context?.peer?.trustLevel ?? "creator";
  }

  function reviewFingerprint(input: {
    trustLevel: TrustLevel;
    recipients: string[];
    rateKey: string;
    request: AgentMailReviewRequest;
  }): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          trustLevel: input.trustLevel,
          recipients: input.recipients.map((recipient) => recipient.toLowerCase()).sort(),
          rateKey: input.rateKey,
          request: input.request,
        }),
      )
      .digest("hex");
  }

  function queueForHumanReview(input: {
    context: ToolExecuteContext | undefined;
    tool: Exclude<DispatchRecord["tool"], "admin-test">;
    recipients: string[];
    subject: string;
    rateKey: string;
    request: AgentMailReviewRequest;
    flaggedSensitive?: boolean;
    force?: boolean;
  }): { envelope: string; record: AgentMailReviewRecord } | undefined {
    const trustLevel = trustLevelOf(input.context);
    if (!input.force && !reviewTrustLevels.includes(trustLevel)) return undefined;
    const fingerprint = reviewFingerprint({
      trustLevel,
      recipients: input.recipients,
      rateKey: input.rateKey,
      request: input.request,
    });
    const queued = reviewQueue.enqueue({
      trustLevel,
      recipients: input.recipients,
      subject: input.subject,
      rateKey: input.rateKey,
      fingerprint,
      request: input.request,
      expiresAt: now() + reviewExpiryMs,
    });
    recordDispatch({
      timestamp: timestampHHMMSS(now()),
      tool: input.tool,
      status: "pending_review",
      recipients: redactRecipients(input.recipients),
      subject: input.subject.slice(0, 80),
      flaggedSensitive: input.flaggedSensitive || undefined,
      detail: queued.duplicate
        ? `duplicate proposal reused review ${queued.record.id}`
        : `queued for operator review as ${queued.record.id}`,
    });
    return {
      record: queued.record,
      envelope: JSON.stringify({
        status: "pending_review",
        reviewId: queued.record.id,
        expiresAt: new Date(queued.record.expiresAt).toISOString(),
        duplicate: queued.duplicate || undefined,
      }),
    };
  }

  function beginDurableDirectAttempt(input: {
    trustLevel: TrustLevel;
    recipients: string[];
    subject: string;
    rateKey: string;
    request: AgentMailReviewRequest;
  }): { ok: true; record: AgentMailReviewRecord | undefined } | { ok: false; envelope: string } {
    const fingerprint = reviewFingerprint(input);
    try {
      const queued = reviewQueue.enqueue({
        ...input,
        fingerprint,
        expiresAt: now() + reviewExpiryMs,
      });
      if (queued.duplicate) {
        return {
          ok: false,
          envelope: JSON.stringify({
            status: "failed",
            message: `agentMail review queue: matching pending attempt "${queued.record.id}" already exists. Do not retry; operator reconciliation is required.`,
          }),
        };
      }
      const record = reviewQueue.beginApproval(queued.record.id);
      if (!reserveRateForAttempt(record)) {
        return {
          ok: false,
          envelope: JSON.stringify({
            status: "failed",
            message: `agentMail durable rate reservation is unavailable for review ${record.id}; the provider was not called and operator reconciliation is required`,
          }),
        };
      }
      return { ok: true, record };
    } catch (error) {
      return {
        ok: false,
        envelope: JSON.stringify({
          status: "failed",
          message: `${(error as Error).message}. Do not retry; operator reconciliation is required.`,
        }),
      };
    }
  }

  function markDirectAttemptFailed(
    attempt: AgentMailReviewRecord | undefined,
    result: SendMessageError,
  ): void {
    if (
      attempt &&
      result.httpStatus !== undefined &&
      !isAmbiguousMutationStatus(result.httpStatus)
    ) {
      if (releaseRateForAttempt(attempt)) reviewQueue.fail(attempt.id, result.detail);
    }
  }

  function markDirectAttemptSent(
    attempt: AgentMailReviewRecord | undefined,
    result: SendMessageResult,
    _rateStateDurable: boolean,
  ): void {
    if (attempt && commitRateForAttempt(attempt)) reviewQueue.approve(attempt.id, result);
  }

  function ambiguousDeliveryResult(): ToolResult {
    return {
      content: JSON.stringify({
        status: "failed",
        message:
          "AgentMail delivery outcome is ambiguous. Do not retry; operator reconciliation is required.",
      }),
      isError: true,
      outcomeUnknown: true,
    };
  }

  async function sendReviewedAction(
    record: AgentMailReviewRecord,
  ): Promise<SendMessageResult | SendMessageError> {
    const request = record.request;
    if (request.kind === "send") {
      const { kind: _, ...input } = request;
      return client.send({ inboxId: opts.inboxId, ...input });
    }
    if (request.kind === "reply") {
      // Recipients were already resolved, authorized, and durably bound.
      // Keep replyAll/attentionVersion as review evidence, never as provider
      // authority that could expand the reviewed recipient set.
      const {
        kind: _,
        attentionVersion: _attentionVersion,
        replyAll: _replyAll,
        ...input
      } = request;
      return client.reply({ inboxId: opts.inboxId, ...input });
    }
    const { kind: _, ...input } = request;
    return client.forward({ inboxId: opts.inboxId, ...input });
  }

  async function approveReview(
    id: string,
    expectedFingerprint: string,
  ): Promise<AdminActionResult> {
    const pending = reviewQueue.get(id);
    if (!pending) return { ok: false, message: `Unknown review id "${id}"` };
    if (pending.state !== "pending") {
      return { ok: false, message: `Review ${id} is ${pending.state}, not pending` };
    }
    if (pending.fingerprint !== expectedFingerprint) {
      return {
        ok: false,
        message: `Review ${id} fingerprint mismatch; inspect the exact queued action again`,
      };
    }
    if (pending.request.kind === "reply" && !pending.request.to) {
      const cancelled = reviewQueue.cancel(
        pending.id,
        "legacy reply review has no explicit recipient binding",
      );
      transitionReviewAttention(cancelled, "failed");
      return {
        ok: false,
        message: `Review ${id} was cancelled because its reply recipients were not durably bound`,
      };
    }
    if (pending.trustLevel !== "creator") {
      const decision = checkOutboundRateLimit(pending.recipients, pending.rateKey);
      if (!decision.allowed) {
        return {
          ok: false,
          message: `Review ${id} remains pending: rate limit blocked approval${decision.retryAfterSec ? `; retry in ${decision.retryAfterSec}s` : ""}`,
        };
      }
    }

    let sending: AgentMailReviewRecord;
    try {
      sending = reviewQueue.beginApproval(id);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (!reserveRateForAttempt(sending)) {
      transitionReviewAttention(sending, "ambiguous");
      return {
        ok: false,
        message: `Review ${id} was not sent because durable rate reservation is unavailable; operator reconciliation is required`,
      };
    }

    let result: SendMessageResult | SendMessageError;
    try {
      result = await sendReviewedAction(sending);
    } catch {
      transitionReviewAttention(sending, "ambiguous");
      return {
        ok: false,
        message: `Review ${id} has an ambiguous delivery outcome; operator reconciliation is required`,
      };
    }

    const tool =
      sending.request.kind === "send"
        ? "send_message"
        : sending.request.kind === "reply"
          ? "reply_to_message"
          : "forward_message";
    if (result.status === "failed") {
      // A transport failure (or an invalid success response) may happen after
      // AgentMail accepted the message. Without a provider HTTP response, keep
      // the durable `sending` marker so a restart or repeated proposal cannot
      // send the same reviewed action again.
      if (result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)) {
        transitionReviewAttention(sending, "ambiguous");
        return {
          ok: false,
          message: `Review ${id} has an ambiguous delivery outcome; operator reconciliation is required`,
        };
      }
      if (!releaseRateForAttempt(sending)) {
        return {
          ok: false,
          message: `Review ${id} remains in reconciliation because reservation release was not durable`,
        };
      }
      reviewQueue.fail(id, result.detail);
      const attentionUpdated = transitionReviewAttention(sending, "failed");
      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool,
        status: "failed",
        recipients: redactRecipients(sending.recipients),
        subject: sending.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: `review ${id}: ${result.detail}`,
      });
      return {
        ok: false,
        message:
          `Review ${id} failed${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}` +
          (attentionUpdated ? "" : "; creator-attention state requires operator repair"),
      };
    }

    const rateStateDurable = commitRateForAttempt(sending);
    if (rateStateDurable) {
      reviewQueue.approve(id, result);
    }
    const attentionUpdated = transitionReviewAttention(
      sending,
      rateStateDurable ? "sent" : "ambiguous",
    );
    const body = "text" in sending.request ? (sending.request.text ?? "") : "";
    const scan = body ? scanForSensitive(body) : { flagged: false, hits: [] };
    recordDispatch({
      timestamp: timestampHHMMSS(now()),
      tool,
      status: "sent",
      recipients: redactRecipients(sending.recipients),
      subject: sending.subject.slice(0, 80),
      flaggedSensitive: scan.flagged || undefined,
      detail: `approved review ${id}${scan.flagged ? `; sensitive content (${scan.hits.join(", ")})` : ""}`,
    });
    return {
      ok: rateStateDurable && attentionUpdated,
      message: !rateStateDurable
        ? `Review ${id} was sent but remains in reconciliation because rate state was not durable`
        : attentionUpdated
          ? `Review ${id} approved and sent`
          : `Review ${id} was sent, but creator-attention state requires operator repair`,
    };
  }

  async function reviseAndApproveReview(
    id: string,
    expectedFingerprint: string,
    text: string,
  ): Promise<AdminActionResult> {
    const pending = reviewQueue.get(id);
    if (!pending) return { ok: false, message: `Unknown review id "${id}"` };
    if (pending.state !== "pending") {
      return { ok: false, message: `Review ${id} is ${pending.state}, not pending` };
    }
    if (pending.fingerprint !== expectedFingerprint) {
      return {
        ok: false,
        message: `Review ${id} fingerprint mismatch; inspect the exact queued action again`,
      };
    }
    // A plain-text revision must not retain stale HTML carrying the old
    // draft. Operators can inspect the exact revised request before future
    // HTML editing is introduced.
    const { html: _html, ...requestBinding } = pending.request;
    const revisedRequest = { ...requestBinding, text } as AgentMailReviewRequest;
    const validation = validateOutbound(
      {
        recipients: pending.recipients,
        subject: pending.subject,
        text,
        // The queued subject was already normalized and is immutable.
        skipSubjectPrefix: true,
      },
      outboundOpts,
    );
    if (!validation.ok) return { ok: false, message: validation.reason };
    const fingerprint = reviewFingerprint({
      trustLevel: pending.trustLevel,
      recipients: pending.recipients,
      rateKey: pending.rateKey,
      request: revisedRequest,
    });
    try {
      reviewQueue.revise({
        id,
        expectedFingerprint,
        request: revisedRequest,
        fingerprint,
      });
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    return approveReview(id, fingerprint);
  }

  function rowBoundId(
    params: Record<string, unknown>,
    field: "reviewId" | "messageId" | "incidentId",
  ): { ok: true; id: string } | { ok: false; result: AdminActionResult } {
    const rowKey = typeof params.rowKey === "string" ? params.rowKey.trim() : "";
    const supplied = typeof params[field] === "string" ? params[field].trim() : "";
    if (rowKey && supplied && rowKey !== supplied) {
      return {
        ok: false,
        result: { ok: false, message: `${field} conflicts with the authorized row` },
      };
    }
    const id = rowKey || supplied;
    if (!id) {
      return { ok: false, result: { ok: false, message: `${field} is required` } };
    }
    return { ok: true, id };
  }

  function requireAmbiguousReview(
    id: string,
    expectedFingerprint: string,
  ): { ok: true; record: AgentMailReviewRecord } | { ok: false; result: AdminActionResult } {
    const record = reviewQueue.get(id);
    if (!record) {
      return { ok: false, result: { ok: false, message: `Unknown review id "${id}"` } };
    }
    if (record.state !== "sending") {
      return {
        ok: false,
        result: { ok: false, message: `Review ${id} is ${record.state}, not ambiguous` },
      };
    }
    if (record.fingerprint !== expectedFingerprint) {
      return {
        ok: false,
        result: {
          ok: false,
          message: `Review ${id} fingerprint mismatch; inspect the exact ambiguous action again`,
        },
      };
    }
    return { ok: true, record };
  }

  function reconcileReviewSent(
    id: string,
    expectedFingerprint: string,
    result: { messageId: string; threadId?: string; evidence: string },
  ): AdminActionResult {
    const ambiguous = requireAmbiguousReview(id, expectedFingerprint);
    if (!ambiguous.ok) return ambiguous.result;
    if (ratePersistenceFailure) {
      return {
        ok: false,
        message: `Review ${id} remains ambiguous: repair rate-state storage and restart before reconciling`,
      };
    }
    if (!commitRateForAttempt(ambiguous.record)) {
      return {
        ok: false,
        message: `Review ${id} remains ambiguous because rate state was not durable`,
      };
    }
    try {
      reviewQueue.approve(id, {
        messageId: result.messageId,
        ...(result.threadId ? { threadId: result.threadId } : {}),
        detail: `operator confirmed sent: ${result.evidence}`,
      });
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (!transitionReviewAttention(ambiguous.record, "sent")) {
      return {
        ok: false,
        message: `Review ${id} was reconciled as sent, but creator-attention state requires repair`,
      };
    }
    return { ok: true, message: `Review ${id} reconciled as sent` };
  }

  function reconcileReviewFailed(
    id: string,
    expectedFingerprint: string,
    reason: string,
  ): AdminActionResult {
    const ambiguous = requireAmbiguousReview(id, expectedFingerprint);
    if (!ambiguous.ok) return ambiguous.result;
    if (!releaseRateForAttempt(ambiguous.record)) {
      return {
        ok: false,
        message: `Review ${id} remains ambiguous because reservation release was not durable`,
      };
    }
    try {
      reviewQueue.fail(id, `operator confirmed not sent: ${reason}`);
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
    if (!transitionReviewAttention(ambiguous.record, "failed")) {
      return {
        ok: false,
        message: `Review ${id} was reconciled as not sent, but creator-attention state requires repair`,
      };
    }
    return { ok: true, message: `Review ${id} reconciled as not sent` };
  }

  function gateTrustLevel(
    context: ToolExecuteContext | undefined,
    tool: DispatchRecord["tool"],
  ): { allowed: true } | { allowed: false; envelope: string } {
    const trustLevel = trustLevelOf(context);
    if (trustLevel === "creator" || allowedTrustLevels.includes(trustLevel)) {
      return { allowed: true };
    }
    recordDispatch({
      timestamp: timestampHHMMSS(now()),
      tool,
      status: "blocked",
      recipients: "(blocked before send)",
      subject: "(blocked before send)",
      detail: `trust level "${trustLevel}" not in allowedTrustLevels=[${allowedTrustLevels.join(", ")}]`,
    });
    return {
      allowed: false,
      envelope: JSON.stringify({
        status: "failed",
        message: `agentMail: trust level "${trustLevel}" is not permitted to send mail. Ask the operator to widen outbound.allowedTrustLevels if appropriate.`,
      }),
    };
  }

  // ---------------------------------------------------------------------------
  // send_message
  // ---------------------------------------------------------------------------
  const sendMessageTool = defineTool({
    name: toolName("send_message"),
    description:
      "Send a new email from the configured AgentMail inbox. Use for proactive outreach, transactional notices, or replies to conversations the agent did not originate. Subject prefix is applied automatically; HTML bodies are disabled by default.",
    category: "communication",
    input: z.object({
      to: toolRecipientsSchema.describe("One or more recipient email addresses."),
      subject: z
        .string()
        .max(MAX_SUBJECT_CHARS)
        .describe("Subject line. Operator-configured prefix is applied automatically."),
      text: toolBodySchema.describe("Plain-text body of the message."),
      html: toolBodySchema
        .optional()
        .describe("HTML body. Off by default; operator must opt in via outbound.allowHtml."),
      labels: toolLabelsSchema
        .optional()
        .describe("AgentMail labels applied to the sent message (e.g., ['outreach'])."),
    }),
    execute: async (input, context) => {
      const gate = gateTrustLevel(context, "send_message");
      if (!gate.allowed) return gate.envelope;

      const validation = validateOutbound(
        { recipients: input.to, subject: input.subject, text: input.text, html: input.html },
        outboundOpts,
      );
      if (!validation.ok) {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "send_message",
          status: "blocked",
          recipients: redactRecipients(input.to),
          subject: input.subject.slice(0, 80),
          detail: validation.reason,
        });
        return JSON.stringify({ status: "failed", message: validation.reason });
      }

      const subjectForRateCheck = validation.value.subject;
      const trustLevel = trustLevelOf(context);
      const subjectToRateLimit = trustLevel === "creator" ? null : subjectForRateCheck;
      // Creator (and null peer) bypass rate limits entirely.
      if (subjectToRateLimit !== null) {
        const decision = checkOutboundRateLimit(validation.value.recipients, subjectToRateLimit);
        if (!decision.allowed) {
          recordDispatch({
            timestamp: timestampHHMMSS(now()),
            tool: "send_message",
            status: "rate_limited",
            recipients: redactRecipients(validation.value.recipients),
            subject: subjectForRateCheck.slice(0, 80),
            detail: decision.reason,
          });
          return JSON.stringify({
            status: "rate_limited",
            message: decision.reason,
            ...(decision.retryAfterSec ? { retryAfterSec: decision.retryAfterSec } : {}),
          });
        }
      }

      const scan = scanForSensitive(validation.value.text);
      const request: AgentMailReviewRequest = {
        kind: "send",
        to: validation.value.recipients,
        subject: validation.value.subject,
        text: validation.value.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      };

      const review = queueForHumanReview({
        context,
        tool: "send_message",
        recipients: validation.value.recipients,
        subject: validation.value.subject,
        rateKey: subjectForRateCheck,
        request,
        flaggedSensitive: scan.flagged,
      });
      if (review) return review.envelope;

      const attempt = beginDurableDirectAttempt({
        trustLevel,
        recipients: validation.value.recipients,
        subject: validation.value.subject,
        rateKey: subjectForRateCheck,
        request,
      });
      if (!attempt.ok) return attempt.envelope;

      let result: SendMessageResult | SendMessageError;
      try {
        const { kind: _, ...sendInput } = request;
        result = await client.send({
          inboxId: opts.inboxId,
          ...sendInput,
          signal: context?.signal,
        });
      } catch {
        return ambiguousDeliveryResult();
      }

      if (result.status === "sent") {
        markDirectAttemptSent(attempt.record, result, true);
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "send_message",
          status: "sent",
          recipients: redactRecipients(validation.value.recipients),
          subject: validation.value.subject.slice(0, 80),
          flaggedSensitive: scan.flagged || undefined,
          detail: scan.flagged
            ? `flagged for sensitive content (${scan.hits.join(", ")})`
            : undefined,
        });
        return JSON.stringify({
          status: "sent",
          messageId: result.messageId,
          threadId: result.threadId,
        });
      }

      markDirectAttemptFailed(attempt.record, result);

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "send_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      if (result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)) {
        return ambiguousDeliveryResult();
      }
      return JSON.stringify({
        status: "failed",
        message:
          attempt.record && result.httpStatus === undefined
            ? `${result.detail}. Do not retry; operator reconciliation is required.`
            : result.detail,
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // reply_to_message
  // ---------------------------------------------------------------------------
  const replyToMessageTool = defineTool({
    name: toolName("reply_to_message"),
    description:
      "Reply to an inbound email by its message_id (received via the agent's inbound trigger). The reply is threaded automatically by AgentMail. Use only with message_ids the agent has been shown this turn.",
    category: "communication",
    input: z.object({
      messageId: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_ID_CHARS)
        .describe("AgentMail message_id of the message being replied to."),
      text: toolBodySchema.describe("Plain-text body of the reply."),
      html: toolBodySchema.optional().describe("HTML body (off by default — operator opts in)."),
      replyAll: z
        .boolean()
        .optional()
        .describe("If true, reply to all original recipients. Default false."),
      labels: toolLabelsSchema.optional(),
    }),
    execute: async (input, context) => {
      if (mismatchedClaimedInboundTurn(context, input.messageId)) {
        const detail =
          "agentMail: inbound turn identity does not match the reserved message authority.";
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: "(blocked before reply)",
          subject: "(reply)",
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }
      const inboundScope = exactInboundTurn(context, input.messageId);
      if (inboundScope) {
        if (inboundReplies.mode === "disabled") {
          const detail =
            "agentMail: replies from inbound email turns are disabled by inbound.replies.mode.";
          recordDispatch({
            timestamp: timestampHHMMSS(now()),
            tool: "reply_to_message",
            status: "blocked",
            recipients: "(blocked before reply)",
            subject: "(reply)",
            detail,
          });
          return JSON.stringify({ status: "failed", message: detail });
        }
      } else {
        const gate = gateTrustLevel(context, "reply_to_message");
        if (!gate.allowed) return gate.envelope;
      }

      const meta = seenMessagesFor(context).get(input.messageId);
      if (!meta) {
        const detail = `reply_to_message: messageId "${input.messageId}" was not delivered to the agent this turn. Reply only to messages from your inbound trigger.`;
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: "(unknown)",
          subject: `re: ${input.messageId.slice(0, 60)}`,
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }
      if (input.replyAll && inboundScope && !inboundReplies.allowReplyAll) {
        const detail =
          "agentMail: replyAll is disabled for inbound email turns; reply only to the sender.";
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: redactRecipients([meta.from]),
          subject: "(reply)",
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }

      // Resolve and pin the exact provider recipients. Inbound replies honor
      // Reply-To, and reply-all removes this inbox by its verified canonical
      // email before validation. We never rely on provider-side expansion for
      // newly admitted inbound mail.
      const resolvedTargets = inboundScope
        ? replyRecipients(meta, input.replyAll === true)
        : {
            ok: true as const,
            recipients: input.replyAll
              ? uniqueReplyRecipients([meta.from, ...(meta.replyAllTo ?? [])])
              : [meta.from],
            replyToMismatch: false,
          };
      if (!resolvedTargets.ok) {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: "(unresolved reply recipients)",
          subject: "(reply)",
          detail: resolvedTargets.reason,
        });
        return JSON.stringify({ status: "failed", message: resolvedTargets.reason });
      }
      const recipients = resolvedTargets.recipients;

      // Validate against the real envelope, applying the same outboundOpts
      // (incl. allowlist + maxRecipients) as send_message.
      // `skipSubjectPrefix: true` is correct here — AgentMail derives the
      // subject from the parent thread; we never set it ourselves on reply.
      const validation = validateOutbound(
        {
          recipients,
          subject: "(server-derived)",
          text: input.text,
          html: input.html,
          skipSubjectPrefix: true,
        },
        outboundOpts,
      );
      if (!validation.ok) {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: redactRecipients(recipients),
          subject: "(reply)",
          detail: validation.reason,
        });
        return JSON.stringify({ status: "failed", message: validation.reason });
      }
      if (inboundScope?.replyAttempted) {
        const detail = "agentMail: this inbound message already has a reply action for this turn.";
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "blocked",
          recipients: redactRecipients(validation.value.recipients),
          subject: "(reply)",
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }
      if (inboundScope) inboundScope.replyAttempted = true;

      // Rate-limit the reply with the SAME state as send_message. The
      // subject-hash dedup uses a stable marker per inbound thread so the
      // model can't bypass dedup by switching tools. Creator (and null
      // peer) bypass — consistent with send_message.
      const trustLevel = trustLevelOf(context);
      const replyDedupKey = `reply:${input.messageId}`;
      if (trustLevel !== "creator") {
        const decision = checkOutboundRateLimit(
          validation.value.recipients,
          replyDedupKey,
          inboundScope && inboundReplies.mode === "automatic"
            ? AGENTMAIL_MAX_AUTOMATIC_REPLIES_PER_HOUR
            : undefined,
        );
        if (!decision.allowed) {
          setInboundReplyOutcome(inboundScope, { state: "failed" });
          recordDispatch({
            timestamp: timestampHHMMSS(now()),
            tool: "reply_to_message",
            status: "rate_limited",
            recipients: redactRecipients(validation.value.recipients),
            subject: "(reply)",
            detail: decision.reason,
          });
          return JSON.stringify({
            status: "rate_limited",
            message: decision.reason,
            ...(decision.retryAfterSec ? { retryAfterSec: decision.retryAfterSec } : {}),
          });
        }
      }

      const scan = scanForSensitive(
        validation.value.html ? `${input.text}\n${validation.value.html}` : input.text,
      );
      const request: AgentMailReviewRequest = {
        kind: "reply",
        messageId: input.messageId,
        to: validation.value.recipients,
        ...(inboundScope ? { attentionVersion: inboundScope.attentionVersion } : {}),
        text: input.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.replyAll !== undefined ? { replyAll: input.replyAll } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      };

      const inboundMustReview =
        inboundScope &&
        (inboundReplies.mode === "review" ||
          (inboundReplies.mode === "automatic" &&
            (scan.flagged || resolvedTargets.replyToMismatch)));
      const review = inboundScope
        ? inboundMustReview
          ? queueForHumanReview({
              context,
              tool: "reply_to_message",
              recipients: validation.value.recipients,
              subject: "(reply)",
              rateKey: replyDedupKey,
              request,
              flaggedSensitive: scan.flagged,
              force: true,
            })
          : undefined
        : queueForHumanReview({
            context,
            tool: "reply_to_message",
            recipients: validation.value.recipients,
            subject: "(reply)",
            rateKey: replyDedupKey,
            request,
            flaggedSensitive: scan.flagged,
          });
      if (review) {
        setInboundReplyOutcome(inboundScope, {
          state: "pending_review",
          reviewId: review.record.id,
        });
        return review.envelope;
      }

      const attempt = beginDurableDirectAttempt({
        trustLevel,
        recipients: validation.value.recipients,
        subject: "(reply)",
        rateKey: replyDedupKey,
        request,
      });
      if (!attempt.ok) {
        setInboundReplyOutcome(inboundScope, { state: "ambiguous" });
        return attempt.envelope;
      }

      let result: SendMessageResult | SendMessageError;
      try {
        const {
          kind: _,
          attentionVersion: _attentionVersion,
          replyAll: _replyAll,
          ...replyInput
        } = request;
        result = await client.reply({
          inboxId: opts.inboxId,
          ...replyInput,
          signal: context?.signal,
        });
      } catch {
        setInboundReplyOutcome(inboundScope, {
          state: "ambiguous",
          ...(attempt.record ? { reviewId: attempt.record.id } : {}),
        });
        return ambiguousDeliveryResult();
      }

      if (result.status === "sent") {
        markDirectAttemptSent(attempt.record, result, true);
        setInboundReplyOutcome(inboundScope, {
          state: "sent",
          ...(attempt.record ? { reviewId: attempt.record.id } : {}),
        });
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "reply_to_message",
          status: "sent",
          recipients: redactRecipients(validation.value.recipients),
          subject: "(reply)",
          flaggedSensitive: scan.flagged || undefined,
          detail: scan.flagged
            ? `flagged for sensitive content (${scan.hits.join(", ")})`
            : undefined,
        });
        return JSON.stringify({
          status: "sent",
          messageId: result.messageId,
          threadId: result.threadId,
        });
      }

      markDirectAttemptFailed(attempt.record, result);

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "reply_to_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: "(reply)",
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      if (result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)) {
        setInboundReplyOutcome(inboundScope, {
          state: "ambiguous",
          ...(attempt.record ? { reviewId: attempt.record.id } : {}),
        });
        return ambiguousDeliveryResult();
      }
      setInboundReplyOutcome(inboundScope, {
        state: "failed",
        ...(attempt.record ? { reviewId: attempt.record.id } : {}),
      });
      return JSON.stringify({
        status: "failed",
        message:
          attempt.record && result.httpStatus === undefined
            ? `${result.detail}. Do not retry; operator reconciliation is required.`
            : result.detail,
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // forward_message
  // ---------------------------------------------------------------------------
  const forwardMessageTool = defineTool({
    name: toolName("forward_message"),
    description:
      "Forward an inbound message to additional recipient(s). Use when handing a thread to a teammate, escalating to an operator, or copying the operator on a thread the agent is handling.",
    category: "communication",
    input: z.object({
      messageId: z
        .string()
        .min(1)
        .max(MAX_MESSAGE_ID_CHARS)
        .describe("AgentMail message_id of the message being forwarded."),
      to: toolRecipientsSchema.describe("Forward recipient(s)."),
      text: toolBodySchema
        .optional()
        .describe("Optional commentary prepended to the forwarded body."),
      html: toolBodySchema.optional().describe("HTML commentary (off by default)."),
      subject: z
        .string()
        .max(MAX_SUBJECT_CHARS)
        .optional()
        .describe('Subject override. Default: AgentMail prepends "Fwd: " to original.'),
      labels: toolLabelsSchema.optional(),
    }),
    execute: async (input, context) => {
      if (mismatchedClaimedInboundTurn(context, input.messageId)) {
        const detail =
          "agentMail: inbound turn identity does not match the reserved message authority.";
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "forward_message",
          status: "blocked",
          recipients: "(blocked before forward)",
          subject: input.subject?.slice(0, 80) ?? "(forward)",
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }
      const gate = gateTrustLevel(context, "forward_message");
      if (!gate.allowed) return gate.envelope;

      if (!seenMessagesFor(context).has(input.messageId)) {
        const detail = `forward_message: messageId "${input.messageId}" was not delivered to the agent this turn.`;
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "forward_message",
          status: "blocked",
          recipients: redactRecipients(input.to),
          subject: input.subject?.slice(0, 80) ?? "(forward)",
          detail,
        });
        return JSON.stringify({ status: "failed", message: detail });
      }

      const validation = validateOutbound(
        {
          recipients: input.to,
          subject: input.subject ?? "Fwd: (server-derived)",
          text: input.text ?? "",
          html: input.html,
          skipSubjectPrefix: input.subject === undefined,
        },
        outboundOpts,
      );
      if (!validation.ok) {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "forward_message",
          status: "blocked",
          recipients: redactRecipients(input.to),
          subject: input.subject?.slice(0, 80) ?? "(forward)",
          detail: validation.reason,
        });
        return JSON.stringify({ status: "failed", message: validation.reason });
      }

      const trustLevel = trustLevelOf(context);
      if (trustLevel !== "creator") {
        const decision = checkOutboundRateLimit(
          validation.value.recipients,
          validation.value.subject,
        );
        if (!decision.allowed) {
          recordDispatch({
            timestamp: timestampHHMMSS(now()),
            tool: "forward_message",
            status: "rate_limited",
            recipients: redactRecipients(validation.value.recipients),
            subject: validation.value.subject.slice(0, 80),
            detail: decision.reason,
          });
          return JSON.stringify({
            status: "rate_limited",
            message: decision.reason,
            ...(decision.retryAfterSec ? { retryAfterSec: decision.retryAfterSec } : {}),
          });
        }
      }

      const scan = input.text ? scanForSensitive(input.text) : { flagged: false, hits: [] };
      const request: AgentMailReviewRequest = {
        kind: "forward",
        messageId: input.messageId,
        to: validation.value.recipients,
        ...(input.subject ? { subject: validation.value.subject } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      };

      const review = queueForHumanReview({
        context,
        tool: "forward_message",
        recipients: validation.value.recipients,
        subject: validation.value.subject,
        rateKey: validation.value.subject,
        request,
        flaggedSensitive: scan.flagged,
      });
      if (review) return review.envelope;

      const attempt = beginDurableDirectAttempt({
        trustLevel,
        recipients: validation.value.recipients,
        subject: validation.value.subject,
        rateKey: validation.value.subject,
        request,
      });
      if (!attempt.ok) return attempt.envelope;

      let result: SendMessageResult | SendMessageError;
      try {
        const { kind: _, ...forwardInput } = request;
        result = await client.forward({
          inboxId: opts.inboxId,
          ...forwardInput,
          signal: context?.signal,
        });
      } catch {
        return ambiguousDeliveryResult();
      }

      if (result.status === "sent") {
        markDirectAttemptSent(attempt.record, result, true);
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "forward_message",
          status: "sent",
          recipients: redactRecipients(validation.value.recipients),
          subject: validation.value.subject.slice(0, 80),
          flaggedSensitive: scan.flagged || undefined,
          detail: scan.flagged
            ? `flagged for sensitive content (${scan.hits.join(", ")})`
            : undefined,
        });
        return JSON.stringify({
          status: "sent",
          messageId: result.messageId,
          threadId: result.threadId,
        });
      }

      markDirectAttemptFailed(attempt.record, result);

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "forward_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      if (result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)) {
        return ambiguousDeliveryResult();
      }
      return JSON.stringify({
        status: "failed",
        message:
          attempt.record && result.httpStatus === undefined
            ? `${result.detail}. Do not retry; operator reconciliation is required.`
            : result.detail,
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async function onBoot(): Promise<void> {
    if (creatorDigestConfig.enabled && !creatorDigestController) {
      throw new Error(
        "agentMail: inbound.creatorDigest is enabled but no Notify bridge is mounted",
      );
    }
    dispatches.clear();
    for (const status of Object.keys(dispatchCounts) as DispatchRecord["status"][]) {
      dispatchCounts[status] = 0;
    }
    lastCatchUpAt = undefined;
    lastCatchUpSummary = undefined;
    lastInboundEventAt = undefined;
    lastWorkerOutcome = undefined;
    lastProviderError = undefined;
    liveState = inboundMode === "none" ? "disabled" : "stopped";
    if (activeCatchUp || activeDrain || deferredInboundRelease) {
      throw new Error("agentMail: previous inbound runtime has not stopped");
    }
    inboundStopping = false;
    reconciliationController = inboundMode === "none" ? undefined : new AbortController();

    // Placeholder-resolution check — same pattern as visitor-auth.
    if (looksLikePlaceholder(opts.apiKey)) {
      throw new Error(
        `agentMail: AGENTMAIL_API_KEY is unresolved (got "${opts.apiKey}"). Set it in .env and restart.`,
      );
    }
    if (looksLikePlaceholder(opts.inboxId)) {
      throw new Error(
        `agentMail: AGENTMAIL_INBOX_ID is unresolved (got "${opts.inboxId}"). Set it in .env and restart.`,
      );
    }
    if (opts.emailAddress && looksLikePlaceholder(opts.emailAddress)) {
      throw new Error(
        `agentMail: AGENTMAIL_INBOX_EMAIL is unresolved (got "${opts.emailAddress}"). Set it in .env and restart.`,
      );
    }

    if (inboundMode !== "none") {
      if (!inboundLedger) {
        inboundLedger = createAgentMailInboundLedger({
          dbPath: opts.dbPath ?? join(stateDir ?? process.cwd(), "agent-mail.db"),
          now,
        });
        ownsInboundLedger = true;
      }
      // Runtime startup is the single-replica ownership boundary. A retained
      // claim may already have caused external effects, so it becomes a
      // durable incident and is never silently replayed.
      inboundLedger.fenceInterruptedClaims({ inboxId: opts.inboxId });
      reconcileLinkedReviewAttention();
      sdkAdapters ??= createAgentMailSdkAdapters({
        apiKey: opts.apiKey,
        apiBaseUrl: opts.apiBaseUrl,
        websocketBaseUrl: opts.inbound?.websocketBaseUrl,
        allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
      });
      if (inboundMode === "webhook" && !webhookRouteInstalled) {
        const webhookOptions = opts.inbound?.webhook;
        agentMailRoutes.push(
          createAgentMailWebhookRoute({
            inboxId: opts.inboxId,
            ledger: () => {
              if (!inboundLedger) throw new Error("agentMail: inbound runtime is not booted");
              return inboundLedger;
            },
            path:
              webhookOptions?.path ??
              (legacySingletonCompatibility ? undefined : `/webhooks/agentmail/${instanceId}`),
            secretEnv: webhookOptions?.secretEnv,
            timestampToleranceSeconds: webhookOptions?.timestampToleranceSeconds,
            onAccepted: () => {
              lastInboundEventAt = now();
              scheduleDrain();
            },
          }),
        );
        webhookRouteInstalled = true;
      }
    }

    // Best-effort inbox healthcheck. Network failures, 5xx, request timeouts,
    // early-data retries, and provider rate limits are transient. Every other
    // provider rejection is deterministic and fails closed so an unverified
    // inbox identity cannot be published.
    const health = await client.getInbox(opts.inboxId);
    if (health.status === "failed") {
      if (health.failureKind === "invalid-response") {
        throw new Error(
          `agentMail: AgentMail returned an invalid identity for inbox "${opts.inboxId}". Refusing to publish the configured address; retry setup or contact AgentMail support.`,
        );
      }
      const httpStatus = health.httpStatus;
      if (!isTransientInboxHealthFailure(health)) {
        throw new Error(
          `agentMail: inbox "${opts.inboxId}" healthcheck failed${httpStatus === undefined ? "" : ` with HTTP ${httpStatus}`}: ${health.detail}. Check AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in .env and restart.`,
        );
      }
      // Transient failure — retain a setup-verified configured address when
      // available, otherwise leave the canonical identity unavailable.
      console.warn(
        `[agent-mail] inbox "${opts.inboxId}" healthcheck failed: ${health.detail}. Continuing boot — first real send will surface the same error.`,
      );
      recordProviderError(health.detail);
      return;
    }
    const providerEmail = canonicalizeEmail(health.email);
    if (resolvedInboxEmail && resolvedInboxEmail !== providerEmail) {
      throw new Error(
        `agentMail: configured emailAddress "${resolvedInboxEmail}" does not match AgentMail inbox "${providerEmail}". Run AgentMail setup again before publishing this address.`,
      );
    }
    resolvedInboxEmail = providerEmail;
    inboxIdentitySource = "provider";
  }

  async function context(turn: TurnState): Promise<ContextBlock[]> {
    if (!resolvedInboxEmail) return [];
    const trustLevel = turn.peer?.trustLevel ?? "creator";
    if (addressVisibility === "creator" && trustLevel !== "creator") return [];

    const monitoring =
      inboundMode === "none"
        ? "Inbound monitoring is disabled. Do not describe this as a monitored contact channel; if asked, explain that messages may not be read."
        : liveState === "ready" || liveState === "subscribed"
          ? `Inbound monitoring is active via ${inboundMode}.`
          : liveState === "degraded"
            ? `Inbound ${inboundMode} monitoring is degraded, so replies may be delayed until catch-up succeeds.`
            : `Inbound ${inboundMode} monitoring is configured but not ready.`;

    return [
      {
        source: `agent-mail-identity:${instanceId}`,
        content:
          `AgentMail instance ${instanceId} (inbox ${opts.inboxId}) uses the canonical email address ${resolvedInboxEmail}. ${monitoring} ` +
          `Its mail tools are ${toolName("send_message")}, ${toolName("reply_to_message")}, and ${toolName("forward_message")}. ` +
          "Provide the address when someone reasonably asks how to contact you or email is the appropriate channel. Do not volunteer it indiscriminately or promise an immediate response.",
        placement: "preamble",
        provenance: "augment",
        priority: "normal",
        eviction: "drop",
        origin: "system",
        ttl: "turn",
      },
    ];
  }

  async function onShutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
      inboundStopping = true;
      const deadline = Date.now() + shutdownTimeoutMs;
      async function withinDeadline<T>(promise: Promise<T>, label: string): Promise<T> {
        const remaining = deadline - Date.now();
        if (remaining <= 0) throw new Error(`agentMail: ${label} timed out`);
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          return await Promise.race([
            promise,
            new Promise<never>((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error(`agentMail: ${label} timed out`)),
                remaining,
              );
            }),
          ]);
        } finally {
          if (timeout) clearTimeout(timeout);
        }
      }
      reconciliationController?.abort();
      if (reconciliationTimer) clearInterval(reconciliationTimer);
      if (drainTimer) clearInterval(drainTimer);
      if (drainKickTimer) clearTimeout(drainKickTimer);
      reconciliationTimer = undefined;
      drainTimer = undefined;
      drainKickTimer = undefined;
      drainKickAt = undefined;
      drainScheduled = false;
      inboundReady = false;

      const subscription = liveSubscription;
      const ownedLedger = ownsInboundLedger ? inboundLedger : undefined;

      let failure: unknown;
      let subscriptionClose: Promise<void> | undefined;
      let subscriptionQuiesced = true;
      try {
        subscriptionClose = subscription?.close();
      } catch (error) {
        failure = error;
      }
      try {
        if (subscriptionClose) {
          subscriptionQuiesced = false;
          await withinDeadline(subscriptionClose, "subscription shutdown");
          subscriptionQuiesced = true;
        }
      } catch (error) {
        // A provider rejection is settled and safe to release; a timeout is
        // not. Attach a settlement observer so the latter can release later.
        if (subscriptionClose) {
          void subscriptionClose.then(
            () => {
              subscriptionQuiesced = true;
            },
            () => {
              subscriptionQuiesced = true;
            },
          );
        }
        failure ??= error;
      }

      // Polling and reconnect catch-up may be inside a provider request when
      // shutdown begins. Abort future pages, then retain the ledger until the
      // current single-flight run has quiesced.
      let catchUpQuiesced = true;
      const catchUp = activeCatchUp;
      try {
        if (catchUp) await withinDeadline(catchUp, "inbound catch-up shutdown");
      } catch (error) {
        catchUpQuiesced = activeCatchUp === undefined;
        // An abort-aware catch-up rejects as part of an ordinary stop. Only a
        // provider request that remains live past the deadline is a shutdown
        // failure; completed provider errors are already recorded in status.
        if (!catchUpQuiesced) failure ??= error;
      }

      // Listener close drains its queued delivery chain. Retain the current
      // ledger until it quiesces, then capture the latest worker drain so an
      // event delivered during close cannot be lost or race a closed handle.
      if (drainKickTimer) clearTimeout(drainKickTimer);
      drainKickTimer = undefined;
      drainScheduled = false;
      try {
        if (activeDrain) await withinDeadline(activeDrain, "inbound drain shutdown");
      } catch (error) {
        failure ??= error;
      }

      liveSubscription = undefined;
      reconciliationController = undefined;
      liveState = inboundMode === "none" ? "disabled" : "stopped";

      const catchUpUser = activeCatchUp;
      const drainUser = activeDrain;
      const usersRemain =
        !subscriptionQuiesced || catchUpUser !== undefined || drainUser !== undefined;
      const releaseInboundResources = () => {
        if (ownedLedger) {
          try {
            ownedLedger.close();
          } catch (error) {
            console.warn(
              `[agent-mail] deferred inbound ledger shutdown failed: ${(error as Error).message}`,
            );
          }
        }
        if (inboundLedger === ownedLedger || !ownedLedger) {
          inboundLedger = opts._inboundLedger;
        }
        ownsInboundLedger = false;
        inboundWorker = undefined;
        inboundKernel = undefined;
        seenMessagesByTurn.clear();
        inboundTurnsByTurn.clear();
      };

      if (!usersRemain && catchUpQuiesced) {
        try {
          ownedLedger?.close();
        } catch (error) {
          failure ??= error;
        }
        inboundLedger = opts._inboundLedger;
        ownsInboundLedger = false;
        inboundWorker = undefined;
        inboundKernel = undefined;
        seenMessagesByTurn.clear();
        inboundTurnsByTurn.clear();
      } else {
        // A timed-out subscription/catch-up/turn may still touch SQLite and
        // turn-scoped reply authority. Fence new tool calls immediately, but
        // retain both until every captured and late drain user has quiesced.
        const pendingUsers = [
          ...(!subscriptionQuiesced && subscriptionClose ? [subscriptionClose] : []),
          ...(catchUpUser ? [catchUpUser] : []),
          ...(drainUser ? [drainUser] : []),
        ];
        deferredInboundRelease ??= Promise.allSettled(pendingUsers)
          .then(async () => {
            const lateCatchUp = activeCatchUp;
            const lateDrain = activeDrain;
            await Promise.allSettled([
              ...(lateCatchUp ? [lateCatchUp] : []),
              ...(lateDrain ? [lateDrain] : []),
            ]);
            releaseInboundResources();
          })
          .finally(() => {
            deferredInboundRelease = undefined;
          });
      }
      if (overrideRootRetained) {
        releaseAdminOverrideRoot(overrideDir);
        overrideRootRetained = false;
      }
      if (failure) throw failure;
    })();
    try {
      await shutdownPromise;
    } finally {
      shutdownPromise = undefined;
    }
  }

  // ---------------------------------------------------------------------------
  // Admin info / actions
  // ---------------------------------------------------------------------------

  function maskApiKey(key: string): string {
    if (key.length < 8) return "***";
    return `${key.slice(0, 4)}…${key.slice(-2)}`;
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    const recent = dispatches.snapshot().slice(-50);
    const reviews = reviewQueue.list();
    const pendingReviews = reviews.filter((review) => review.state === "pending");
    const ambiguousReviews = reviews.filter((review) => review.state === "sending");
    let ledgerCounts = {
      pending: 0,
      processing: 0,
      processed: 0,
      discarded: 0,
      outcomeUnknown: 0,
    };
    let inboundIncidents: ReturnType<AgentMailInboundLedger["listIncidents"]> = [];
    let attentionRecords: AgentMailCreatorAttentionRecord[] = [];
    let attentionCounts = {
      open: 0,
      pendingReview: 0,
      sent: 0,
      rejected: 0,
      failed: 0,
      ambiguous: 0,
      dismissed: 0,
    };
    let inboundQuota = {
      rollingGlobalUsage: 0,
      globalRejections: 0,
      perSenderRejections: 0,
      lastRejectedAt: undefined as number | undefined,
    };
    let checkpoint: string | undefined;
    if (inboundLedger) {
      try {
        reconcileLinkedReviewAttention();
        ledgerCounts = inboundLedger.counts(opts.inboxId);
        inboundIncidents = inboundLedger.listIncidents(50, opts.inboxId);
        attentionRecords = inboundLedger.creatorAttention.list({
          inboxId: opts.inboxId,
          limit: 50,
        });
        attentionCounts = inboundLedger.creatorAttention.counts(opts.inboxId);
        inboundQuota = inboundLedger.inboundQuotaStatus(opts.inboxId);
        checkpoint = inboundLedger.checkpoint(opts.inboxId);
      } catch (error) {
        recordProviderError(error);
      }
    }
    const operationalWarnings: string[] = [];
    if (inboundMode !== "none" && !inboundReady) operationalWarnings.push("inbound not ready");
    if (inboundSenderPolicy === "any") {
      operationalWarnings.push("public inbound sender admission enabled");
    }
    if (lastProviderError) operationalWarnings.push(`provider: ${lastProviderError}`);
    if (ambiguousReviews.length > 0) {
      operationalWarnings.push(
        `${ambiguousReviews.length} review(s) stopped in ambiguous sending state`,
      );
    }
    if (attentionCounts.open + attentionCounts.pendingReview + attentionCounts.ambiguous > 0) {
      operationalWarnings.push(
        `${attentionCounts.open + attentionCounts.pendingReview + attentionCounts.ambiguous} inbound item(s) need creator attention`,
      );
    }
    const creatorDigestStatus = creatorDigestController?.status() ?? {
      state: creatorDigestConfig.enabled ? "degraded" : "disabled",
    };
    if (
      creatorDigestStatus.state === "outcome_unknown" ||
      creatorDigestStatus.state === "attempts_exhausted" ||
      creatorDigestStatus.state === "degraded"
    ) {
      operationalWarnings.push(`creator digest: ${creatorDigestStatus.state.replaceAll("_", " ")}`);
    }
    const statusLevel = operationalWarnings.length === 0 ? "ok" : "warn";
    const statusMessage =
      operationalWarnings.length === 0
        ? inboundMode === "none"
          ? "Outbound ready; inbound disabled"
          : `Inbound ${inboundMode} ready`
        : operationalWarnings.join("; ");
    const attentionMetadata = new Map(
      attentionRecords.map((record) => {
        const message = inboundLedger?.get(opts.inboxId, record.messageId)?.envelope.message;
        return [record.messageId, message] as const;
      }),
    );
    const projectedReviews = [...pendingReviews, ...ambiguousReviews]
      .sort((left, right) => left.createdAt - right.createdAt || left.id.localeCompare(right.id))
      .map((review) => ({
        rowKey: review.id,
        reviewId: review.id,
        status: review.state as "pending" | "sending",
        subject: review.subject.slice(0, 200),
        correspondent: redactRecipients(review.recipients),
        updatedAt: new Date(review.attemptedAt ?? review.createdAt).toISOString(),
        expiresAt: new Date(review.expiresAt).toISOString(),
        detailPath: `${instanceRouteBase}/reviews/${encodeURIComponent(review.id)}`,
        actions:
          review.state === "pending"
            ? {
                approve: { actionId: "agentmail-review-approve" },
                revise: { actionId: "agentmail-review-revise" },
                reject: { actionId: "agentmail-review-reject" },
              }
            : {
                reconcileSent: { actionId: "agentmail-review-reconcile-sent" },
                reconcileFailed: { actionId: "agentmail-review-reconcile-failed" },
              },
      }));
    const incidentMessageIds = new Set(inboundIncidents.map((incident) => incident.messageId));
    const projectedCreatorAttention = attentionRecords
      .filter(
        (
          record,
        ): record is AgentMailCreatorAttentionRecord & {
          state: "open" | "pending_review" | "ambiguous";
        } =>
          (record.state === "open" ||
            record.state === "pending_review" ||
            record.state === "ambiguous") &&
          !incidentMessageIds.has(record.messageId),
      )
      .map((record) => {
        const message = attentionMetadata.get(record.messageId);
        return {
          rowKey: record.messageId,
          messageId: record.messageId,
          status: record.state,
          version: record.version,
          ...(message
            ? {
                subject: message.subject.slice(0, 200),
                sender: message.from.slice(0, 320),
                receivedAt: message.timestamp,
              }
            : {}),
          updatedAt: new Date(record.updatedAt).toISOString(),
          detailPath: `${instanceRouteBase}/messages/${encodeURIComponent(record.messageId)}`,
          actions: { dismiss: { actionId: "agentmail-attention-dismiss" } },
        };
      });
    const projectedIncidents = inboundIncidents.map((incident) => {
      const message = inboundLedger?.get(opts.inboxId, incident.messageId)?.envelope.message;
      return {
        rowKey: incident.id,
        messageId: incident.messageId,
        status: "ambiguous" as const,
        version: incident.version,
        ...(message
          ? {
              subject: message.subject.slice(0, 200),
              sender: message.from.slice(0, 320),
              receivedAt: message.timestamp,
            }
          : {}),
        updatedAt: new Date(incident.quarantinedAt).toISOString(),
        detailPath: `${instanceRouteBase}/messages/${encodeURIComponent(incident.messageId)}`,
        actions: {
          reconcileProcessed: { actionId: "agentmail-inbound-reconcile-handled" },
          reconcilePending: { actionId: "agentmail-inbound-reconcile-no-effect" },
        },
      };
    });
    const projectedAttention = [...projectedCreatorAttention, ...projectedIncidents].sort(
      (left, right) =>
        left.updatedAt.localeCompare(right.updatedAt) || left.rowKey.localeCompare(right.rowKey),
    );

    return {
      augmentName: instanceId,
      title: hasExplicitInstanceId ? `AgentMail · ${instanceId}` : "AgentMail",
      sections: [
        {
          kind: "status",
          level: statusLevel,
          message: statusMessage,
        },
        {
          kind: "keyValue",
          rows: [
            { label: "Inbox ID", value: opts.inboxId },
            {
              label: "Inbox email",
              value: resolvedInboxEmail ?? "(unavailable — run AgentMail setup)",
              source: inboxIdentitySource,
            },
            {
              label: "Address visibility",
              value: addressVisibility,
              source: "yaml",
            },
            { label: "API key", value: maskApiKey(opts.apiKey) },
            {
              label: "Global cap (per hour)",
              value: String(globalMaxPerHour),
              source: globalMaxSource === "override" ? "/admin override" : "yaml",
              resetAction: { id: "agentmail-cap-reset", label: "Reset to yaml" },
            },
            {
              label: "Allowed trust levels",
              value: allowedTrustLevels.join(", ") || "(none)",
              source: "yaml",
            },
            {
              label: "Human review required",
              value: reviewTrustLevels.join(", ") || "(none — autonomous)",
              source: "yaml",
            },
            {
              label: "Recipient allowlist",
              value:
                outboundOpts.allowedRecipients && outboundOpts.allowedRecipients.length > 0
                  ? `${outboundOpts.allowedRecipients.length} entries`
                  : "(open — any well-formed email)",
              source: "yaml",
            },
            {
              label: "Sent (since boot)",
              value: String(dispatchCounts.sent),
            },
            { label: "Blocked (since boot)", value: String(dispatchCounts.blocked) },
            {
              label: "Rate limited (since boot)",
              value: String(dispatchCounts.rate_limited),
            },
            { label: "Recent dispatches", value: String(recent.length) },
            { label: "Pending human reviews", value: String(pendingReviews.length) },
            { label: "Ambiguous sending reviews", value: String(ambiguousReviews.length) },
            { label: "Inbound mode", value: inboundMode, source: "yaml" },
            {
              label: "Inbound sender policy",
              value:
                inboundSenderPolicy === "any"
                  ? "any well-formed sender"
                  : inboundSenderPolicy === "allowlist"
                    ? `${inboundAllowedSenderCount} allowlist entries`
                    : "disabled",
              source: "yaml",
            },
            {
              label: "Inbound global cap (per hour)",
              value: inboundRateLimit ? String(inboundRateLimit.globalMaxPerHour) : "(disabled)",
              source: "yaml",
            },
            {
              label: "Inbound per-sender cap (per hour)",
              value: inboundRateLimit ? String(inboundRateLimit.perSenderMaxPerHour) : "(disabled)",
              source: "yaml",
            },
            {
              label: "Inbound rolling-hour usage",
              value: String(inboundQuota.rollingGlobalUsage),
            },
            {
              label: "Inbound global quota rejections",
              value: String(inboundQuota.globalRejections),
            },
            {
              label: "Inbound per-sender quota rejections",
              value: String(inboundQuota.perSenderRejections),
            },
            {
              label: "Last inbound quota rejection",
              value:
                inboundQuota.lastRejectedAt === undefined
                  ? "(never)"
                  : new Date(inboundQuota.lastRejectedAt).toISOString(),
            },
            { label: "Inbound runtime", value: liveState },
            { label: "Inbound pending", value: String(ledgerCounts.pending) },
            { label: "Inbound processing", value: String(ledgerCounts.processing) },
            { label: "Inbound processed", value: String(ledgerCounts.processed) },
            { label: "Inbound discarded", value: String(ledgerCounts.discarded) },
            { label: "Inbound outcome unknown", value: String(ledgerCounts.outcomeUnknown) },
            { label: "Attention open", value: String(attentionCounts.open) },
            { label: "Attention pending review", value: String(attentionCounts.pendingReview) },
            { label: "Attention ambiguous", value: String(attentionCounts.ambiguous) },
            {
              label: "Creator digest",
              value: creatorDigestConfig.enabled ? creatorDigestStatus.state : "disabled",
              source: "yaml",
            },
            {
              label: "Creator digest pending items",
              value: String(creatorDigestStatus.pendingItems ?? 0),
            },
            {
              label: "Creator digest pending batch",
              value: creatorDigestStatus.pendingBatchId ?? "(none)",
            },
            {
              label: "Creator digest attempts",
              value: String(creatorDigestStatus.attemptCount ?? 0),
            },
            {
              label: "Creator digest last presented",
              value: creatorDigestStatus.lastPresentedAt
                ? new Date(creatorDigestStatus.lastPresentedAt).toISOString()
                : "(never)",
            },
            { label: "Catch-up checkpoint", value: checkpoint ?? "(none)" },
            {
              label: "Last catch-up",
              value: lastCatchUpAt ? new Date(lastCatchUpAt).toISOString() : "(never)",
            },
            { label: "Last catch-up result", value: lastCatchUpSummary ?? "(none)" },
            {
              label: "Last inbound event",
              value: lastInboundEventAt
                ? new Date(lastInboundEventAt).toISOString()
                : "(none since boot)",
            },
            { label: "Last worker outcome", value: lastWorkerOutcome ?? "(none since boot)" },
          ],
        },
        {
          kind: "table",
          columns: ["Time", "Tool", "Status", "Recipients", "Subject"],
          rows: recent.map((e) => [
            e.timestamp,
            e.tool,
            e.flaggedSensitive ? `${e.status} ⚠` : e.status,
            e.recipients,
            e.subject,
          ]),
          caption: `Recent dispatches (${recent.length})`,
        },
        {
          kind: "table",
          columns: ["Review ID", "Trust", "State", "Recipients", "Subject", "Expires", "Inspect"],
          rows: reviews
            .slice(-50)
            .map((review) => [
              review.id,
              review.trustLevel,
              review.state,
              redactRecipients(review.recipients),
              review.subject.slice(0, 80),
              new Date(review.expiresAt).toISOString(),
              `${instanceRouteBase}/reviews/${encodeURIComponent(review.id)}`,
            ]),
          rowActions: [
            {
              id: "agentmail-review-approve",
              label: "Approve",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [
                {
                  name: "fingerprint",
                  label: "Inspection fingerprint",
                  type: "text",
                  required: true,
                },
              ],
            },
            {
              id: "agentmail-review-revise",
              label: "Revise and send",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [
                {
                  name: "fingerprint",
                  label: "Inspection fingerprint",
                  type: "text",
                  required: true,
                },
                {
                  name: "text",
                  label: "Revised plain-text body",
                  type: "text",
                  required: true,
                },
              ],
            },
            {
              id: "agentmail-review-reject",
              label: "Reject",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [{ name: "reason", label: "Reason", type: "text", required: false }],
            },
            {
              id: "agentmail-review-reconcile-sent",
              label: "Confirm sent",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [
                {
                  name: "fingerprint",
                  label: "Inspection fingerprint",
                  type: "text",
                  required: true,
                },
                {
                  name: "messageId",
                  label: "Provider message ID",
                  type: "text",
                  required: true,
                },
                {
                  name: "threadId",
                  label: "Provider thread ID",
                  type: "text",
                  required: false,
                },
                {
                  name: "evidence",
                  label: "Verification evidence",
                  type: "text",
                  required: true,
                },
              ],
            },
            {
              id: "agentmail-review-reconcile-failed",
              label: "Confirm not sent",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [
                {
                  name: "fingerprint",
                  label: "Inspection fingerprint",
                  type: "text",
                  required: true,
                },
                {
                  name: "reason",
                  label: "Verification evidence",
                  type: "text",
                  required: true,
                },
              ],
            },
          ],
          caption: `Outbound reviews (${reviews.length}) — list is redacted; exact content requires creator auth`,
        },
        {
          kind: "table",
          columns: ["Incident", "Message", "Reason", "Version", "Detected"],
          rows: inboundIncidents.map((incident) => [
            incident.id,
            incident.messageId,
            incident.reasonCode,
            String(incident.version),
            new Date(incident.quarantinedAt).toISOString(),
          ]),
          rowActions: [
            {
              id: "agentmail-inbound-reconcile-handled",
              label: "Confirm handled",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: inboundRecoveryInputs(
                "Use after confirming the ambiguous turn's external effects already occurred.",
                false,
              ),
            },
            {
              id: "agentmail-inbound-reconcile-no-effect",
              label: "Confirm no effect",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: inboundRecoveryInputs(
                "Use only after confirming no external effect occurred; a later worker may retry.",
                false,
              ),
            },
          ],
          caption:
            "Inbound outcome-unknown incidents. Verify downstream effects before reconciliation.",
        },
        {
          kind: "table",
          columns: ["Message", "State", "Version", "Sender", "Subject", "Review", "Updated"],
          rows: attentionRecords.map((record) => [
            record.messageId,
            record.state,
            String(record.version),
            attentionMetadata.get(record.messageId)?.from.slice(0, 320) ?? "(unavailable)",
            attentionMetadata.get(record.messageId)?.subject.slice(0, 200) ?? "(unavailable)",
            record.reviewId
              ? `${instanceRouteBase}/reviews/${encodeURIComponent(record.reviewId)}`
              : "(none)",
            new Date(record.updatedAt).toISOString(),
          ]),
          rowActions: [
            {
              id: "agentmail-attention-dismiss",
              label: "Dismiss",
              confirmRequired: true,
              rowKeyColumn: 0,
              inputs: [
                {
                  name: "expectedVersion",
                  label: "Expected attention version",
                  type: "number",
                  required: true,
                },
              ],
            },
          ],
          caption: "Creator attention (assistant response previews are intentionally omitted).",
        },
      ],
      projection: {
        kind: "mail",
        schemaVersion: 1,
        augmentName: instanceId,
        inboxId: opts.inboxId,
        ...(resolvedInboxEmail ? { inboxEmail: resolvedInboxEmail } : {}),
        externalConsoleUrl: AGENTMAIL_CONSOLE_URL,
        status: { level: statusLevel, message: statusMessage },
        inbound: {
          mode: inboundMode,
          state: liveState,
          senderPolicy: inboundSenderPolicy,
          allowedSenderCount: inboundAllowedSenderCount,
          ...(inboundSenderPolicy !== "disabled" && inboundRateLimit
            ? {
                rateLimit: {
                  globalMaxPerHour: inboundRateLimit.globalMaxPerHour,
                  perSenderMaxPerHour: inboundRateLimit.perSenderMaxPerHour,
                  rollingGlobalUsage: inboundQuota.rollingGlobalUsage,
                  globalRejections: inboundQuota.globalRejections,
                  perSenderRejections: inboundQuota.perSenderRejections,
                  ...(inboundQuota.lastRejectedAt === undefined
                    ? {}
                    : { lastRejectedAt: new Date(inboundQuota.lastRejectedAt).toISOString() }),
                },
              }
            : {}),
        },
        reviews: projectedReviews,
        attention: projectedAttention,
      },
      actions: [
        {
          id: "agentmail-test-send",
          label: "Send test email",
          confirmRequired: false,
          inputs: [
            { name: "to", label: "Recipient", type: "text", required: true },
            {
              name: "subject",
              label: "Subject",
              type: "text",
              required: false,
              default: "Test from /admin",
            },
            {
              name: "text",
              label: "Body",
              type: "text",
              required: false,
              default: "This is a test message sent from the AgentMail augment's admin panel.",
            },
          ],
        },
        {
          id: "agentmail-cap-adjust",
          label: "Adjust globalMaxPerHour",
          confirmRequired: true,
          inputs: [
            {
              name: "value",
              label: "New value (positive integer)",
              type: "number",
              required: true,
              helpText: "Persists across restart via admin-overrides.json.",
            },
          ],
        },
        ...(creatorDigestConfig.enabled
          ? [
              {
                id: "agentmail-creator-digest-retry",
                label: "Authorize one creator digest retry",
                confirmRequired: true,
                inputs: [
                  {
                    name: "batchId",
                    label: "Pending digest batch ID",
                    type: "text" as const,
                    required: true,
                  },
                  {
                    name: "expectedAttemptCount",
                    label: "Expected attempt count",
                    type: "number" as const,
                    required: true,
                  },
                  {
                    name: "evidence",
                    label: "Retry evidence",
                    type: "text" as const,
                    required: true,
                    helpText:
                      "Explain why one more attempt is appropriate. Only its SHA-256 digest is retained.",
                  },
                ],
              },
              {
                id: "agentmail-creator-digest-dismiss",
                label: "Dismiss failed creator digest",
                confirmRequired: true,
                inputs: [
                  {
                    name: "batchId",
                    label: "Pending digest batch ID",
                    type: "text" as const,
                    required: true,
                  },
                  {
                    name: "evidence",
                    label: "Dismissal evidence",
                    type: "text" as const,
                    required: true,
                    helpText:
                      "Dismisses only this metadata digest generation; it does not change email attention or reviews.",
                  },
                ],
              },
            ]
          : []),
      ],
    };
  }

  function inboundRecoveryInputs(helpText: string, includeIncidentId = true) {
    return [
      ...(includeIncidentId
        ? [{ name: "incidentId", label: "Incident ID", type: "text" as const, required: true }]
        : []),
      { name: "version", label: "Expected version", type: "number" as const, required: true },
      {
        name: "evidence",
        label: "Verification evidence",
        type: "text" as const,
        required: true,
        helpText,
      },
    ];
  }

  async function persistCapOverride(value: number): Promise<void> {
    if (!overrideDir) {
      throw new Error("override storage not configured; admin overrides cannot persist");
    }
    const current = readOverrides(overrideDir);
    if (!hasExplicitInstanceId && instanceId === DEFAULT_INSTANCE_ID) {
      const compatible: AdminOverrides =
        current ??
        ({
          version: 1,
          lastModified: new Date().toISOString(),
          lastModifiedBy: "creator",
          overrides: {},
        } satisfies AdminOverrides);
      compatible.lastModified = new Date().toISOString();
      compatible.lastModifiedBy = "creator";
      compatible.overrides.agentMail = {
        ...compatible.overrides.agentMail,
        globalMaxPerHour: value,
      };
      writeOverrides(overrideDir, compatible);
      return;
    }
    const migrated: Extract<AdminOverrides, { version: 2 }> = {
      version: 2,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {
        ...(current?.overrides.webTransport
          ? { webTransport: current.overrides.webTransport }
          : {}),
        ...(current?.overrides.budgets ? { budgets: current.overrides.budgets } : {}),
        ...(current?.overrides.notify ? { notify: current.overrides.notify } : {}),
        agentMail: {
          ...(!legacySingletonCompatibility && current?.overrides.agentMail?.globalMaxPerHour
            ? { globalMaxPerHour: current.overrides.agentMail.globalMaxPerHour }
            : {}),
          ...(current?.version === 2 && current.overrides.agentMail?.instances
            ? { instances: current.overrides.agentMail.instances }
            : {}),
        },
      },
    };
    migrated.overrides.agentMail = {
      ...migrated.overrides.agentMail,
      instances: {
        ...migrated.overrides.agentMail?.instances,
        [instanceId]: { globalMaxPerHour: value },
      },
    };
    writeOverrides(overrideDir, migrated);
  }

  async function clearCapOverride(): Promise<void> {
    if (!overrideDir) return;
    const current = readOverrides(overrideDir);
    if (!current) return;
    if (hasExplicitInstanceId && current.version === 2) {
      const instances = current.overrides.agentMail?.instances;
      if (instances?.[instanceId]) {
        delete instances[instanceId];
        if (Object.keys(instances).length === 0 && current.overrides.agentMail) {
          delete current.overrides.agentMail.instances;
        }
        if (current.overrides.agentMail && Object.keys(current.overrides.agentMail).length === 0) {
          delete current.overrides.agentMail;
        }
      }
    } else if (current.overrides.agentMail) {
      delete (current.overrides.agentMail as Record<string, unknown>).globalMaxPerHour;
      if (Object.keys(current.overrides.agentMail).length === 0) {
        delete (current.overrides as Record<string, unknown>).agentMail;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(overrideDir, current);
  }

  function reconcileInboundIncident(
    params: Record<string, unknown>,
    disposition: "confirmed-handled" | "confirmed-no-effect",
  ): AdminActionResult {
    if (!inboundLedger) return { ok: false, message: "Inbound ledger is not available" };
    const boundIncident = rowBoundId(params, "incidentId");
    if (!boundIncident.ok) return boundIncident.result;
    const incidentId = boundIncident.id;
    const version = typeof params.version === "number" ? params.version : Number(params.version);
    const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
    if (!incidentId || !/^[A-Za-z0-9_-]{1,128}$/.test(incidentId)) {
      return { ok: false, message: "A valid incident ID is required" };
    }
    if (!Number.isSafeInteger(version) || version < 1) {
      return { ok: false, message: "A valid expected incident version is required" };
    }
    if (!evidence || evidence.length > 400) {
      return {
        ok: false,
        message: "Verification evidence must contain 1 to 400 characters",
      };
    }
    if (disposition === "confirmed-no-effect") {
      try {
        reconcileLinkedReviewAttention();
        const incident = inboundLedger
          .listIncidents(100, opts.inboxId)
          .find((candidate) => candidate.id === incidentId);
        if (!incident || incident.version !== version) {
          return { ok: false, message: "Incident is stale, resolved, or does not match" };
        }
        const replyReviews = reviewQueue
          .list()
          .filter(
            (review) =>
              review.request.kind === "reply" && review.request.messageId === incident.messageId,
          );
        const durableBlocker = replyReviews.find(
          (review) =>
            review.state === "sending" ||
            review.state === "approved" ||
            review.state === "rejected",
        );
        if (durableBlocker) {
          const evidence =
            durableBlocker.state === "sending"
              ? "ambiguous sending"
              : durableBlocker.state === "approved"
                ? "sent"
                : "operator rejection";
          return {
            ok: false,
            message:
              `Inbound retry is blocked by ${evidence} reply review ` +
              `${durableBlocker.id}, even without creator-attention metadata`,
          };
        }
        for (const pendingReview of replyReviews.filter((review) => review.state === "pending")) {
          const cancelled = reviewQueue.cancel(
            pendingReview.id,
            "cancelled before operator-confirmed inbound retry",
          );
          if (!transitionReviewAttention(cancelled, "failed")) {
            return {
              ok: false,
              message:
                "Inbound retry is blocked because linked creator attention could not be cancelled",
            };
          }
        }
        let attention = inboundLedger.creatorAttention.get(incident.inboxId, incident.messageId);
        if (attention?.state === "pending_review") {
          const review = attention.reviewId ? reviewQueue.get(attention.reviewId) : undefined;
          if (review?.state !== "pending") {
            return {
              ok: false,
              message:
                "Inbound retry is blocked until the linked review has an explicitly reconciled outcome",
            };
          }
          const cancelled = reviewQueue.cancel(
            review.id,
            "cancelled before operator-confirmed inbound retry",
          );
          if (!transitionReviewAttention(cancelled, "failed")) {
            return {
              ok: false,
              message:
                "Inbound retry is blocked because linked creator attention could not be cancelled",
            };
          }
          attention = inboundLedger.creatorAttention.get(incident.inboxId, incident.messageId);
        }
        if (
          attention &&
          attention.state !== "open" &&
          attention.state !== "failed" &&
          attention.state !== "dismissed"
        ) {
          return {
            ok: false,
            message: `Inbound retry is blocked while creator attention is ${attention.state}`,
          };
        }
      } catch (error) {
        return {
          ok: false,
          message: `Inbound retry safety check failed: ${(error as Error).message}`,
        };
      }
    }
    const resolved = inboundLedger.reconcileIncident({
      incidentId,
      expectedVersion: version,
      disposition,
      evidence,
      inboxId: opts.inboxId,
    });
    if (!resolved.resolved || !resolved.threadId) {
      return { ok: false, message: "Incident is stale, resolved, or does not match" };
    }
    if (disposition === "confirmed-no-effect") scheduleDrain();
    return {
      ok: true,
      message:
        disposition === "confirmed-handled"
          ? "Inbound incident reconciled as already handled"
          : "Inbound incident reconciled as having no external effect",
      recoverThreadId: resolved.releaseThread
        ? agentMailRuntimeThreadId(opts.inboxId, resolved.threadId)
        : undefined,
    };
  }

  const adminActions: Record<
    string,
    (params: Record<string, unknown>) => Promise<AdminActionResult>
  > = {
    "agentmail-test-send": async (params) => {
      const to = typeof params.to === "string" ? params.to : "";
      const subject =
        typeof params.subject === "string" && params.subject ? params.subject : "Test from /admin";
      const text =
        typeof params.text === "string" && params.text
          ? params.text
          : "This is a test message sent from the AgentMail augment's admin panel.";

      if (!to) return { ok: false, message: "Recipient is required" };

      const validation = validateOutbound({ recipients: [to], subject, text }, outboundOpts);
      if (!validation.ok) {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "admin-test",
          status: "blocked",
          recipients: redactRecipients([to]),
          subject: subject.slice(0, 80),
          detail: validation.reason,
        });
        return { ok: false, message: validation.reason };
      }

      const request: AgentMailReviewRequest = {
        kind: "send",
        to: validation.value.recipients,
        subject: validation.value.subject,
        text: validation.value.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
      };
      const attempt = beginDurableDirectAttempt({
        trustLevel: "creator",
        recipients: validation.value.recipients,
        subject: validation.value.subject,
        rateKey: validation.value.subject,
        request,
      });
      if (!attempt.ok) {
        return { ok: false, message: JSON.parse(attempt.envelope).message as string };
      }

      let result: SendMessageResult | SendMessageError;
      try {
        const { kind: _, ...sendInput } = request;
        result = await client.send({ inboxId: opts.inboxId, ...sendInput });
      } catch {
        return {
          ok: false,
          message: `Send outcome is ambiguous (review ${attempt.record?.id}); do not retry until reconciled`,
        };
      }

      if (result.status === "sent") {
        markDirectAttemptSent(attempt.record, result, true);
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "admin-test",
          status: "sent",
          recipients: redactRecipients(validation.value.recipients),
          subject: validation.value.subject.slice(0, 80),
        });
        return { ok: true, message: `Test message sent to ${to}` };
      }

      markDirectAttemptFailed(attempt.record, result);

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "admin-test",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      return {
        ok: false,
        message:
          result.httpStatus === undefined || isAmbiguousMutationStatus(result.httpStatus)
            ? `Send outcome is ambiguous (review ${attempt.record?.id}); do not retry until reconciled`
            : `Send failed (HTTP ${result.httpStatus})`,
      };
    },
    "agentmail-cap-adjust": async (params) => {
      const raw = params.value;
      const value = typeof raw === "number" ? raw : Number(raw);
      if (!Number.isFinite(value) || value <= 0 || !Number.isInteger(value)) {
        return {
          ok: false,
          message: `invalid value: must be a positive integer (got ${String(raw)})`,
        };
      }
      try {
        validateAgentMailEffectiveHourlyCap(
          value,
          inboundReplies.mode,
          "admin override globalMaxPerHour",
        );
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      try {
        await persistCapOverride(value);
      } catch (err) {
        return { ok: false, message: `could not persist override: ${(err as Error).message}` };
      }
      globalMaxPerHour = value;
      globalMaxSource = "override";
      return { ok: true, message: `globalMaxPerHour set to ${value}` };
    },
    "agentmail-cap-reset": async () => {
      try {
        await clearCapOverride();
      } catch (err) {
        return { ok: false, message: `could not clear override: ${(err as Error).message}` };
      }
      globalMaxPerHour = yamlGlobalMaxPerHour;
      globalMaxSource = "yaml";
      return { ok: true, message: "globalMaxPerHour reset to yaml value" };
    },
    "agentmail-review-approve": async (params) => {
      const boundReview = rowBoundId(params, "reviewId");
      if (!boundReview.ok) return boundReview.result;
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
      if (!fingerprint) return { ok: false, message: "Inspection fingerprint is required" };
      return approveReview(boundReview.id, fingerprint);
    },
    "agentmail-review-revise": async (params) => {
      const boundReview = rowBoundId(params, "reviewId");
      if (!boundReview.ok) return boundReview.result;
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
      if (!fingerprint) return { ok: false, message: "Inspection fingerprint is required" };
      const text = typeof params.text === "string" ? params.text : "";
      if (!text.trim()) return { ok: false, message: "Revised plain-text body is required" };
      return reviseAndApproveReview(boundReview.id, fingerprint, text);
    },
    "agentmail-review-reject": async (params) => {
      const boundReview = rowBoundId(params, "reviewId");
      if (!boundReview.ok) return boundReview.result;
      const reviewId = boundReview.id;
      const review = reviewQueue.get(reviewId);
      if (!review) return { ok: false, message: `Unknown review id "${reviewId}"` };
      const reason =
        typeof params.reason === "string" && params.reason.trim()
          ? params.reason.trim()
          : "rejected by operator";
      try {
        reviewQueue.reject(reviewId, reason);
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      if (!transitionReviewAttention(review, "rejected")) {
        return {
          ok: false,
          message: `Review ${reviewId} was rejected, but creator-attention state requires repair`,
        };
      }
      return { ok: true, message: `Review ${reviewId} rejected` };
    },
    "agentmail-review-reconcile-sent": async (params) => {
      const boundReview = rowBoundId(params, "reviewId");
      if (!boundReview.ok) return boundReview.result;
      const reviewId = boundReview.id;
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
      if (!fingerprint) return { ok: false, message: "Inspection fingerprint is required" };
      const messageId = typeof params.messageId === "string" ? params.messageId.trim() : "";
      if (!messageId) return { ok: false, message: "Provider message ID is required" };
      const threadId = typeof params.threadId === "string" ? params.threadId.trim() : "";
      if (messageId.length > 256 || threadId.length > 256) {
        return { ok: false, message: "Provider IDs must be at most 256 characters" };
      }
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      if (!evidence) return { ok: false, message: "Verification evidence is required" };
      if (evidence.length > 400) {
        return { ok: false, message: "Verification evidence must be at most 400 characters" };
      }
      return reconcileReviewSent(reviewId, fingerprint, {
        messageId,
        ...(threadId ? { threadId } : {}),
        evidence,
      });
    },
    "agentmail-review-reconcile-failed": async (params) => {
      const boundReview = rowBoundId(params, "reviewId");
      if (!boundReview.ok) return boundReview.result;
      const reviewId = boundReview.id;
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
      if (!fingerprint) return { ok: false, message: "Inspection fingerprint is required" };
      const reason = typeof params.reason === "string" ? params.reason.trim() : "";
      if (!reason) return { ok: false, message: "Verification evidence is required" };
      if (reason.length > 400) {
        return { ok: false, message: "Verification evidence must be at most 400 characters" };
      }
      return reconcileReviewFailed(reviewId, fingerprint, reason);
    },
    "agentmail-inbound-reconcile-handled": async (params) =>
      reconcileInboundIncident(params, "confirmed-handled"),
    "agentmail-inbound-reconcile-no-effect": async (params) =>
      reconcileInboundIncident(params, "confirmed-no-effect"),
    "agentmail-attention-dismiss": async (params) => {
      if (!inboundLedger) return { ok: false, message: "Creator attention is not available" };
      const boundMessage = rowBoundId(params, "messageId");
      if (!boundMessage.ok) return boundMessage.result;
      const messageId = boundMessage.id;
      if (!messageId || messageId.length > 256) {
        return { ok: false, message: "A valid message ID is required" };
      }
      const expectedVersion =
        typeof params.expectedVersion === "number"
          ? params.expectedVersion
          : Number(params.expectedVersion);
      if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
        return { ok: false, message: "A valid expected attention version is required" };
      }
      try {
        const result = inboundLedger.creatorAttention.transition({
          inboxId: opts.inboxId,
          messageId,
          expectedVersion,
          state: "dismissed",
        });
        if (!result.updated) {
          return {
            ok: false,
            message: result.record
              ? `Creator attention changed; current state is ${result.record.state} at version ${result.record.version}`
              : "Creator attention was not found",
          };
        }
        scheduleDrain();
        return {
          ok: true,
          message: `Creator attention for ${messageId} dismissed`,
        };
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
    "agentmail-creator-digest-retry": async (params) => {
      if (!creatorDigestController) {
        return { ok: false, message: "Creator digest bridge is not available" };
      }
      const batchId = typeof params.batchId === "string" ? params.batchId.trim() : "";
      const expectedAttemptCount =
        typeof params.expectedAttemptCount === "number"
          ? params.expectedAttemptCount
          : Number(params.expectedAttemptCount);
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      if (!batchId || batchId.length > 128 || /\p{Cc}/u.test(batchId)) {
        return { ok: false, message: "A valid pending digest batch ID is required" };
      }
      if (!Number.isSafeInteger(expectedAttemptCount) || expectedAttemptCount < 1) {
        return { ok: false, message: "A valid expected attempt count is required" };
      }
      if (!evidence || evidence.length > 400) {
        return { ok: false, message: "Retry evidence must contain 1 to 400 characters" };
      }
      try {
        return creatorDigestController.authorizeRetry({
          batchId,
          expectedAttemptCount,
          evidence,
        });
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
    "agentmail-creator-digest-dismiss": async (params) => {
      if (!creatorDigestController) {
        return { ok: false, message: "Creator digest bridge is not available" };
      }
      const batchId = typeof params.batchId === "string" ? params.batchId.trim() : "";
      const evidence = typeof params.evidence === "string" ? params.evidence.trim() : "";
      if (!batchId || batchId.length > 128 || /\p{Cc}/u.test(batchId)) {
        return { ok: false, message: "A valid pending digest batch ID is required" };
      }
      if (!evidence || evidence.length > 400) {
        return { ok: false, message: "Dismissal evidence must contain 1 to 400 characters" };
      }
      try {
        return creatorDigestController.dismiss({ batchId, evidence });
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
    },
  };

  // ---------------------------------------------------------------------------
  // Test-only seam for reply/forward unit tests. Production inbound work uses
  // the per-turn map populated by onTurnPrepared above.
  // ---------------------------------------------------------------------------
  const aug: Augment & {
    [AGENTMAIL_CREATOR_DIGEST_SOURCE]: AgentMailCreatorDigestSource;
    _markSeenForTest?: (messageId: string, meta: { from: string; replyAllTo?: string[] }) => void;
  } = {
    name: instanceId,
    type: "agentMail",
    context,
    tools: [sendMessageTool, replyToMessageTool, forwardMessageTool],
    ...(inboundTransport ? { transport: inboundTransport } : {}),
    httpRoutes: agentMailRoutes,
    onBoot,
    onShutdown,
    adminInfo,
    adminActions,
    ...(inboundMode !== "none"
      ? {
          durableThreadQuarantine: {
            listThreadIds: () =>
              (inboundLedger?.listIncidentThreads(opts.inboxId) ?? []).map((providerThreadId) =>
                agentMailRuntimeThreadId(opts.inboxId, providerThreadId),
              ),
            hasThread: (runtimeThreadId: string) =>
              (inboundLedger?.listIncidentThreads(opts.inboxId) ?? []).some(
                (providerThreadId) =>
                  agentMailRuntimeThreadId(opts.inboxId, providerThreadId) === runtimeThreadId,
              ),
          },
        }
      : {}),
    onTurnEnd: async (result) => {
      seenMessagesByTurn.delete(result.turnId);
    },
    [AGENTMAIL_CREATOR_DIGEST_SOURCE]: creatorDigestSource,
    _markSeenForTest: (messageId, meta) => legacySeenMessages.set(messageId, meta),
  };

  return aug;
}

// Silence the unused-helper warning when only the augment is imported.
export type { AgentMailAugmentInternalOptions };
void isToolResult;
