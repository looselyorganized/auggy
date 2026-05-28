/**
 * auggy dev <name> — run an agent in the foreground.
 *
 * This is the core lifecycle driver. Both `auggy dev` (interactive)
 * and `auggy start` (via launchd) ultimately run this code path.
 *
 * Flow:
 *   1. Parse config → ParsedConfig
 *   2. Resolve engine → ModelClient
 *   3. Resolve augments → Augment[]
 *   4. defineAgent(config, model)
 *   5. Write PID manifest
 *   6. Register signal handlers
 *   7. agent.start()
 *   8. Wait for signal → agent.stop() → cleanup
 */

import { resolve, dirname } from "node:path";
import { defineAgent } from "../../agent";
import { parseConfig } from "../config-parser";
import { resolveEngine } from "../engine-resolver";
import { resolveAugments } from "../augment-resolver";
import { writePidManifest, removePidManifest } from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";
import { openBrowser } from "../open-browser";
import type { AgentConfig, Augment, ModelClient } from "../../types";

/**
 * Extract the webTransport port from augment configs (for the PID manifest
 * and startup banner). Returns null when no webTransport augment is mounted.
 */
function extractPort(config: ReturnType<typeof parseConfig>): number | null {
  for (const aug of config.augments) {
    if (aug.type === "webTransport" && aug.options?.port) {
      return aug.options.port as number;
    }
  }
  return null;
}

export interface DevReadyInfo {
  /** Resolved agent name (from agent.yaml's `name:` field, not the CLI arg). */
  agentName: string;
  /** webTransport port if configured, else null. */
  port: number | null;
  /** Operator console URL — `http://localhost:<port>/console`, or null when no webTransport. */
  consoleUrl: string | null;
}

export interface DevOpts {
  config?: string;
  /** Test seam: override process.cwd() for project-local resolution. */
  cwd?: string;
  internalMode?: string;
  /**
   * When true, auto-launch the operator's default browser to `/console`
   * after the agent starts. No-op when webTransport isn't configured.
   */
  open?: boolean;
  /**
   * Callback invoked after `agent.start()` returns. Primarily for tests; the
   * `--open` flag is plumbed through `opts.open` directly.
   */
  onReady?: (info: DevReadyInfo) => void;
}

export async function runDev(name: string | undefined, opts: DevOpts): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const agentDir = dirname(configPath);
  const mode = opts.internalMode === "launchd" ? ("launchd" as const) : ("dev" as const);

  // Parse and validate config.
  const config = parseConfig(configPath);

  if (name && config.name !== name) {
    console.warn(
      `Warning: agent name in config ("${config.name}") differs from CLI argument ("${name}"). Using "${config.name}".`,
    );
  }

  const agentName = config.name;

  // Claim the name by writing the PID manifest atomically (wx flag).
  // This prevents TOCTOU races — the filesystem is the lock.
  const port = extractPort(config);
  try {
    writePidManifest({
      pid: process.pid,
      name: agentName,
      port,
      configPath: resolve(configPath),
      agentDir: resolve(agentDir),
      startedAt: new Date().toISOString(),
      mode,
    });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(
        `Agent "${agentName}" is already running. Use "auggy stop ${agentName}" first.`,
      );
    }
    throw err;
  }

  // From here on, clean up the PID manifest on any failure.
  let model: ModelClient;
  let augments: Augment[];
  let agentConfig: AgentConfig;
  try {
    model = await resolveEngine(config.engine, agentDir);
    augments = await resolveAugments(config.augments, agentDir);
    agentConfig = {
      name: agentName,
      purpose: config.purpose,
      model: config.engine.model,
      augments,
      operators: config.operators,
      contextBudget: config.settings.contextBudget,
      compactionStrategy: config.settings.compactionStrategy,
      maxInferenceLoops: config.settings.maxInferenceLoops,
    };
  } catch (err) {
    removePidManifest(agentName);
    throw err;
  }

  // Create and start the agent.
  const agent = defineAgent(agentConfig, model);

  // Graceful shutdown handler.
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.log(`\n${signal} received — shutting down ${agentName}...`);
    try {
      await agent.stop();
    } catch (err) {
      console.error("Error during shutdown:", err);
    }
    removePidManifest(agentName);
    console.log(`${agentName} stopped.`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Also clean up PID on unexpected exit.
  process.on("exit", () => {
    removePidManifest(agentName);
  });

  // Start the agent.
  await agent.start();

  const consoleUrl = port ? `http://localhost:${port}/console` : null;
  console.log(`Agent "${agentName}" running (PID ${process.pid})`);
  if (consoleUrl) {
    console.log(`  Chat:      ${consoleUrl}/chat`);
    console.log(`  Console:   ${consoleUrl}`);
    console.log(`  Health:    http://localhost:${port}/health`);
  }
  console.log(`  Config:    ${configPath}`);
  console.log(`  Press Ctrl-C to stop.`);

  // --open: pop the operator's browser to the chat surface. Small delay so
  // the banner lands first, then the browser opens — cleaner than racing
  // stdout against the browser launcher.
  if (opts.open && consoleUrl) {
    setTimeout(() => {
      const result = openBrowser(`${consoleUrl}/chat`);
      if (!result.ok) {
        console.log(
          `  (couldn't auto-launch \`${result.command}\`; open ${consoleUrl}/chat manually)`,
        );
      }
    }, 50);
  }

  opts.onReady?.({ agentName, port, consoleUrl });
}
