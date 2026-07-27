import type { DistributedCoordinationConfig } from "../types";
import {
  DISTRIBUTED_AUGMENT_REQUIREMENT_CODES,
  DISTRIBUTED_REPLICA_TOPOLOGY_CLASSES,
  type DistributedAugmentRequirementCode,
  type DistributedAugmentPreflightEvidence,
} from "./topology";

const MAX_CAPACITY = 1_000_000;
const MAX_COMPONENTS = 256;
const MAX_SOURCES = 256;
const REQUIREMENT_SET = new Set<string>(DISTRIBUTED_AUGMENT_REQUIREMENT_CODES);
const TOPOLOGY_CLASS_SET = new Set<string>(DISTRIBUTED_REPLICA_TOPOLOGY_CLASSES);
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DISTRIBUTED_COORDINATION_PROTOCOL = Object.freeze({
  name: "auggy-postgres-coordination" as const,
  protocolVersion: 7 as const,
  schemaVersion: 7 as const,
  fingerprintVersion: 2 as const,
});

const PREVIOUS_DISTRIBUTED_COORDINATION_PROTOCOL = Object.freeze({
  name: "auggy-postgres-coordination" as const,
  protocolVersion: 6 as const,
  schemaVersion: 6 as const,
  fingerprintVersion: 2 as const,
});

export interface DistributedCompatibilitySourcePolicy {
  id: string;
  maxConcurrent: number;
  maxQueued: number;
}

export type DistributedAugmentCompatibilityProjection = DistributedAugmentPreflightEvidence;

export interface DistributedCompatibilityInput {
  coordination: DistributedCoordinationConfig;
  sources: readonly DistributedCompatibilitySourcePolicy[];
  augments: readonly DistributedAugmentCompatibilityProjection[];
}

export interface DistributedCoordinationCompatibility {
  protocolVersion: number;
  protocolFingerprint: string;
  configurationFingerprint: string;
  upgradeFrom: {
    protocolVersion: number;
    protocolFingerprint: string;
    configurationFingerprint: string;
  };
}

function fingerprint(domain: string, value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

const PROTOCOL_FINGERPRINT = fingerprint(
  "auggy-distributed-coordination-protocol-v7",
  DISTRIBUTED_COORDINATION_PROTOCOL,
);
const PREVIOUS_PROTOCOL_FINGERPRINT = fingerprint(
  "auggy-distributed-coordination-protocol-v6",
  PREVIOUS_DISTRIBUTED_COORDINATION_PROTOCOL,
);

function integer(value: unknown, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error("invalid");
  }
  return value as number;
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) {
    throw new Error("invalid");
  }
  return value;
}

/**
 * Derive the immutable compatibility tuple from a reviewed semantic projection.
 * Raw YAML, environment names/values, local polling, and augment options never
 * enter either digest. This low-level constructor is internal to coordination;
 * startup code must obtain augment projections from source-owned verifiers.
 */
