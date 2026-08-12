import { hashAgentMailOrchestrationValue, type AgentMailOrchestrationStore } from "./store";
import type {
  AgentMailMessageSummary,
  AgentMailProvider,
  AgentMailProviderError,
  AgentMailProviderEvent,
  AgentMailProviderSubscription,
} from "./provider";

export type AgentMailInboundStatus =
  | "idle"
  | "connecting"
  | "catching_up"
  | "ready"
  | "degraded"
  | "stopped";

export interface AgentMailInboundCoordinatorOptions {
  provider: AgentMailProvider;
  store: AgentMailOrchestrationStore;
  policyVersion: number;
  onWorkAvailable(messageId: string): void | Promise<void>;
  onError?(error: AgentMailProviderError | Error): void;
  catchUpOverlapMs?: number;
  repairIntervalMs?: number;
  maxCatchUpPages?: number;
  clock?: () => number;
}

export interface AgentMailInboundCoordinator {
  start(): Promise<void>;
  stop(): Promise<void>;
  repair(): Promise<void>;
  status(): {
    state: AgentMailInboundStatus;
    lastCatchUpAt?: number;
    lastEventAt?: number;
    lastErrorCode?: string;
  };
}

const DEFAULT_OVERLAP_MS = 5 * 60_000;
const DEFAULT_REPAIR_INTERVAL_MS = 60_000;
const DEFAULT_MAX_CATCH_UP_PAGES = 100;

function messagePayloadHash(
  message: AgentMailMessageSummary,
  classification = message.classification,
) {
  return hashAgentMailOrchestrationValue(
    JSON.stringify([
      message.inboxId,
      message.messageId,
      message.threadId,
      message.timestamp,
      classification,
      message.sender,
    ]),
  );
}

function eventPayloadHash(event: Exclude<AgentMailProviderEvent, { type: "message.received" }>) {
  return hashAgentMailOrchestrationValue(
    JSON.stringify([event.type, event.inboxId, event.messageId, event.threadId, event.timestamp]),
  );
}

