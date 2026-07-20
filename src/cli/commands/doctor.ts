/**
 * `auggy doctor <name>` — local readiness checks for an agent.
 *
 * Doctor does not boot the agent. It validates the setup pieces that most
 * often block `create -> run`: config resolution/parsing, per-agent package
 * install, web port availability, and bundled skills.
 */

import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { createServer } from "node:net";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { parseConfig } from "../config-parser";
import { resolveConfigPath } from "../resolve-config";
import { PROVIDER_TO_PACKAGE } from "../scaffold-package-json";
import { AUGMENT_CATALOG } from "../augment-catalog";
import { augmentFolderForType } from "../scaffold-skills";
import { parseEnvFile } from "../env-parse";
import { diagnoseMcpConfig } from "../mcp-config";
import { describeEnginePricing, hasUsdBudgetCaps } from "../model-registry";
import {
  MODEL_SNAPSHOT_RELATIVE_PATH,
  formatModelSnapshotRef,
  readModelSnapshot,
} from "../model-snapshot";
import {
  formatRouteManifestEntry,
  inspectAugmentRoutes,
  isIntentionalFrameworkPublicRoute,
} from "../route-inspector";
import type { AugmentConfig, ParsedConfig } from "../types";

export type DoctorStatus = "pass" | "info" | "warn" | "fail";

export interface DoctorCheck {
  name: string;
  status: DoctorStatus;
  message: string;
  fix?: string;
}

export interface DoctorOptions {
  config?: string;
  auggyDir?: string;
  cwd?: string;
  isPortAvailable?: (port: number) => Promise<boolean>;
  cloud?: boolean;
}

export interface DoctorCommandDeps {
  runDoctor?: (name: string | undefined, opts: DoctorOptions) => Promise<DoctorCheck[]>;
  exit?: (code: number) => void;
}

export async function runDoctor(
  name: string | undefined,
  opts: DoctorOptions = {},
): Promise<DoctorCheck[]> {
  const checks: DoctorCheck[] = [];

  let configPath: string;
  try {
    configPath = resolveConfigPath(name, opts.config, { auggyDir: opts.auggyDir, cwd: opts.cwd });
    checks.push({
      name: "config path",
      status: "pass",
      message: configPath,
    });
  } catch (err) {
    checks.push({
      name: "config path",
      status: "fail",
      message: (err as Error).message,
      fix: name
        ? `Run \`auggy create ${name}\` or pass \`--config <path>\`.`
        : "Run from inside an agent project, pass an agent name, or pass `--config <path>`.",
    });
    return checks;
  }

  const agentDir = dirname(configPath);

  let config: ParsedConfig;
  try {
    config = parseConfig(configPath);
    checks.push({
      name: "agent.yaml",
      status: "pass",
      message: `parsed ${config.name}`,
    });
  } catch (err) {
    checks.push({
      name: "agent.yaml",
      status: "fail",
      message: (err as Error).message,
    });
    return checks;
  }

  checks.push(checkPackageManifest(agentDir));
  checks.push(...checkConfigEnvReferences(configPath, agentDir));
  checks.push(...checkLearnedBehaviorFiles(agentDir, config));
  checks.push(...checkProviderEnv(agentDir, config));
  checks.push(...checkAgentDependencies(agentDir, config));
  checks.push(...checkRuntimeSource(agentDir));
  checks.push(checkModelPricing(config));
  checks.push(...checkModelSnapshot(agentDir, config));
  checks.push(...(await checkWebPorts(config, opts.isPortAvailable ?? isPortAvailable)));
  checks.push(...checkBundledSkills(agentDir, config.augments));
  checks.push(...(await checkAugmentRoutes(agentDir, config.augments)));
  checks.push(...checkMcp(agentDir, config, opts.cloud ?? false));

  return checks;
}

