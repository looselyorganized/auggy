/**
 * auggy restart <name> — stop + start in one command.
 *
 * Reads the PID manifest to determine mode (dev vs launchd),
 * stops the agent, then restarts it in the same mode.
 */

import { resolve } from "node:path";
import { parseConfig } from "../config-parser";
import { claimAgentLifecycle, readLaunchdGenerationState, readPidManifest } from "../pid-registry";
import type { PidManifest } from "../types";
import { runStop } from "./stop";
import { runStart } from "./start";
import { runDev } from "./dev";
import { assertDistributedCoordinationStartupAllowed } from "../../coordination/topology";
import { configuredAugmentReplicaEvidence } from "../distributed-coordination-preflight";

interface RestartOptions {
  config?: string;
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
  /** Internal: an outer exact-id restart already owns the lifecycle lease. */
  lifecycleOwned?: boolean;
  /** Deterministic lifecycle seams for race regression tests. */
  _readPidManifest?: typeof readPidManifest;
  _claimAgentLifecycle?: typeof claimAgentLifecycle;
  _runStop?: typeof runStop;
  _runStart?: typeof runStart;
  _runDev?: typeof runDev;
  _sleep?: (milliseconds: number) => Promise<void>;
}

const AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export async function runRestart(name: string, opts: RestartOptions): Promise<void> {
  const registryOptions = {
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
  };
  if (AGENT_ID_RE.test(name) && !opts.lifecycleOwned) {
    const releaseLifecycle = (opts._claimAgentLifecycle ?? claimAgentLifecycle)(
      name,
      "launchd-restart",
      registryOptions,
    );
    try {
      await runRestart(name, { ...opts, lifecycleOwned: true });
    } finally {
      releaseLifecycle();
    }
    return;
  }

  const readManifest = opts._readPidManifest ?? readPidManifest;
  const manifest = readManifest(name, registryOptions);

  if (!manifest) {
    if (!AGENT_ID_RE.test(name)) {
      throw new Error(
        `Agent "${name}" has no runtime manifest, so its display name cannot safely identify an in-flight start. Retry with the immutable aug1_... id from agent.yaml.`,
      );
    }
    const generation = readLaunchdGenerationState(name, registryOptions);
    if (generation) {
      throw new Error(
        `Agent "${name}" has persisted launchd generation state but no runtime manifest. Run "auggy stop ${name}" to recover any installed job before starting again with the intended config.`,
      );
    }
    console.log(
      `Agent "${name}" is not running. Use "auggy dev ${name}" or "auggy start ${name}" to start it.`,
    );
    return;
  }

  const releaseLifecycle =
    opts.lifecycleOwned || !manifest.agentId
      ? () => {}
      : (opts._claimAgentLifecycle ?? claimAgentLifecycle)(
          manifest.agentId,
          manifest.name,
          registryOptions,
        );

  try {
    // The lease can queue behind another controller. Adopt and validate the
    // current generation only after acquiring it; never stop a replacement
    // and then resurrect the stale pre-lease snapshot.
    const current = readManifest(manifest.agentId ?? name, registryOptions);
    if (!current) {
      console.log(`Agent "${name}" stopped before restart acquired its lifecycle lease.`);
      return;
    }
    if (manifest.agentId && current.agentId !== manifest.agentId) {
      throw new Error("Agent identity changed while restart waited for its lifecycle lease");
    }
    const mode = current.mode;
    const configPath = assertRestartTarget(current, opts.config ?? current.configPath);
    console.log(`Restarting "${current.name}" (${mode} mode)...`);

    // Stop the agent.
    await (opts._runStop ?? runStop)(current.agentId ?? name, {
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
  } finally {
    releaseLifecycle();
  }
}

/** Validate a restart target completely before the running process is touched. */
export function assertRestartTarget(manifest: PidManifest, candidatePath: string): string {
  const configPath = resolve(candidatePath);
  const manifestPath = resolve(manifest.configPath);
  if (configPath !== manifestPath) {
    throw new Error("Restart config path does not match the running agent manifest");
  }
  const config = parseConfig(configPath);
  assertDistributedCoordinationStartupAllowed(config.settings.coordination, {
    augmentEvidence: configuredAugmentReplicaEvidence(config.augments),
  });
  if (manifest.agentId && config.id !== manifest.agentId) {
    throw new Error("Restart config identity does not match the running agent manifest");
  }
  if (!manifest.agentId && config.name !== manifest.name) {
    throw new Error("Restart config name does not match the legacy running agent manifest");
  }
  return configPath;
}
