import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentMailClient } from "agentmail";
import {
  agentMail,
  type Augment,
  type OutboundMessage,
  type PeerIdentity,
  type Tool,
  type ToolExecuteContext,
  type ToolResult,
  type TransportKernel,
  type TurnResult,
  type TurnState,
  type TurnTrigger,
} from "../src";
import {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailProvider,
  type AgentMailProviderEvent,
  type AgentMailProviderSubscription,
} from "../src/augments/agentMail/provider";

const CONFIRMATION = "create-temporary-inbox-and-send-live-email";
const OPERATION_TIMEOUT_MS = 30_000;
const DELIVERY_TIMEOUT_MS = 180_000;
const POLL_INTERVAL_MS = 3_000;

const creator: PeerIdentity = {
  id: "creator_agentmail_live_canary",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "webTransport",
};

interface LiveCanaryEnvironment {
  apiKey: string;
  targetInboxId: string;
  targetInboxEmail: string;
  runIdentity: string;
}

interface DraftListItem {
  draftId?: string;
  subject?: string;
  inReplyTo?: string;
  state?: string;
  management?: string;
}

interface KernelProbe {
  turns: number;
}

interface LiveStageDiagnostics {
  targetDelivery?: "received" | "spam" | "blocked" | "unauthenticated";
  targetCatchUp: boolean;
  senderEvents: string[];
  senderMessageStored: boolean;
  senderStreamError?: string;
  kernelTurns: number;
  providerDraft: boolean;
  managedDraftState?: string;
  managedDraftManagement?: string;
  inboundState?: string;
  inboundError?: string;
}

function readEnvironment(): LiveCanaryEnvironment {
  if (process.env.AGENTMAIL_LIVE_MUTATION_CONFIRM !== CONFIRMATION) {
    throw new Error("Live AgentMail mutation confirmation is missing.");
  }
  const apiKey = requiredSecret("AGENTMAIL_API_KEY");
  const targetInboxId = requiredIdentifier("AGENTMAIL_CANARY_INBOX_ID");
  const targetInboxEmail = requiredEmail("AGENTMAIL_CANARY_INBOX_EMAIL");
  const runId = process.env.GITHUB_RUN_ID;
  const runAttempt = process.env.GITHUB_RUN_ATTEMPT;
  if (!runId || !/^\d{1,32}$/.test(runId) || !runAttempt || !/^\d{1,8}$/.test(runAttempt)) {
    throw new Error("The live AgentMail canary requires a GitHub Actions run identity.");
  }
  return { apiKey, targetInboxId, targetInboxEmail, runIdentity: `${runId}-${runAttempt}` };
}

function requiredSecret(name: string): string {
  const value = process.env[name];
  if (!value || !/^[\x21-\x7e]{1,4096}$/.test(value)) {
    throw new Error(`${name} must be a non-empty protected Environment secret.`);
  }
  return value;
}

function requiredIdentifier(name: string): string {
  const value = process.env[name];
  if (!value || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new Error(`${name} must be a non-empty protected Environment value.`);
  }
  return value;
}

