/**
 * auggy restart <name> — stop + start in one command.
 *
 * Reads the PID manifest to determine mode (dev vs launchd),
 * stops the agent, then restarts it in the same mode.
 */

import { resolve } from "node:path";
import { parseConfig } from "../config-parser";
import {
  claimAgentLifecycle,
  listPidManifests,
  readLaunchdGenerationState,
  readPidManifest,
} from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";
import type { PidManifest } from "../types";
import { runStop } from "./stop";
import { runStart } from "./start";
import { runDev } from "./dev";

interface RestartOptions {
  config?: string;
  /** Test seam: override process.cwd() for project-local resolution. */
  cwd?: string;
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
  /** Internal: an outer exact-id restart already owns the lifecycle lease. */
  lifecycleOwned?: boolean;
  /** Deterministic lifecycle seams for race regression tests. */
  _readPidManifest?: typeof readPidManifest;
  _listPidManifests?: typeof listPidManifests;
  _claimAgentLifecycle?: typeof claimAgentLifecycle;
  _runStop?: typeof runStop;
  _runStart?: typeof runStart;
  _runDev?: typeof runDev;
  _sleep?: (milliseconds: number) => Promise<void>;
}

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface RestartTarget {
  agentId: string;
  agentName: string;
  configPath?: string;
}

function resolveRestartTarget(name: string, opts: RestartOptions): RestartTarget {
  if (AGENT_ID_RE.test(name)) {
    if (!opts.config) {
      return { agentId: name, agentName: "launchd-restart" };
    }
    const configPath = resolveConfigPath(undefined, opts.config, { cwd: opts.cwd });
    const config = parseConfig(configPath);
    if (config.id !== name) {
      throw new Error(
        `Restart target identity mismatch.\n` +
          `Requested immutable ID: ${name}\n` +
          `Config at ${resolve(configPath)} declares: ${config.name} (${config.id})\n` +
          "No process was stopped. Use the immutable ID declared by the intended agent.yaml.",
      );
    }
    return { agentId: config.id, agentName: config.name, configPath: resolve(configPath) };
  }

  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const config = parseConfig(configPath);
  if (config.name !== name) {
    throw new Error(
      `Restart target name mismatch.\n` +
        `Command requested: ${name}\n` +
        `Config at ${resolve(configPath)} declares: ${config.name} (${config.id})\n` +
        "No process was stopped. Run the command with the config's declared name or choose the intended agent.yaml.",
    );
  }
  return { agentId: config.id, agentName: config.name, configPath: resolve(configPath) };
}

function formatDifferentIdentityRunningMessage(
  target: Required<RestartTarget>,
  running: readonly PidManifest[],
): string {
  const lines = [
    `The project "${target.agentName}" is not the running identity with that display name.`,
    `Target project: ${target.agentId}`,
    `Target config: ${target.configPath}`,
    "Running same-name identities:",
  ];
  for (const manifest of running) {
    lines.push(
      `  - ${manifest.agentId ?? "legacy identity"} (PID ${manifest.pid}, config ${resolve(manifest.configPath)})`,
    );
  }
  lines.push(
    "No process was stopped or adopted.",
    `Stop an old identity explicitly with \`auggy stop <aug1_...>\`, then start this project with \`auggy start --config ${target.configPath}\` or \`auggy run --config ${target.configPath}\`.`,
  );
  return lines.join("\n");
}

export async function runRestart(name: string, opts: RestartOptions): Promise<void> {
  const registryOptions = {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  };
  const target = resolveRestartTarget(name, opts);
  const releaseLifecycle = opts.lifecycleOwned
    ? () => {}
    : (opts._claimAgentLifecycle ?? claimAgentLifecycle)(
        target.agentId,
        target.agentName,
        registryOptions,
      );

  try {
    await restartResolvedTarget(name, target, opts, registryOptions);
  } finally {
    releaseLifecycle();
  }
}

