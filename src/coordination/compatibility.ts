import type { DistributedCoordinationConfig } from "../types";
import {
  DISTRIBUTED_AUGMENT_REQUIREMENT_CODES,
  DISTRIBUTED_REPLICA_TOPOLOGY_CLASSES,
  type DistributedAugmentRequirementCode,
  type DistributedReplicaTopologyClass,
} from "./topology";

const MAX_CAPACITY = 1_000_000;
const MAX_COMPONENTS = 256;
const MAX_SOURCES = 256;
const REQUIREMENT_SET = new Set<string>(DISTRIBUTED_AUGMENT_REQUIREMENT_CODES);
const TOPOLOGY_CLASS_SET = new Set<string>(DISTRIBUTED_REPLICA_TOPOLOGY_CLASSES);
const CANONICAL_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export const DISTRIBUTED_COORDINATION_PROTOCOL = Object.freeze({
  name: "auggy-postgres-coordination" as const,
  protocolVersion: 1 as const,
  schemaVersion: 2 as const,
  fingerprintVersion: 1 as const,
});

export interface DistributedCompatibilitySourcePolicy {
  id: string;
  maxConcurrent: number;
  maxQueued: number;
}

export interface DistributedAugmentCompatibilityProjection {
  augmentIndex: number;
  topologyClass: DistributedReplicaTopologyClass;
  compatibilityVersion: number;
  requirements: readonly DistributedAugmentRequirementCode[];
}

export interface DistributedCompatibilityInput {
  coordination: DistributedCoordinationConfig;
  sources: readonly DistributedCompatibilitySourcePolicy[];
  augments: readonly DistributedAugmentCompatibilityProjection[];
}

export interface DistributedCoordinationCompatibility {
  protocolVersion: number;
  protocolFingerprint: string;
  configurationFingerprint: string;
}

function fingerprint(domain: string, value: unknown): string {
  return new Bun.CryptoHasher("sha256")
    .update(domain, "utf8")
    .update("\0", "utf8")
    .update(JSON.stringify(value), "utf8")
    .digest("hex");
}

const PROTOCOL_FINGERPRINT = fingerprint(
  "auggy-distributed-coordination-protocol-v1",
  DISTRIBUTED_COORDINATION_PROTOCOL,
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
 * enter either digest.
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
        topologyClass: augment.topologyClass,
        compatibilityVersion: integer(augment.compatibilityVersion, 1, MAX_CAPACITY),
        requirements,
      };
    });

    const configurationFingerprint = fingerprint(
      "auggy-distributed-coordination-configuration-v1",
      {
        protocolFingerprint: PROTOCOL_FINGERPRINT,
        namespace: coordination.namespace,
        fleetCapacity,
        leaseDurationMs,
        retention,
        result,
        sources,
        augments,
      },
    );
    return Object.freeze({
      protocolVersion: DISTRIBUTED_COORDINATION_PROTOCOL.protocolVersion,
      protocolFingerprint: PROTOCOL_FINGERPRINT,
      configurationFingerprint,
    });
  } catch {
    throw new Error("invalid distributed compatibility input");
  }
}
