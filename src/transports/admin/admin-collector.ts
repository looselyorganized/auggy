import type {
  AdminInfoBlock,
  AugmentCategory,
  AuthorizationRequirement,
  ToolCategory,
  TransportKernel,
  TrustLevel,
} from "../../types";
import { inspectAugment, type AugmentLifecycleHook } from "../../augment-inspector";

/**
 * Minimal augment shape rendered in the console's augment summary payload.
 * Independent of `AdminInfoBlock` — every mounted augment shows up here, even
 * ones that don't ship operator-facing settings. The SPA cross-references
 * `name` against `blocks[].augmentName` to decide whether to render an
 * expandable settings panel beneath the row.
 */
export interface AugmentSummary {
  /** Canonical type from the create-flow catalog (e.g. `layeredMemory`). */
  type: string;
  /** Runtime instance name (e.g. `layered-memory-test_agent`). Often equals type. */
  name: string;
  version?: string;
  required: boolean;
  /**
   * Operator-facing category. Falls back to `"capabilities"` when the augment
   * has not declared one — keeps third-party / older augments visible in the
   * console summary instead of dropping them into an "uncategorized" bin.
   */
  category: AugmentCategory;
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
  /** Safe, operator-facing memory ownership and context policy metadata. */
  memory?: {
    ownership: { kind: "static"; labels: string[] } | { kind: "namespace"; prefix: string };
    mutable: boolean;
    origin: string;
    priority: string;
    placement: string;
    eviction: string;
    ttl: string;
    writeTrustLevels?: string[];
  };
}

/**
 * Best-guess category for augments that haven't been migrated to declare
 * `category` yet. Inferred from the augment's structural shape so the SPA
 * always has a useful bucket. New augments should set `category` explicitly.
 */
function inferCategory(aug: { transport?: unknown; memory?: unknown }): AugmentCategory {
  if (aug.transport) return "transports";
  if (aug.memory) return "memory";
  return "capabilities";
}

export function collectAugmentSummaries(kernel: TransportKernel): AugmentSummary[] {
  return (
    kernel
      .getAugments()
      // Hide kernel-injected plumbing the operator didn't mount.
      .filter((aug) => !aug.synthetic)
      .map((aug) => ({
        type: aug.type ?? aug.name,
        name: aug.name,
        version: aug.version,
        required: aug.required ?? false,
        category: aug.category ?? inferCategory(aug),
        ...inspectAugment(aug),
        ...(aug.memory
          ? {
              memory: {
                ownership:
                  aug.memory.owns.kind === "static"
                    ? { kind: "static" as const, labels: [...aug.memory.owns.labels] }
                    : { kind: "namespace" as const, prefix: aug.memory.owns.prefix },
                mutable: aug.memory.defaults.mutable,
                origin: aug.memory.defaults.origin,
                priority: aug.memory.defaults.priority,
                placement: aug.memory.defaults.placement,
                eviction: aug.memory.defaults.eviction,
                ttl: aug.memory.defaults.ttl ?? "persistent",
                ...(aug.memory.writeTrustLevels
                  ? { writeTrustLevels: [...aug.memory.writeTrustLevels] }
                  : {}),
              },
            }
          : {}),
      }))
  );
}

export interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  augmentName: string;
  augmentType: string;
  hasInputSchema: boolean;
  requires?: AuthorizationRequirement | readonly AuthorizationRequirement[];
  constraints: {
    maxToolCallsPerTurn?: number;
    toolTimeoutMs?: number;
    neverExpose: boolean;
    requiresHumanApproval: boolean;
    hiddenFromTrustLevels: TrustLevel[];
    approvalRequiredForTrustLevels: TrustLevel[];
  };
}

export interface ToolInventory {
  totalTools: number;
  entries: ToolSummary[];
}

export function collectToolSummaries(kernel: TransportKernel): ToolInventory {
  const entries = kernel
    .getAugments()
    .filter((aug) => !aug.synthetic)
    .flatMap((aug) => {
      const constraints = aug.constraints;
      return (aug.tools ?? []).map((tool) => ({
        name: tool.name,
        description: tool.description,
        category: tool.category,
        augmentName: aug.name,
        augmentType: aug.type ?? aug.name,
        hasInputSchema: tool.inputJsonSchema !== undefined,
        ...(tool.requires ? { requires: tool.requires } : {}),
        constraints: {
          ...(constraints?.maxToolCallsPerTurn !== undefined
            ? { maxToolCallsPerTurn: constraints.maxToolCallsPerTurn }
            : {}),
          ...(constraints?.toolTimeoutMs !== undefined
            ? { toolTimeoutMs: constraints.toolTimeoutMs }
            : {}),
          neverExpose: (constraints?.neverExpose ?? []).includes(tool.name),
          requiresHumanApproval: (constraints?.requiresHumanApproval ?? []).includes(tool.name),
          hiddenFromTrustLevels: trustLevelsForTool(
            constraints?.perTrustLevel,
            tool.name,
            "neverExpose",
          ),
          approvalRequiredForTrustLevels: trustLevelsForTool(
            constraints?.perTrustLevel,
            tool.name,
            "requiresHumanApproval",
          ),
        },
      }));
    });

  return {
    totalTools: entries.length,
    entries,
  };
}

function trustLevelsForTool(
  perTrustLevel:
    | Record<string, { neverExpose?: string[]; requiresHumanApproval?: string[] } | undefined>
    | null
    | undefined,
  toolName: string,
  key: "neverExpose" | "requiresHumanApproval",
): TrustLevel[] {
  if (!perTrustLevel) return [];
  return Object.entries(perTrustLevel)
    .filter(([, rules]) => rules?.[key]?.includes(toolName))
    .map(([level]) => level as TrustLevel);
}

/**
 * Iterate registered augments and collect their AdminInfoBlocks for dashboard
 * JSON and action registration. Augments without adminInfo are skipped.
 * Augments whose adminInfo throws are replaced with a status-error block —
 * one broken augment can't take down the whole dashboard.
 */
export async function collectAdminInfoBlocks(kernel: TransportKernel): Promise<AdminInfoBlock[]> {
  const augments = kernel.getAugments();
  const blocks: AdminInfoBlock[] = [];

  for (const aug of augments) {
    if (!aug.adminInfo) continue;
    try {
      const block = await aug.adminInfo();
      if (block) {
        // The mounted runtime name is the dispatch identity. An augment's
        // presentation block may carry a type-oriented fallback (especially
        // before register()), but the dashboard must never mint action targets
        // for a name that is not present in the runtime registry.
        blocks.push({ ...block, augmentName: aug.name });
      }
    } catch {
      console.error(`[admin] augment "${aug.name}" adminInfo() failed`);
      blocks.push({
        augmentName: aug.name,
        title: aug.name,
        sections: [
          {
            kind: "status",
            level: "error",
            message: "Failed to load admin info.",
          },
        ],
      });
    }
  }

  return blocks;
}