async function restartResolvedTarget(
  requestedName: string,
  target: RestartTarget,
  opts: RestartOptions,
  registryOptions: {
    auggyDir: string | undefined;
    processIdentityForPid: ((pid: number) => string | null) | undefined;
  },
): Promise<void> {
  const readManifest = opts._readPidManifest ?? readPidManifest;
  const manifest = readManifest(target.agentId, registryOptions);

  if (!manifest) {
    if (target.configPath) {
      const sameName = (opts._listPidManifests ?? listPidManifests)(registryOptions).filter(
        (candidate) => candidate.name === target.agentName && candidate.agentId !== target.agentId,
      );
      if (sameName.length > 0) {
        throw new Error(
          formatDifferentIdentityRunningMessage(target as Required<RestartTarget>, sameName),
        );
      }
    }
    const generation = readLaunchdGenerationState(target.agentId, registryOptions);
    if (generation) {
      throw new Error(
        `Agent "${target.agentName}" (${target.agentId}) has persisted launchd generation state but no runtime manifest. Run "auggy stop ${target.agentId}" to recover any installed job before starting again with the intended config.`,
      );
    }
    const startTarget = target.configPath ? ` --config ${target.configPath}` : ` ${target.agentId}`;
    console.log(
      `Agent "${target.agentName}" (${target.agentId}) is not running. Use "auggy run${startTarget}" or "auggy start${startTarget}" to start it.`,
    );
    return;
  }

  // The exact immutable target is resolved before the lifecycle lease. Read
  // the runtime generation only after acquiring that lease, and never fall
  // back to a same-name manifest.
  const current = manifest;
  const mode = current.mode;
  const configPath = assertRestartTarget(current, target.configPath ?? current.configPath);
  console.log(`Restarting "${current.name}" (${mode} mode)...`);

  // Stop the agent.
  await (opts._runStop ?? runStop)(current.agentId ?? requestedName, {
    lifecycleOwned: true,
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  });

  // Brief pause for port release.
  await (opts._sleep ?? Bun.sleep)(1000);

  // Restart in the same mode.
  if (mode === "launchd") {
    await (opts._runStart ?? runStart)(current.name, {
      config: configPath,
      lifecycleOwned: true,
      auggyDir: opts.auggyDir,
      processIdentityForPid: opts.processIdentityForPid,
    });
  } else {
    await (opts._runDev ?? runDev)(current.name, {
      config: configPath,
      lifecycleOwned: true,
      auggyDir: opts.auggyDir,
      processIdentityForPid: opts.processIdentityForPid,
    });
  }
}

/** Validate a restart target completely before the running process is touched. */
export function assertRestartTarget(manifest: PidManifest, candidatePath: string): string {
  const configPath = resolve(candidatePath);
  const manifestPath = resolve(manifest.configPath);
  if (configPath !== manifestPath) {
    throw new Error(
      `Restart config path does not match the running agent manifest.\n` +
        `Running: ${manifest.name} (${manifest.agentId ?? "legacy identity"}) at ${manifestPath}\n` +
        `Requested config: ${configPath}\n` +
        "No process was stopped. Stop the running immutable ID explicitly before moving or replacing its project.",
    );
  }
  const config = parseConfig(configPath);
  if (manifest.agentId && config.id !== manifest.agentId) {
    throw new Error(
      `Restart config identity does not match the running agent manifest.\n` +
        `Running: ${manifest.name} (${manifest.agentId})\n` +
        `Config now declares: ${config.name} (${config.id}) at ${configPath}\n` +
        `No process was stopped. Stop the old runtime with \`auggy stop ${manifest.agentId}\`, then start the intended project explicitly.`,
    );
  }
  if (!manifest.agentId && config.name !== manifest.name) {
    throw new Error(
      `Restart config name does not match the legacy running agent manifest.\n` +
        `Running name: ${manifest.name}\n` +
        `Config name: ${config.name} at ${configPath}\n` +
        "No process was stopped. Stop the legacy runtime before starting the intended project.",
    );
  }
  return configPath;
}
