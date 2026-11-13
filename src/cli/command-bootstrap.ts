import { spawn } from "node:child_process";
import { constants } from "node:os";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { Command, CommanderError } from "commander";
import { readApplicationDefinition } from "./application-definition";
import {
  createLaunchCommand,
  PROJECT_COMMANDS,
  type BootstrapCommand,
} from "./launch-command-options";
import { inspectProjectRuntime, type ProjectRuntime } from "./project-runtime";
import { resolveConfigPath } from "./resolve-config";

const DELEGATION_ENV = "AUGGY_CLI_DELEGATION";
const CURRENT_PACKAGE_ROOT = realpathSync(resolve(import.meta.dir, "../.."));
const IMMUTABLE_ID = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface Selection {
  readonly configPath: string;
  readonly runtime: ProjectRuntime;
}

/** Read location/declaration/package metadata only; never load project .env or code. */
export function inspectLaunchSelection(configPath: string): Selection {
  const canonicalConfig = join(realpathSync(dirname(resolve(configPath))), basename(configPath));
  const application = readApplicationDefinition(canonicalConfig);
  const runtime = inspectProjectRuntime(dirname(canonicalConfig), {
    applicationContract: application?.application.contractVersion,
  });
  return { configPath: canonicalConfig, runtime };
}

export function assertCurrentProjectRuntime(selection: Selection): void {
  if (selection.runtime.packageRoot !== CURRENT_PACKAGE_ROOT) {
    throw new Error(
      "[runtime] invoke this command through the project's local Auggy CLI; the selected runtime differs from this process",
    );
  }
}

interface DelegationEnvelope {
  protocol: 1;
  configPath: string;
  packageRoot: string;
  cliPath: string;
  manifestSHA256: string;
}

function envelopeFor(selection: Selection): DelegationEnvelope {
  return {
    protocol: 1,
    configPath: selection.configPath,
    packageRoot: selection.runtime.packageRoot,
    cliPath: selection.runtime.cliPath,
    manifestSHA256: selection.runtime.manifestSHA256,
  };
}

export function validateDelegationEnvelope(
  value: string | undefined,
  selection: Selection,
  currentRoot: string,
): void {
  if (value === undefined) return;
  let parsed: unknown;
  try {
    if (value.length > 16_384) throw new Error();
    parsed = JSON.parse(value);
  } catch {
    throw new Error("[runtime] invalid local CLI delegation envelope");
  }
  const expected = envelopeFor(selection);
  if (
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== Object.keys(expected).length ||
    Object.entries(expected).some(
      ([key, entry]) => (parsed as Record<string, unknown>)[key] !== entry,
    ) ||
    currentRoot !== selection.runtime.packageRoot
  ) {
    throw new Error(
      "[runtime] local CLI selection changed during delegation; refusing a second hop",
    );
  }
}

export interface ParsedBootstrapCommand {
  command: BootstrapCommand;
  name: string | undefined;
  options: { config?: string; [key: string]: unknown };
}

/** Commander validates the exact shared grammar before any config inspection. */
export function parseBootstrapCommand(
  argv: readonly string[],
): ParsedBootstrapCommand | { exitCode: number } | null {
  // Commander accepts a root option terminator before a subcommand.
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const first = args[0];
  if (!first || ![...PROJECT_COMMANDS, "stop", "status"].includes(first)) return null;
  const command = first as BootstrapCommand;
  const program = new Command("auggy").exitOverride();
  let result: ParsedBootstrapCommand | undefined;
  program.addCommand(
    createLaunchCommand(command)
      .exitOverride()
      .action((name, options) => {
        result = { command, name, options };
      }),
  );
  try {
    program.parse([...argv], { from: "user" });
  } catch (error) {
    if (error instanceof CommanderError) return { exitCode: error.exitCode };
    throw error;
  }
  return result ?? null;
}

