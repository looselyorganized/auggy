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

import { dirname, resolve } from "node:path";
import { defineAgent } from "../../agent";
import { parseConfig } from "../config-parser";
import { resolveEngine } from "../engine-resolver";
import { resolveAugments } from "../augment-resolver";
import {
  claimRuntimePidManifest,
  formatAgentAlreadyRunningMessage,
  readPidManifest,
  releaseRuntimePidManifest,
} from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";
import { openBrowser } from "../open-browser";
import type { AgentConfig, Augment, ModelClient } from "../../types";
import { displayPath } from "../display-path";
import { prepareRailwayRuntimeVolume } from "../runtime-volume";

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

/** Resolve the persistent data root for deployment runtimes that provide one. */
export function resolveRuntimeDataRoot(internalMode: string | undefined): string | undefined {
  return internalMode === "railway" ? "/app/data" : undefined;
}

export function formatDevReadyMessage(args: {
  agentName: string;
  port: number | null;
  configPath: string;
  deployCommand: string;
  runtime?: "local" | "railway";
  publicUrl?: string | undefined;
}): string {
  const lines = [`Agent "${args.agentName}" is live.`, ""];

  const urls = resolveReadyUrls(args);
  if (urls) {
    lines.push(`  Chat:     ${urls.chat}`);
    lines.push(`  Console:  ${urls.console}`);
    lines.push(`  Health:   ${urls.health}`);
    lines.push(`  Home:     ${urls.home}`);
    lines.push("");
  }

  if (args.runtime !== "railway") {
    lines.push("Extend it:");
    lines.push("  auggy augment list");
    lines.push("  auggy augment add <name>");
    lines.push("  auggy augment create <name>");
    lines.push("");
    lines.push("Deploy it:");
    lines.push(`  ${args.deployCommand.padEnd(20)} Deploy to Railway`);
    lines.push("");
  }
  lines.push(`Config: ${args.configPath}`);
  if (args.runtime === "railway") {
    lines.push("Runtime: Railway");
  } else {
    lines.push("Press Ctrl-C to stop.");
  }

  return lines.join("\n");
}

function resolveReadyUrls(args: {
  port: number | null;
  runtime?: "local" | "railway";
  publicUrl?: string | undefined;
}): { chat: string; console: string; health: string; home: string } | null {
  if (args.runtime === "railway") {
    const publicBase = normalizePublicUrl(args.publicUrl);
    if (publicBase) {
      return {
        chat: `${publicBase}/console/chat`,
        console: `${publicBase}/console`,
        health: `${publicBase}/health`,
        home: publicBase,
      };
    }
  }

  if (!args.port) return null;
  const localBase = `http://localhost:${args.port}`;
  return {
    chat: `${localBase}/console/chat`,
    console: `${localBase}/console`,
    health: `${localBase}/health`,
    home: `${localBase}/`,
  };
}

function normalizePublicUrl(value: string | undefined): string | null {
  const trimmed = value?.trim();
  if (!trimmed) return null;

  try {
    const url = new URL(trimmed);
    if (url.protocol !== "http:" && url.protocol !== "https:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

export function formatRunDisplayPath(
  path: string,
  cwd: string | undefined = process.cwd(),
): string {
  return displayPath(path, cwd);
}

export async function runDev(name: string | undefined, opts: DevOpts): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const agentDir = dirname(configPath);
  const mode = opts.internalMode === "launchd" ? ("launchd" as const) : ("dev" as const);
  const requestedRuntimeDataRoot = resolveRuntimeDataRoot(opts.internalMode);
  const runtimeDataRoot = requestedRuntimeDataRoot
    ? prepareRailwayRuntimeVolume(process.env.RAILWAY_VOLUME_MOUNT_PATH)
    : undefined;

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
  let pidManifestClaimed = false;
  try {
    pidManifestClaimed = claimRuntimePidManifest(
      {
        pid: process.pid,
        name: agentName,
        port,
        configPath: resolve(configPath),
        agentDir: resolve(agentDir),
        startedAt: new Date().toISOString(),
        mode,
      },
      { internalMode: opts.internalMode },
    );
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EEXIST") {
      throw new Error(formatAgentAlreadyRunningMessage(agentName, readPidManifest(agentName)));
    }
    throw err;
  }

  // From here on, clean up the PID manifest on any failure.
  let model: ModelClient;
  let augments: Augment[];
  let agentConfig: AgentConfig;
  try {
    model = await resolveEngine(config.engine, agentDir);
    augments = await resolveAugments(config.augments, agentDir, {
      creator: config.creator,
      ...(runtimeDataRoot ? { runtimeDataRoot } : {}),
      selfInspection: {
        name: agentName,
        displayName: config.displayName,
        purpose: config.purpose,
        engine: {
          provider: config.engine.provider,
          model: config.engine.model,
        },
        creator: config.creator,
      },
    });
    agentConfig = {
      name: agentName,
      displayName: config.displayName,
      creator: config.creator,
      purpose: config.purpose,
      model: config.engine.model,
      augments,
      contextBudget: config.settings.contextBudget,
      compactionStrategy: config.settings.compactionStrategy,
      maxInferenceLoops: config.settings.maxInferenceLoops,
      responseLimits: config.engine.responseLimits,
    };
  } catch (err) {
    releaseRuntimePidManifest(agentName, pidManifestClaimed);
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
    releaseRuntimePidManifest(agentName, pidManifestClaimed);
    console.log(`${agentName} stopped.`);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  // Also clean up PID on unexpected exit.
  process.on("exit", () => {
    releaseRuntimePidManifest(agentName, pidManifestClaimed);
  });

  // Start the agent.
  console.log("Starting services:");
  await agent.start();

  const consoleUrl = port ? `http://localhost:${port}/console` : null;
  console.log(
    `\n${formatDevReadyMessage({
      agentName,
      port,
      configPath: formatRunDisplayPath(configPath, opts.cwd),
      deployCommand: name ? `auggy deploy ${agentName}` : "auggy deploy",
      runtime: opts.internalMode === "railway" ? "railway" : "local",
      publicUrl: process.env.AUGGY_PUBLIC_URL,
    })}`,
  );

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