function requiredEmail(name: string): string {
  const value = requiredIdentifier(name).toLowerCase();
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.includes(" ")) {
    throw new Error(`${name} must be the canonical canary inbox email.`);
  }
  return value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  label: string,
  timeoutMs = OPERATION_TIMEOUT_MS,
) {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}.`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor<T>(probe: () => Promise<T | undefined>, label: string): Promise<T> {
  const deadline = Date.now() + DELIVERY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const value = await probe();
    if (value !== undefined) return value;
    await Bun.sleep(Math.min(POLL_INTERVAL_MS, Math.max(0, deadline - Date.now())));
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

function kernel(reply: string, probe: KernelProbe): TransportKernel {
  let outbound: ((peer: PeerIdentity, message: OutboundMessage) => Promise<void>) | undefined;
  return {
    async handleInbound(trigger: TurnTrigger) {
      if (!trigger.peer || !outbound) throw new Error("Live AgentMail turn identity was missing.");
      probe.turns += 1;
      const response: OutboundMessage = {
        parts: [{ kind: "text", text: reply }],
        contextId: trigger.contextId,
      };
      await outbound(trigger.peer, response);
      return {
        turnId: trigger.turnId,
        success: true,
        status: "completed",
        response,
      } as TurnResult;
    },
    onOutbound(callback) {
      outbound = callback;
    },
    getAgentCard: () => ({}) as never,
    quarantineThread: () => true,
    recoverThread: () => true,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
}

function requireTool(augment: Augment, name: string): Tool {
  const tool = augment.tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`Live AgentMail runtime omitted ${name}.`);
  return tool;
}

function toolJson(value: string | ToolResult): Record<string, unknown> {
  const raw = typeof value === "string" ? value : value.content;
  const parsed = JSON.parse(raw) as Record<string, unknown>;
  if (typeof value !== "string" && value.isError) {
    throw new Error(`AgentMail tool failed with status ${String(parsed.status ?? "unknown")}.`);
  }
  return parsed;
}

function creatorTurn(turnId: string, text: string): TurnState {
  return {
    turnId,
    threadId: "console_agentmail_live_canary",
    peer: creator,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId,
      threadId: "console_agentmail_live_canary",
      timestamp: Date.now(),
      source: "webTransport",
      peer: creator,
      payload: {
        parts: [{ kind: "text", text }],
        sourceAugment: "webTransport",
        peer: creator,
        timestamp: Date.now(),
      },
    },
  };
}

function context(turnId: string, operationId: string): ToolExecuteContext {
  return {
    turnId,
    threadId: "console_agentmail_live_canary",
    peer: creator,
    operationId,
  };
}

async function boot(
  augment: ReturnType<typeof agentMail>,
  reply: string,
  probe: KernelProbe,
): Promise<void> {
  await withTimeout(augment.onBoot?.() ?? Promise.resolve(), "AgentMail runtime boot");
  if (!augment.transport) throw new Error("Live AgentMail runtime omitted its transport.");
  await augment.transport.register(kernel(reply, probe), "agentMail");
  await withTimeout(augment.transport.ready?.() ?? Promise.resolve(), "AgentMail transport ready");
}

function runtime(input: {
  apiKey: string;
  inboxId: string;
  emailAddress: string;
  dbPath: string;
  subjectPrefix: string;
}) {
  return agentMail({
    apiKey: input.apiKey,
    inboxId: input.inboxId,
    emailAddress: input.emailAddress,
    dbPath: input.dbPath,
    inbound: {
      mode: "websocket",
      allowAnySender: true,
      rateLimit: { globalMaxPerHour: 20, perSenderMaxPerHour: 5 },
    },
    replies: { mode: "review", allowReplyAll: false },
    outbound: {
      allowedTrustLevels: ["creator"],
      allowDirectDelivery: true,
      subjectPrefix: input.subjectPrefix,
      maxRecipients: 2,
      bodyMaxBytes: 8_192,
      rateLimit: {
        globalMaxPerHour: 5,
        perRecipientCooldownMs: 0,
        dedupWindowMs: 0,
      },
    },
  });
}

async function findManagedDraft(
  augment: Augment,
  marker: string,
): Promise<DraftListItem | undefined> {
  const value = toolJson(
    await requireTool(augment, "list_mail_drafts").execute(
      // Stay within the shipped default mailbox.maxListResults policy. The
      // canary must prove the public baseline rather than silently widening it.
      { limit: 50 },
      context("list-live-draft", "list-live-draft"),
    ),
  );
  if (value.status !== "ok" || !Array.isArray(value.drafts)) {
    throw new Error("AgentMail draft listing returned an invalid contract.");
  }
  return (value.drafts as DraftListItem[]).find(
    (draft) => draft.subject?.includes(marker) === true,
  );
}

async function findTargetDelivery(provider: AgentMailProvider, subject: string) {
  if (!provider.listMailboxMessages) {
    throw new Error("Live AgentMail provider omitted mailbox message listing.");
  }
  const page = await provider.listMailboxMessages({
    subject: [subject],
    limit: 10,
    includeSpam: true,
    includeBlocked: true,
    includeUnauthenticated: true,
    includeTrash: true,
  });
  const matches = page.items.filter((message) => message.subject === subject);
  if (matches.length > 1) {
    throw new Error("Live AgentMail target inbox received a duplicate canary message.");
  }
  return matches[0];
}

async function findCatchUpDelivery(provider: AgentMailProvider, subject: string, after: number) {
  let pageToken: string | undefined;
  for (let pageNumber = 1; pageNumber <= 10; pageNumber += 1) {
    const page = await provider.listMessages({ after, pageToken, limit: 100 });
    const match = page.messages.find((message) => message.subject === subject);
    if (match) return match;
    pageToken = page.nextPageToken;
    if (!pageToken) return undefined;
  }
  throw new Error("Live AgentMail target catch-up exceeded its bounded page scan.");
}

async function findProviderDraft(provider: AgentMailProvider, replySubject: string) {
  if (!provider.listMailboxDrafts) {
    throw new Error("Live AgentMail provider omitted mailbox draft listing.");
  }
  const page = await provider.listMailboxDrafts({ limit: 100 });
  const matches = page.items.filter((draft) => draft.subject === replySubject);
  if (matches.length > 1) {
    throw new Error("Live AgentMail target inbox contained duplicate canary drafts.");
  }
  return matches[0];
}

async function updateRuntimeDiagnostics(
  augment: Augment,
  diagnostics: LiveStageDiagnostics,
): Promise<void> {
  const projection = (await augment.adminInfo?.())?.projection;
  if (projection?.kind !== "mail") return;
  diagnostics.inboundState = projection.inbound.state;
  diagnostics.inboundError = projection.inbound.lastErrorCode;
}

function stagedTimeout(diagnostics: LiveStageDiagnostics): Error {
  const managed = diagnostics.managedDraftState
    ? `${diagnostics.managedDraftState}/${diagnostics.managedDraftManagement ?? "unknown"}`
    : "none";
  return new Error(
    "Live AgentMail review draft timed out " +
      `(targetDelivery=${diagnostics.targetDelivery ?? "none"}, ` +
      `kernelTurns=${diagnostics.kernelTurns}, providerDraft=${diagnostics.providerDraft ? "yes" : "no"}, ` +
      `managedDraft=${managed}, inboundState=${diagnostics.inboundState ?? "unknown"}, ` +
      `inboundError=${diagnostics.inboundError ?? "none"}).`,
  );
}

function deliveryTimeout(diagnostics: LiveStageDiagnostics): Error {
  return new Error(
    "Live AgentMail target delivery timed out " +
      `(senderStored=${diagnostics.senderMessageStored ? "yes" : "no"}, ` +
      `senderEvents=${diagnostics.senderEvents.join(",") || "none"}, ` +
      `senderStreamError=${diagnostics.senderStreamError ?? "none"}, ` +
      `targetCatchUp=${diagnostics.targetCatchUp ? "yes" : "no"}, ` +
      `kernelTurns=${diagnostics.kernelTurns}, inboundState=${diagnostics.inboundState ?? "unknown"}, ` +
      `inboundError=${diagnostics.inboundError ?? "none"}).`,
  );
}

async function cleanupCurrentRun(input: {
  provider: AgentMailProvider;
  subject: string;
  replySubject: string;
  knownMessageIds: Array<string | undefined>;
}): Promise<void> {
  const messageIds = new Set(input.knownMessageIds.filter((id): id is string => id !== undefined));
  const draftIds = new Set<string>();
  if (input.provider.listMailboxMessages) {
    for (const subject of [input.subject, input.replySubject]) {
      const page = await input.provider.listMailboxMessages({
        subject: [subject],
        limit: 10,
        includeSpam: true,
        includeBlocked: true,
        includeUnauthenticated: true,
        includeTrash: true,
      });
      for (const message of page.items) {
        if (message.subject === subject) messageIds.add(message.messageId);
      }
    }
  }
  if (input.provider.listMailboxDrafts) {
    const page = await input.provider.listMailboxDrafts({ limit: 100 });
    for (const draft of page.items) {
      if (draft.subject === input.replySubject) draftIds.add(draft.draftId);
    }
  }
  if (!input.provider.deleteMessagePermanently || !input.provider.deleteDraft) {
    throw new Error("Live AgentMail provider omitted current-run cleanup operations.");
  }
  for (const draftId of draftIds) await input.provider.deleteDraft(draftId);
  for (const messageId of messageIds) await input.provider.deleteMessagePermanently(messageId);
}

function safeFailure(error: unknown): string {
  if (error instanceof AgentMailProviderError) {
    const status = error.details.httpStatus ? ` (HTTP ${error.details.httpStatus})` : "";
    return `${error.details.operation} failed: ${error.details.code}${status}. ${error.details.nextAction}`;
  }
  if (
    error instanceof Error &&
    /^(Timed out|Live AgentMail|AgentMail|The live)/.test(error.message)
  ) {
    return error.message;
  }
  return "Unexpected failure; provider credentials, identifiers, and responses were suppressed.";
}

export async function runAgentMailLiveE2E(): Promise<void> {
  const env = readEnvironment();
  const marker = env.runIdentity;
  const username = `auggy-live-${marker}`;
  const clientId = `auggy.live-e2e.${marker}`;
  const subject = `Live provider E2E ${marker}`;
  const firstDraftBody = `Live provider draft ${marker}.`;
  const revisedDraftBody = `Live provider revised draft ${marker}.`;
  const subjectPrefix = `[Auggy Live E2E ${marker}] `;
  const replySubject = `${subjectPrefix}Re: ${subject}`;
  const stateDir = mkdtempSync(join(tmpdir(), "auggy-agentmail-live-"));
  const dbPath = join(stateDir, "orchestration.db");
  const sdk = new AgentMailClient({ apiKey: env.apiKey });
  const targetProvider = createAgentMailProvider({
    apiKey: env.apiKey,
    inboxId: env.targetInboxId,
  });
  let senderInboxId: string | undefined;
  let inboundMessageId: string | undefined;
  let sentReplyMessageId: string | undefined;
  let firstRuntime: ReturnType<typeof agentMail> | undefined;
  let restartRuntime: ReturnType<typeof agentMail> | undefined;
  let senderSubscription: AgentMailProviderSubscription | undefined;
  let targetVerified = false;
  let failure: unknown;
  const cleanupFailures: string[] = [];
  const unhandled: unknown[] = [];
  const onUnhandled = (error: unknown) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);

  try {
    const targetIdentity = await withTimeout(targetProvider.verifyAccess(), "target inbox access");
    targetVerified = true;
    if (
      targetIdentity.configuredInboxId !== env.targetInboxId ||
      targetIdentity.emailAddress !== env.targetInboxEmail
    ) {
      throw new Error("AgentMail target inbox identity did not match protected configuration.");
    }

    const temporary = await withTimeout(
      sdk.inboxes.create({
        username,
        displayName: "Auggy live mutation canary",
        clientId,
        metadata: { source: "auggy-live-e2e", run: marker },
      }),
      "temporary sender inbox creation",
    );
    senderInboxId = temporary.inboxId;
    const senderProvider = createAgentMailProvider({ apiKey: env.apiKey, inboxId: senderInboxId });
    await withTimeout(senderProvider.verifyAccess(), "temporary sender inbox access");
    const senderEvents = new Set<AgentMailProviderEvent["type"]>();
    let senderStreamError: string | undefined;
    senderSubscription = await withTimeout(
      senderProvider.connect({
        onEvent(event) {
          senderEvents.add(event.type);
        },
        onError(error) {
          senderStreamError = error.details.code;
        },
      }),
      "temporary sender event stream",
    );

    firstRuntime = runtime({
      apiKey: env.apiKey,
      inboxId: env.targetInboxId,
      emailAddress: env.targetInboxEmail,
      dbPath,
      subjectPrefix,
    });
    const firstProbe: KernelProbe = { turns: 0 };
    await boot(firstRuntime, firstDraftBody, firstProbe);

    const sentInbound = await withTimeout(
      senderProvider.sendMessage({
        to: [env.targetInboxEmail],
        subject,
        text: `Live inbound message ${marker}.`,
        idempotencyKey: `auggy.live-e2e.inbound.${marker}`,
      }),
      "live inbound send",
    );
    const senderStored = await withTimeout(
      senderProvider.getMessage(sentInbound.messageId),
      "sent message persistence",
    );
    if (senderStored.messageId !== sentInbound.messageId) {
      throw new Error("Live AgentMail sender persisted the wrong message identity.");
    }

    const deliveryDiagnostics: LiveStageDiagnostics = {
      targetCatchUp: false,
      senderEvents: [],
      senderMessageStored: true,
      kernelTurns: 0,
      providerDraft: false,
    };
    const sentAt = Date.now() - 60_000;
    let targetDelivery: Awaited<ReturnType<typeof findTargetDelivery>>;
    try {
      targetDelivery = await waitFor(async () => {
        deliveryDiagnostics.senderEvents = [...senderEvents].sort();
        deliveryDiagnostics.senderStreamError = senderStreamError;
        deliveryDiagnostics.kernelTurns = firstProbe.turns;
        const [mailboxDelivery, catchUpDelivery] = await Promise.all([
          findTargetDelivery(targetProvider, subject),
          findCatchUpDelivery(targetProvider, subject, sentAt),
        ]);
        deliveryDiagnostics.targetCatchUp = catchUpDelivery !== undefined;
        const canonicalDelivery = catchUpDelivery ?? mailboxDelivery;
        deliveryDiagnostics.targetDelivery = canonicalDelivery?.classification;
        await updateRuntimeDiagnostics(firstRuntime as Augment, deliveryDiagnostics);
        // The runtime's durable recovery contract uses the received-label
        // catch-up path. Keep the subject-filtered mailbox lookup as extra
        // telemetry, but never let optional provider filter behavior overrule
        // canonical evidence that the exact run-unique message was received.
        return canonicalDelivery;
      }, "live inbound delivery to the target inbox");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Timed out waiting for")) {
        deliveryDiagnostics.senderEvents = [...senderEvents].sort();
        deliveryDiagnostics.senderStreamError = senderStreamError;
        deliveryDiagnostics.kernelTurns = firstProbe.turns;
        await updateRuntimeDiagnostics(firstRuntime, deliveryDiagnostics);
        throw deliveryTimeout(deliveryDiagnostics);
      }
      throw error;
    }
    inboundMessageId = targetDelivery.messageId;
    const diagnostics: LiveStageDiagnostics = {
      targetDelivery: targetDelivery.classification,
      targetCatchUp: deliveryDiagnostics.targetCatchUp,
      senderEvents: deliveryDiagnostics.senderEvents,
      senderMessageStored: deliveryDiagnostics.senderMessageStored,
      ...(deliveryDiagnostics.senderStreamError === undefined
        ? {}
        : { senderStreamError: deliveryDiagnostics.senderStreamError }),
      kernelTurns: 0,
      providerDraft: false,
    };
    if (targetDelivery.classification !== "received") {
      throw new Error(
        `Live AgentMail target delivery was classified as ${targetDelivery.classification} and correctly rejected by inbound policy.`,
      );
    }

    let draft: DraftListItem | undefined;
    try {
      draft = await waitFor(async () => {
        diagnostics.kernelTurns = firstProbe.turns;
        const [managed, providerDraft] = await Promise.all([
          findManagedDraft(firstRuntime as Augment, marker),
          findProviderDraft(targetProvider, replySubject),
        ]);
        diagnostics.providerDraft = providerDraft !== undefined;
        diagnostics.managedDraftState = managed?.state;
        diagnostics.managedDraftManagement = managed?.management;
        await updateRuntimeDiagnostics(firstRuntime as Augment, diagnostics);
        return managed?.draftId &&
          managed.state === "ready" &&
          managed.management === "managed" &&
          typeof managed.inReplyTo === "string"
          ? managed
          : undefined;
      }, "live inbound wake and review draft creation");
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Timed out waiting for")) {
        diagnostics.kernelTurns = firstProbe.turns;
        await updateRuntimeDiagnostics(firstRuntime, diagnostics);
        throw stagedTimeout(diagnostics);
      }
      throw error;
    }
    if (!draft?.draftId || !draft.inReplyTo) {
      throw new Error("AgentMail runtime did not preserve the inbound draft source.");
    }
    if (draft.inReplyTo !== inboundMessageId) {
      throw new Error("AgentMail runtime attached the review draft to the wrong inbound message.");
    }

    const showTurn = creatorTurn("show-live-draft", `show draft ${draft.draftId}`);
    await firstRuntime.onTurnStart?.(showTurn);
    const shown = toolJson(
      await requireTool(firstRuntime, "show_mail_draft").execute(
        { draftId: draft.draftId },
        context("show-live-draft", "show-live-draft"),
      ),
    );
    await firstRuntime.onTurnEnd?.({ turnId: showTurn.turnId } as TurnResult);
    if (
      shown.status !== "review" ||
      shown.text !== firstDraftBody ||
      typeof shown.providerRevision !== "string"
    ) {
      throw new Error("AgentMail runtime did not expose the expected review draft.");
    }

    const reviseTurn = creatorTurn("revise-live-draft", `revise draft ${draft.draftId}`);
    await firstRuntime.onTurnStart?.(reviseTurn);
    const revised = toolJson(
      await requireTool(firstRuntime, "revise_mail_draft").execute(
        {
          draftId: draft.draftId,
          expectedRevision: shown.providerRevision,
          text: revisedDraftBody,
        },
        context("revise-live-draft", "revise-live-draft"),
      ),
    );
    await firstRuntime.onTurnEnd?.({ turnId: reviseTurn.turnId } as TurnResult);
    if (revised.status !== "revised" || typeof revised.providerRevision !== "string") {
      throw new Error("AgentMail runtime did not revise the provider draft.");
    }
    const revisedProviderDraft = await targetProvider.getDraft(draft.draftId);
    if (
      revisedProviderDraft.text !== revisedDraftBody ||
      revisedProviderDraft.text.includes(firstDraftBody)
    ) {
      throw new Error("AgentMail provider did not persist the creator-reviewed revision.");
    }

    const sendTurn = creatorTurn("send-live-draft", `send draft ${draft.draftId}`);
    await firstRuntime.onTurnStart?.(sendTurn);
    const sendContext = context("send-live-draft", `send-live-draft-${marker}`);
    const sent = toolJson(
      await requireTool(firstRuntime, "send_mail_draft").execute(
        { draftId: draft.draftId, expectedRevision: revised.providerRevision },
        sendContext,
      ),
    );
    const replayed = toolJson(
      await requireTool(firstRuntime, "send_mail_draft").execute(
        { draftId: draft.draftId, expectedRevision: revised.providerRevision },
        sendContext,
      ),
    );
    await firstRuntime.onTurnEnd?.({ turnId: sendTurn.turnId } as TurnResult);
    if (
      sent.status !== "sent" ||
      typeof sent.messageId !== "string" ||
      replayed.status !== "sent" ||
      replayed.replayed !== true
    ) {
      throw new Error("AgentMail runtime did not durably send and replay the reviewed draft.");
    }
    sentReplyMessageId = sent.messageId;

    const receivedReply = await waitFor(async () => {
      const page = await senderProvider.listMessages({ after: Date.now() - 300_000, limit: 100 });
      const matches = page.messages.filter((message) => message.subject?.includes(marker));
      if (matches.length > 1) {
        throw new Error("AgentMail live canary received a duplicate reply.");
      }
      if (matches.length !== 1) return undefined;
      return senderProvider.getMessage(matches[0]!.messageId);
    }, "reviewed reply delivery to the temporary sender inbox");
    const deliveredText = receivedReply.text ?? receivedReply.extractedText ?? "";
    if (!deliveredText.includes(revisedDraftBody) || deliveredText.includes(firstDraftBody)) {
      throw new Error("AgentMail delivered reply did not contain the creator-reviewed revision.");
    }

    await firstRuntime.onShutdown?.();
    firstRuntime = undefined;

    restartRuntime = runtime({
      apiKey: env.apiKey,
      inboxId: env.targetInboxId,
      emailAddress: env.targetInboxEmail,
      dbPath,
      subjectPrefix,
    });
    await boot(restartRuntime, "[NO_REPLY]", { turns: 0 });
    const restartTurn = creatorTurn("restart-live-replay", `send draft ${draft.draftId}`);
    await restartRuntime.onTurnStart?.(restartTurn);
    const restartReplay = toolJson(
      await requireTool(restartRuntime, "send_mail_draft").execute(
        { draftId: draft.draftId, expectedRevision: revised.providerRevision },
        context("restart-live-replay", `send-live-draft-${marker}`),
      ),
    );
    await restartRuntime.onTurnEnd?.({ turnId: restartTurn.turnId } as TurnResult);
    if (restartReplay.status !== "sent" || restartReplay.replayed !== true) {
      throw new Error("AgentMail runtime did not recover the sent settlement after restart.");
    }
    await Bun.sleep(2_000);
    if (unhandled.length > 0) {
      throw new Error("AgentMail live E2E produced an unhandled rejection.");
    }
  } catch (error) {
    failure = error;
  } finally {
    await firstRuntime?.onShutdown?.().catch(() => undefined);
    await restartRuntime?.onShutdown?.().catch(() => undefined);
    senderSubscription?.close();
    process.off("unhandledRejection", onUnhandled);
    if (targetVerified) {
      await cleanupCurrentRun({
        provider: targetProvider,
        subject,
        replySubject,
        knownMessageIds: [inboundMessageId, sentReplyMessageId],
      }).catch(() => cleanupFailures.push("target artifacts"));
    }
    if (senderInboxId) {
      await sdk.inboxes.delete(senderInboxId).catch(() => cleanupFailures.push("temporary inbox"));
    }
    rmSync(stateDir, { recursive: true, force: true });
  }
  if (cleanupFailures.length > 0) {
    throw new Error(
      "AgentMail live E2E cleanup failed; inspect resources tagged with source auggy-live-e2e.",
    );
  }
  if (failure) throw failure;
  console.log(
    "AgentMail live E2E passed: send -> WebSocket receive -> wake -> provider draft -> creator revise/send -> delivery -> restart replay; temporary resources removed.",
  );
}

if (import.meta.main) {
  try {
    await runAgentMailLiveE2E();
  } catch (error) {
    console.error(`AgentMail live E2E failed: ${safeFailure(error)}`);
    process.exitCode = 1;
  }
}
