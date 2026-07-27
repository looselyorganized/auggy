import type { DistributedBudgetPolicyV1, TurnGateProvider } from "../types";

const coordinatorBudgetPolicies = new WeakMap<TurnGateProvider, DistributedBudgetPolicyV1>();

/** Internal first-party registration; this module is not part of the package export map. */
export function registerCoordinatorBudgetTurnGate(
  gate: TurnGateProvider,
  policy: DistributedBudgetPolicyV1,
): void {
  if (coordinatorBudgetPolicies.has(gate)) {
    throw new Error("coordinator budget turn gate is already registered");
  }
  coordinatorBudgetPolicies.set(gate, structuredClone(policy));
}

export function coordinatorBudgetPolicyForTurnGate(
  gate: TurnGateProvider,
): DistributedBudgetPolicyV1 | undefined {
  const policy = coordinatorBudgetPolicies.get(gate);
  return policy ? structuredClone(policy) : undefined;
}
