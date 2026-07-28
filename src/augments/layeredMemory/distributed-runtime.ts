/**
 * Private runtime plumbing for coordinator-backed layered memory.
 *
 * This intentionally is not part of the Augment contract. A public boolean
 * or structural property would let an arbitrary augment opt into shared
 * authority. The agent binds only factory-registered layered-memory instances
 * after it has verified the exact immutable coordinator policy.
 */
import type {
  DistributedMemoryMutationV1,
  DistributedPeerBindingV1,
  DistributedTurnCoordinator,
  DistributedTurnLease,
} from "../../coordination/types";
import type {
  Augment,
  DistributedMemoryPolicyV1,
  ExecutionAuthorityV1,
  ExecutionTraceContextV1,
  MemoryProviderSpec,
  PeerIdentity,
} from "../../types";
import { normalizeDistributedMemoryPolicy } from "../../coordination/memory-policy";

export interface DistributedLayeredMemoryExecution {
  lease: DistributedTurnLease;
  peer?: PeerIdentity;
  peerBinding: DistributedPeerBindingV1;
  stageMemoryMutation(mutation: DistributedMemoryMutationV1): Promise<"staged" | "replayed">;
}

export interface DistributedLayeredMemoryBinding {
  coordinator: DistributedTurnCoordinator;
  policy: DistributedMemoryPolicyV1;
  resolveExecution(
    executionContext: ExecutionTraceContextV1 | undefined,
    executionAuthority: ExecutionAuthorityV1 | undefined,
  ): DistributedLayeredMemoryExecution | null;
}

const declaredPolicies = new WeakMap<Augment, DistributedMemoryPolicyV1>();
const declaredMemoryPolicies = new WeakMap<MemoryProviderSpec, DistributedMemoryPolicyV1>();
const bindings = new WeakMap<Augment, DistributedLayeredMemoryBinding>();
const memoryBindings = new WeakMap<MemoryProviderSpec, DistributedLayeredMemoryBinding>();

export function declareDistributedLayeredMemoryPolicy(
  augment: Augment,
  policy: DistributedMemoryPolicyV1,
): void {
  if (declaredPolicies.has(augment)) {
    throw new Error("layeredMemory distributed policy was declared twice");
  }
  if (!augment.memory) throw new Error("layeredMemory distributed policy requires memory");
  const normalized = normalizeDistributedMemoryPolicy(policy);
  declaredPolicies.set(augment, normalized);
  declaredMemoryPolicies.set(augment.memory, normalized);
}

export function declaredDistributedLayeredMemoryPolicy(
  augment: Augment,
): DistributedMemoryPolicyV1 | undefined {
  return (
    declaredPolicies.get(augment) ?? (augment.memory && declaredMemoryPolicies.get(augment.memory))
  );
}

export function bindDistributedLayeredMemory(
  augment: Augment,
  binding: DistributedLayeredMemoryBinding,
): () => void {
  if (!declaredPolicies.has(augment)) {
    if (!augment.memory || !declaredMemoryPolicies.has(augment.memory)) {
      throw new Error(
        "only factory-registered layeredMemory augments may bind distributed authority",
      );
    }
  }
  if (bindings.has(augment)) throw new Error("layeredMemory distributed authority was bound twice");
  bindings.set(augment, binding);
  if (augment.memory) memoryBindings.set(augment.memory, binding);
  return () => {
    if (bindings.get(augment) === binding) bindings.delete(augment);
    if (augment.memory && memoryBindings.get(augment.memory) === binding) {
      memoryBindings.delete(augment.memory);
    }
  };
}

export function distributedLayeredMemoryBinding(
  augment: Augment,
): DistributedLayeredMemoryBinding | undefined {
  return bindings.get(augment) ?? (augment.memory && memoryBindings.get(augment.memory));
}
