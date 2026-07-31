import { createHash } from "node:crypto";
import type { Augment } from "../../types";
import type { AgentMailCreatorDigestBatch, AgentMailCreatorDigestStore } from "./creator-digest";
import type { ResolvedAgentMailCreatorDigestConfig } from "./creator-digest-policy";

export const AGENTMAIL_CREATOR_DIGEST_SOURCE = Symbol("agentMail.creatorDigestSource");

export function agentMailCreatorDigestBridgeName(agentMailName: string): string {
  return `agent-mail-creator-digest-${agentMailName}`;
}

export type AgentMailCreatorDigestBridgeState =
  | "disabled"
  | "idle"
  | "dispatching"
  | "rate_limited"
  | "in_flight"
  | "outcome_unknown"
  | "failed"
  | "attempts_exhausted"
  | "degraded";

export interface AgentMailCreatorDigestBridgeStatus {
  state: AgentMailCreatorDigestBridgeState;
  lastRunAt?: number;
  lastPresentedAt?: number;
  pendingBatchId?: string;
  pendingItems?: number;
  attemptCount?: number;
  reasonCode?: string;
}

export interface AgentMailCreatorDigestController {
  readonly deliveryTargetSha256: string;
  status(): AgentMailCreatorDigestBridgeStatus;
  runNow(): Promise<void>;
  authorizeRetry(input: {
    batchId: string;
    expectedAttemptCount: number;
    evidence: string;
  }): AgentMailCreatorDigestControlResult;
  dismiss(input: { batchId: string; evidence: string }): AgentMailCreatorDigestControlResult;
}

export type AgentMailCreatorDigestControlResult =
  | { ok: true; message: string }
  | { ok: false; message: string };

export interface AgentMailCreatorDigestSource {
  readonly inboxId: string;
  readonly config: ResolvedAgentMailCreatorDigestConfig;
  attach(controller: AgentMailCreatorDigestController): void;
  store(): AgentMailCreatorDigestStore;
}

interface AgentMailCreatorDigestCapableAugment extends Augment {
  [AGENTMAIL_CREATOR_DIGEST_SOURCE]?: AgentMailCreatorDigestSource;
}

interface NotifyInternalDispatchInput {
  source: "agentmail.creator-digest";
  operationKey: string;
  destination: string;
  threadId: string;
  payload: {
    summary: string;
    reason?: string;
  };
  maxAttempts: number;
  signal?: AbortSignal;
}

type NotifyInternalDispatchResult =
  | { status: "sent"; replayed: boolean; attemptCount: number }
  | { status: "failed"; retryable: boolean; attemptCount: number; reason: string }
  | { status: "attempts_exhausted"; attemptCount: number; reason?: string }
  | { status: "rate_limited"; attemptCount?: number }
  | { status: "in_flight"; attemptCount?: number }
  | { status: "outcome_unknown"; attemptCount?: number };

type NotifyInternalInspectionResult =
  | { status: "not_found"; attemptCount: 0 }
  | { status: "sent" | "failed" | "in_flight" | "attempts_exhausted"; attemptCount: number }
  | { status: "outcome_unknown"; attemptCount: number }
  | {
      status: "operation_conflict" | "invalid_request" | "durable_state_unavailable";
      attemptCount: number;
    };

