import type { AgentConfig, TurnResult } from "../types";
import type {
  DistributedReplayResult,
  DistributedRootTurnRuntime,
  DistributedTurnLease,
  LeaseResult,
} from "./index";

/**
 * Test-only checkpoint adapter. This module is intentionally absent from the
 * package export map while the public distributed profile remains disabled.
 */
export interface DistributedAgentRuntimeTestAdapter {
  runtime: DistributedRootTurnRuntime;
  commit(lease: DistributedTurnLease, result: TurnResult): Promise<LeaseResult>;
  replay(result: DistributedReplayResult): TurnResult;
  /** Bounded cooperative cleanup before non-responsive work is detached. */
  authorityLossGraceMs?: number;
  /** Maximum graceful wait before shutdown revokes distributed authority. */
  drainTimeoutMs?: number;
}

const pendingAdapters = new WeakMap<AgentConfig, DistributedAgentRuntimeTestAdapter>();

/** @internal Direct-source test seam; never add this module to package exports. */
export function attachDistributedRuntimeForTest(
  config: AgentConfig,
  adapter: DistributedAgentRuntimeTestAdapter,
): void {
  if (pendingAdapters.has(config)) {
    throw new Error("distributed test runtime is already attached to this configuration");
  }
  pendingAdapters.set(config, adapter);
}

export function consumeDistributedRuntimeForTest(
  config: AgentConfig,
): DistributedAgentRuntimeTestAdapter | undefined {
  const adapter = pendingAdapters.get(config);
  pendingAdapters.delete(config);
  return adapter;
}