function checkModelSnapshot(agentDir: string, config: ParsedConfig): DoctorCheck[] {
  const result = readModelSnapshot(agentDir);
  if (result.kind === "missing") return [];
  if (result.kind === "invalid") {
    return [
      {
        name: "model snapshot",
        status: "warn",
        message: `${MODEL_SNAPSHOT_RELATIVE_PATH}: ${result.error}`,
        fix: `Delete ${MODEL_SNAPSHOT_RELATIVE_PATH}, or recreate the agent to regenerate it.`,
      },
    ];
  }

  const selected = result.snapshot.selected;
  if (selected.provider !== config.engine.provider || selected.model !== config.engine.model) {
    return [
      {
        name: "model snapshot",
        status: "info",
        message: `${formatModelSnapshotRef(selected)} does not match agent.yaml ${config.engine.provider}/${config.engine.model}`,
        fix: `Update or delete ${MODEL_SNAPSHOT_RELATIVE_PATH}; agent.yaml remains the source of truth.`,
      },
    ];
  }

  const created = result.snapshot.createdAt.slice(0, 10);
  const source = selected.source === "provider" ? (selected.status ?? "provider") : selected.source;
  const pricing = selected.pricingKnown ? "priced" : "unpriced";
  return [
    {
      name: "model snapshot",
      status: "pass",
      message: `${source}, ${pricing}, captured ${created}`,
    },
  ];
}

function checkModelPricing(config: ParsedConfig): DoctorCheck {
  const pricing = describeEnginePricing(config.engine);
  if (pricing.status !== "unknown") {
    return {
      name: "model pricing",
      status: "pass",
      message: pricing.message,
    };
  }

  const usdBudgets = hasUsdBudgetCaps(config.augments);
  return {
    name: "model pricing",
    status: usdBudgets ? "warn" : "info",
    message: pricing.message,
    fix: usdBudgets
      ? "Add engine.costOverride in agent.yaml so budgets can enforce USD caps for this model."
      : "Allowed. Add engine.costOverride before enabling USD budget caps.",
  };
}

function checkLearnedBehaviorFiles(agentDir: string, config: ParsedConfig): DoctorCheck[] {
  const canonical = join(agentDir, "learned-behaviors.md");
  const legacy = join(agentDir, "learned.md");
  const hasCanonical = existsSync(canonical);
  const hasLegacy = existsSync(legacy);
  const usesLearnedBehaviorStore = config.augments.some(
    (aug) =>
      aug.type === "fileMemory" &&
      aug.options?.label === "learned" &&
      typeof aug.options.source === "string",
  );

  if (!usesLearnedBehaviorStore && !hasCanonical && !hasLegacy) {
    return [];
  }

  if (hasCanonical && hasLegacy) {
    return [
      {
        name: "learned behavior files",
        status: "warn",
        message:
          "both learned-behaviors.md and legacy learned.md exist; runtime prefers learned-behaviors.md",
        fix: "Consolidate behavior notes into learned-behaviors.md, then remove learned.md after confirming nothing relies on it.",
      },
    ];
  }

  if (hasCanonical) {
    return [
      {
        name: "learned behavior files",
        status: "pass",
        message: "learned-behaviors.md",
      },
    ];
  }

  if (hasLegacy) {
    return [
      {
        name: "learned behavior files",
        status: "warn",
        message: "using legacy learned.md; new agents use learned-behaviors.md",
        fix: "Rename or copy learned.md to learned-behaviors.md when you are ready to migrate.",
      },
    ];
  }

  return [
    {
      name: "learned behavior files",
      status: "warn",
      message: "no learned behavior file found",
      fix: "Create learned-behaviors.md if this agent uses the default fileMemory learned behavior store.",
    },
  ];
}

function checkMcp(agentDir: string, config: ParsedConfig, cloud: boolean): DoctorCheck[] {
  if (!config.augments.some((aug) => aug.type === "mcp")) return [];
  return diagnoseMcpConfig(agentDir, { cloud });
}

