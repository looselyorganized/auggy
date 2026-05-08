/**
 * `auggy visitors <agent>` — list verified visitors for a single agent.
 *
 * Operates on the agent's SQLite files directly (visitor-auth.db). The agent
 * does NOT need to be running — SQLite WAL mode keeps reads safe alongside
 * a running agent.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { getAgent } from "../agent-index";
import { createSqliteVisitorAuthStore } from "../../augments/visitor-auth/storage/sqlite-store";

export interface VisitorsCommandOptions {
  auggyDir?: string;
  log?: (line: string) => void;
}

interface ResolvedAgentPaths {
  agentDir: string;
  visitorAuthDb: string;
}

function resolveAgentPaths(agentName: string, opts: VisitorsCommandOptions): ResolvedAgentPaths {
  const entry = getAgent(agentName, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(
      `Agent "${agentName}" is not registered. Run \`auggy ls\` to see registered agents.`,
    );
  }
  const agentDir = entry.localDir;
  const yamlPath = join(agentDir, "agent.yaml");
  if (!existsSync(yamlPath)) {
    throw new Error(`Agent "${agentName}": agent.yaml not found at ${yamlPath}.`);
  }
  // Use raw YAML parse to extract the visitorAuth augment config without running
  // full config validation (which requires id/name/engine fields the visitors
  // command does not need).
  const raw = readFileSync(yamlPath, "utf-8");
  const parsed = parseYaml(raw) as Record<string, unknown> | null;
  const augments = (parsed?.augments ?? []) as Array<Record<string, unknown>>;
  const va = augments.find((a) => a.type === "visitorAuth");
  if (!va) {
    throw new Error(`Agent "${agentName}": visitorAuth augment is not configured.`);
  }
  const opts2 = (va.options ?? {}) as Record<string, unknown>;
  const dbPath = (opts2.dbPath as string | undefined) ?? "./visitor-auth.db";
  return {
    agentDir,
    visitorAuthDb: resolve(agentDir, dbPath),
  };
}

function pad(s: string, w: number): string {
  return s + " ".repeat(Math.max(0, w - s.length));
}

function formatTs(ms: number | null): string {
  if (!ms) return "—";
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19) + " UTC";
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
  log(headers.map((h, i) => pad(h, widths[i]!)).join("  "));
  for (const row of data) log(row.map((c, i) => pad(c, widths[i]!)).join("  "));
}
