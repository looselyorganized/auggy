import type {
  DistributedCoordinationResultConfig,
  DistributedCoordinationTurnStateConfig,
} from "../types";
import type {
  DistributedCostMarkerV1,
  DistributedHistorySnapshotV1,
  DistributedOutboxIntentV1,
  DistributedPeerBindingV1,
  DistributedReplayResult,
  DistributedTurnCheckpointV1,
  LeaseResult,
} from "./types";
import { parseThreadHistoryMessages } from "../kernel/history-manager";
import { decodeDistributedReplay } from "./agent-turn-state";
import { isCanonicalDistributedBudgetCostUsd } from "./budget-policy";

export const EMPTY_DISTRIBUTED_HISTORY = new TextEncoder().encode(
  JSON.stringify({ version: 1, messages: [] }),
);

export function validDistributedDigest(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

export function validDistributedOperationId(value: unknown): value is string {
  return typeof value === "string" && /^auggy-op-v1-[0-9a-f]{64}$/.test(value);
}

export function validDistributedPeerBinding(value: unknown): value is DistributedPeerBindingV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const binding = value as Partial<DistributedPeerBindingV1>;
  if (
    binding.version !== 1 ||
    !validDistributedDigest(binding.bindingHash) ||
    (binding.peerIdHash !== null && !validDistributedDigest(binding.peerIdHash)) ||
    !validDistributedDigest(binding.promotionScopeHash) ||
    (binding.trustLevel !== "creator" &&
      binding.trustLevel !== "agent" &&
      binding.trustLevel !== "public") ||
    (binding.priorPeerIdHash !== undefined && !validDistributedDigest(binding.priorPeerIdHash))
  ) {
    return false;
  }
  if (binding.trustLevel === "public") {
    return (
      (binding.publicSubstate === "anonymous" || binding.publicSubstate === "recognized") &&
      binding.peerIdHash !== null &&
      !(binding.publicSubstate === "anonymous" && binding.priorPeerIdHash !== undefined)
    );
  }
  return binding.publicSubstate === undefined && binding.priorPeerIdHash === undefined;
}

export function sameDistributedPeerBinding(
  left: DistributedPeerBindingV1,
  right: DistributedPeerBindingV1,
): boolean {
  return left.bindingHash === right.bindingHash;
}

export function allowsDistributedPeerPromotion(
  stored: DistributedPeerBindingV1,
  incoming: DistributedPeerBindingV1,
): boolean {
  return (
    stored.trustLevel === "public" &&
    stored.publicSubstate === "anonymous" &&
    incoming.trustLevel === "public" &&
    incoming.publicSubstate === "recognized" &&
    stored.peerIdHash !== null &&
    incoming.peerIdHash !== null &&
    incoming.priorPeerIdHash === stored.peerIdHash &&
    incoming.promotionScopeHash === stored.promotionScopeHash
  );
}

export function copyDistributedPeerBinding(
  binding: DistributedPeerBindingV1,
): DistributedPeerBindingV1 {
  return { ...binding };
}

export function validDistributedReplay(
  result: unknown,
  expectedThreadId?: string,
): result is DistributedReplayResult {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return false;
  const replay = result as Partial<DistributedReplayResult>;
  if (replay.contentType !== "application/json" || !(replay.body instanceof Uint8Array)) {
    return false;
  }
  try {
    decodeDistributedReplay(replay as DistributedReplayResult, expectedThreadId);
    return true;
  } catch {
    return false;
  }
}

export function validDistributedHistory(
  value: unknown,
  limits: DistributedCoordinationTurnStateConfig["history"],
): value is DistributedHistorySnapshotV1 {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const history = value as Partial<DistributedHistorySnapshotV1>;
  if (
    history.version !== 1 ||
    !(history.body instanceof Uint8Array) ||
    !Number.isSafeInteger(history.messageCount) ||
    (history.messageCount as number) < 0 ||
    (history.messageCount as number) > limits.maxMessages ||
    history.body.byteLength > limits.maxSnapshotBytes
  ) {
    return false;
  }
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(history.body));
    return (
      parseThreadHistoryMessages(parsed, { allowLegacyArray: false }).length ===
      history.messageCount
    );
  } catch {
    return false;
  }
}