function checkPackageManifest(agentDir: string): DoctorCheck {
  const packagePath = join(agentDir, "package.json");
  if (existsSync(packagePath)) {
    return {
      name: "package.json",
      status: "pass",
      message: packagePath,
    };
  }

  return {
    name: "package.json",
    status: "fail",
    message: `missing ${packagePath}`,
    fix: "Re-run create for this agent, or add package.json with auggy + the selected engine adapter, then run bun install.",
  };
}

function checkConfigEnvReferences(configPath: string, agentDir: string): DoctorCheck[] {
  const vars = collectConfigEnvReferences(configPath, agentDir);
  if (vars.length === 0) return [];

  const envPath = join(agentDir, ".env");
  const env = readEnvValues(envPath);

  return vars.map((key) => {
    const value = env.values.get(key) ?? process.env[key];
    if (value?.trim()) {
      return {
        name: `env ${key}`,
        status: "pass",
        message: env.values.has(key) ? envPath : "shell environment",
      };
    }

    return {
      name: `env ${key}`,
      status: "fail",
      message: env.error
        ? `could not read ${envPath}: ${env.error}`
        : `missing value in ${envPath}`,
      fix: `Set ${key}=<value> in ${envPath}.`,
    };
  });
}

function collectEnvReferences(text: string): string[] {
  const vars = new Set<string>();
  for (const match of text.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
    const key = match[1];
    if (key) vars.add(key);
  }
  return [...vars].sort();
}

function collectConfigEnvReferences(configPath: string, agentDir: string): string[] {
  const vars = new Set<string>();
  const add = (keys: string[]) => {
    for (const key of keys) vars.add(key);
  };

  const agentYaml = readFileSync(configPath, "utf-8");
  add(collectEnvReferences(agentYaml));

  const parsed = parseYaml(agentYaml);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return [...vars].sort();

  const augments = (parsed as Record<string, unknown>).augments;
  if (!Array.isArray(augments)) return [...vars].sort();

  for (const entry of augments) {
    if (typeof entry !== "string") continue;
    const metadataPath = join(agentDir, "augments", entry, "augment.yaml");
    if (!existsSync(metadataPath)) continue;
    add(collectEnvReferences(readFileSync(metadataPath, "utf-8")));
  }

  return [...vars].sort();
}

function readEnvValues(envPath: string): { values: Map<string, string>; error?: string } {
  const values = new Map<string, string>();
  if (!existsSync(envPath)) return { values };

  try {
    for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
      if (line.kind === "kv") values.set(line.key, line.value);
    }
    return { values };
  } catch (err) {
    return { values, error: (err as Error).message };
  }
}

const PROVIDER_ENV_VARS: Partial<Record<ParsedConfig["engine"]["provider"], string>> = {
  anthropic: "ANTHROPIC_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
};

function checkProviderEnv(agentDir: string, config: ParsedConfig): DoctorCheck[] {
  const envVar = PROVIDER_ENV_VARS[config.engine.provider];
  if (!envVar) return [];

  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) {
    return [
      {
        name: `env ${envVar}`,
        status: "fail",
        message: `missing ${envPath}`,
        fix: `Create ${envPath} and set ${envVar}.`,
      },
    ];
  }

  let value: string | undefined;
  try {
    for (const line of parseEnvFile(readFileSync(envPath, "utf-8"))) {
      if (line.kind === "kv" && line.key === envVar) value = line.value;
    }
  } catch (err) {
    return [
      {
        name: `env ${envVar}`,
        status: "fail",
        message: `could not read ${envPath}: ${(err as Error).message}`,
        fix: `Make ${envPath} readable and set ${envVar}.`,
      },
    ];
  }

  if (!value?.trim()) {
    return [
      {
        name: `env ${envVar}`,
        status: "fail",
        message: `missing value in ${envPath}`,
        fix: `Set ${envVar}=<your ${config.engine.provider} key> in ${envPath}.`,
      },
    ];
  }

  return [
    {
      name: `env ${envVar}`,
      status: "pass",
      message: envPath,
    },
  ];
}