function withCanonicalConfig(argv: readonly string[], configPath: string): string[] {
  if (argv[0] === "deploy") return [...argv];
  const options = createLaunchCommand(argv[0] as BootstrapCommand).options;
  const rewritten: string[] = [];
  let positionalOnly = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (!positionalOnly && arg === "--") {
      rewritten.push("--config", configPath);
      positionalOnly = true;
    }
    if (!positionalOnly && arg === "--config") {
      i++;
      continue;
    }
    if (!positionalOnly && arg.startsWith("--config=")) continue;
    rewritten.push(arg);
    if (!positionalOnly) {
      const option = options.find((candidate) => candidate.long === arg || candidate.short === arg);
      // A required option's value is data even if it resembles --config or --.
      if (option?.required && i + 1 < argv.length) rewritten.push(argv[++i]!);
    }
  }
  if (!positionalOnly) rewritten.push("--config", configPath);
  return rewritten;
}

async function delegate(selection: Selection, argv: readonly string[]): Promise<number> {
  return await new Promise<number>((resolveExit, reject) => {
    const child = spawn(process.execPath, [selection.runtime.cliPath, ...argv], {
      cwd: process.cwd(),
      stdio: "inherit",
      env: { ...process.env, [DELEGATION_ENV]: JSON.stringify(envelopeFor(selection)) },
    });
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const forward = (signal: "SIGINT" | "SIGTERM") => {
      child.kill(signal);
      // Give the managed runner its 15-second cleanup observation budget.
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 16_000);
    };
    const interrupt = () => forward("SIGINT");
    const terminate = () => forward("SIGTERM");
    const parentExit = () => child.kill("SIGTERM");
    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", terminate);
      process.off("exit", parentExit);
    };
    process.on("SIGINT", interrupt);
    process.on("SIGTERM", terminate);
    process.once("exit", parentExit);
    child.once("error", (error) => {
      cleanup();
      reject(error);
    });
    child.once("exit", (code, signal) => {
      cleanup();
      resolveExit(code ?? (signal ? 128 + (constants.signals[signal] ?? 1) : 1));
    });
  });
}

export type BootstrapResult =
  | { kind: "continue"; argv: string[] }
  | { kind: "handled"; exitCode: number };

export async function bootstrapCli(argv: readonly string[]): Promise<BootstrapResult> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  const parsed = parseBootstrapCommand(argv);
  if (!parsed) return { kind: "continue", argv: [...argv] };
  if ("exitCode" in parsed) return { kind: "handled", exitCode: parsed.exitCode };
  if (parsed.command === "stop") {
    await (await import("./commands/stop")).runStop(parsed.name!);
    return { kind: "handled", exitCode: 0 };
  }
  if (parsed.command === "status") {
    await (await import("./commands/status")).runStatus(parsed.name);
    return { kind: "handled", exitCode: 0 };
  }
  let configPath: string;
  let selection: Selection;
  try {
    if (
      parsed.command === "restart" &&
      parsed.name &&
      IMMUTABLE_ID.test(parsed.name) &&
      !parsed.options.config
    ) {
      const manifest = (await import("./pid-registry")).readPidManifest(parsed.name);
      // The legacy recovery diagnostic has no process to restart or project to select.
      if (!manifest) return { kind: "continue", argv: [...argv] };
      configPath = resolveConfigPath(undefined, manifest.configPath);
    } else {
      configPath = resolveConfigPath(parsed.name, parsed.options.config);
    }
    selection = inspectLaunchSelection(configPath);
  } catch (error) {
    // Doctor reports absent/broken installs itself; it never invokes main.
    if (parsed.command === "doctor" && process.env[DELEGATION_ENV] === undefined) {
      return { kind: "continue", argv: [...argv] };
    }
    throw error;
  }
  validateDelegationEnvelope(process.env[DELEGATION_ENV], selection, CURRENT_PACKAGE_ROOT);
  const selectedArgv = withCanonicalConfig(args, selection.configPath);
  if (selection.runtime.packageRoot === CURRENT_PACKAGE_ROOT) {
    return { kind: "continue", argv: selectedArgv };
  }
  return { kind: "handled", exitCode: await delegate(selection, selectedArgv) };
}
