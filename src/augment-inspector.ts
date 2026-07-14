import type { Augment } from "./types";

export const AUGMENT_LIFECYCLE_HOOKS = [
  "onBoot",
  "onShutdown",
  "onTurnStart",
  "onTurnEnd",
  "onIdle",
  "scheduleAfterTurn",
] as const;

export type AugmentLifecycleHook = (typeof AUGMENT_LIFECYCLE_HOOKS)[number];

export interface AugmentRuntimeShape {
  hasContext: boolean;
  toolCount: number;
  usesSharedMemoryTools: boolean;
  isTransport: boolean;
  isMemoryProvider: boolean;
  httpRouteCount: number;
  hasAdminInfo: boolean;
  lifecycleHooks: AugmentLifecycleHook[];
  handlesInternalTurns: boolean;
  hasTurnGate: boolean;
}

/** Inspect the augment's current runtime shape without caching boot-populated fields. */
export function inspectAugment(augment: Augment): AugmentRuntimeShape {
  return {
    // Memory providers receive synthesized context from the memory bus.
    hasContext: augment.context !== undefined || augment.memory !== undefined,
    toolCount: augment.tools?.length ?? 0,
    // Memory tools live on a hidden synthetic augment rather than each provider.
    usesSharedMemoryTools: augment.memory !== undefined,
    isTransport: augment.transport !== undefined,
    isMemoryProvider: augment.memory !== undefined,
    httpRouteCount: augment.httpRoutes?.length ?? 0,
    hasAdminInfo: augment.adminInfo !== undefined,
    lifecycleHooks: AUGMENT_LIFECYCLE_HOOKS.filter((hook) => augment[hook] !== undefined),
    handlesInternalTurns: augment.handleInternalTurn !== undefined,
    hasTurnGate: augment.turnGate !== undefined,
  };
}
