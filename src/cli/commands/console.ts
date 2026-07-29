import { dirname, join } from "node:path";
import { Command } from "commander";
import { readBoundCloudRecord } from "../agent-index";
import { openConsoleWithSignIn, type OpenConsoleResult } from "../console-login";
import { displayPath } from "../display-path";
import { openBrowser, type OpenBrowserResult } from "../open-browser";
import { readLivePidManifest } from "../pid-registry";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import type { PidManifest } from "../types";
import { parseAgentIdOnly, parseAugmentConfigOnly } from "../yaml-helpers";

export interface ConsoleOpts {
  config?: string;
  cloud?: boolean;
  cwd?: string;
  auggyDir?: string;
  processIdentityForPid?: (pid: number) => string | null;
}

interface ConsoleCommandDeps {
  runConsole?: (name: string | undefined, opts: ConsoleOpts) => Promise<void>;
  exit?: (code: number) => void;
}

interface RunConsoleDeps {
  readLiveManifest?: (
    identifier: string,
    opts: Pick<ConsoleOpts, "auggyDir" | "processIdentityForPid">,
  ) => PidManifest | null;
  openConsole?: (args: {
    baseUrl: string;
    bearer: string;
    open: (url: string) => OpenBrowserResult;
  }) => Promise<OpenConsoleResult>;
  open?: (url: string) => OpenBrowserResult;
  log?: (message: string) => void;
  warn?: (message: string) => void;
}

export function consoleCommand(deps: ConsoleCommandDeps = {}): Command {
  const run = deps.runConsole ?? runConsole;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("console")
    .description("Open an agent's local or Railway Console with a one-time sign-in")
    .argument("[name]", "agent name (defaults to ./agent.yaml)")
    .option("--config <path>", "path to agent.yaml")
    .option("--cloud", "open the saved Railway deployment even when the agent is running locally")
    .action(async (name: string | undefined, opts: { config?: string; cloud?: boolean }) => {
      try {
        await run(name, { config: opts.config, cloud: opts.cloud });
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        exit(1);
      }
    });
}

export async function runConsole(
  name: string | undefined,
  opts: ConsoleOpts = {},
  deps: RunConsoleDeps = {},
): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const agentDir = dirname(configPath);
  const agentId = parseAgentIdOnly(configPath);
  const agentName = readAgentName(configPath);
  const webOptions = parseAugmentConfigOnly(configPath, "webTransport");
  const bearer = readConsoleBearer(webOptions);
  const liveManifest = opts.cloud
    ? null
    : (deps.readLiveManifest ?? readLivePidManifest)(agentId, {
        auggyDir: opts.auggyDir,
        processIdentityForPid: opts.processIdentityForPid,
      });

  let runtime: "local" | "Railway";
  let baseUrl: string;
  if (liveManifest?.port) {
    runtime = "local";
    baseUrl = `http://localhost:${liveManifest.port}`;
  } else {
    const cloud = readBoundCloudRecord(agentDir, agentId);
    if (!cloud) {
      const localHint = liveManifest
        ? "The local agent is running without a Console web port."
        : `Run \`auggy run ${agentName}\` first, or deploy it to Railway.`;
      throw new Error(`No Console is available for "${agentName}". ${localHint}`);
    }
    runtime = "Railway";
    baseUrl = cloud.url;
  }

  const open = deps.open ?? openBrowser;
  const result = await (deps.openConsole ?? openConsoleWithSignIn)({ baseUrl, bearer, open });
  const log = deps.log ?? console.log;
  const warn = deps.warn ?? console.warn;
  if (result.automaticSignIn && result.opened) {
    log(`Opened ${runtime} Console for "${agentName}".`);
    return;
  }

  const envPath = displayPath(join(agentDir, ".env"), opts.cwd);
  warn(
    result.automaticSignIn
      ? "The browser could not be launched; use the password screen."
      : `Automatic sign-in was unavailable; ${result.opened ? "opened" : "use"} the password screen.`,
  );
  log(
    runtime === "Railway"
      ? `Password: AUGGY_WEB_TOKEN in Railway service variables (normally synced from ${envPath})`
      : `Password: AUGGY_WEB_TOKEN in ${envPath}`,
  );
  if (!result.opened) log(`Console: ${result.consoleUrl}`);
}

function readConsoleBearer(options: Record<string, unknown> | null): string {
  if (!options) {
    throw new Error("This agent does not have the webTransport augment required for Console.");
  }
  const auth = options.auth;
  if (!auth || typeof auth !== "object" || Array.isArray(auth)) {
    throw new Error("This agent's webTransport does not have Console authentication configured.");
  }
  const record = auth as Record<string, unknown>;
  if (record.type !== "bearer" || typeof record.token !== "string" || !record.token) {
    throw new Error("This agent's webTransport bearer token is missing.");
  }
  return record.token;
}
