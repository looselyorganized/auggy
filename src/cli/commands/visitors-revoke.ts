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
import { canonicalizeEmail, isWellFormedEmail } from "../../augments/visitorAuth/email-validation";
import { createSqliteVisitorAuthStore } from "../../augments/visitorAuth/storage/sqlite-store";
import { scopedAgentNamespace } from "../agent-isolation";
import { parseAgentIdOnly, parseAugmentConfigOnly, parseAugmentConfigsOnly } from "../yaml-helpers";
import { resolveConfigPath } from "../resolve-config";
import { compareOwnedStatePaths, resolveOwnedStatePath } from "../owned-state-path";

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
  const matchingNamespaces = new Set<string>();
  for (const options of parseAugmentConfigsOnly(yamlPath, "layeredMemory")) {
    if ((options.backend ?? "sqlite") !== "sqlite" || memoryDb === null) continue;
    const configuredMemory = resolveOwnedStatePath(
      (options.dbPath as string | undefined) ?? "./memory.db",
      agentDir,
      agentDir,
      "layeredMemory dbPath",
    );
    const relationship = compareOwnedStatePaths(configuredMemory, memoryDb);
    if (relationship === "ambiguous") {
      throw new Error(
        `Agent "${agentName}": visitorAuth memory path may alias layeredMemory on a case-insensitive volume; use one exact path spelling.`,
      );
    }
    if (relationship === "same") {
      matchingNamespaces.add(
        scopedAgentNamespace(agentId, options.namespace as string | undefined, "ep"),
      );
    }
  }
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
  const canonicalEmail = canonicalizeEmail(email);
  if (!isWellFormedEmail(canonicalEmail)) {
    throw new Error("Visitor email is malformed.");
  }
  const paths = resolvePaths(agentName, opts);

  if (!existsSync(paths.visitorAuthDb)) {
    throw new Error(`No verified visitors yet — visitor-auth.db not found.`);
  }

  const store = createSqliteVisitorAuthStore({ dbPath: paths.visitorAuthDb });
  store.initialize();
  const existing = store.findVerifiedByEmail(canonicalEmail);
  if (!existing) {
    store.close();
    throw new Error(`No verified visitor found for "${canonicalEmail}".`);
  }

  if (opts.confirm) {
    const ok = (opts._confirmAnswer ?? defaultConfirm)(
      `Revoke verified visitor "${canonicalEmail}" (${existing.visitorId})? This deletes peer-scoped memory rows. [y/N] `,
    );
    if (!ok) {
      log("Cancelled. No changes made.");
      store.close();
      return;
    }
  }

  const revoked = store.revokeCurrentByEmail(canonicalEmail, "operator", Date.now());
  const revokedVisitorIds = store.listRevokedVisitorIdsByEmail(canonicalEmail);
  store.close();
  if (!revoked) throw new Error(`No verified visitor found for "${canonicalEmail}".`);

  let memDeleted = 0;
  try {
    for (const visitorId of revokedVisitorIds) {
      memDeleted += cascadeMemoryDelete(paths.memoryDb, paths.memoryNamespace, visitorId, log);
    }
  } catch (error) {
    throw new Error(
      `Visitor "${canonicalEmail}" was revoked, but memory erasure is incomplete for retired identity ${revoked.visitorId}. Retry the same revoke command after repairing the memory store.`,
      { cause: error },
    );
  }
  const outcome = revoked.wasRevoked ? "was already revoked; reconciled" : "revoked";
  log(
    `Visitor "${canonicalEmail}" (${revoked.visitorId}) ${outcome}. ${memDeleted} memory row(s) removed.`,
  );
}

/**
 * DELETE memory rows for a peer-id from the layeredMemory SQLite file.
 * Errors propagate after auth revocation so automation observes partial
 * completion and can retry. Every retired identity for the email is retried.
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
  return deleteSqliteMemoryForPeer(memoryDb, memoryNamespace, visitorId);
}
