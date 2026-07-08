import type { AdminInfoBlock, AugmentCategory, TransportKernel } from "../../types";

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
  capabilities: string[];
  hasTools: boolean;
  toolCount: number;
  isTransport: boolean;
  isMemoryProvider: boolean;
  httpRouteCount: number;
  hasAdminInfo: boolean;
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
        capabilities: aug.capabilities ?? [],
        hasTools: (aug.tools?.length ?? 0) > 0,
        toolCount: aug.tools?.length ?? 0,
        isTransport: !!aug.transport,
        isMemoryProvider: !!aug.memory,
        httpRouteCount: aug.httpRoutes?.length ?? 0,
        hasAdminInfo: !!aug.adminInfo,
      }))
  );
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
      if (block) blocks.push(block);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[admin] augment "${aug.name}" adminInfo() threw: ${message}`);
      blocks.push({
        augmentName: aug.name,
        title: aug.name,
        sections: [
          {
            kind: "status",
            level: "error",
            message: `Failed to load admin info: ${message}`,
          },
        ],
      });
    }
  }

  return blocks;
}
