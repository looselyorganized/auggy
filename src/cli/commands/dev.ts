/** Foreground/launchd command adapter for the shared managed application host. */
import { realpathSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  runLegacyApplication,
  runManagedApplication,
  type ManagedLaunchOptions,
} from "../../application/runner";
import { readApplicationDefinition } from "../application-definition";
import { inspectProjectRuntime } from "../project-runtime";
import { resolveConfigPath } from "../resolve-config";
import { openConsoleWithSignIn } from "../console-login";
import type { ParsedConfig } from "../types";
import { displayPath } from "../display-path";

function extractConsoleBearer(config: ParsedConfig): string | null {
  for (const augment of config.augments) {
    if (augment.type !== "webTransport") continue;
    const auth = augment.options?.auth;
    if (!auth || typeof auth !== "object" || Array.isArray(auth)) return null;
    const record = auth as Record<string, unknown>;
    return record.type === "bearer" && typeof record.token === "string" && record.token
      ? record.token
      : null;
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
  /** Internal: restart already holds this agent's lifecycle admission lease. */
  lifecycleOwned?: boolean;
  /** Internal/test registry seams. */
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
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
    lines.push(
      args.runtime === "railway"
        ? "  Password: AUGGY_WEB_TOKEN Railway variable (if the sign-in screen appears)"
        : "  Password: AUGGY_WEB_TOKEN in .env (if the sign-in screen appears)",
    );
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
  const definition = readApplicationDefinition(configPath);
  if (definition) {
    const selected = inspectProjectRuntime(definition.projectDir, { applicationContract: 1 });
    const executingPackage = realpathSync(fileURLToPath(new URL("../../../", import.meta.url)));
    if (selected.packageRoot !== executingPackage) {
      throw new Error(
        "[runtime] application startup must execute the selected project-local Auggy CLI",
      );
    }
  }
  let consoleBearer: string | null = null;
  const options: ManagedLaunchOptions = {
    configPath,
    mode:
      opts.internalMode === "launchd"
        ? "launchd"
        : opts.internalMode === "railway"
          ? "railway"
          : "foreground",
    lifetime: "return-after-ready",
    lifecycleOwned: opts.lifecycleOwned,
    auggyDir: opts.auggyDir,
    processIdentityForPid: opts.processIdentityForPid,
    onConfigured(config) {
      consoleBearer = extractConsoleBearer(config);
      if (name && config.name !== name) {
        console.warn(
          `Warning: agent name in config ("${config.name}") differs from CLI argument ("${name}"). Using "${config.name}".`,
        );
      }
    },
    async onReady(ready) {
      const agentName = ready.agentName;
      const web = ready.http[0];
      const port = web?.port ?? null;
      const consoleUrl = web?.consoleUrl ?? null;
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
      // The permanent bearer stays in this package-owned callback, never in readiness or a URL.
      if (opts.open && consoleUrl && web) {
        if (!consoleBearer) {
          console.warn("[runtime] automatic Console sign-in is not configured");
        } else {
          try {
            const result = await openConsoleWithSignIn({
              baseUrl: web.localBaseUrl,
              bearer: consoleBearer,
            });
            if (!result.automaticSignIn) {
              console.warn(
                "Automatic sign-in was unavailable; use AUGGY_WEB_TOKEN from .env on the password screen.",
              );
            }
            if (!result.opened) {
              console.log(
                `  (couldn't auto-launch the browser; open ${result.consoleUrl} manually)`,
              );
            }
          } catch {
            console.error("[runtime] browser-open-failed");
          }
        }
      }
      opts.onReady?.({ agentName, port, consoleUrl });
    },
  };
  console.log("Starting services:");
  if (definition) {
    const entry = await import(pathToFileURL(definition.entrypointPath).href);
    if (typeof entry.main !== "function") {
      throw new Error("[application] entrypoint must export a named main function");
    }
    await runManagedApplication(entry.main, options);
  } else {
    await runLegacyApplication(options);
  }
}
