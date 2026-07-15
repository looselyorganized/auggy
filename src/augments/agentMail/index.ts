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
import { join } from "node:path";
import { defineTool } from "../../helpers";
import { createAgentMailClient, type AgentMailClient } from "../../agentmail-client";
import { createRingBuffer } from "../../lib/ring-buffer";
import { readOverrides, writeOverrides } from "../../lib/admin-overrides";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  ToolExecuteContext,
  TransportKernel,
  TrustLevel,
} from "../../types";
import type { AgentMailAugmentInternalOptions, DispatchRecord } from "./types";
import { redactRecipients, scanForSensitive, validateOutbound } from "./outbound";
import { checkRateLimit, createRateLimitState, recordSend } from "./rate-limit";
import { loadRateState, saveRateState } from "./persist-state";
import { createAgentMailInboundLedger, type AgentMailInboundLedger } from "./inbound-ledger";
import { createAgentMailInboundWorker, type AgentMailInboundWorker } from "./inbound-worker";
import {
  createAgentMailSdkAdapters,
  runAgentMailCatchUp,
  type AgentMailSdkAdapters,
} from "./sdk-provider";
import { AGENTMAIL_RECEIVED_EVENT_TYPES, type AgentMailEventSubscription } from "./provider";
import { createAgentMailWebhookRoute } from "./webhook-provider";

const DEFAULT_ALLOWED_TRUST_LEVELS: TrustLevel[] = ["creator"];
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
}

function timestampHHMMSS(now: number): string {
  return new Date(now).toISOString().slice(11, 19);
}

function isToolResult(value: unknown): value is { error: string } {
  return typeof value === "object" && value !== null && "error" in value;
}

