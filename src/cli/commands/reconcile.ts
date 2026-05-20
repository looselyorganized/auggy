/**
 * auggy reconcile — fix mismatches between the agent index and the on-disk
 * agent directories. Reports + cleans:
 *
 *   - orphans: dirs under ~/.auggy/agents/ NOT in the index (typically left
 *     over from aborted `auggy create` runs)
 *   - ghosts:  index entries whose localDir no longer exists on disk
 *   - .tmp-*: scaffold-staging dirs left behind by killed creates
 *
 * Interactive by default. `--yes` skips prompts and removes everything in
 * one shot. `--dry-run` prints findings without changing anything.
 *
 * Lifecycle hardening F6 in audit (2026-05-20).
 */

import { existsSync, readdirSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { confirm } from "@inquirer/prompts";
import { listAgents, removeAgent } from "../agent-index";

interface ReconcileOptions {
  /** Skip prompts, delete everything found. */
  yes?: boolean;
  /** List mismatches without changing anything. */
  dryRun?: boolean;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
}

interface Mismatch {
  kind: "orphan" | "ghost" | "tmp";
  name: string;
  path: string;
  /** For ghost entries: the index-recorded path that's gone. */
  indexPath?: string;
}

function scanDisk(auggyDir: string): {
  orphans: Array<{ name: string; localDir: string }>;
  tmpDirs: Array<{ name: string; localDir: string }>;
} {
  const agentsDir = join(auggyDir, "agents");
  if (!existsSync(agentsDir)) return { orphans: [], tmpDirs: [] };
  const orphans: Array<{ name: string; localDir: string }> = [];
  const tmpDirs: Array<{ name: string; localDir: string }> = [];
  for (const entry of readdirSync(agentsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const localDir = join(agentsDir, entry.name);
    if (entry.name.startsWith(".tmp-")) {
      tmpDirs.push({ name: entry.name, localDir });
      continue;
    }
    if (entry.name.startsWith(".")) continue;
    // Orphan classification deferred to the caller after cross-referencing
    // the index.
    if (!existsSync(join(localDir, "agent.yaml"))) continue;
    orphans.push({ name: entry.name, localDir });
  }
  return { orphans, tmpDirs };
}

export async function runReconcile(opts: ReconcileOptions = {}): Promise<void> {
  const auggyDir = opts.auggyDir ?? join(homedir(), ".auggy");
  const indexed = listAgents({ auggyDir: opts.auggyDir });
  const indexedSet = new Set(indexed.map((a) => a.localDir));

  const { orphans: diskOrphans, tmpDirs } = scanDisk(auggyDir);
  const orphans = diskOrphans.filter((o) => !indexedSet.has(o.localDir));
  const ghosts = indexed.filter((a) => !existsSync(a.localDir));

  const mismatches: Mismatch[] = [
    ...orphans.map((o) => ({
      kind: "orphan" as const,
      name: o.name,
      path: o.localDir,
    })),
    ...ghosts.map((g) => ({
      kind: "ghost" as const,
      name: g.name,
      path: g.localDir,
      indexPath: g.localDir,
    })),
    ...tmpDirs.map((t) => ({
      kind: "tmp" as const,
      name: t.name,
      path: t.localDir,
    })),
  ];

  if (mismatches.length === 0) {
    console.log("Index + on-disk state are consistent. Nothing to reconcile.");
    return;
  }

  console.log(`Found ${mismatches.length} mismatch(es):`);
  console.log();
  for (const m of mismatches) {
    console.log(`  [${m.kind}] ${m.name}`);
    console.log(`    ${m.path}`);
  }
  console.log();

  if (opts.dryRun) {
    console.log("Dry-run. Re-run without --dry-run to clean.");
    return;
  }

  if (!opts.yes) {
    const ok = await confirm({
      message:
        "Clean all mismatches?\n  orphans → rmSync the dir\n  ghosts  → remove index entry\n  tmp     → rmSync the staging dir",
      default: false,
    });
    if (!ok) {
      console.log("Aborted.");
      return;
    }
  }

  let cleaned = 0;
  for (const m of mismatches) {
    try {
      if (m.kind === "orphan" || m.kind === "tmp") {
        rmSync(m.path, { recursive: true, force: true });
        console.log(`  ✓ removed ${m.kind} dir: ${m.path}`);
      } else if (m.kind === "ghost") {
        removeAgent(m.name, { auggyDir: opts.auggyDir });
        console.log(`  ✓ removed ghost entry: ${m.name}`);
      }
      cleaned++;
    } catch (err) {
      console.error(`  ✗ failed to clean ${m.kind} ${m.name}: ${(err as Error).message}`);
    }
  }

  console.log();
  console.log(`Reconciled ${cleaned}/${mismatches.length}.`);
}