function checkAgentDependencies(agentDir: string, config: ParsedConfig): DoctorCheck[] {
  const packages = collectRequiredPackages(config);
  return packages.map((pkg) => {
    const packageRoot = join(agentDir, "node_modules", packageNameFromSpecifier(pkg));
    if (existsSync(packageRoot)) {
      return {
        name: `dependency ${pkg}`,
        status: "pass",
        message: packageRoot,
      };
    }

    return {
      name: `dependency ${pkg}`,
      status: "fail",
      message: `missing ${packageRoot}`,
      fix: `Run \`cd ${agentDir} && bun install\`.`,
    };
  });
}

function checkRuntimeSource(agentDir: string): DoctorCheck[] {
  const packageRoot = join(agentDir, "node_modules", "auggy");
  if (!existsSync(packageRoot)) return [];

  const sourceRoot = join(packageRoot, "src");
  if (existsSync(sourceRoot)) {
    return [
      {
        name: "runtime auggy",
        status: "pass",
        message: sourceRoot,
      },
    ];
  }

  return [
    {
      name: "runtime auggy",
      status: "warn",
      message: `source not found at ${sourceRoot}`,
      fix: "Reinstall the agent dependencies with `bun install`.",
    },
  ];
}

function collectRequiredPackages(config: ParsedConfig): string[] {
  const packages = new Set<string>(["auggy", PROVIDER_TO_PACKAGE[config.engine.provider]]);
  for (const aug of config.augments) {
    const entry = AUGMENT_CATALOG.find((e) => e.type === aug.type);
    if (!entry?.packageDeps) continue;
    for (const pkg of Object.keys(entry.packageDeps)) packages.add(pkg);
  }
  return [...packages].sort();
}

function packageNameFromSpecifier(specifier: string): string {
  if (!specifier.startsWith("@")) return specifier.split("/")[0] ?? specifier;
  const [scope, name] = specifier.split("/");
  if (!scope || !name) return specifier;
  return `${scope}/${name}`;
}

async function checkWebPorts(
  config: ParsedConfig,
  checkPort: (port: number) => Promise<boolean>,
): Promise<DoctorCheck[]> {
  const out: DoctorCheck[] = [];
  for (const aug of config.augments) {
    if (aug.type !== "webTransport") continue;
    const port = aug.options?.port;
    if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
      out.push({
        name: `port ${aug.name}`,
        status: "warn",
        message: "webTransport has no concrete positive integer port to check",
      });
      continue;
    }

    const available = await checkPort(port);
    if (available) {
      out.push({
        name: `port ${port}`,
        status: "pass",
        message: "available",
      });
    } else {
      out.push({
        name: `port ${port}`,
        status: "fail",
        message: "already in use",
        fix: `Stop the process using port ${port}, or change config.port in augments/${aug.name}/augment.yaml.`,
      });
    }
  }
  return out;
}

function checkBundledSkills(agentDir: string, augments: AugmentConfig[]): DoctorCheck[] {
  const out: DoctorCheck[] = [];
  for (const aug of augments) {
    const folder = augmentFolderForType(aug.type);
    if (!folder) continue;

    const bundledSkillPath = resolve(
      import.meta.dir,
      "../../augments",
      folder,
      "skill",
      "SKILL.md",
    );
    if (!existsSync(bundledSkillPath)) continue;

    const mountedSkillPath = join(agentDir, "skills", folder, "SKILL.md");
    if (existsSync(mountedSkillPath)) {
      out.push({
        name: `skill ${folder}`,
        status: "pass",
        message: mountedSkillPath,
      });
    } else {
      out.push({
        name: `skill ${folder}`,
        status: "warn",
        message: `missing ${mountedSkillPath}`,
        fix: `Run \`auggy skill add ${folder} --agent ${nameForFix(agentDir)}\`, or re-add the augment.`,
      });
    }
  }
  return out;
}