function validCostMarkers(
  value: unknown,
  maximum: number,
): value is readonly DistributedCostMarkerV1[] {
  if (!Array.isArray(value) || value.length > maximum) return false;
  const operations = new Set<string>();
  return value.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const marker = entry as Partial<DistributedCostMarkerV1>;
    if (
      marker.version !== 1 ||
      !validDistributedOperationId(marker.operationId) ||
      operations.has(marker.operationId)
    ) {
      return false;
    }
    operations.add(marker.operationId);
    return marker.priced === true
      ? typeof marker.costUsd === "number" && isCanonicalDistributedBudgetCostUsd(marker.costUsd)
      : marker.priced === false &&
          (marker.reason === "missing-usage" || marker.reason === "missing-pricing");
  });
}

function validOutboxIntents(
  value: unknown,
  limits: DistributedCoordinationTurnStateConfig["outbox"],
): value is readonly DistributedOutboxIntentV1[] {
  if (!Array.isArray(value) || value.length > limits.maxIntentsPerTurn) return false;
  const operations = new Set<string>();
  const ordinals = new Set<number>();
  return value.every((entry: unknown) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return false;
    const intent = entry as Partial<DistributedOutboxIntentV1>;
    if (
      intent.version !== 1 ||
      intent.contentType !== "application/json" ||
      !(intent.body instanceof Uint8Array) ||
      intent.body.byteLength > limits.maxIntentBytes ||
      !Number.isSafeInteger(intent.ordinal) ||
      (intent.ordinal as number) < 0 ||
      (intent.ordinal as number) >= value.length ||
      !validDistributedOperationId(intent.operationId) ||
      operations.has(intent.operationId) ||
      ordinals.has(intent.ordinal as number)
    ) {
      return false;
    }
    operations.add(intent.operationId);
    ordinals.add(intent.ordinal as number);
    try {
      JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(intent.body));
      return true;
    } catch {
      return false;
    }
  });
}

export function validateDistributedTurnCheckpoint(
  value: unknown,
  turnState: DistributedCoordinationTurnStateConfig,
  result: DistributedCoordinationResultConfig,
  expectedThreadId?: string,
): Extract<LeaseResult, { status: "rejected" }> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { status: "rejected", reason: "invalid-turn-state" };
  }
  const checkpoint = value as Partial<DistributedTurnCheckpointV1>;
  if (
    !validDistributedPeerBinding(checkpoint.peerBinding) ||
    !Number.isSafeInteger(checkpoint.expectedHistoryRevision) ||
    (checkpoint.expectedHistoryRevision as number) < 0
  ) {
    return { status: "rejected", reason: "invalid-turn-state" };
  }
  if (
    typeof checkpoint.history === "object" &&
    checkpoint.history !== null &&
    !Array.isArray(checkpoint.history) &&
    checkpoint.history.body instanceof Uint8Array &&
    checkpoint.history.body.byteLength > turnState.history.maxSnapshotBytes
  ) {
    return { status: "rejected", reason: "history-too-large" };
  }
  if (!validDistributedHistory(checkpoint.history, turnState.history)) {
    return { status: "rejected", reason: "invalid-history" };
  }
  if (!validDistributedReplay(checkpoint.replay, expectedThreadId)) {
    return { status: "rejected", reason: "invalid-result" };
  }
  if (checkpoint.replay.body.byteLength > result.maxReplayBytes) {
    return { status: "rejected", reason: "result-too-large" };
  }
  if (
    !validCostMarkers(checkpoint.costMarkers, turnState.maxCostMarkersPerTurn) ||
    !validOutboxIntents(checkpoint.outboxIntents, turnState.outbox)
  ) {
    return { status: "rejected", reason: "invalid-turn-state" };
  }
  return null;
}
