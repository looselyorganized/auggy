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
import { defineRoute, defineTool, json } from "../../helpers";
import {
  createAgentMailClient,
  type AgentMailClient,
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
} from "../../lib/admin-overrides";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  ToolResult,
  ToolExecuteContext,
  TransportKernel,
  TrustLevel,
} from "../../types";
import type { AgentMailAugmentInternalOptions, DispatchRecord } from "./types";
import { redactRecipients, scanForSensitive, validateOutbound } from "./outbound";
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
import { AGENTMAIL_RECEIVED_EVENT_TYPES, type AgentMailEventSubscription } from "./provider";
import { createAgentMailWebhookRoute } from "./webhook-provider";
import {
  createAgentMailReviewQueue,
  type AgentMailReviewQueue,
  type AgentMailReviewRecord,
  type AgentMailReviewRequest,
} from "./review-queue";

const DEFAULT_ALLOWED_TRUST_LEVELS: TrustLevel[] = ["creator"];
const DEFAULT_REVIEW_TRUST_LEVELS: TrustLevel[] = ["public"];
const DEFAULT_REVIEW_EXPIRY_MS = 24 * 60 * 60_000;
const MAX_REVIEW_EXPIRY_MS = 30 * 24 * 60 * 60_000;
const RING_BUFFER_SIZE = 100;

function looksLikePlaceholder(value: string): boolean {
  return /^\$\{[A-Z0-9_]+\}$/.test(value);
}