export function buildDistributedCoordinationCompatibility(
  input: DistributedCompatibilityInput,
): DistributedCoordinationCompatibility {
  try {
    const coordination = input.coordination;
    if (coordination.mode !== "postgres" || !CANONICAL_UUID_RE.test(coordination.namespace)) {
      throw new Error("invalid");
    }
    const maxQueued = integer(coordination.fleetCapacity.maxQueued, 0, MAX_CAPACITY);
    const fleetCapacity = {
      maxConcurrent: integer(coordination.fleetCapacity.maxConcurrent, 1, MAX_CAPACITY),
      maxQueued,
      maxQueuedPerThread: integer(coordination.fleetCapacity.maxQueuedPerThread, 0, maxQueued),
    };
    const retention = {
      terminalRequestRetentionMs: integer(
        coordination.retention.terminalRequestRetentionMs,
        60_000,
        31_536_000_000,
      ),
      maxTerminalRequests: integer(coordination.retention.maxTerminalRequests, 1, MAX_CAPACITY),
      eventRetentionMs: integer(coordination.retention.eventRetentionMs, 60_000, 31_536_000_000),
      maxEvents: integer(coordination.retention.maxEvents, 1, MAX_CAPACITY),
    };
    const result = {
      maxReplayBytes: integer(coordination.result.maxReplayBytes, 1_024, 1_048_576),
    };
    const turnState = {
      history: {
        maxSnapshotBytes: integer(
          coordination.turnState.history.maxSnapshotBytes,
          1_024,
          1_048_576,
        ),
        maxMessages: integer(coordination.turnState.history.maxMessages, 1, 10_000),
        maxThreads: integer(coordination.turnState.history.maxThreads, 1, MAX_CAPACITY),
      },
      maxCostMarkersPerTurn: integer(coordination.turnState.maxCostMarkersPerTurn, 1, 1_000),
      outbox: {
        maxIntentsPerTurn: integer(coordination.turnState.outbox.maxIntentsPerTurn, 0, 1_000),
        maxIntentBytes: integer(coordination.turnState.outbox.maxIntentBytes, 1_024, 1_048_576),
        maxPendingIntents: integer(
          coordination.turnState.outbox.maxPendingIntents,
          0,
          MAX_CAPACITY,
        ),
      },
    };
    const admission = {
      maxRateLimitEvents: integer(coordination.admission?.maxRateLimitEvents ?? 0, 0, MAX_CAPACITY),
      capacityClasses: [...(coordination.admission?.capacityClasses ?? [])]
        .map((policy) => ({
          id: identifier(policy.id),
          maxRetainedRequests: integer(policy.maxRetainedRequests, 1, MAX_CAPACITY),
          maxRetainedRequestsPerPartition: integer(
            policy.maxRetainedRequestsPerPartition,
            1,
            MAX_CAPACITY,
          ),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
      rateLimits: [...(coordination.admission?.rateLimits ?? [])]
        .map((policy) => ({
          id: identifier(policy.id),
          max: integer(policy.max, 1, MAX_CAPACITY),
          maxEvents: integer(policy.maxEvents, 1, MAX_CAPACITY),
          windowMs: integer(policy.windowMs, 1_000, 86_400_000),
        }))
        .sort((left, right) => left.id.localeCompare(right.id)),
    };
    if (
      admission.capacityClasses.length > 64 ||
      new Set(admission.capacityClasses.map((policy) => policy.id)).size !==
        admission.capacityClasses.length ||
      admission.capacityClasses.some(
        (policy) => policy.maxRetainedRequestsPerPartition > policy.maxRetainedRequests,
      ) ||
      admission.capacityClasses.reduce((sum, policy) => sum + policy.maxRetainedRequests, 0) >
        retention.maxTerminalRequests ||
      admission.rateLimits.length > 64 ||
      new Set(admission.rateLimits.map((policy) => policy.id)).size !==
        admission.rateLimits.length ||
      admission.rateLimits.reduce((sum, policy) => sum + policy.maxEvents, 0) >
        admission.maxRateLimitEvents
    ) {
      throw new Error("invalid");
    }
    const leaseDurationMs = integer(coordination.leaseDurationMs, 1_000, 300_000);

    if (!Array.isArray(input.sources) || input.sources.length > MAX_SOURCES) {
      throw new Error("invalid");
    }
    const sources = input.sources
      .map((source) => ({
        id: identifier(source.id),
        maxConcurrent: integer(source.maxConcurrent, 1, MAX_CAPACITY),
        maxQueued: integer(source.maxQueued, 0, MAX_CAPACITY),
      }))
      .sort((left, right) => (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
    if (sources.some((source, index) => source.id === sources[index - 1]?.id)) {
      throw new Error("invalid");
    }

    if (!Array.isArray(input.augments) || input.augments.length > MAX_COMPONENTS) {
      throw new Error("invalid");
    }
    const augments = input.augments.map((augment, augmentIndex) => {
      if (
        augment.augmentIndex !== augmentIndex ||
        typeof augment.componentType !== "string" ||
        typeof augment.semanticFingerprint !== "string" ||
        !/^[0-9a-f]{64}$/.test(augment.semanticFingerprint) ||
        !TOPOLOGY_CLASS_SET.has(augment.topologyClass) ||
        !Array.isArray(augment.requirements) ||
        augment.requirements.length > 32
      ) {
        throw new Error("invalid");
      }
      const requirements = augment.requirements.map((requirement: unknown) => {
        if (typeof requirement !== "string" || !REQUIREMENT_SET.has(requirement)) {
          throw new Error("invalid");
        }
        return requirement as DistributedAugmentRequirementCode;
      });
      if (new Set(requirements).size !== requirements.length) throw new Error("invalid");
      return {
        augmentIndex,
        componentType: identifier(augment.componentType),
        topologyClass: augment.topologyClass,
        compatibilityVersion: integer(augment.compatibilityVersion, 1, MAX_CAPACITY),
        semanticFingerprint: augment.semanticFingerprint,
        requirements,
      };
    });

    const semanticConfiguration = {
      namespace: coordination.namespace,
      fleetCapacity,
      leaseDurationMs,
      retention,
      result,
      turnState,
      admission,
      sources,
      augments,
    };
    const configurationFingerprint = fingerprint(
      "auggy-distributed-coordination-configuration-v7",
      {
        protocolFingerprint: PROTOCOL_FINGERPRINT,
        ...semanticConfiguration,
      },
    );
    const previousConfigurationFingerprint = fingerprint(
      "auggy-distributed-coordination-configuration-v6",
      {
        protocolFingerprint: PREVIOUS_PROTOCOL_FINGERPRINT,
        ...semanticConfiguration,
      },
    );
    return Object.freeze({
      protocolVersion: DISTRIBUTED_COORDINATION_PROTOCOL.protocolVersion,
      protocolFingerprint: PROTOCOL_FINGERPRINT,
      configurationFingerprint,
      upgradeFrom: Object.freeze({
        protocolVersion: PREVIOUS_DISTRIBUTED_COORDINATION_PROTOCOL.protocolVersion,
        protocolFingerprint: PREVIOUS_PROTOCOL_FINGERPRINT,
        configurationFingerprint: previousConfigurationFingerprint,
      }),
    });
  } catch {
    throw new Error("invalid distributed compatibility input");
  }
}
