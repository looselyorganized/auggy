import type {
  DistributedAugmentPreflightEvidence,
  DistributedAugmentRequirementCode,
  DistributedReplicaTopologyClass,
} from "../coordination/topology";
import { DISTRIBUTED_AUGMENT_REQUIREMENT_CODES } from "../coordination/topology";
import type { AugmentConfig, BuiltinAugmentType } from "./types";

/**
 * Trusted source-owned topology definitions for configured built-ins. A
 * topology class is descriptive, not proof of readiness: every verifier must
 * independently return its remaining blockers. Operator YAML cannot override
 * either field.
 */
export interface BuiltinReplicaTopologyDefinition {
  readonly componentType: BuiltinAugmentType;
  readonly topologyClass: DistributedReplicaTopologyClass;
  readonly compatibilityVersion: number;
  /** Must return only a bounded, secret-free identity for replica semantics. */
  readonly compatibilityIdentity: (augment: Readonly<AugmentConfig>) => string;
  readonly verify: (
    augment: Readonly<AugmentConfig>,
  ) => readonly DistributedAugmentRequirementCode[];
}

const MAX_CONFIGURED_AUGMENTS = 256;
const MAX_REQUIREMENTS_PER_AUGMENT = 32;
const REQUIREMENT_CODES = new Set<string>(DISTRIBUTED_AUGMENT_REQUIREMENT_CODES);

function blocked(
  componentType: BuiltinAugmentType,
  topologyClass: DistributedReplicaTopologyClass,
  requirement: DistributedAugmentRequirementCode,
): BuiltinReplicaTopologyDefinition {
  const requirements = Object.freeze([requirement]);
  return Object.freeze({
    componentType,
    topologyClass,
    compatibilityVersion: 1,
    compatibilityIdentity: () => `builtin:${componentType}:blocked:v1`,
    verify: () => requirements,
  });
}

export const BUILTIN_REPLICA_TOPOLOGY = Object.freeze({
  fileMemory: blocked("fileMemory", "unsupported", "local-mutable-state"),
  supabaseMemory: blocked("supabaseMemory", "shared", "shared-store-unverified"),
  layeredMemory: blocked("layeredMemory", "shared", "shared-store-unverified"),
  filesystem: blocked("filesystem", "unsupported", "local-filesystem-unverified"),
  webTransport: blocked("webTransport", "shared", "shared-web-state-missing"),
  webFetch: blocked("webFetch", "stateless", "stateless-verifier-missing"),
  knowledge: blocked("knowledge", "stateless", "immutable-assets-unverified"),
  skills: blocked("skills", "stateless", "immutable-assets-unverified"),
  bash: blocked("bash", "unsupported", "local-effects-unverified"),
  budgets: blocked("budgets", "fence-aware", "shared-budget-store-missing"),
  notify: blocked("notify", "fence-aware", "shared-delivery-store-missing"),
  mcp: blocked("mcp", "unsupported", "mcp-topology-unverified"),
  agentMail: blocked("agentMail", "leader-owned", "shared-inbound-store-missing"),
  telegramTransport: blocked("telegramTransport", "leader-owned", "shared-replay-store-missing"),
  turnControl: blocked("turnControl", "stateless", "stateless-verifier-missing"),
  visitorAuth: blocked("visitorAuth", "shared", "shared-session-store-missing"),
  link: blocked("link", "shared", "shared-link-store-missing"),
} as const satisfies Record<BuiltinAugmentType, BuiltinReplicaTopologyDefinition>);

function hasBuiltInRequirement(type: string): type is keyof typeof BUILTIN_REPLICA_TOPOLOGY {
  return Object.hasOwn(BUILTIN_REPLICA_TOPOLOGY, type);
}

function unsupportedEvidence(
  augmentIndex: number,
  componentType: "custom" | "runtime" | "unknown",
  requirement: DistributedAugmentRequirementCode,
): DistributedAugmentPreflightEvidence {
  return Object.freeze({
    augmentIndex,
    componentType,
    topologyClass: "unsupported",
    compatibilityVersion: 1,
    semanticFingerprint: fingerprintSemanticIdentity(
      componentType,
      `unsupported:${componentType}:${requirement}:v1`,
    ),
    requirements: Object.freeze([requirement]),
  });
}

function fingerprintSemanticIdentity(componentType: string, identity: string): string {
  return new Bun.CryptoHasher("sha256")
    .update("auggy-replica-semantic-identity-v1", "utf8")
    .update("\0", "utf8")
    .update(componentType, "utf8")
    .update("\0", "utf8")
    .update(identity, "utf8")
    .digest("hex");
}

function verifyBuiltIn(
  augment: Readonly<AugmentConfig>,
  augmentIndex: number,
  definition: BuiltinReplicaTopologyDefinition,
): DistributedAugmentPreflightEvidence {
  try {
    const compatibilityIdentity = definition.compatibilityIdentity(augment);
    const requirements = definition.verify(augment);
    const identityHasControlCharacter =
      typeof compatibilityIdentity === "string" &&
      [...compatibilityIdentity].some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 31 || codePoint === 127;
      });
    if (
      typeof compatibilityIdentity !== "string" ||
      compatibilityIdentity.length < 1 ||
      compatibilityIdentity.length > 512 ||
      identityHasControlCharacter ||
      !Array.isArray(requirements) ||
      requirements.length > MAX_REQUIREMENTS_PER_AUGMENT ||
      requirements.some(
        (requirement) => typeof requirement !== "string" || !REQUIREMENT_CODES.has(requirement),
      ) ||
      new Set(requirements).size !== requirements.length
    ) {
      return unsupportedEvidence(augmentIndex, "runtime", "runtime-augment-unverified");
    }
    return Object.freeze({
      augmentIndex,
      componentType: definition.componentType,
      topologyClass: definition.topologyClass,
      compatibilityVersion: definition.compatibilityVersion,
      semanticFingerprint: fingerprintSemanticIdentity(
        definition.componentType,
        compatibilityIdentity,
      ),
      requirements: Object.freeze([...requirements]),
    });
  } catch {
    return unsupportedEvidence(augmentIndex, "runtime", "runtime-augment-unverified");
  }
}

/** Return deterministic, secret-free evidence in configured augment order. */
export function configuredAugmentReplicaEvidence(
  augments: readonly AugmentConfig[],
): readonly DistributedAugmentPreflightEvidence[] {
  let length: number;
  try {
    if (!Array.isArray(augments)) throw new Error("invalid");
    length = augments.length;
  } catch {
    throw new Error("configured augment topology cannot be verified");
  }
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_CONFIGURED_AUGMENTS) {
    throw new Error("configured augment topology exceeds supported bounds");
  }
  const evidence: DistributedAugmentPreflightEvidence[] = [];
  for (let augmentIndex = 0; augmentIndex < length; augmentIndex++) {
    try {
      const augment = augments[augmentIndex];
      const typeValue = augment?.type;
      const type = typeof typeValue === "string" ? typeValue : "";
      if (type === "custom") {
        evidence.push(unsupportedEvidence(augmentIndex, "custom", "custom-augment-unverified"));
        continue;
      }
      if (!hasBuiltInRequirement(type)) {
        evidence.push(unsupportedEvidence(augmentIndex, "unknown", "unknown-augment-type"));
        continue;
      }
      evidence.push(verifyBuiltIn(augment, augmentIndex, BUILTIN_REPLICA_TOPOLOGY[type]));
    } catch {
      evidence.push(unsupportedEvidence(augmentIndex, "runtime", "runtime-augment-unverified"));
    }
  }
  return Object.freeze(evidence);
}