interface NotifyDispatchCapableAugment extends Augment {
  dispatchHost?: {
    destinationBindingSha256(destination: string): string | undefined;
    inspectInternal(input: NotifyInternalDispatchInput): NotifyInternalInspectionResult;
    dispatchInternal(input: NotifyInternalDispatchInput): Promise<NotifyInternalDispatchResult>;
    acknowledgeInternalSettlement(input: {
      source: "agentmail.creator-digest";
      operationKey: string;
      settlementSha256: string;
    }): {
      status:
        | "acknowledged"
        | "already_acknowledged"
        | "not_found"
        | "not_terminal"
        | "operation_conflict"
        | "invalid_request"
        | "durable_state_unavailable";
    };
    authorizeInternalRetry(input: {
      source: "agentmail.creator-digest";
      operationKey: string;
      expectedAttemptCount: number;
      evidence: string;
    }):
      | { status: "authorized"; attemptCount: number; authorizedAttempt: number }
      | { status: string; attemptCount: number };
  };
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function deliveryTargetSha256(input: {
  agentMailName: string;
  notifyName: string;
  destination: string;
  notifyDestinationSha256: string;
}): string {
  return sha256(
    JSON.stringify({
      version: 1,
      sourceAugment: input.agentMailName,
      notifyAugment: input.notifyName,
      destination: input.destination,
      notifyDestinationSha256: input.notifyDestinationSha256,
    }),
  );
}

function operationKey(batch: AgentMailCreatorDigestBatch): string {
  return sha256(
    JSON.stringify({
      version: 1,
      kind: "agentmail-creator-digest",
      batchId: batch.id,
      contentSha256: batch.contentSha256,
    }),
  );
}

function settlementSha256(
  batch: AgentMailCreatorDigestBatch,
  settlement: NonNullable<AgentMailCreatorDigestBatch["settlement"]>,
): string {
  return sha256(
    JSON.stringify([
      "agentmail-creator-digest-settlement/v1",
      batch.id,
      batch.contentSha256,
      settlement.generation,
      settlement.disposition,
      settlement.evidenceSha256,
    ]),
  );
}

function digestThreadId(input: {
  agentMailName: string;
  inboxId: string;
  destination: string;
}): string {
  const binding = sha256(
    JSON.stringify({
      version: 1,
      sourceAugment: input.agentMailName,
      inboxId: input.inboxId,
      destination: input.destination,
    }),
  );
  return `agentmail-digest:${binding.slice(0, 32)}`;
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * Render only aggregate state. Subjects, bodies, addresses, provider errors,
 * message IDs, review IDs, and visitor identities never cross this boundary.
 */
export function renderAgentMailCreatorDigestSummary(
  batch: Pick<AgentMailCreatorDigestBatch, "items">,
): string {
  let incidents = 0;
  let ambiguous = 0;
  let pendingReview = 0;
  let open = 0;
  for (const item of batch.items) {
    if (item.incidentVersion > 0) incidents++;
    if (item.attentionState === "ambiguous") ambiguous++;
    else if (item.attentionState === "pending_review") pendingReview++;
    else if (item.attentionState === "open") open++;
  }

  const parts: string[] = [];
  if (incidents > 0) parts.push(plural(incidents, "quarantined email"));
  if (ambiguous > 0) parts.push(plural(ambiguous, "ambiguous reply", "ambiguous replies"));
  if (pendingReview > 0) {
    parts.push(plural(pendingReview, "reply awaiting review", "replies awaiting review"));
  }
  if (open > 0) parts.push(plural(open, "open email"));
  const detail = parts.length > 0 ? parts.join(", ") : plural(batch.items.length, "email item");
  return `AgentMail has ${detail} needing creator attention. Open the creator console to review them.`;
}

function cloneStatus(
  status: AgentMailCreatorDigestBridgeStatus,
): AgentMailCreatorDigestBridgeStatus {
  return { ...status };
}

/**
 * Compose an explicitly enabled AgentMail creator digest with one Notify
 * augment. The returned synthetic augment must be mounted after both inputs so
 * it boots after them and shuts down before them.
 */
export function createAgentMailCreatorDigestBridge(input: {
  agentMail: Augment;
  notify: Augment;
}): Augment {
  const agentMailAugment = input.agentMail as AgentMailCreatorDigestCapableAugment;
  const notifyAugment = input.notify as NotifyDispatchCapableAugment;
  const source = agentMailAugment[AGENTMAIL_CREATOR_DIGEST_SOURCE];
  if (!source) {
    throw new Error(
      `agentMail creator digest: augment "${input.agentMail.name}" does not expose a creator-digest source`,
    );
  }
  const configuredDestination = source.config.destination;
  if (!source.config.enabled || !configuredDestination) {
    throw new Error(
      `agentMail creator digest: augment "${input.agentMail.name}" is not enabled for creator digest delivery`,
    );
  }
  const dispatchHost = notifyAugment.dispatchHost;
  if (!dispatchHost) {
    throw new Error(
      `agentMail creator digest: augment "${input.notify.name}" does not expose internal Notify dispatch`,
    );
  }

  const attachedSource = source;
  const attachedDispatchHost = dispatchHost;
  const destination = configuredDestination;
  const notifyDestinationSha256 = attachedDispatchHost.destinationBindingSha256(destination);
  if (!notifyDestinationSha256) {
    throw new Error(`agentMail creator digest: Notify destination "${destination}" is unavailable`);
  }
  const targetSha256 = deliveryTargetSha256({
    agentMailName: input.agentMail.name,
    notifyName: input.notify.name,
    destination,
    notifyDestinationSha256,
  });
  const threadId = digestThreadId({
    agentMailName: input.agentMail.name,
    inboxId: attachedSource.inboxId,
    destination,
  });

  let status: AgentMailCreatorDigestBridgeStatus = { state: "idle" };
  let timer: ReturnType<typeof setInterval> | undefined;
  let controller: AbortController | undefined;
  let active: Promise<void> | undefined;
  let started = false;
  let settlementAcknowledgementsRecovered = false;

  function notifyInputFor(
    batch: AgentMailCreatorDigestBatch,
    signal?: AbortSignal,
  ): NotifyInternalDispatchInput {
    return {
      source: "agentmail.creator-digest",
      operationKey: operationKey(batch),
      destination,
      threadId,
      payload: {
        summary: renderAgentMailCreatorDigestSummary(batch),
        reason: "Durable AgentMail creator-attention digest.",
      },
      maxAttempts: attachedSource.config.maxAttempts,
      ...(signal ? { signal } : {}),
    };
  }

  function updateStatus(next: AgentMailCreatorDigestBridgeStatus): void {
    status = { ...next };
  }

  function acknowledgeSettledBatch(batch: AgentMailCreatorDigestBatch): boolean {
    if (!batch.settlement) return false;
    const result = attachedDispatchHost.acknowledgeInternalSettlement({
      source: "agentmail.creator-digest",
      operationKey: operationKey(batch),
      settlementSha256: settlementSha256(batch, batch.settlement),
    });
    return (
      result.status === "acknowledged" ||
      result.status === "already_acknowledged" ||
      result.status === "not_found"
    );
  }

  function acknowledgeRecentSettlements(): boolean {
    // The digest store hard-caps live batches at 100,000. Scan that complete,
    // bounded set so a long outage cannot strand an older acknowledgement
    // behind an already-acknowledged first page.
    const batches = attachedSource.store().listSettled(attachedSource.inboxId, 100_000);
    settlementAcknowledgementsRecovered = batches.every(acknowledgeSettledBatch);
    const lastPresentedAt = batches.reduce<number | undefined>(
      (latest, batch) =>
        batch.settlement?.disposition === "presented"
          ? Math.max(latest ?? 0, batch.settlement.advancedAt)
          : latest,
      status.lastPresentedAt,
    );
    if (lastPresentedAt !== undefined) {
      status = { ...status, lastPresentedAt };
    }
    return settlementAcknowledgementsRecovered;
  }

  async function runCycleUnsafe(): Promise<void> {
    if (!started || controller?.signal.aborted) return;
    const runAt = Date.now();
    if (!settlementAcknowledgementsRecovered && !acknowledgeRecentSettlements()) {
      updateStatus({
        state: "degraded",
        lastRunAt: runAt,
        lastPresentedAt: status.lastPresentedAt,
        reasonCode: "notify-settlement-acknowledgement-failed",
      });
      return;
    }
    let batch: AgentMailCreatorDigestBatch | null;
    try {
      batch = attachedSource.store().prepare({
        inboxId: attachedSource.inboxId,
        deliveryTargetSha256: targetSha256,
        limit: attachedSource.config.maxItems,
      });
    } catch {
      updateStatus({ state: "degraded", lastRunAt: runAt, reasonCode: "prepare-failed" });
      return;
    }
    if (!batch) {
      updateStatus({
        state: "idle",
        lastRunAt: runAt,
        lastPresentedAt: status.lastPresentedAt,
      });
      return;
    }
    if (attachedDispatchHost.destinationBindingSha256(destination) !== notifyDestinationSha256) {
      updateStatus({
        state: "degraded",
        lastRunAt: runAt,
        lastPresentedAt: status.lastPresentedAt,
        pendingBatchId: batch.id,
        pendingItems: batch.items.length,
        reasonCode: "delivery-target-changed",
      });
      return;
    }
    if (!attachedSource.store().isCurrent(batch.id)) {
      const inspected = attachedDispatchHost.inspectInternal(notifyInputFor(batch));
      if (inspected.status === "in_flight" || inspected.status === "outcome_unknown") {
        updateStatus({
          state: inspected.status,
          lastRunAt: runAt,
          lastPresentedAt: status.lastPresentedAt,
          pendingBatchId: batch.id,
          pendingItems: batch.items.length,
          attemptCount: inspected.attemptCount,
          reasonCode:
            inspected.status === "outcome_unknown"
              ? "operator-reconciliation-required"
              : "stale-batch-attempt-in-flight",
        });
        return;
      }
      if (
        inspected.status === "operation_conflict" ||
        inspected.status === "invalid_request" ||
        inspected.status === "durable_state_unavailable"
      ) {
        updateStatus({
          state: "degraded",
          lastRunAt: runAt,
          lastPresentedAt: status.lastPresentedAt,
          pendingBatchId: batch.id,
          pendingItems: batch.items.length,
          attemptCount: inspected.attemptCount,
          reasonCode: `stale-batch-${inspected.status.replaceAll("_", "-")}`,
        });
        return;
      }
      const delivered = inspected.status === "sent";
      const retired = attachedSource.store().settle({
        batchId: batch.id,
        expectedBaseGeneration: batch.baseGeneration,
        expectedDeliveryTargetSha256: targetSha256,
        expectedContentSha256: batch.contentSha256,
        disposition: delivered ? "presented" : "confirmed-no-effect",
        evidence: delivered
          ? "notify-probe-confirmed-sent"
          : "digest-source-generation-stale-no-effect",
      });
      const settledBatch =
        retired.status === "conflict" ? null : attachedSource.store().get(batch.id);
      const acknowledged = settledBatch ? acknowledgeSettledBatch(settledBatch) : false;
      if (!acknowledged) settlementAcknowledgementsRecovered = false;
      updateStatus({
        state: retired.status === "conflict" || !acknowledged ? "degraded" : "idle",
        lastRunAt: runAt,
        lastPresentedAt: delivered ? runAt : status.lastPresentedAt,
        attemptCount: inspected.attemptCount,
        ...(retired.status === "conflict" || !acknowledged
          ? {
              pendingBatchId: batch.id,
              pendingItems: batch.items.length,
              reasonCode:
                retired.status === "conflict"
                  ? "stale-batch-retirement-conflict"
                  : "notify-settlement-acknowledgement-failed",
            }
          : {
              reasonCode: delivered ? "stale-batch-confirmed-presented" : "stale-batch-retired",
            }),
      });
      return;
    }

    updateStatus({
      state: "dispatching",
      lastRunAt: runAt,
      lastPresentedAt: status.lastPresentedAt,
      pendingBatchId: batch.id,
      pendingItems: batch.items.length,
    });

    let result: NotifyInternalDispatchResult;
    try {
      result = await attachedDispatchHost.dispatchInternal(
        notifyInputFor(batch, controller?.signal),
      );
    } catch {
      updateStatus({
        state: "degraded",
        lastRunAt: runAt,
        lastPresentedAt: status.lastPresentedAt,
        pendingBatchId: batch.id,
        pendingItems: batch.items.length,
        reasonCode: "notify-host-failed",
      });
      return;
    }

    if (result.status === "sent") {
      const settlement = attachedSource.store().settle({
        batchId: batch.id,
        expectedBaseGeneration: batch.baseGeneration,
        expectedDeliveryTargetSha256: targetSha256,
        expectedContentSha256: batch.contentSha256,
        disposition: "presented",
        evidence: result.replayed ? "notify-replayed-sent" : "notify-provider-sent",
      });
      if (settlement.status === "conflict") {
        updateStatus({
          state: "degraded",
          lastRunAt: runAt,
          pendingBatchId: batch.id,
          pendingItems: batch.items.length,
          attemptCount: result.attemptCount,
          reasonCode: "settlement-conflict",
        });
        return;
      }
      const settledBatch = attachedSource.store().get(batch.id);
      if (!settledBatch || !acknowledgeSettledBatch(settledBatch)) {
        settlementAcknowledgementsRecovered = false;
        updateStatus({
          state: "degraded",
          lastRunAt: runAt,
          lastPresentedAt: runAt,
          attemptCount: result.attemptCount,
          reasonCode: "notify-settlement-acknowledgement-failed",
        });
        return;
      }
      updateStatus({
        state: "idle",
        lastRunAt: runAt,
        lastPresentedAt: runAt,
        attemptCount: result.attemptCount,
      });
      return;
    }

    const next = {
      lastRunAt: runAt,
      lastPresentedAt: status.lastPresentedAt,
      pendingBatchId: batch.id,
      pendingItems: batch.items.length,
      ...(result.attemptCount === undefined ? {} : { attemptCount: result.attemptCount }),
    };
    if (result.status === "failed") {
      updateStatus({
        ...next,
        state: result.retryable ? "failed" : "attempts_exhausted",
        reasonCode: result.retryable ? "definitive-delivery-failure" : "attempts-exhausted",
      });
      return;
    }
    if (result.status === "attempts_exhausted") {
      updateStatus({ ...next, state: "attempts_exhausted", reasonCode: "attempts-exhausted" });
      return;
    }
    updateStatus({
      ...next,
      state: result.status,
      reasonCode:
        result.status === "outcome_unknown" ? "operator-reconciliation-required" : undefined,
    });
  }

  async function runCycle(): Promise<void> {
    try {
      await runCycleUnsafe();
    } catch {
      updateStatus({
        state: "degraded",
        lastRunAt: Date.now(),
        lastPresentedAt: status.lastPresentedAt,
        pendingBatchId: status.pendingBatchId,
        pendingItems: status.pendingItems,
        attemptCount: status.attemptCount,
        reasonCode: "digest-store-unavailable",
      });
    }
  }

  async function runSingleFlight(): Promise<void> {
    if (active) return active;
    active = runCycle().finally(() => {
      active = undefined;
    });
    return active;
  }

  function currentBatch(batchId: string): AgentMailCreatorDigestBatch | null {
    const pending = attachedSource.store().getPending(attachedSource.inboxId);
    return pending?.id === batchId ? pending : null;
  }

  attachedSource.attach({
    deliveryTargetSha256: targetSha256,
    status: () => cloneStatus(status),
    runNow: runSingleFlight,
    authorizeRetry: ({ batchId, expectedAttemptCount, evidence }) => {
      if (status.state !== "attempts_exhausted") {
        return { ok: false, message: "Creator digest delivery is not exhausted." };
      }
      const batch = currentBatch(batchId);
      if (!batch || batch.deliveryTargetSha256 !== targetSha256) {
        return { ok: false, message: "Creator digest batch is stale or no longer pending." };
      }
      const authorized = attachedDispatchHost.authorizeInternalRetry({
        source: "agentmail.creator-digest",
        operationKey: operationKey(batch),
        expectedAttemptCount,
        evidence,
      });
      if (authorized.status !== "authorized" || !("authorizedAttempt" in authorized)) {
        return {
          ok: false,
          message: `Creator digest retry was not authorized (${authorized.status}).`,
        };
      }
      updateStatus({
        ...status,
        state: "failed",
        attemptCount: authorized.attemptCount,
        reasonCode: "creator-retry-authorized",
      });
      return {
        ok: true,
        message: `Creator digest attempt ${authorized.authorizedAttempt} is authorized.`,
      };
    },
    dismiss: ({ batchId, evidence }) => {
      if (status.state !== "failed" && status.state !== "attempts_exhausted") {
        return {
          ok: false,
          message: "Only a definitively failed creator digest can be dismissed.",
        };
      }
      const batch = currentBatch(batchId);
      if (!batch || batch.deliveryTargetSha256 !== targetSha256) {
        return { ok: false, message: "Creator digest batch is stale or no longer pending." };
      }
      const settled = attachedSource.store().settle({
        batchId: batch.id,
        expectedBaseGeneration: batch.baseGeneration,
        expectedDeliveryTargetSha256: targetSha256,
        expectedContentSha256: batch.contentSha256,
        disposition: "dismissed",
        evidence,
      });
      if (settled.status === "conflict") {
        return { ok: false, message: "Creator digest batch changed before dismissal." };
      }
      const settledBatch = attachedSource.store().get(batch.id);
      if (!settledBatch || !acknowledgeSettledBatch(settledBatch)) {
        settlementAcknowledgementsRecovered = false;
        updateStatus({
          state: "degraded",
          lastRunAt: status.lastRunAt,
          lastPresentedAt: status.lastPresentedAt,
          reasonCode: "notify-settlement-acknowledgement-failed",
        });
        return {
          ok: false,
          message:
            "Creator digest was durably dismissed, but Notify capacity acknowledgement needs recovery.",
        };
      }
      updateStatus({
        state: "idle",
        lastRunAt: status.lastRunAt,
        lastPresentedAt: status.lastPresentedAt,
        reasonCode: "creator-dismissed",
      });
      return {
        ok: true,
        message: "Creator digest batch dismissed. Email attention and reviews were not changed.",
      };
    },
  });

  return {
    name: agentMailCreatorDigestBridgeName(input.agentMail.name),
    type: "agentMailCreatorDigestBridge",
    category: "transports",
    synthetic: true,
    onBoot: async () => {
      if (started) throw new Error("agentMail creator digest: bridge is already running");
      started = true;
      settlementAcknowledgementsRecovered = false;
      controller = new AbortController();
      await runSingleFlight();
      timer = setInterval(() => void runSingleFlight(), attachedSource.config.intervalMs);
      timer.unref?.();
    },
    onShutdown: async (signal) => {
      started = false;
      if (timer) clearInterval(timer);
      timer = undefined;
      controller?.abort();
      if (active) {
        if (!signal) {
          await active;
        } else {
          await Promise.race([
            active,
            new Promise<void>((resolve) => {
              if (signal.aborted) resolve();
              else signal.addEventListener("abort", () => resolve(), { once: true });
            }),
          ]);
        }
      }
      controller = undefined;
    },
  };
}