async function checkAugmentRoutes(
  agentDir: string,
  configs: AugmentConfig[],
): Promise<DoctorCheck[]> {
  const inspected = await inspectAugmentRoutes(agentDir, configs);
  if (inspected.issues.length > 0) {
    return inspected.issues.map((issue) => ({
      name: "augment routes",
      status: "fail",
      message: issue.message,
      fix:
        issue.kind === "load" || issue.kind === "boot"
          ? "Run `bun install`, then check the augment config, source paths, env vars, and boot diagnostics."
          : "Fix the route path, auth mode, or duplicate registration in the custom augment.",
    }));
  }

  const { manifest, summary } = inspected;
  if (manifest.length === 0) return [];

  const intentionalPublicRoutes = manifest.filter((route) =>
    isIntentionalFrameworkPublicRoute(route, configs),
  );
  const publicRoutesToReview = manifest.filter(
    (route) => route.public && !isIntentionalFrameworkPublicRoute(route, configs),
  );

  const checks: DoctorCheck[] = [];
  if (publicRoutesToReview.length > 0) {
    checks.push({
      name: "augment route posture",
      status: "warn",
      message: `${summary.totalRoutes} route(s): ${summary.publicRoutes} public, ${summary.privateRoutes} private`,
      fix: 'Review public routes and confirm auth: "none" or auth: "visitor.optional" is intentional.',
    });
  } else if (intentionalPublicRoutes.length > 0) {
    checks.push({
      name: "visitorAuth routes",
      status: "info",
      message: `${intentionalPublicRoutes.length} intentional public routes for magic-link request and verification; rate-limited, with agent tools protected separately`,
    });
  } else {
    checks.push({
      name: "augment route posture",
      status: "pass",
      message: `${summary.totalRoutes} route(s): 0 public, ${summary.privateRoutes} private`,
    });
  }

  for (const route of manifest) {
    if (isIntentionalFrameworkPublicRoute(route, configs)) continue;
    checks.push({
      name: `route ${route.method} ${route.path}`,
      status: route.public ? "warn" : "pass",
      message: formatRouteManifestEntry(route),
      fix: route.public
        ? 'Set auth: "creator", auth: "bearer", auth: "visitor.required", or auth: "agent.required" unless this route is intentionally public.'
        : undefined,
    });
  }

  return checks;
}

function nameForFix(agentDir: string): string {
  return agentDir.split(/[\\/]/).filter(Boolean).at(-1) ?? "<name>";
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolvePort) => {
    const server = createServer();
    server.once("error", () => resolvePort(false));
    server.once("listening", () => {
      server.close(() => resolvePort(true));
    });
    // Match webTransport/Bun's broad bind semantics. A loopback-only probe can
    // miss an existing wildcard/IPv6 listener and report a false "available".
    server.listen(port);
  });
}

export function hasDoctorFailures(checks: DoctorCheck[]): boolean {
  return checks.some((c) => c.status === "fail");
}

export interface FormatDoctorChecksOptions {
  relativeTo?: string;
  color?: boolean;
  verbose?: boolean;
}

export function formatDoctorChecks(
  checks: DoctorCheck[],
  opts: FormatDoctorChecksOptions = {},
): string {
  if (!opts.verbose) {
    return checks
      .filter((check) => !(check.name === "runtime auggy" && check.status === "pass"))
      .map((check) => formatDoctorCheckSummary(check, opts))
      .join("\n");
  }

  return checks
    .map((check) => {
      const status = formatStatus(check.status, opts.color ?? false);
      const message = compactPaths(check.message, opts.relativeTo);
      const head = `${status.padEnd(opts.color ? 13 : 4)} ${check.name}: ${message}`;
      return check.fix ? `${head}\n     fix: ${compactPaths(check.fix, opts.relativeTo)}` : head;
    })
    .join("\n");
}

