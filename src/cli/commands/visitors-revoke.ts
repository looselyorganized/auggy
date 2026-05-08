/**
 * `auggy visitors <agent> --revoke <email>` — hard-revoke + memory cascade.
 *
 * Operates on SQLite files directly (visitor-auth.db, memory.db). Safe with
 * a running agent thanks to WAL mode.
 *
 * Cascade order:
 *   1. visitor-auth.db: revokeByEmail returns visitorId
 *   2. memory.db: DELETE FROM entries WHERE peer_id = visitorId
 */

import { existsSync, readFileSync } from "node:fs";
import { Database } from "bun:sqlite";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { getAgent } from "../agent-index";
import { createSqliteVisitorAuthStore } from "../../augments/visitor-auth/storage/sqlite-store";

export interface VisitorsRevokeOptions {
  auggyDir?: string;
  /** When true, prompt the user. When false (or --yes), skip the prompt. */
  confirm?: boolean;
  log?: (line: string) => void;
  /** Test seam — production reads from stdin (currently always returns false in non-interactive contexts). */
  _confirmAnswer?: (prompt: string) => boolean;
}

interface ResolvedPaths {
  agentDir: string;
  visitorAuthDb: string;
  memoryDb: string | null;
}

function resolvePaths(agentName: string, opts: VisitorsRevokeOptions): ResolvedPaths {
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
  // Raw YAML parse (matches src/cli/commands/visitors.ts) — avoids parseConfig's
  // strict id/name/engine requirements for an operator-only read/write CLI.
  const raw = parseYaml(readFileSync(yamlPath, "utf-8")) as {
    augments?: Array<{ type?: string; options?: Record<string, unknown> }>;
  };
  const augments = raw?.augments ?? [];
  const va = augments.find((a) => a?.type === "visitorAuth");
  if (!va) {
    throw new Error(`Agent "${agentName}": visitorAuth is not configured.`);
  }
  const o = (va.options ?? {}) as Record<string, unknown>;
  const dbPath = (o.dbPath as string | undefined) ?? "./visitor-auth.db";
  // null = explicit opt-out from peer-id migration; undefined = default.
  const memPathRaw =
    o.layeredMemoryDbPath === null
      ? null
      : (o.layeredMemoryDbPath as string | undefined) ?? "./memory.db";
  return {
    agentDir,
    visitorAuthDb: resolve(agentDir, dbPath),
    memoryDb: memPathRaw === null ? null : resolve(agentDir, memPathRaw),
  };
}

function defaultConfirm(prompt: string): boolean {
  process.stdout.write(prompt);
  // Synchronous stdin read in Bun is non-trivial. For v1 we assume "no" in
  // non-interactive contexts. Operators must pass `--yes` for non-interactive
  // revocation. Tests inject _confirmAnswer.
  return false;
}

export async function runVisitorsRevoke(
  agentName: string,
  email: string,
  opts: VisitorsRevokeOptions = {},
): Promise<void> {
  const log = opts.log ?? ((l: string) => console.log(l));
  const paths = resolvePaths(agentName, opts);

  if (!existsSync(paths.visitorAuthDb)) {
    throw new Error(`No verified visitors yet — visitor-auth.db not found.`);
  }

  const store = createSqliteVisitorAuthStore({ dbPath: paths.visitorAuthDb });
  store.initialize();
  const existing = store.findVerifiedByEmail(email);
  if (!existing) {
    store.close();
    throw new Error(`No verified visitor found for "${email}".`);
  }
  if (existing.revoked) {
    log(`Visitor "${email}" is already revoked (${existing.revokedReason ?? "unspecified"}).`);
    store.close();
    return;
  }

  if (opts.confirm) {
    const ok = (opts._confirmAnswer ?? defaultConfirm)(
      `Revoke verified visitor "${email}" (${existing.visitorId})? This deletes peer-scoped memory rows. [y/N] `,
    );
    if (!ok) {
      log("Cancelled. No changes made.");
      store.close();
      return;
    }
  }

  const visitorId = store.revokeByEmail(email, "operator", Date.now())!;
  store.close();

  let memDeleted = 0;
  if (paths.memoryDb && existsSync(paths.memoryDb)) {
    let db: Database | null = null;
    try {
      db = new Database(paths.memoryDb, { readwrite: true });
      const r = db.prepare(`DELETE FROM entries WHERE peer_id = ?`).run(visitorId);
      memDeleted = r.changes;
    } catch (err) {
      log(`Memory cascade failed: ${(err as Error).message}. Operator should retry manually.`);
    } finally {
      if (db) {
        try {
          db.close();
        } catch {
          // ignore close errors
        }
      }
    }
  } else if (paths.memoryDb) {
    log(`memory.db not found at ${paths.memoryDb} — skipping memory cascade.`);
  }
  log(`Revoked "${email}" (${visitorId}). ${memDeleted} memory row(s) removed.`);
}
