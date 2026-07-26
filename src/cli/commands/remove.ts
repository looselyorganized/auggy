/**
 * auggy remove [name] — delete an agent project.
 *
 * Refuses if the agent is running. Prompts before deletion (skipped with
 * --yes). The agent dir is the source of truth — removing it removes the
 * agent entirely.
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { confirm } from "@inquirer/prompts";
import { getAgentFromDir, readBoundCloudRecord } from "../agent-index";
import { createRailwayCli, type RailwayCli } from "../deploy/railway-cli";
import {
  claimAgentLifecycle,
  claimAgentMaintenance,
  listPidManifests,
  readLivePidManifest,
} from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";
import { parse as parseYaml } from "yaml";
import { agentStateRootClaims } from "../runtime-resource-claims";

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function readConfigIdentity(localDir: string): { id: string | null; name: string | null } {
  try {
    const yamlPath = join(localDir, "agent.yaml");
    if (!existsSync(yamlPath)) return { id: null, name: null };
    const value = parseYaml(readFileSync(yamlPath, "utf-8"));
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return { id: null, name: null };
    }
    const record = value as Record<string, unknown>;
    return {
      id: typeof record.id === "string" && AGENT_ID_RE.test(record.id) ? record.id : null,
      name: typeof record.name === "string" ? record.name.trim() || null : null,
    };
  } catch {
    return { id: null, name: null };
  }
}

interface RemoveOptions {
  /** Skip the y/N prompt. */
  yes?: boolean;
  /** When set with a cloud-deployed agent, also destroy the Railway service. */
  cloud?: boolean;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  cwd?: string;
  /** Inject a RailwayCli for tests (defaults to the real one). */
  railwayCli?: RailwayCli;
  /** Deterministic process-incarnation inspection for tests. */
  processIdentityForPid?: (pid: number) => string | null;
}