export function createAgentMailInboundCoordinator(
  options: AgentMailInboundCoordinatorOptions,
): AgentMailInboundCoordinator {
  const clock = options.clock ?? Date.now;
  const overlapMs = options.catchUpOverlapMs ?? DEFAULT_OVERLAP_MS;
  const repairIntervalMs = options.repairIntervalMs ?? DEFAULT_REPAIR_INTERVAL_MS;
  const maxCatchUpPages = options.maxCatchUpPages ?? DEFAULT_MAX_CATCH_UP_PAGES;
  if (!Number.isSafeInteger(options.policyVersion) || options.policyVersion < 1) {
    throw new Error("agentMail inbound: policyVersion must be a positive integer");
  }
  if (!Number.isSafeInteger(overlapMs) || overlapMs < 0 || overlapMs > 24 * 60 * 60_000) {
    throw new Error("agentMail inbound: catchUpOverlapMs must be between 0 and 24 hours");
  }
  if (
    !Number.isSafeInteger(repairIntervalMs) ||
    repairIntervalMs < 1_000 ||
    repairIntervalMs > 24 * 60 * 60_000
  ) {
    throw new Error("agentMail inbound: repairIntervalMs must be between 1 second and 24 hours");
  }
  if (!Number.isSafeInteger(maxCatchUpPages) || maxCatchUpPages < 1 || maxCatchUpPages > 1_000) {
    throw new Error("agentMail inbound: maxCatchUpPages must be between 1 and 1000");
  }

  let currentState: AgentMailInboundStatus = "idle";
  let lastCatchUpAt: number | undefined;
  let lastEventAt: number | undefined;
  let lastErrorCode: string | undefined;
  let subscription: AgentMailProviderSubscription | undefined;
  let repairTimer: ReturnType<typeof setInterval> | undefined;
  let stopped = false;
  let initialConnect = true;
  let catchUpPromise: Promise<void> | undefined;
  const scheduledMessageIds = new Set<string>();
  const abortController = new AbortController();

  function report(error: AgentMailProviderError | Error): void {
    if (stopped) return;
    currentState = "degraded";
    lastErrorCode =
      "details" in error &&
      typeof error.details === "object" &&
      error.details !== null &&
      "code" in error.details &&
      typeof error.details.code === "string"
        ? error.details.code
        : "inbound_failure";
    options.onError?.(error);
  }

  async function signalWork(messageId: string): Promise<void> {
    if (scheduledMessageIds.has(messageId)) return;
    scheduledMessageIds.add(messageId);
    try {
      await options.onWorkAvailable(messageId);
    } catch (error) {
      scheduledMessageIds.delete(messageId);
      report(error as Error);
    }
  }

  function claimSummary(message: AgentMailMessageSummary, eventId?: string): "new" | "known" {
    const result = options.store.claimMessage({
      messageId: message.messageId,
      threadId: message.threadId,
      ...(eventId === undefined ? {} : { eventId }),
      classification: message.classification,
      senderHash: hashAgentMailOrchestrationValue(message.sender.trim().toLowerCase()),
      payloadHash: messagePayloadHash(message),
      receivedAt: message.timestamp,
      policyVersion: options.policyVersion,
    });
    if (result.status === "conflict") {
      throw new Error(
        `agentMail inbound: conflicting provider identity for message ${message.messageId}`,
      );
    }
    options.store.advanceCheckpoint(message.timestamp, message.messageId);
    return result.status === "claimed" ? "new" : "known";
  }

  async function catchUp(): Promise<void> {
    if (catchUpPromise) return catchUpPromise;
    catchUpPromise = (async () => {
      if (stopped) return;
      currentState = "catching_up";
      options.store.recoverInterrupted(clock() - 5 * 60_000);
      for (const messageId of scheduledMessageIds) {
        if (options.store.getMessage(messageId)?.state !== "pending") {
          scheduledMessageIds.delete(messageId);
        }
      }
      const checkpoint = options.store.getCheckpoint();
      const after = Math.max(0, checkpoint.timestamp - overlapMs);
      let pageToken: string | undefined;
      let pageCount = 0;
      do {
        pageCount += 1;
        if (pageCount > maxCatchUpPages) {
          throw new Error("agentMail inbound: catch-up exceeded the configured page bound");
        }
        const page = await options.provider.listMessages(
          { after, pageToken, limit: 100 },
          abortController.signal,
        );
        for (const message of page.messages) {
          if (stopped) return;
          claimSummary(message);
        }
        pageToken = page.nextPageToken;
      } while (pageToken !== undefined && !stopped);
      lastCatchUpAt = clock();
      lastErrorCode = undefined;
      currentState = "ready";
      for (const messageId of options.store.listPendingMessageIds(10_000)) {
        await signalWork(messageId);
      }
    })()
      .catch((error) => {
        report(error as Error);
        throw error;
      })
      .finally(() => {
        catchUpPromise = undefined;
      });
    return catchUpPromise;
  }

  async function onProviderEvent(event: AgentMailProviderEvent): Promise<void> {
    if (stopped) return;
    lastEventAt = clock();
    if (event.type === "message.received") {
      const message = { ...event.message, classification: event.classification };
      const status = claimSummary(message, event.eventId);
      if (status === "new") await signalWork(message.messageId);
      return;
    }
    const result = options.store.recordProviderEvent({
      eventId: event.eventId,
      eventType: event.type,
      messageId: event.messageId,
      payloadHash: eventPayloadHash(event),
      observedAt: event.timestamp,
    });
    if (result === "conflict") {
      throw new Error(`agentMail inbound: conflicting provider event ${event.eventId}`);
    }
  }

  return {
    async start() {
      if (currentState !== "idle")
        throw new Error("agentMail inbound: coordinator already started");
      stopped = false;
      currentState = "connecting";
      options.store.recoverInterrupted(clock() - 5 * 60_000);
      await options.provider.verifyAccess(abortController.signal);
      subscription = await options.provider.connect(
        {
          onEvent: onProviderEvent,
          onOpen: () => {
            if (initialConnect) return;
            void catchUp().catch(() => undefined);
          },
          onClose: () => {
            if (!stopped) currentState = "connecting";
          },
          onError: report,
        },
        abortController.signal,
      );
      initialConnect = false;
      // connect() resolves only after subscription; catch-up therefore closes
      // both the startup gap and any overlap with live delivery.
      await catchUp();
      repairTimer = setInterval(() => {
        void catchUp().catch(() => undefined);
      }, repairIntervalMs);
      repairTimer.unref?.();
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      currentState = "stopped";
      abortController.abort();
      if (repairTimer) clearInterval(repairTimer);
      repairTimer = undefined;
      subscription?.close();
      subscription = undefined;
      await catchUpPromise?.catch(() => undefined);
    },
    async repair() {
      if (stopped) throw new Error("agentMail inbound: coordinator is stopped");
      await catchUp();
    },
    status() {
      return {
        state: currentState,
        ...(lastCatchUpAt === undefined ? {} : { lastCatchUpAt }),
        ...(lastEventAt === undefined ? {} : { lastEventAt }),
        ...(lastErrorCode === undefined ? {} : { lastErrorCode }),
      };
    },
  };
}
