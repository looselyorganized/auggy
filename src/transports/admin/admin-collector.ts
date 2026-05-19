import type { AdminInfoBlock, TransportKernel } from "../../types";

/**
 * Iterate registered augments and collect their AdminInfoBlocks for /admin
 * rendering. Augments without adminInfo are skipped. Augments whose adminInfo
 * throws are replaced with a status-error block — one broken augment can't
 * take down the whole dashboard.
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
