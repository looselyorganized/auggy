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

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { deleteSqliteMemoryForPeer } from "../../augments/layeredMemory/storage/sqlite-store";
import { createSqliteVisitorAuthStore } from "../../augments/visitorAuth/storage/sqlite-store";
import { scopedAgentNamespace } from "../agent-isolation";
import { parseAgentIdOnly, parseAugmentConfigOnly, parseAugmentConfigsOnly } from "../yaml-helpers";
import { resolveConfigPath } from "../resolve-config";
import { resolveOwnedStatePath } from "../owned-state-path";

export interface VisitorsRevokeOptions {
  auggyDir?: string;
  cwd?: string;
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
  memoryNamespace: string;
}

function resolvePaths(agentName: string, opts: VisitorsRevokeOptions): ResolvedPaths {
  const yamlPath = resolveConfigPath(agentName, undefined, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const agentDir = resolve(yamlPath, "..");
  const agentId = parseAgentIdOnly(yamlPath);
  // parseAugmentConfigOnly handles env-var interpolation (F15) so that
  // `dbPath: ${MY_DB_PATH}` / `layeredMemoryDbPath: ${MEMORY_DB}` in
  // agent.yaml resolves correctly here.
  const vaOptions = parseAugmentConfigOnly(yamlPath, "visitorAuth");
  if (!vaOptions) {
    throw new Error(`Agent "${agentName}": visitorAuth is not configured.`);
  }
  const dbPath = (vaOptions.dbPath as string | undefined) ?? "./visitor-auth.db";
  // null = explicit opt-out from peer-id migration; undefined = default.
  const memPathRaw =
    vaOptions.layeredMemoryDbPath === null
      ? null
      : ((vaOptions.layeredMemoryDbPath as string | undefined) ?? "./memory.db");
  const memoryDb =
    memPathRaw === null
      ? null
      : resolveOwnedStatePath(memPathRaw, agentDir, agentDir, "visitorAuth layeredMemoryDbPath");
  const matchingNamespaces = new Set(
    parseAugmentConfigsOnly(yamlPath, "layeredMemory")
      .filter((options) => (options.backend ?? "sqlite") === "sqlite")
      .filter(
        (options) =>
          memoryDb !== null &&
          resolveOwnedStatePath(
            (options.dbPath as string | undefined) ?? "./memory.db",
            agentDir,
            agentDir,
            "layeredMemory dbPath",
          ) === memoryDb,
      )
      .map((options) =>
        scopedAgentNamespace(agentId, options.namespace as string | undefined, "ep"),
      ),
  );
  if (matchingNamespaces.size > 1) {
    throw new Error(
      `Agent "${agentName}": visitorAuth memory path matches multiple layeredMemory namespaces; use separate database files.`,
    );
  }
  return {
    agentDir,
    visitorAuthDb: resolveOwnedStatePath(dbPath, agentDir, agentDir, "visitorAuth dbPath"),
    memoryDb,
    memoryNamespace:
      matchingNamespaces.values().next().value ?? scopedAgentNamespace(agentId, undefined, "ep"),
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

  const revoked = store.revokeCurrentByEmail(email, "operator", Date.now());
  store.close();
  if (!revoked) throw new Error(`No verified visitor found for "${email}".`);

  const memDeleted = cascadeMemoryDelete(
    paths.memoryDb,
    paths.memoryNamespace,
    revoked.visitorId,
    log,
  );
  const outcome = revoked.wasRevoked ? "was already revoked; reconciled" : "revoked";
  log(`Visitor "${email}" (${revoked.visitorId}) ${outcome}. ${memDeleted} memory row(s) removed.`);
}

/**
 * DELETE memory rows for a peer-id from the layeredMemory SQLite file.
 * Best-effort — exceptions are logged and swallowed; the visitor-auth row
 * has already been revoked at the call site, so partial-success state is
 * acceptable. Returns the row count (0 if missing-file/null-path).
 */
function cascadeMemoryDelete(
  memoryDb: string | null,
  memoryNamespace: string,
  visitorId: string,
  log: (line: string) => void,
): number {
  if (!memoryDb) return 0;
  if (!existsSync(memoryDb)) {
    log(`memory.db not found at ${memoryDb} — skipping memory cascade.`);
    return 0;
  }
  try {
    return deleteSqliteMemoryForPeer(memoryDb, memoryNamespace, visitorId);
  } catch (err) {
    log(`Memory cascade failed: ${(err as Error).message}. Operator should retry manually.`);
    return 0;
  }
}