function validateOptions(opts: AgentMailAugmentInternalOptions): void {
  if (!opts.apiKey || typeof opts.apiKey !== "string") {
    throw new Error("agentMail: apiKey is required (set AGENTMAIL_API_KEY in .env)");
  }
  if (!opts.inboxId || typeof opts.inboxId !== "string") {
    throw new Error("agentMail: inboxId is required (set AGENTMAIL_INBOX_ID in .env)");
  }
  // Subject prefix non-empty when explicitly set.
  if (opts.outbound?.subjectPrefix !== undefined && opts.outbound.subjectPrefix.length === 0) {
    throw new Error("agentMail: outbound.subjectPrefix cannot be the empty string");
  }
  const mode = opts.inbound?.mode ?? "none";
  if (
    mode !== "none" &&
    (!opts.inbound?.allowedSenders || opts.inbound.allowedSenders.length === 0)
  ) {
    throw new Error("agentMail: inbound.allowedSenders must be non-empty when inbound is enabled");
  }
  if (mode === "webhook" && !opts.inbound?.webhook) {
    throw new Error("agentMail: inbound.webhook is required when inbound.mode is webhook");
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
  ): ReturnType<typeof checkRateLimit> {
    if (ratePersistenceFailure) {
      return {
        allowed: false,
        reason:
          "agentMail: durable rate-limit state is unavailable; non-creator mail is blocked until restart/operator repair.",
      };
    }
    return checkRateLimit(rateState, recipients, rateKey, effectiveRateLimit(), now());
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
    /** Other original recipients — used when the model passes replyAll: true. */
    replyAllTo?: string[];
  }
  const legacySeenMessages = new Map<string, SeenMessageMeta>();
  const seenMessagesByTurn = new Map<string, Map<string, SeenMessageMeta>>();

  function seenMessagesFor(context: ToolExecuteContext | undefined): Map<string, SeenMessageMeta> {
    return (context ? seenMessagesByTurn.get(context.turnId) : undefined) ?? legacySeenMessages;
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
      const overrideVal = overrides?.overrides.agentMail?.globalMaxPerHour;
      if (typeof overrideVal === "number" && Number.isFinite(overrideVal) && overrideVal > 0) {
        globalMaxPerHour = overrideVal;
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

  const inboundMode = opts.inbound?.mode ?? "none";
  const agentMailRoutes: NonNullable<Augment["httpRoutes"]> = [
    defineRoute.get("/agentmail/reviews/:reviewId", {
      auth: "creator",
      params: z.object({ reviewId: z.string().min(1).max(128) }),
      handler: ({ params }) => {
        const record = reviewQueue.get(params.reviewId);
        if (!record) return json({ error: "review-not-found" }, 404);
        if (record.state !== "pending" && record.state !== "sending") {
          return json({ error: "review-no-longer-inspectable", state: record.state }, 410);
        }
        return new Response(
          JSON.stringify({
            reviewId: record.id,
            fingerprint: record.fingerprint,
            state: record.state,
            trustLevel: record.trustLevel,
            expiresAt: new Date(record.expiresAt).toISOString(),
            recipients: record.recipients,
            subject: record.subject,
            request: record.request,
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
  let inboundRegisteredName = "agent-mail";
  let inboundWorker: AgentMailInboundWorker | undefined;
  let liveSubscription: AgentMailEventSubscription | undefined;
  let pollTimer: ReturnType<typeof setInterval> | undefined;
  let drainTimer: ReturnType<typeof setInterval> | undefined;
  let drainKickTimer: ReturnType<typeof setTimeout> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let activeDrain: Promise<void> | undefined;
  let drainScheduled = false;
  let inboundReady = false;
  let liveState: "disabled" | "starting" | "ready" | "subscribed" | "degraded" | "stopped" =
    inboundMode === "none" ? "disabled" : "stopped";
  let lastCatchUpAt: number | undefined;
  let lastCatchUpSummary: string | undefined;
  let lastInboundEventAt: number | undefined;
  let lastWorkerOutcome: string | undefined;
  let lastProviderError: string | undefined;

  function recordProviderError(error: unknown): void {
    lastProviderError = (error instanceof Error ? error.message : String(error)).slice(0, 500);
  }

  function inboundPolicy() {
    const config = opts.inbound!;
    return {
      allowedSenders: config.allowedSenders ?? [],
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

  async function catchUpInbound(): Promise<void> {
    if (!inboundLedger || !sdkAdapters) throw new Error("agentMail: inbound runtime is not booted");
    try {
      const result = await runAgentMailCatchUp({
        reader: sdkAdapters.catchUp,
        ledger: inboundLedger,
        inboxId: opts.inboxId,
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

  function scheduleDrain(): void {
    if (drainScheduled) return;
    drainScheduled = true;
    drainKickTimer = setTimeout(() => {
      drainScheduled = false;
      drainKickTimer = undefined;
      void drainInbound();
    }, 0);
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
            const incidentThreads = inboundLedger.listIncidentThreads();
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
              onTurnPrepared: ({ envelope, trigger }) => {
                seenMessagesByTurn.set(
                  trigger.turnId,
                  new Map([
                    [
                      envelope.message.messageId,
                      {
                        from: envelope.message.from,
                        replyAllTo: [...envelope.message.to, ...envelope.message.cc].filter(
                          (address) => address.toLowerCase() !== opts.inboxId.toLowerCase(),
                        ),
                      },
                    ],
                  ]),
                );
              },
              onTurnSettled: ({ trigger }) => {
                seenMessagesByTurn.delete(trigger.turnId);
              },
            });

            if (inboundMode === "websocket") {
              liveState = "starting";
              try {
                liveSubscription = await sdkAdapters.live.subscribe({
                  inboxId: opts.inboxId,
                  eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
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
            if (inboundMode === "polling") {
              pollTimer = setInterval(() => {
                void catchUpInbound()
                  .then(() => scheduleDrain())
                  .catch((error) => {
                    console.warn(`[agent-mail] catch-up failed: ${(error as Error).message}`);
                  });
              }, pollIntervalMs);
              pollTimer.unref?.();
            }
            drainTimer = setInterval(() => void drainInbound(), 1_000);
            drainTimer.unref?.();
            inboundReady = true;
            if (inboundMode !== "websocket") liveState = "ready";
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
  }): string | undefined {
    const trustLevel = trustLevelOf(input.context);
    if (!reviewTrustLevels.includes(trustLevel)) return undefined;
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
    return JSON.stringify({
      status: "pending_review",
      reviewId: queued.record.id,
      expiresAt: new Date(queued.record.expiresAt).toISOString(),
      duplicate: queued.duplicate || undefined,
    });
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
      const { kind: _, ...input } = request;
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
      return {
        ok: false,
        message: `Review ${id} was not sent because durable rate reservation is unavailable; operator reconciliation is required`,
      };
    }

    let result: SendMessageResult | SendMessageError;
    try {
      result = await sendReviewedAction(sending);
    } catch {
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
        message: `Review ${id} failed${result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""}`,
      };
    }

    const rateStateDurable = commitRateForAttempt(sending);
    if (rateStateDurable) {
      reviewQueue.approve(id, result);
    }
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
      ok: true,
      message: rateStateDurable
        ? `Review ${id} approved and sent`
        : `Review ${id} was sent but remains in reconciliation because rate state was not durable`,
    };
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
    name: "send_message",
    description:
      "Send a new email from the configured AgentMail inbox. Use for proactive outreach, transactional notices, or replies to conversations the agent did not originate. Subject prefix is applied automatically; HTML bodies are disabled by default.",
    category: "communication",
    input: z.object({
      to: z.array(z.string()).min(1).describe("One or more recipient email addresses."),
      subject: z
        .string()
        .describe("Subject line. Operator-configured prefix is applied automatically."),
      text: z.string().describe("Plain-text body of the message."),
      html: z
        .string()
        .optional()
        .describe("HTML body. Off by default; operator must opt in via outbound.allowHtml."),
      labels: z
        .array(z.string())
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
      if (review) return review;

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
    name: "reply_to_message",
    description:
      "Reply to an inbound email by its message_id (received via the agent's inbound trigger). The reply is threaded automatically by AgentMail. Use only with message_ids the agent has been shown this turn.",
    category: "communication",
    input: z.object({
      messageId: z.string().describe("AgentMail message_id of the message being replied to."),
      text: z.string().describe("Plain-text body of the reply."),
      html: z.string().optional().describe("HTML body (off by default — operator opts in)."),
      replyAll: z
        .boolean()
        .optional()
        .describe("If true, reply to all original recipients. Default false."),
      labels: z.array(z.string()).optional(),
    }),
    execute: async (input, context) => {
      const gate = gateTrustLevel(context, "reply_to_message");
      if (!gate.allowed) return gate.envelope;

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

      // Resolve the REAL recipients the reply will reach. Codex #1:
      // previously we ran validation against a placeholder address so the
      // allowlist + cooldown were never applied to the actual envelope.
      const recipients = input.replyAll
        ? [
            meta.from,
            ...(meta.replyAllTo ?? []).filter((r) => r.toLowerCase() !== meta.from.toLowerCase()),
          ]
        : [meta.from];

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

      // Rate-limit the reply with the SAME state as send_message. The
      // subject-hash dedup uses a stable marker per inbound thread so the
      // model can't bypass dedup by switching tools. Creator (and null
      // peer) bypass — consistent with send_message.
      const trustLevel = trustLevelOf(context);
      const replyDedupKey = `reply:${input.messageId}`;
      if (trustLevel !== "creator") {
        const decision = checkOutboundRateLimit(validation.value.recipients, replyDedupKey);
        if (!decision.allowed) {
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

      const scan = scanForSensitive(input.text);
      const request: AgentMailReviewRequest = {
        kind: "reply",
        messageId: input.messageId,
        text: input.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.replyAll ? { replyAll: true } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      };

      const review = queueForHumanReview({
        context,
        tool: "reply_to_message",
        recipients: validation.value.recipients,
        subject: "(reply)",
        rateKey: replyDedupKey,
        request,
        flaggedSensitive: scan.flagged,
      });
      if (review) return review;

      const attempt = beginDurableDirectAttempt({
        trustLevel,
        recipients: validation.value.recipients,
        subject: "(reply)",
        rateKey: replyDedupKey,
        request,
      });
      if (!attempt.ok) return attempt.envelope;

      let result: SendMessageResult | SendMessageError;
      try {
        const { kind: _, ...replyInput } = request;
        result = await client.reply({
          inboxId: opts.inboxId,
          ...replyInput,
          signal: context?.signal,
        });
      } catch {
        return ambiguousDeliveryResult();
      }

      if (result.status === "sent") {
        markDirectAttemptSent(attempt.record, result, true);
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
  // forward_message
  // ---------------------------------------------------------------------------
  const forwardMessageTool = defineTool({
    name: "forward_message",
    description:
      "Forward an inbound message to additional recipient(s). Use when handing a thread to a teammate, escalating to an operator, or copying the operator on a thread the agent is handling.",
    category: "communication",
    input: z.object({
      messageId: z.string().describe("AgentMail message_id of the message being forwarded."),
      to: z.array(z.string()).min(1).describe("Forward recipient(s)."),
      text: z.string().optional().describe("Optional commentary prepended to the forwarded body."),
      html: z.string().optional().describe("HTML commentary (off by default)."),
      subject: z
        .string()
        .optional()
        .describe('Subject override. Default: AgentMail prepends "Fwd: " to original.'),
      labels: z.array(z.string()).optional(),
    }),
    execute: async (input, context) => {
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
      if (review) return review;

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
      inboundLedger.fenceInterruptedClaims();
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
            path: webhookOptions?.path,
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

    // Best-effort inbox healthcheck. Warn-and-continue on failure (transient
    // outage shouldn't block agent boot; the first real send surfaces the
    // same error). 4xx is a config error and DOES throw.
    const health = await client.getInbox(opts.inboxId);
    if (health.status === "failed") {
      const httpStatus = health.httpStatus;
      if (httpStatus !== undefined && httpStatus >= 400 && httpStatus < 500) {
        throw new Error(
          `agentMail: inbox "${opts.inboxId}" healthcheck failed with HTTP ${httpStatus}: ${health.detail}. Check AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in .env and restart.`,
        );
      }
      // 5xx or network — warn and continue.
      console.warn(
        `[agent-mail] inbox "${opts.inboxId}" healthcheck failed: ${health.detail}. Continuing boot — first real send will surface the same error.`,
      );
      recordProviderError(health.detail);
      return;
    }
    // ok
  }

  async function onShutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    shutdownPromise = (async () => {
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
      if (pollTimer) clearInterval(pollTimer);
      if (drainTimer) clearInterval(drainTimer);
      if (drainKickTimer) clearTimeout(drainKickTimer);
      pollTimer = undefined;
      drainTimer = undefined;
      drainKickTimer = undefined;
      drainScheduled = false;
      inboundReady = false;

      const subscription = liveSubscription;
      const ownedLedger = ownsInboundLedger ? inboundLedger : undefined;

      let failure: unknown;
      let subscriptionClose: Promise<void> | undefined;
      try {
        subscriptionClose = subscription?.close();
      } catch (error) {
        failure = error;
      }
      try {
        if (subscriptionClose) {
          await withinDeadline(subscriptionClose, "subscription shutdown");
        }
      } catch (error) {
        failure ??= error;
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
      inboundLedger = opts._inboundLedger;
      ownsInboundLedger = false;
      liveState = inboundMode === "none" ? "disabled" : "stopped";
      inboundWorker = undefined;
      inboundKernel = undefined;
      seenMessagesByTurn.clear();
      try {
        ownedLedger?.close();
      } catch (error) {
        failure ??= error;
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
    let checkpoint: string | undefined;
    if (inboundLedger) {
      try {
        ledgerCounts = inboundLedger.counts();
        inboundIncidents = inboundLedger.listIncidents(50);
        checkpoint = inboundLedger.checkpoint(opts.inboxId);
      } catch (error) {
        recordProviderError(error);
      }
    }
    const operationalWarnings: string[] = [];
    if (inboundMode !== "none" && !inboundReady) operationalWarnings.push("inbound not ready");
    if (lastProviderError) operationalWarnings.push(`provider: ${lastProviderError}`);
    if (ambiguousReviews.length > 0) {
      operationalWarnings.push(
        `${ambiguousReviews.length} review(s) stopped in ambiguous sending state`,
      );
    }

    return {
      augmentName: "agent-mail",
      title: "AgentMail",
      sections: [
        {
          kind: "status",
          level: operationalWarnings.length === 0 ? "ok" : "warn",
          message:
            operationalWarnings.length === 0
              ? inboundMode === "none"
                ? "Outbound ready; inbound disabled"
                : `Inbound ${inboundMode} ready`
              : operationalWarnings.join("; "),
        },
        {
          kind: "keyValue",
          rows: [
            { label: "Inbox ID", value: opts.inboxId },
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
            { label: "Inbound runtime", value: liveState },
            { label: "Inbound pending", value: String(ledgerCounts.pending) },
            { label: "Inbound processing", value: String(ledgerCounts.processing) },
            { label: "Inbound processed", value: String(ledgerCounts.processed) },
            { label: "Inbound discarded", value: String(ledgerCounts.discarded) },
            { label: "Inbound outcome unknown", value: String(ledgerCounts.outcomeUnknown) },
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
              `/agentmail/reviews/${encodeURIComponent(review.id)}`,
            ]),
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
          caption:
            "Inbound outcome-unknown incidents. Verify downstream effects before reconciliation.",
        },
      ],
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
        {
          id: "agentmail-review-approve",
          label: "Approve queued email",
          confirmRequired: true,
          inputs: [
            {
              name: "reviewId",
              label: "Review ID",
              type: "text",
              required: true,
              helpText: "Sends the exact queued action after rechecking current rate limits.",
            },
            {
              name: "fingerprint",
              label: "Inspection fingerprint",
              type: "text",
              required: true,
              helpText:
                "Copy from the creator-authenticated review detail route to bind approval to the reviewed content.",
            },
          ],
        },
        {
          id: "agentmail-review-reject",
          label: "Reject queued email",
          confirmRequired: true,
          inputs: [
            { name: "reviewId", label: "Review ID", type: "text", required: true },
            { name: "reason", label: "Reason", type: "text", required: false },
          ],
        },
        {
          id: "agentmail-review-reconcile-sent",
          label: "Confirm ambiguous email was sent",
          confirmRequired: true,
          inputs: [
            { name: "reviewId", label: "Review ID", type: "text", required: true },
            {
              name: "fingerprint",
              label: "Inspection fingerprint",
              type: "text",
              required: true,
              helpText:
                "Use only after confirming delivery with AgentMail; this closes the durable attempt without resending it.",
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
              helpText: "Record how the provider-confirmed message ID was verified.",
            },
          ],
        },
        {
          id: "agentmail-review-reconcile-failed",
          label: "Confirm ambiguous email was not sent",
          confirmRequired: true,
          inputs: [
            { name: "reviewId", label: "Review ID", type: "text", required: true },
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
              helpText:
                "Record how non-delivery was verified; only this outcome permits a later retry.",
            },
          ],
        },
        {
          id: "agentmail-inbound-reconcile-handled",
          label: "Confirm inbound incident was handled",
          confirmRequired: true,
          inputs: inboundRecoveryInputs(
            "Use after confirming the ambiguous turn's external effects already occurred.",
          ),
        },
        {
          id: "agentmail-inbound-reconcile-no-effect",
          label: "Confirm inbound incident had no external effect",
          confirmRequired: true,
          inputs: inboundRecoveryInputs(
            "Use only after confirming no external effect occurred; a later worker may retry.",
          ),
        },
      ],
    };
  }

  function inboundRecoveryInputs(helpText: string) {
    return [
      { name: "incidentId", label: "Incident ID", type: "text" as const, required: true },
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
    const current = readOverrides(overrideDir) ?? {
      version: 1 as const,
      lastModified: new Date().toISOString(),
      lastModifiedBy: "creator",
      overrides: {},
    };
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    current.overrides.agentMail = {
      ...current.overrides.agentMail,
      globalMaxPerHour: value,
    };
    writeOverrides(overrideDir, current);
  }

  async function clearCapOverride(): Promise<void> {
    if (!overrideDir) return;
    const current = readOverrides(overrideDir);
    if (!current) return;
    if (current.overrides.agentMail) {
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
    const incidentId = typeof params.incidentId === "string" ? params.incidentId.trim() : "";
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
    const resolved = inboundLedger.reconcileIncident({
      incidentId,
      expectedVersion: version,
      disposition,
      evidence,
    });
    if (!resolved.resolved || !resolved.threadId) {
      return { ok: false, message: "Incident is stale, resolved, or does not match" };
    }
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
      const reviewId = typeof params.reviewId === "string" ? params.reviewId.trim() : "";
      if (!reviewId) return { ok: false, message: "Review ID is required" };
      const fingerprint = typeof params.fingerprint === "string" ? params.fingerprint.trim() : "";
      if (!fingerprint) return { ok: false, message: "Inspection fingerprint is required" };
      return approveReview(reviewId, fingerprint);
    },
    "agentmail-review-reject": async (params) => {
      const reviewId = typeof params.reviewId === "string" ? params.reviewId.trim() : "";
      if (!reviewId) return { ok: false, message: "Review ID is required" };
      const reason =
        typeof params.reason === "string" && params.reason.trim()
          ? params.reason.trim()
          : "rejected by operator";
      try {
        reviewQueue.reject(reviewId, reason);
      } catch (error) {
        return { ok: false, message: (error as Error).message };
      }
      return { ok: true, message: `Review ${reviewId} rejected` };
    },
    "agentmail-review-reconcile-sent": async (params) => {
      const reviewId = typeof params.reviewId === "string" ? params.reviewId.trim() : "";
      if (!reviewId) return { ok: false, message: "Review ID is required" };
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
      const reviewId = typeof params.reviewId === "string" ? params.reviewId.trim() : "";
      if (!reviewId) return { ok: false, message: "Review ID is required" };
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
  };

  // ---------------------------------------------------------------------------
  // Test-only seam for reply/forward unit tests. Production inbound work uses
  // the per-turn map populated by onTurnPrepared above.
  // ---------------------------------------------------------------------------
  const aug: Augment & {
    _markSeenForTest?: (messageId: string, meta: { from: string; replyAllTo?: string[] }) => void;
  } = {
    name: "agent-mail",
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
              (inboundLedger?.listIncidentThreads() ?? []).map((providerThreadId) =>
                agentMailRuntimeThreadId(opts.inboxId, providerThreadId),
              ),
            hasThread: (runtimeThreadId: string) =>
              (inboundLedger?.listIncidentThreads() ?? []).some(
                (providerThreadId) =>
                  agentMailRuntimeThreadId(opts.inboxId, providerThreadId) === runtimeThreadId,
              ),
          },
        }
      : {}),
    onTurnEnd: async (result) => {
      seenMessagesByTurn.delete(result.turnId);
    },
    _markSeenForTest: (messageId, meta) => legacySeenMessages.set(messageId, meta),
  };

  return aug;
}

// Silence the unused-helper warning when only the augment is imported.
export type { AgentMailAugmentInternalOptions };
void isToolResult;