export async function runRemove(name: string | undefined, opts: RemoveOptions = {}): Promise<void> {
  const cwd = opts.cwd ?? process.cwd();
  const cwdAgentDir = existsSync(join(cwd, "agent.yaml")) ? cwd : null;
  const cwdConfigName = cwdAgentDir ? readConfigIdentity(cwdAgentDir).name : null;
  if (name && cwdAgentDir && name !== cwdConfigName) {
    throw new Error(
      `Refusing to remove the current agent project for argument "${name}".\n\n` +
        `If you meant to remove an augment, run:\n` +
        `  auggy augment remove ${name}`,
    );
  }
  const configPath = resolveConfigPath(name, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  const localDir = dirname(configPath);
  const entry = getAgentFromDir(localDir);
  const configIdentity = readConfigIdentity(localDir);
  const configName = configIdentity.name;
  const displayName = configName ?? name ?? "this agent";
  const localConfig = resolve(cwd, "agent.yaml");
  if (name && localConfig === resolve(configPath) && name !== configName) {
    throw new Error(
      `Refusing to remove the current agent project for argument "${name}".\n\n` +
        `If you meant to remove an augment, run:\n` +
        `  auggy augment remove ${name}`,
    );
  }
  if (!entry) {
    throw new Error(
      `Agent "${displayName}" not found.\n\n  Run from inside an agent project or its parent.`,
    );
  }
  if (!configIdentity.id || !configName) {
    throw new Error(
      `Agent "${displayName}" has no valid immutable identity; refusing destructive removal until agent.yaml is repaired.`,
    );
  }

  const capturedRootClaims = agentStateRootClaims(localDir);
  const claimOptions = {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  };
  const releaseLifecycle = claimAgentLifecycle(configIdentity.id, configName, claimOptions);
  let releaseMaintenance = () => {};
  try {
    releaseMaintenance = claimAgentMaintenance(
      configIdentity.id,
      configName,
      capturedRootClaims,
      claimOptions,
    );
  } catch (error) {
    releaseLifecycle();
    throw error;
  }
  try {
    const cloud = opts.cloud ? readBoundCloudRecord(localDir, configIdentity.id) : null;

    // Immutable identity and canonical config path are authoritative. Names are
    // only a legacy fallback and must never allow deletion of a renamed live
    // project.
    const liveById = configIdentity.id
      ? readLivePidManifest(configIdentity.id, {
          auggyDir: opts.auggyDir,
          processIdentityForPid: opts.processIdentityForPid,
        })
      : null;
    const liveByConfigPath = listPidManifests({
      auggyDir: opts.auggyDir,
      processIdentityForPid: opts.processIdentityForPid,
    }).find((manifest) => resolve(manifest.configPath) === resolve(configPath));
    const live = liveById ?? liveByConfigPath;
    if (live) {
      const identifier = live.agentId ?? live.name;
      throw new Error(
        `Agent "${live.name}" is running. Stop it first:\n\n  auggy stop ${identifier}`,
      );
    }

    if (!opts.yes) {
      const ok = await confirm({
        message: `This will permanently delete:\n  ${entry.localDir}\n\nContinue?`,
        default: false,
      });
      if (!ok) {
        console.log("Aborted.");
        return;
      }
    }

    // --cloud: destroy the Railway service BEFORE removing the local dir,
    // because the cloud record lives inside the dir's .auggy-cloud.json.
    if (opts.cloud && cloud) {
      const cli = opts.railwayCli ?? createRailwayCli();
      const tmp = mkdtempSync(join(tmpdir(), `auggy-remove-${displayName}-`));
      try {
        await cli.link({
          projectId: cloud.projectId,
          serviceName: cloud.serviceId,
          cwd: tmp,
        });
        await cli.destroyService({ cwd: tmp });
        console.log(`Destroyed Railway service "${cloud.serviceId}" (project ${cloud.projectId}).`);
      } catch (err) {
        console.warn(
          `warn: Railway service destruction failed: ${(err as Error).message}\n` +
            `  Local cleanup proceeding; remove the Railway service manually if needed.`,
        );
      } finally {
        try {
          rmSync(tmp, { recursive: true, force: true });
        } catch {}
      }
    }

    if (!existsSync(join(localDir, "agent.yaml"))) {
      throw new Error(`Refusing to delete "${localDir}" — it does not contain agent.yaml.`);
    }
    const currentIdentity = readConfigIdentity(localDir);
    if (
      currentIdentity.id !== configIdentity.id ||
      currentIdentity.name !== configName ||
      agentStateRootClaims(localDir).join("\0") !== capturedRootClaims.join("\0")
    ) {
      throw new Error(
        `Refusing to delete "${localDir}" — its directory generation or immutable identity changed during removal.`,
      );
    }

    // Atomically detach the captured pathname before recursive deletion. A
    // final inode/identity check on the detached object prevents a same-path
    // replacement from turning this command into a confused deputy.
    const quarantinePath = join(
      dirname(localDir),
      `.auggy-remove-${configIdentity.id}-${randomUUID()}`,
    );
    renameSync(localDir, quarantinePath);
    const quarantinedIdentity = readConfigIdentity(quarantinePath);
    const capturedInodeClaim = capturedRootClaims.find((claim) =>
      claim.startsWith("agent-state-root-sha256:"),
    );
    const quarantinedInodeClaim = agentStateRootClaims(quarantinePath).find((claim) =>
      claim.startsWith("agent-state-root-sha256:"),
    );
    if (
      quarantinedIdentity.id !== configIdentity.id ||
      quarantinedIdentity.name !== configName ||
      !capturedInodeClaim ||
      quarantinedInodeClaim !== capturedInodeClaim
    ) {
      if (!existsSync(localDir)) renameSync(quarantinePath, localDir);
      throw new Error(
        `Refusing to delete "${localDir}" — the quarantined directory is not the captured agent generation.`,
      );
    }
    rmSync(quarantinePath, { recursive: true, force: true });

    console.log(`Removed agent "${displayName}" (was at ${entry.localDir}).`);
  } finally {
    releaseMaintenance();
    releaseLifecycle();
  }
}