export function agentMail(opts: AgentMailAugmentInternalOptions): Augment {
  validateOptions(opts);

  const now = opts._now ?? (() => Date.now());

  const outboundOpts = opts.outbound ?? {};
  const allowedTrustLevels = outboundOpts.allowedTrustLevels ?? DEFAULT_ALLOWED_TRUST_LEVELS;
  const rateLimitOpts = outboundOpts.rateLimit ?? {};
  const yamlGlobalMaxPerHour = rateLimitOpts.globalMaxPerHour ?? 10;

  // Mutable runtime ceiling (admin-override aware). YAML value is the floor
  // we reset back to on `agentmail-cap-reset`.
  let globalMaxPerHour = yamlGlobalMaxPerHour;
  let globalMaxSource: "yaml" | "override" = "yaml";

  if (opts.agentDir) {
    const overrides = readOverrides(opts.agentDir);
    const overrideVal = overrides?.overrides.agentMail?.globalMaxPerHour;
    if (typeof overrideVal === "number" && Number.isFinite(overrideVal) && overrideVal > 0) {
      globalMaxPerHour = overrideVal;
      globalMaxSource = "override";
    }
  }

  // Load persisted rate-limit / dedup state from agentDir if configured —
  // Codex finding #3. Fresh empty state otherwise (test runs, no scaffold).
  const rateState =
    (opts.agentDir && loadRateState(opts.agentDir, now())) || createRateLimitState();
  const dispatches = createRingBuffer<DispatchRecord>(RING_BUFFER_SIZE);

  /**
   * Persist rate-limit state after a successful send. No-op when no
   * `agentDir` is configured (the augment is running in a test fixture
   * or pre-scaffold dev context). Errors during persistence are logged
   * but swallowed — losing durability is a degraded mode, not a reason
   * to fail the send the model just received "sent" for.
   */
  function persistRateStateIfConfigured(): void {
    if (!opts.agentDir) return;
    try {
      saveRateState(opts.agentDir, rateState, now());
    } catch (err) {
      console.warn(
        `[agent-mail] failed to persist rate-limit state: ${(err as Error).message}. ` +
          `State remains in memory; a crash before the next successful send will lose recent history.`,
      );
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
    opts._client ?? createAgentMailClient({ apiKey: opts.apiKey, apiBaseUrl: opts.apiBaseUrl });

  const inboundMode = opts.inbound?.mode ?? "none";
  const inboundRoutes: NonNullable<Augment["httpRoutes"]> = [];
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
  let drainScheduled = false;
  let draining = false;
  let inboundReady = false;

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
    await runAgentMailCatchUp({
      reader: sdkAdapters.catchUp,
      ledger: inboundLedger,
      inboxId: opts.inboxId,
    });
  }

  async function drainInbound(): Promise<void> {
    if (draining || !inboundWorker) return;
    draining = true;
    try {
      for (let i = 0; i < 100; i++) {
        const result = await inboundWorker.processNext();
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
    } finally {
      draining = false;
    }
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
              liveSubscription = await sdkAdapters.live.subscribe({
                inboxId: opts.inboxId,
                eventTypes: AGENTMAIL_RECEIVED_EVENT_TYPES,
                onSubscribed: catchUpInbound,
                onEvent: async (envelope) => {
                  inboundLedger!.enqueue(envelope);
                  scheduleDrain();
                },
                onError: (error) => {
                  console.warn(`[agent-mail] WebSocket: ${error.message}`);
                },
              });
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
  }

  function trustLevelOf(context: ToolExecuteContext | undefined): TrustLevel {
    // Null peer = internal trigger (scheduled / system) — treated as creator.
    return context?.peer?.trustLevel ?? "creator";
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
        const decision = checkRateLimit(
          rateState,
          validation.value.recipients,
          subjectToRateLimit,
          effectiveRateLimit(),
          now(),
        );
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

      const result = await client.send({
        inboxId: opts.inboxId,
        to: validation.value.recipients,
        subject: validation.value.subject,
        text: validation.value.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });

      if (result.status === "sent") {
        // Only burn quota when AgentMail actually accepted the message.
        if (subjectToRateLimit !== null) {
          recordSend(rateState, validation.value.recipients, subjectForRateCheck, now());
          persistRateStateIfConfigured();
        }
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

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "send_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      return JSON.stringify({
        status: "failed",
        message: result.detail,
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
        const decision = checkRateLimit(
          rateState,
          validation.value.recipients,
          replyDedupKey,
          effectiveRateLimit(),
          now(),
        );
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

      const result = await client.reply({
        inboxId: opts.inboxId,
        messageId: input.messageId,
        text: input.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.replyAll ? { replyAll: true } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });

      if (result.status === "sent") {
        if (trustLevel !== "creator") {
          recordSend(rateState, validation.value.recipients, replyDedupKey, now());
          persistRateStateIfConfigured();
        }
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

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "reply_to_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: "(reply)",
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      return JSON.stringify({
        status: "failed",
        message: result.detail,
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
        const decision = checkRateLimit(
          rateState,
          validation.value.recipients,
          validation.value.subject,
          effectiveRateLimit(),
          now(),
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

      const result = await client.forward({
        inboxId: opts.inboxId,
        messageId: input.messageId,
        to: validation.value.recipients,
        ...(input.subject ? { subject: validation.value.subject } : {}),
        ...(input.text ? { text: input.text } : {}),
        ...(validation.value.html ? { html: validation.value.html } : {}),
        ...(input.labels && input.labels.length > 0 ? { labels: input.labels } : {}),
      });

      if (result.status === "sent") {
        if (trustLevel !== "creator") {
          recordSend(rateState, validation.value.recipients, validation.value.subject, now());
          persistRateStateIfConfigured();
        }
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

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "forward_message",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      return JSON.stringify({
        status: "failed",
        message: result.detail,
        ...(result.httpStatus ? { httpStatus: result.httpStatus } : {}),
        ...(result.retryAfterSec ? { retryAfterSec: result.retryAfterSec } : {}),
      });
    },
  });

  // ---------------------------------------------------------------------------
  // Lifecycle
  // ---------------------------------------------------------------------------
  async function onBoot(): Promise<void> {
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
          dbPath: opts.dbPath ?? join(opts.agentDir ?? process.cwd(), "agent-mail.db"),
          now,
        });
        ownsInboundLedger = true;
      }
      sdkAdapters ??= createAgentMailSdkAdapters({
        apiKey: opts.apiKey,
        apiBaseUrl: opts.apiBaseUrl,
        websocketBaseUrl: opts.inbound?.websocketBaseUrl,
      });
      if (inboundMode === "webhook" && inboundRoutes.length === 0) {
        const webhookOptions = opts.inbound?.webhook;
        inboundRoutes.push(
          createAgentMailWebhookRoute({
            inboxId: opts.inboxId,
            ledger: inboundLedger,
            path: webhookOptions?.path,
            secretEnv: webhookOptions?.secretEnv,
            timestampToleranceSeconds: webhookOptions?.timestampToleranceSeconds,
            onAccepted: scheduleDrain,
          }),
        );
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
      return;
    }
    // ok
  }

  async function onShutdown(): Promise<void> {
    if (pollTimer) clearInterval(pollTimer);
    if (drainTimer) clearInterval(drainTimer);
    if (drainKickTimer) clearTimeout(drainKickTimer);
    pollTimer = undefined;
    drainTimer = undefined;
    drainKickTimer = undefined;
    drainScheduled = false;
    await liveSubscription?.close();
    liveSubscription = undefined;
    inboundReady = false;
    inboundWorker = undefined;
    inboundKernel = undefined;
    seenMessagesByTurn.clear();
    if (ownsInboundLedger) inboundLedger?.close();
    inboundLedger = opts._inboundLedger;
    ownsInboundLedger = false;
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
    const sentInLastHour = recent.filter(
      (r) =>
        r.status === "sent" &&
        // The HH:MM:SS comparison is rough but adequate — for a precise
        // window we'd need to add a `now` field to DispatchRecord. Skip
        // the precision for the admin view.
        true,
    ).length;

    return {
      augmentName: "agent-mail",
      title: "AgentMail",
      sections: [
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
              label: "Recipient allowlist",
              value:
                outboundOpts.allowedRecipients && outboundOpts.allowedRecipients.length > 0
                  ? `${outboundOpts.allowedRecipients.length} entries`
                  : "(open — any well-formed email)",
              source: "yaml",
            },
            {
              label: "Sent (since boot)",
              value: String(recent.filter((r) => r.status === "sent").length),
            },
            { label: "Recent dispatches", value: String(recent.length) },
            {
              label: "(unused) sent-in-last-hour",
              value: String(sentInLastHour),
            },
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
      ],
    };
  }

  async function persistCapOverride(value: number): Promise<void> {
    if (!opts.agentDir) {
      throw new Error("agentDir not configured; admin overrides cannot persist");
    }
    const current = readOverrides(opts.agentDir) ?? {
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
    writeOverrides(opts.agentDir, current);
  }

  async function clearCapOverride(): Promise<void> {
    if (!opts.agentDir) return;
    const current = readOverrides(opts.agentDir);
    if (!current) return;
    if (current.overrides.agentMail) {
      delete (current.overrides.agentMail as Record<string, unknown>).globalMaxPerHour;
      if (Object.keys(current.overrides.agentMail).length === 0) {
        delete (current.overrides as Record<string, unknown>).agentMail;
      }
    }
    current.lastModified = new Date().toISOString();
    current.lastModifiedBy = "creator";
    writeOverrides(opts.agentDir, current);
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

      const result = await client.send({
        inboxId: opts.inboxId,
        to: validation.value.recipients,
        subject: validation.value.subject,
        text: validation.value.text,
        ...(validation.value.html ? { html: validation.value.html } : {}),
      });

      if (result.status === "sent") {
        recordDispatch({
          timestamp: timestampHHMMSS(now()),
          tool: "admin-test",
          status: "sent",
          recipients: redactRecipients(validation.value.recipients),
          subject: validation.value.subject.slice(0, 80),
        });
        return { ok: true, message: `Test message sent to ${to}` };
      }

      recordDispatch({
        timestamp: timestampHHMMSS(now()),
        tool: "admin-test",
        status: "failed",
        recipients: redactRecipients(validation.value.recipients),
        subject: validation.value.subject.slice(0, 80),
        httpStatus: result.httpStatus,
        detail: result.detail,
      });
      return { ok: false, message: `Send failed: ${result.detail}` };
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
    ...(inboundMode === "webhook" ? { httpRoutes: inboundRoutes } : {}),
    onBoot,
    onShutdown,
    adminInfo,
    adminActions,
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
