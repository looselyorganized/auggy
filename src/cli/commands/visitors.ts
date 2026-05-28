/**
 * `auggy visitors <agent>` — list verified visitors for a single agent.
 *
 * Operates on the agent's SQLite files directly (visitor-auth.db). The agent
 * does NOT need to be running — SQLite WAL mode keeps reads safe alongside
 * a running agent.
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { createSqliteVisitorAuthStore } from "../../augments/visitor-auth/storage/sqlite-store";
import { parseAugmentConfigOnly } from "../yaml-helpers";
import { resolveConfigPath } from "../resolve-config";

export interface VisitorsCommandOptions {
  auggyDir?: string;
  cwd?: string;
  log?: (line: string) => void;
}

interface ResolvedAgentPaths {
  agentDir: string;
  visitorAuthDb: string;
}

function resolveAgentPaths(agentName: string, opts: VisitorsCommandOptions): ResolvedAgentPaths {
  const yamlPath = resolveConfigPath(agentName, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  const agentDir = resolve(yamlPath, "..");
  // parseAugmentConfigOnly handles env-var interpolation (F15) so that
  // `dbPath: ${MY_DB_PATH}` in agent.yaml resolves correctly here.
  const vaOptions = parseAugmentConfigOnly(yamlPath, "visitorAuth");
  if (!vaOptions) {
    throw new Error(`Agent "${agentName}": visitorAuth augment is not configured.`);
  }
  const dbPath = (vaOptions.dbPath as string | undefined) ?? "./visitor-auth.db";
  return {
    agentDir,
    visitorAuthDb: resolve(agentDir, dbPath),
  };
}

function formatTs(ms: number | null): string {
  if (!ms) return "—";
  return `${new Date(ms).toISOString().replace("T", " ").slice(0, 19)} UTC`;
}

function statusLabel(row: {
  revoked: boolean;
  reverifyDueAt: number;
  revokedReason: string | null;
}): string {
  if (row.revoked) {
    const reason = row.revokedReason ?? "unspecified";
    return `revoked (${reason})`;
  }
  if (row.reverifyDueAt <= Date.now()) return "reverify due";
  return "active";
}

export async function runVisitorsList(
  agentName: string,
  opts: VisitorsCommandOptions = {},
): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const paths = resolveAgentPaths(agentName, opts);

  if (!existsSync(paths.visitorAuthDb)) {
    log(`(none) — visitor-auth.db has not been created yet for "${agentName}".`);
    return;
  }
  const store = createSqliteVisitorAuthStore({ dbPath: paths.visitorAuthDb });
  store.initialize();
  const rows = store.listVerifiedVisitors();
  store.close();

  if (rows.length === 0) {
    log(`(none) — no verified visitors recorded for "${agentName}".`);
    return;
  }

  const headers = ["EMAIL", "VISITOR_ID", "VERIFIED_AT", "LAST_SEEN", "STATUS"];
  const data = rows.map((r) => [
    r.email,
    r.visitorId,
    formatTs(r.verifiedAt),
    formatTs(r.lastSeenAt),
    statusLabel(r),
  ]);
  const widths = headers.map((h, i) => Math.max(h.length, ...data.map((row) => row[i]!.length)));
  log(headers.map((h, i) => h.padEnd(widths[i]!)).join("  "));
  for (const row of data) log(row.map((c, i) => c.padEnd(widths[i]!)).join("  "));
}