function formatDoctorCheckSummary(check: DoctorCheck, opts: FormatDoctorChecksOptions): string {
  const status = formatStatus(check.status, opts.color ?? false);
  const summary = summarizeDoctorCheck(check);
  const head = `${status.padEnd(opts.color ? 13 : 4)} ${summary}`;
  return check.fix ? `${head}\n     fix: ${compactPaths(check.fix, opts.relativeTo)}` : head;
}

function summarizeDoctorCheck(check: DoctorCheck): string {
  if (check.name === "augment route posture") {
    return `route posture: ${check.message}`;
  }
  if (check.name.startsWith("route ")) {
    return `route: ${check.name.slice("route ".length)} ${check.message}`;
  }
  if (check.status === "fail" || check.status === "warn") {
    return `${check.name}: ${check.message}`;
  }

  if (check.name === "config path") return `config: ${basename(check.message)}`;
  if (check.name === "agent.yaml") return `agent: ${check.message.replace(/^parsed\s+/, "")}`;
  if (check.name === "package.json") return "package manifest: package.json";
  if (check.name.startsWith("env ")) return `env: ${check.name.slice("env ".length)}`;
  if (check.name.startsWith("dependency ")) {
    return `dependency: ${check.name.slice("dependency ".length)}`;
  }
  if (check.name === "model pricing") return `model pricing: ${check.message}`;
  if (check.name === "model snapshot") return `model snapshot: ${check.message}`;
  if (check.name.startsWith("port "))
    return `port: ${check.name.slice("port ".length)} ${check.message}`;
  if (check.name.startsWith("skill ")) return `skill: ${check.name.slice("skill ".length)}`;
  if (check.name === "mcp config") return "mcp config: .mcp.json";
  return `${check.name}: ${check.message}`;
}

function formatStatus(status: DoctorStatus, color: boolean): string {
  const label = status.toUpperCase();
  if (!color) return label;
  const code = status === "pass" ? 32 : status === "info" ? 36 : status === "warn" ? 33 : 31;
  return `\x1b[${code}m${label}\x1b[0m`;
}

function compactPaths(text: string, root: string | undefined): string {
  if (!root) return text;
  const normalizedRoot = resolve(root);
  return text.replace(/\/[^\s`'")]+/g, (candidate) => {
    const normalizedCandidate = resolve(candidate);
    if (
      normalizedCandidate !== normalizedRoot &&
      !normalizedCandidate.startsWith(`${normalizedRoot}/`)
    ) {
      return candidate;
    }
    const compact = relative(normalizedRoot, normalizedCandidate) || ".";
    return compact.startsWith("..") ? candidate : compact;
  });
}

function relativeOutputRoot(checks: DoctorCheck[]): string | undefined {
  const configPath = checks.find(
    (check) => check.name === "config path" && check.status === "pass",
  )?.message;
  return configPath ? dirname(configPath) : undefined;
}

export function doctorCommand(deps: DoctorCommandDeps = {}): Command {
  const run = deps.runDoctor ?? runDoctor;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("doctor")
    .description("Check whether an agent is ready to run")
    .argument("[name]", "agent name (defaults to ./agent.yaml)")
    .option("--config <path>", "path to agent.yaml")
    .option("--cloud", "include cloud deploy preflight checks")
    .option("--verbose", "show absolute paths")
    .action(
      async (
        name: string | undefined,
        opts: { config?: string; cloud?: boolean; verbose?: boolean },
      ) => {
        try {
          const checks = await run(name, { config: opts.config, cloud: opts.cloud });
          console.log(
            formatDoctorChecks(checks, {
              relativeTo: opts.verbose ? undefined : relativeOutputRoot(checks),
              color: process.stdout.isTTY,
              verbose: opts.verbose,
            }),
          );
          exit(hasDoctorFailures(checks) ? 1 : 0);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
        }
      },
    );
}
