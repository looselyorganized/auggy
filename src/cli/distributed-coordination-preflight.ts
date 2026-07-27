import type {
  DistributedAugmentPreflightEvidence,
  DistributedAugmentRequirementCode,
} from "../coordination/topology";
import type { AugmentConfig, BuiltinAugmentType } from "./types";

/**
 * Trusted source-owned requirements for configured built-ins. These are
 * blockers, not assertions of readiness. Operator YAML cannot override them.
 */
export const BUILTIN_DISTRIBUTED_REQUIREMENTS = {
  fileMemory: "local-mutable-state",
  supabaseMemory: "shared-store-unverified",
  layeredMemory: "shared-store-unverified",
  filesystem: "local-filesystem-unverified",
  webTransport: "shared-web-state-missing",
  webFetch: "stateless-verifier-missing",
  knowledge: "immutable-assets-unverified",
  skills: "immutable-assets-unverified",
  bash: "local-effects-unverified",
  budgets: "shared-budget-store-missing",
  notify: "shared-delivery-store-missing",
  mcp: "mcp-topology-unverified",
  agentMail: "shared-inbound-store-missing",
  telegramTransport: "shared-replay-store-missing",
  turnControl: "stateless-verifier-missing",
  visitorAuth: "shared-session-store-missing",
  link: "shared-link-store-missing",
} as const satisfies Record<BuiltinAugmentType, DistributedAugmentRequirementCode>;

function hasBuiltInRequirement(
  type: string,
): type is keyof typeof BUILTIN_DISTRIBUTED_REQUIREMENTS {
  return Object.hasOwn(BUILTIN_DISTRIBUTED_REQUIREMENTS, type);
}

/** Return deterministic, secret-free evidence in configured augment order. */
export function configuredAugmentReplicaEvidence(
  augments: readonly AugmentConfig[],
): DistributedAugmentPreflightEvidence[] {
  return augments.map((augment, augmentIndex) => {
    const type = String(augment.type);
    const requirement: DistributedAugmentRequirementCode =
      type === "custom"
        ? "custom-augment-unverified"
        : hasBuiltInRequirement(type)
          ? BUILTIN_DISTRIBUTED_REQUIREMENTS[type]
          : "unknown-augment-type";
    return { augmentIndex, requirement };
  });
}
