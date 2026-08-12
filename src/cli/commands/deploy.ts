/**
 * `auggy deploy <name>` command.
 *
 * Orchestrates the first-deploy + redeploy flows:
 *
 *   first-deploy: presence + auth checks → operator prompt for projectId →
 *     stage bundle → write Dockerfile + entrypoint → link project →
 *     create service (or link --service existing) → addVolume →
 *     generateDomain → push secrets (.env + AUGGY_PUBLIC_URL) → up →
 *     capture status → write CloudRecord to index.
 *
 *   redeploy:    presence + auth checks → stage bundle → write Dockerfile +
 *     entrypoint → link (idempotent) → re-push secrets → up → status →
 *     update CloudRecord.deployedAt.
 *
 * Cleanly testable via a dependency-injected `RailwayCli` (real or mocked)
 * plus pluggable prompt + logger helpers — no I/O hardcoded into the orchestrator.
 *
 * Per D7 (architecture deltas in the v1.0 plan): the URL is captured BEFORE
 * `up` runs so AUGGY_PUBLIC_URL is set as a Railway env var, ensuring
 * visitorAuth sees the publicUrl on first boot. This avoids a first-boot
 * crash when agent.yaml interpolates `${AUGGY_PUBLIC_URL}` or similar.
 */

import {
  closeSync,
  constants,
  fstatSync,
  openSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { getAgentFromDir, readBoundCloudRecord, setCloudForDir } from "../agent-index";
import { parseConfig } from "../config-parser";
import { formatDoctorChecks, hasDoctorFailures, runDoctor } from "./doctor";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import { stageBundle } from "../deploy/bundle";
import { generateDockerfile, generateEntrypoint } from "../deploy/dockerfile";
import { waitForHealth, type HealthCheckOptions, type HealthCheckResult } from "../deploy/health";
import {
  RailwayWorkspaceRequiredError,
  type RailwayCli,
  type RailwayProject,
  type RailwayWorkspace,
} from "../deploy/railway-cli";
import { loadSecretsPlan } from "../deploy/secrets";
import { getAuggyVersion } from "../scaffold-package-json";
import { writeFileSafely } from "../safe-write";
import type { CloudRecord } from "../types";

export interface DeployLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
  task?<T>(msg: string, run: () => Promise<T>): Promise<T>;
}

export interface DeployOptions {
  to: "railway";
  yes: boolean;
  auggyDir?: string;
  cwd?: string;
  cli: RailwayCli;
  /** Existing Railway project ID. When omitted on first deploy, operator chooses new/existing. */
  project?: string;
  /** New Railway project name. When set on first deploy, creates a new project non-interactively. */
  projectName?: string;
  /** Prompt the operator to create a new Railway project or use an existing one. */
  promptProjectTarget: (args?: {
    workspace?: RailwayWorkspace | null;
    projects?: RailwayProject[];
  }) => Promise<"new" | "existing">;
  /** Prompt for a new Railway project name. */
  promptProjectName: (defaultName: string) => Promise<string>;
  /** Prompt the operator for a Railway project ID. */
  promptProjectId: (projects?: RailwayProject[]) => Promise<string>;
  /** Prompt the operator for a Railway workspace ID or name. */
  promptWorkspace: (workspaces: RailwayWorkspace[]) => Promise<string>;
  /** Prompt when this agent already has saved Railway deployment metadata. */
  promptSavedDeploymentTarget: (args: {
    cloud: NonNullable<CloudRecord>;
    metadataPath: string;
  }) => Promise<"saved" | "recreate" | "choose" | "reset" | "cancel">;
  /** Prompt whether to create a new service or bind an existing one. */
  promptServiceTarget: (args: { defaultServiceName: string }) => Promise<"new" | "existing">;
  /** Prompt for an existing Railway service name/id. */
  promptServiceName: (defaultName: string) => Promise<string>;
  /** Prompt the operator for yes/no confirmation. Receives a human-readable message. */
  promptConfirm: (message: string) => Promise<boolean>;
  logger: DeployLogger;
  healthCheck?: HealthCheckOptions | false;
  deployWait?: DeployWaitOptions | false;
  /**
   * Existing Railway service name/id to deploy into. Omit on first deploy to
   * create a new service named after the agent.
   */
  service?: string;
  /** Railway workspace ID or name used when creating a new project. */
  workspace?: string;
}

export interface DeployWaitOptions {
  timeoutMs?: number;
  intervalMs?: number;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

export interface DeployResult {
  name: string;
  url: string;
  projectId: string;
  serviceId: string;
  volumeId: string;
  health: HealthCheckResult;
}

const VOLUME_MOUNT_PATH = "/app/data";
const DEFAULT_DEPLOY_WAIT_TIMEOUT_MS = 10 * 60_000;
const DEFAULT_DEPLOY_WAIT_INTERVAL_MS = 5_000;

function isRailwayServiceNotFoundError(err: unknown): boolean {
  return /Service ".*" not found/i.test((err as Error).message ?? "");
}

function formatMissingServiceError(args: {
  name: string;
  projectId: string;
  serviceName: string;
  agentDir: string;
  explicitService: boolean;
}): Error {
  if (args.explicitService) {
    return new Error(
      `Railway service "${args.serviceName}" was not found in project ${args.projectId}.\n\n` +
        `  Check the service name in Railway, then rerun:\n` +
        `  auggy deploy ${args.name} --service <service-name>`,
    );
  }

  return new Error(
    `Saved Railway service "${args.serviceName}" was not found in project ${args.projectId}.\n\n` +
      `Local deploy metadata says this agent is already deployed:\n` +
      `  ${join(args.agentDir, ".auggy-cloud.json")}\n\n` +
      `If that Railway service was deleted, remove the metadata file and rerun:\n` +
      `  auggy deploy ${args.name}\n\n` +
      `If you want to bind this agent to an existing Railway service, rerun:\n` +
      `  auggy deploy ${args.name} --service <service-name>`,
  );
}

function clearCloudMetadataForDir(agentDir: string): void {
  const path = join(agentDir, ".auggy-cloud.json");
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function formatStaleCloudMetadataWarning(args: {
  serviceName: string;
  projectId: string;
  metadataPath: string;
}): string {
  return [
    "Stale Railway deploy metadata detected",
    "",
    `Saved service "${args.serviceName}" was not found in project ${args.projectId}.`,
    `Cleared ${args.metadataPath} and continuing as a first deploy.`,
  ].join("\n");
}

function maybeVendorLocalAuggyTarball(args: {
  agentDir: string;
  stagingDir: string;
  cwd?: string;
}): string | null {
  const maxStagedPackageBytes = 1024 * 1024;
  const maxRuntimeTarballBytes = 256 * 1024 * 1024;
  const version = getAuggyVersion();
  const tarballName = `auggy-${version}.tgz`;
  const candidates = [
    args.cwd,
    args.agentDir,
    dirname(args.agentDir),
    dirname(dirname(args.agentDir)),
    process.cwd(),
  ].filter((p): p is string => Boolean(p));

  const stagedPackagePath = join(args.stagingDir, "package.json");
  const stagedPackageBytes = readRegularFileNoFollow(stagedPackagePath, maxStagedPackageBytes);
  if (!stagedPackageBytes) return null;
  const parsed = JSON.parse(new TextDecoder().decode(stagedPackageBytes)) as {
    dependencies?: Record<string, string>;
  };
  const deps = parsed.dependencies;
  if (!deps?.auggy) return null;
  const explicitTarball = resolveFileAuggyTarball(deps.auggy, args.agentDir);
  const tarballCandidates = explicitTarball
    ? [explicitTarball]
    : /^\^?\d+\.\d+\.\d+/.test(deps.auggy)
      ? candidates.map((root) => resolve(root, tarballName))
      : [];
  let selectedTarball: { path: string; bytes: Uint8Array } | null = null;
  for (const candidate of tarballCandidates) {
    const bytes = readRegularFileNoFollow(candidate, maxRuntimeTarballBytes);
    if (bytes) {
      selectedTarball = { path: candidate, bytes };
      break;
    }
  }
  if (!selectedTarball) return null;

  const stagedTarballName = basename(selectedTarball.path);
  writeFileSafely(join(args.stagingDir, stagedTarballName), selectedTarball.bytes);
  deps.auggy = `file:./${stagedTarballName}`;
  writeFileSafely(stagedPackagePath, `${JSON.stringify(parsed, null, 2)}\n`);
  return stagedTarballName;
}

function readRegularFileNoFollow(path: string, maxBytes: number): Uint8Array | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      path,
      constants.O_RDONLY | (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
    );
    const stat = fstatSync(descriptor);
    if (!stat.isFile()) return null;
    if (!Number.isSafeInteger(stat.size) || stat.size < 0 || stat.size > maxBytes) {
      throw new Error(`deploy source file exceeds the ${maxBytes}-byte safety limit: ${path}`);
    }
    return readFileSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ELOOP") return null;
    throw error;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function configuredDatabaseArtifacts(config: ReturnType<typeof parseConfig>): string[] {
  const artifacts = new Set<string>();
  const addDatabase = (dbPath: string) => {
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      artifacts.add(`${dbPath}${suffix}`);
    }
  };
  for (const augment of config.augments) {
    for (const field of ["dbPath", "layeredMemoryDbPath"] as const) {
      const dbPath = augment.options?.[field];
      if (typeof dbPath !== "string" || dbPath.trim() === "") continue;
      addDatabase(dbPath);
    }
    if (augment.type === "webTransport") {
      const consoleDbPath = asRecord(augment.options?.consoleChat)?.dbPath;
      if (typeof consoleDbPath === "string" && consoleDbPath.trim() !== "") {
        addDatabase(consoleDbPath);
      }
    }
  }
  return [...artifacts];
}

function resolveFileAuggyTarball(spec: string, agentDir: string): string | null {
  if (!spec.startsWith("file:")) return null;
  const rawPath = spec.slice("file:".length);
  let resolved: string;
  try {
    resolved = spec.startsWith("file://") ? fileURLToPath(spec) : resolve(agentDir, rawPath);
  } catch {
    return null;
  }
  if (!resolved.endsWith(".tgz")) return null;
  return resolved;
}

export async function runDeploy(
  nameArg: string | undefined,
  opts: DeployOptions,
): Promise<DeployResult> {
  if (opts.to !== "railway") {
    throw new Error(
      `Only "railway" is supported in v1.0 (got "${opts.to}"). Other targets: deferred.`,
    );
  }

  let configPath: string;
  try {
    configPath = resolveConfigPath(nameArg, undefined, { auggyDir: opts.auggyDir, cwd: opts.cwd });
  } catch {
    const nameForMessage = nameArg ?? "<name>";
    throw new Error(
      `Agent "${nameForMessage}" not found. Run \`auggy create ${nameForMessage}\` first, then \`auggy deploy ${nameForMessage}\`.`,
    );
  }
  const name = readAgentName(configPath);
  const agentDir = dirname(configPath);
  const entry = getAgentFromDir(agentDir);
  if (!entry) {
    throw new Error(
      `Agent "${name}" not found. Run \`auggy create ${name}\` first, then \`auggy deploy ${name}\`.`,
    );
  }

  // 1) Local preflight before touching Railway or staging a deploy bundle.
  const preflight = await runDoctor(name, {
    auggyDir: opts.auggyDir,
    config: configPath,
    isPortAvailable: async () => true,
    cloud: true,
  });
  const warnings = preflight.filter((check) => check.status === "warn");
  for (const warning of warnings) {
    opts.logger.warn(`${warning.name}: ${warning.message}`);
  }
  if (hasDoctorFailures(preflight)) {
    throw new Error(`Deploy preflight failed:\n${formatDoctorChecks(preflight)}`);
  }
  const config = assertRailwayDeploySafeConfig(configPath);
  const savedCloud = readBoundCloudRecord(agentDir, config.id);
  await acknowledgeBudgetsDeployPosture(config, opts);
  opts.logger.info(`Deploy preflight passed.`);

  // 2) Presence + auth checks (fail fast before any subprocess work).
  await opts.cli.checkPresence();
  await opts.cli.checkAuth();
  opts.logger.info(`Railway CLI ready.`);

  // 3) Determine first-deploy vs redeploy from existing CloudRecord.
  let existingCloud = savedCloud;
  let isRedeploy = existingCloud !== null;
  let savedProjectIdForRecreate: string | null = null;
  let shouldPromptServiceTarget = false;
  let serviceName = opts.service;

  if (isRedeploy && existingCloud && (opts.project || opts.projectName)) {
    existingCloud = null;
    isRedeploy = false;
  }

  if (isRedeploy && existingCloud && !opts.yes && !opts.service) {
    const choice = await opts.promptSavedDeploymentTarget({
      cloud: existingCloud,
      metadataPath: join(agentDir, ".auggy-cloud.json"),
    });
    if (choice === "cancel") {
      throw new Error("Deploy aborted by operator.");
    }
    if (choice === "recreate") {
      savedProjectIdForRecreate = existingCloud.projectId;
      existingCloud = null;
      isRedeploy = false;
    } else if (choice === "choose") {
      existingCloud = null;
      isRedeploy = false;
      shouldPromptServiceTarget = true;
    } else if (choice === "reset") {
      clearCloudMetadataForDir(agentDir);
      opts.logger.info(`Removed saved Railway deploy metadata.`);
      existingCloud = null;
      isRedeploy = false;
    }
  }

  // 4) Stage the bundle (excludes secrets + volume-bound state). New Railway
  //    project creation links the current directory, so staging must exist
  //    before we can create/link project state.
  const stagingDir = stageBundle({
    agentDir,
    agentName: name,
    excludedPaths: configuredDatabaseArtifacts(config),
  });

  try {
    opts.logger.info(`Bundle staged at ${stagingDir}.`);
    // 5) Write Dockerfile + entrypoint into the staging dir.
    const vendoredRuntime = maybeVendorLocalAuggyTarball({
      agentDir,
      stagingDir,
      cwd: opts.cwd,
    });
    if (vendoredRuntime) {
      opts.logger.info(`Vendored local Auggy runtime ${vendoredRuntime} into deploy bundle.`);
    }
    writeFileSync(
      join(stagingDir, "Dockerfile"),
      generateDockerfile({ agentName: name, runtimeTarballName: vendoredRuntime ?? undefined }),
    );
    writeFileSync(join(stagingDir, "auggy-entrypoint.sh"), generateEntrypoint());

    let projectId: string;
    let projectAlreadyLinked = false;
    if (isRedeploy && existingCloud) {
      projectId = existingCloud.projectId;
      opts.logger.info(`Redeploying ${name} to Railway project ${projectId}.`);
    } else if (savedProjectIdForRecreate) {
      projectId = savedProjectIdForRecreate;
      opts.logger.info(`Recreating ${name} service in Railway project ${projectId}.`);
    } else if (opts.project) {
      projectId = opts.project;
      opts.logger.info(`First deploy of ${name} to existing Railway project ${projectId}.`);
    } else {
      const workspace = await resolveWorkspaceForFirstDeploy(opts);
      const workspaceValue = workspace?.id ?? workspace?.name;
      const projects =
        workspaceValue && !opts.projectName
          ? await listProjectsForWorkspace(opts, workspaceValue)
          : [];
      const target = opts.projectName
        ? "new"
        : await opts.promptProjectTarget({ workspace, projects });
      if (target === "new") {
        const projectName = opts.projectName?.trim() || (await opts.promptProjectName(name));
        const createProject = (workspace?: string) =>
          withProgress(opts, `Creating Railway project ${projectName}`, () =>
            opts.cli.createProject({ projectName, workspace, cwd: stagingDir }),
          );
        try {
          projectId = await createProject(workspaceValue);
        } catch (err) {
          if (!(err instanceof RailwayWorkspaceRequiredError)) throw err;
          const workspace = await opts.promptWorkspace([]);
          projectId = await createProject(workspace);
        }
        projectAlreadyLinked = true;
        opts.logger.info(`Created Railway project ${projectName} (${projectId}).`);
      } else {
        projectId = await opts.promptProjectId(projects);
        opts.logger.info(`First deploy of ${name} to existing Railway project ${projectId}.`);
      }
    }

    // 6) Load secrets plan and confirm with operator unless --yes.
    const envPath = join(agentDir, ".env");
    const plan = loadSecretsPlan(envPath);
    const agentIdentityVariable = {
      key: "AUGGY_AGENT_ID",
      value: config.id,
      redactedValue: "<server-minted agent id>",
    };
    const configuredIdentityIndex = plan.variables.findIndex(
      (variable) => variable.key === "AUGGY_AGENT_ID",
    );
    if (configuredIdentityIndex >= 0) {
      plan.variables[configuredIdentityIndex] = agentIdentityVariable;
    } else {
      plan.variables.push(agentIdentityVariable);
    }
    if (plan.warnings.length > 0) {
      for (const w of plan.warnings) opts.logger.warn(w);
    }
    if (!opts.yes) {
      const summary =
        plan.variables.length === 0
          ? `No secrets to push (no .env file or all entries malformed).`
          : `Push ${plan.variables.length} secret(s) to Railway:\n` +
            plan.variables.map((v) => `  ${v.key} = ${v.redactedValue}`).join("\n");
      const confirmed = await opts.promptConfirm(`${summary}\n\nProceed?`);
      if (!confirmed) {
        throw new Error("Deploy aborted by operator (declined secrets push).");
      }
    }

    // 7) Link the staging dir to the Railway project/service.
    //
    // First deploy default: create a new Railway service named after the agent.
    // First deploy with --service: link an existing Railway service by name/id.
    // Redeploy: use the stored serviceId unless --service explicitly overrides.
    if (!isRedeploy) {
      if (!projectAlreadyLinked) {
        await withProgress(opts, `Linking Railway project`, () =>
          opts.cli.linkProject({ projectId, cwd: stagingDir }),
        );
        opts.logger.info(`Linked staging dir to project ${projectId}.`);
      }
      if (shouldPromptServiceTarget && !serviceName) {
        const serviceTarget = await opts.promptServiceTarget({ defaultServiceName: name });
        if (serviceTarget === "existing") {
          serviceName = await opts.promptServiceName(name);
        }
      }
      if (serviceName) {
        const selectedServiceName = serviceName;
        await withProgress(opts, `Linking Railway service ${selectedServiceName}`, () =>
          opts.cli.linkService({ serviceName: selectedServiceName, cwd: stagingDir }),
        );
        opts.logger.info(`Using existing Railway service ${selectedServiceName}.`);
      } else {
        await withProgress(opts, `Creating Railway service ${name}`, () =>
          opts.cli.createService({ serviceName: name, cwd: stagingDir }),
        );
        opts.logger.info(`Created Railway service ${name}.`);
      }
    } else if (existingCloud) {
      serviceName = opts.service ?? existingCloud.serviceId;
      const selectedServiceName = serviceName;
      let recoveredStaleService = false;
      try {
        await withProgress(opts, `Linking Railway service ${selectedServiceName}`, () =>
          opts.cli.link({ projectId, serviceName: selectedServiceName, cwd: stagingDir }),
        );
      } catch (err) {
        if (isRailwayServiceNotFoundError(err)) {
          if (!opts.service) {
            const metadataPath = join(agentDir, ".auggy-cloud.json");
            clearCloudMetadataForDir(agentDir);
            existingCloud = null;
            isRedeploy = false;
            opts.logger.warn(
              formatStaleCloudMetadataWarning({
                serviceName: selectedServiceName,
                projectId,
                metadataPath,
              }),
            );
            await withProgress(opts, `Creating Railway service ${name}`, () =>
              opts.cli.createService({ serviceName: name, cwd: stagingDir }),
            );
            opts.logger.info(`Created Railway service ${name}.`);
            projectAlreadyLinked = true;
            recoveredStaleService = true;
          } else {
            throw formatMissingServiceError({
              name,
              projectId,
              serviceName,
              agentDir,
              explicitService: Boolean(opts.service),
            });
          }
        } else {
          throw err;
        }
      }
      if (!recoveredStaleService) {
        opts.logger.info(
          `Linked staging dir to project ${projectId}, service ${selectedServiceName}.`,
        );
      }
    }

    // 8) Volume: only add on first deploy. Redeploys keep the existing volume
    //    (Railway preserves it via the volumeId in the existing CloudRecord).
    if (!isRedeploy) {
      await withProgress(opts, `Mounting Railway volume`, () =>
        opts.cli.addVolume({
          name: `${name}-data`,
          mountPath: VOLUME_MOUNT_PATH,
          cwd: stagingDir,
        }),
      );
      opts.logger.info(`Volume "${name}-data" mounted at ${VOLUME_MOUNT_PATH}.`);
    }

    // 9) Generate (or recover) the public domain. Idempotent: second call
    //    returns the existing URL.
    const url = await withProgress(opts, `Generating public Railway URL`, () =>
      opts.cli.generateDomain({ cwd: stagingDir }),
    );
    opts.logger.info(`Public URL: ${url}`);

    // 10) Push secrets (.env keys + AUGGY_PUBLIC_URL). D7: AUGGY_PUBLIC_URL must
    //    be set BEFORE `up` so visitorAuth sees the publicUrl on first boot.
    await withProgress(opts, `Pushing ${plan.variables.length + 1} env var(s)`, async () => {
      for (const v of plan.variables) {
        await opts.cli.setVariable({ key: v.key, value: v.value, cwd: stagingDir });
      }
      await opts.cli.setVariable({ key: "AUGGY_PUBLIC_URL", value: url, cwd: stagingDir });
    });
    opts.logger.info(`Pushed ${plan.variables.length + 1} env var(s) to Railway.`);

    // 11) Start the build + deploy. --detach so we return without tailing
    //     build logs; operator follows progress via Railway UI / `railway logs`.
    await withProgress(opts, `Starting Railway build`, () => opts.cli.up({ cwd: stagingDir }));
    opts.logger.info(
      `Build started. Railway will build the image, deploy it, then start the service.`,
    );

    // 12) Wait for Railway to report a terminal deployment state when the CLI
    //     exposes one. If status is unavailable or shape-shifts, fall back to
    //     the health check instead of blocking forever.
    const deployWait =
      opts.deployWait === false
        ? {
            state: "unknown" as const,
            status: await opts.cli.status({ cwd: stagingDir }),
            reason: "deployment wait disabled",
          }
        : await withProgress(opts, `Waiting for Railway deployment`, () =>
            waitForRailwayDeployment(opts, stagingDir),
          );
    if (deployWait.state === "ready") {
      opts.logger.info(`Railway deployment finished: ${deployWait.statusText}.`);
    } else if (deployWait.state === "failed") {
      throw new Error(
        `Railway deployment failed with status ${deployWait.statusText}. Check \`railway logs\` for details.`,
      );
    }

    // 13) Verify the public health endpoint. Timeout is non-destructive: the
    //     deploy may still finish, but the operator needs recovery commands.
    const healthCheckOptions = opts.healthCheck === false ? undefined : opts.healthCheck;
    const health =
      opts.healthCheck === false
        ? { ok: false, url: new URL("/health", ensureTrailingSlash(url)).toString(), attempts: 0 }
        : await withProgress(opts, `Verifying deployment health`, () =>
            waitForHealth(url, healthCheckOptions),
          );
    if (health.ok) {
      opts.logger.info(`Deployment health verified: ${health.url}`);
    } else {
      if (deployWait.state === "unknown") {
        opts.logger.info(
          `Railway deployment status not final yet; continuing with health check (${deployWait.reason}).`,
        );
      }
      const reason = health.status
        ? `last HTTP status ${health.status}`
        : health.error
          ? `last error: ${health.error}`
          : "no attempts completed";
      opts.logger.info(
        `Deployment health is pending (${reason}). Railway may still be building or starting the service.`,
      );
    }

    // 14) Capture service metadata for the CloudRecord.
    const status = deployWait.status ?? (await opts.cli.status({ cwd: stagingDir }));
    opts.logger.info(`Service status: ${formatRailwayServiceStatus(status, health.ok)}.`);

    // 15) Write CloudRecord to the agent index.
    const statusRecord = asRecord(status);
    const serviceRecord = asRecord(statusRecord?.service);
    const serviceId =
      stringField(serviceRecord?.id) ??
      stringField(serviceRecord?.name) ??
      opts.service ??
      existingCloud?.serviceId ??
      name;
    const result: DeployResult = {
      name,
      url,
      projectId,
      serviceId,
      volumeId: `${name}-data`,
      health,
    };
    setCloudForDir(agentDir, {
      version: 1,
      agentId: config.id,
      provider: "railway",
      projectId: result.projectId,
      serviceId: result.serviceId,
      url: result.url,
      volumeId: result.volumeId,
      deployedAt: new Date().toISOString(),
    });

    return result;
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
    } catch (error) {
      try {
        opts.logger.warn(
          `Could not remove deploy staging directory ${stagingDir}: ${(error as Error).message}`,
        );
      } catch {
        // Cleanup and diagnostics must never mask the deploy result or root failure.
      }
    }
  }
}

function assertRailwayDeploySafeConfig(configPath: string): ReturnType<typeof parseConfig> {
  const config = parseConfig(configPath);
  const webTransport = config.augments.find((augment) => augment.type === "webTransport");
  const webPort = webTransport?.options?.port;
  if (webPort !== 8080) {
    throw new Error(
      [
        "Deploy preflight failed:",
        `webTransport must listen on port 8080 for Railway deploys (found ${webPort ?? "unset"}).`,
        "",
        "Auggy's generated Railway Dockerfile exposes port 8080. A different",
        "webTransport port can boot successfully inside the container while Railway",
        "still returns 502 because the proxy cannot reach the app.",
        "",
        "Fix:",
        "  - Set `port: 8080` under config in augments/webTransport/augment.yaml.",
      ].join("\n"),
    );
  }

  assertRailwayDatabasePaths(config);

  const visitorAuth = config.augments.find((augment) => augment.type === "visitorAuth");
  if (!visitorAuth) return config;

  const options = visitorAuth.options ?? {};
  const agentMail = asRecord(options.agentMail);
  if (agentMail?.transport !== "console") return config;
  if (options.allowConsoleInProduction === true) return config;

  const canonicalSharedAgentMail = hasCanonicalSingletonAgentMail(configPath, config);
  const anyAgentMailInstalled = config.augments.some((augment) => augment.type === "agentMail");
  const recommendedSetup = canonicalSharedAgentMail
    ? [
        "  - Recommended: reuse the installed AgentMail inbox:",
        "      auggy augment setup agentMail --mode connect",
        "      auggy augment setup visitorAuth --mode env",
      ]
    : anyAgentMailInstalled
      ? [
          "  - This agent has an inline, renamed, or additional agentMail mount.",
          "    Shared credential connection is unavailable for that topology. Configure exact",
          "    AGENTMAIL_* references for each mount, or migrate to one canonical agentMail mount",
          "    and then attach visitorAuth with `auggy augment setup visitorAuth --mode env`.",
        ]
      : [
          "  - Recommended: run `auggy augment setup visitorAuth --mode connect`.",
          "    This verifies an existing inbox and supplied API key, then writes the needed .env values.",
        ];

  throw new Error(
    [
      "Deploy preflight failed:",
      'visitorAuth is using agentMail.transport: "console".',
      "",
      "Console magic links are for local development only. On Railway, they would be",
      "written to service logs, which can leak sign-in credentials through dashboards",
      "or log shipping.",
      "",
      "Fix one of these before deploying:",
      ...recommendedSetup,
      "  - Smoke test only: add this under config in augments/visitorAuth/augment.yaml:",
      "      allowConsoleInProduction: true",
      "    This acknowledges that magic links will appear in Railway logs.",
    ].join("\n"),
  );
}

function hasCanonicalSingletonAgentMail(
  configPath: string,
  config: ReturnType<typeof parseConfig>,
): boolean {
  const resolved = config.augments.filter((augment) => augment.type === "agentMail");
  if (resolved.length !== 1 || resolved[0]?.name !== "agentMail") return false;

  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> | null;
  if (!raw || !Array.isArray(raw.augments)) return false;
  return raw.augments.filter((augment) => augment === "agentMail").length === 1;
}

function assertRailwayDatabasePaths(config: ReturnType<typeof parseConfig>): void {
  const expectedByType: Record<
    string,
    ReadonlyArray<{ field: "dbPath" | "layeredMemoryDbPath"; expected: string; nullable?: boolean }>
  > = {
    layeredMemory: [{ field: "dbPath", expected: "./memory.db" }],
    budgets: [{ field: "dbPath", expected: "./budgets.db" }],
    visitorAuth: [
      { field: "dbPath", expected: "./visitor-auth.db" },
      { field: "layeredMemoryDbPath", expected: "./memory.db", nullable: true },
    ],
    link: [{ field: "dbPath", expected: "./link.db" }],
  };

  for (const augment of config.augments) {
    for (const rule of expectedByType[augment.type] ?? []) {
      const value = augment.options?.[rule.field];
      if (value === undefined || (rule.nullable && value === null)) continue;
      const resolvedPath = typeof value === "string" ? resolve("/app", value) : "";
      const fromVolume = relative("/app/data", resolvedPath);
      const isDirectVolumePath =
        fromVolume !== "" &&
        fromVolume !== ".." &&
        !fromVolume.startsWith(`..${sep}`) &&
        !isAbsolute(fromVolume);
      const isMappedDefault =
        typeof value === "string" &&
        !isAbsolute(value) &&
        resolvedPath === resolve("/app", rule.expected);
      if (isMappedDefault || isDirectVolumePath) continue;
      throw new Error(
        [
          "Deploy preflight failed:",
          `${augment.type}.${rule.field} must remain ${rule.expected} or resolve below ./data for Railway durability (found ${String(value)}).`,
          "Core SQLite paths must resolve directly below /app/data.",
          "Paths outside that root would be recreated on ephemeral container storage after redeploy.",
        ].join("\n"),
      );
    }
  }

  if (config.settings.jobs) {
    const configuredPath = config.settings.jobs.dbPath;
    const configuredFromAgent = resolve("/app", configuredPath);
    const configuredFromAgentRelative = relative(VOLUME_MOUNT_PATH, configuredFromAgent);
    const alreadyBelowVolume =
      configuredFromAgentRelative !== "" &&
      configuredFromAgentRelative !== ".." &&
      !configuredFromAgentRelative.startsWith(`..${sep}`) &&
      !isAbsolute(configuredFromAgentRelative);
    const resolvedPath =
      isAbsolute(configuredPath) || alreadyBelowVolume
        ? configuredFromAgent
        : resolve(VOLUME_MOUNT_PATH, configuredPath);
    const fromVolume = relative(VOLUME_MOUNT_PATH, resolvedPath);
    const isDurablePath =
      fromVolume !== "" &&
      fromVolume !== ".." &&
      !fromVolume.startsWith(`..${sep}`) &&
      !isAbsolute(fromVolume);
    if (!isDurablePath) {
      throw new Error(
        [
          "Deploy preflight failed:",
          `settings.jobs.dbPath must resolve below ${VOLUME_MOUNT_PATH} for Railway durability.`,
          "Use a relative child path or an absolute path within the runtime volume.",
        ].join("\n"),
      );
    }
  }

  for (const webTransport of config.augments.filter((augment) => augment.type === "webTransport")) {
    const consoleChat = asRecord(webTransport.options?.consoleChat);
    const configuredPath = consoleChat?.dbPath;
    // `null` is an explicit, documented opt-out from cross-restart persistence.
    // Omitted config uses the runtime default at /app/data/console-chat.db when
    // the console is enabled. An explicit path is still resolved when
    // adminRoute is false so it must obey the same boundary as runtime startup.
    if (configuredPath === undefined || configuredPath === null) continue;
    if (typeof configuredPath !== "string") continue; // Config parsing reports shape errors.

    const configuredFromAgent = resolve("/app", configuredPath);
    const configuredFromAgentRelative = relative(VOLUME_MOUNT_PATH, configuredFromAgent);
    const alreadyBelowVolume =
      configuredFromAgentRelative !== ".." &&
      !configuredFromAgentRelative.startsWith(`..${sep}`) &&
      !isAbsolute(configuredFromAgentRelative);
    const resolvedPath =
      isAbsolute(configuredPath) || alreadyBelowVolume
        ? configuredFromAgent
        : resolve(VOLUME_MOUNT_PATH, configuredPath);
    const fromVolume = relative(VOLUME_MOUNT_PATH, resolvedPath);
    const isDurablePath =
      fromVolume !== "" &&
      fromVolume !== ".." &&
      !fromVolume.startsWith(`..${sep}`) &&
      !isAbsolute(fromVolume);
    if (isDurablePath) continue;

    throw new Error(
      [
        "Deploy preflight failed:",
        `webTransport.consoleChat.dbPath must resolve below ${VOLUME_MOUNT_PATH} for Railway durability (found ${configuredPath}).`,
        `Omit dbPath to use ${VOLUME_MOUNT_PATH}/console-chat.db, use a relative path`,
        `that stays below the runtime data root, or set dbPath: null to explicitly`,
        "choose process-memory-only console chats.",
      ].join("\n"),
    );
  }
}

async function acknowledgeBudgetsDeployPosture(
  config: ReturnType<typeof parseConfig>,
  opts: DeployOptions,
): Promise<void> {
  const dailyBudgetCaps = config.augments.flatMap((augment) => {
    if (augment.type !== "budgets") return [];
    const dailyBudgetUsd = augment.options?.dailyBudgetUsd;
    return typeof dailyBudgetUsd === "number" ? [{ name: augment.name, dailyBudgetUsd }] : [];
  });
  if (dailyBudgetCaps.length === 0) return;
  const capSummary =
    dailyBudgetCaps.length === 1
      ? `budgets.dailyBudgetUsd is set to $${dailyBudgetCaps[0]!.dailyBudgetUsd.toFixed(2)}.`
      : `budgets.dailyBudgetUsd is set on ${dailyBudgetCaps.length} budgets augments: ${dailyBudgetCaps
          .map((cap) => `${cap.name}=$${cap.dailyBudgetUsd.toFixed(2)}`)
          .join(", ")}.`;

  const warning = [
    capSummary,
    "This is a runtime soft cap, not billing control.",
    "Configure provider-side hard spend caps before unattended deploys.",
    "SQLite budgets are single-process/single-replica; do not scale this Railway service horizontally.",
  ].join("\n");
  opts.logger.warn(warning);

  if (opts.yes) return;

  const confirmed = await opts.promptConfirm(`${warning}\n\nProceed with Railway deploy?`);
  if (!confirmed) {
    throw new Error("Deploy aborted by operator (declined budgets deploy acknowledgement).");
  }
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function withProgress<T>(opts: DeployOptions, message: string, run: () => Promise<T>): Promise<T> {
  return opts.logger.task ? opts.logger.task(message, run) : run();
}

async function resolveWorkspaceForFirstDeploy(
  opts: DeployOptions,
): Promise<RailwayWorkspace | null> {
  const explicit = opts.workspace?.trim();
  if (explicit) return { id: explicit, name: explicit };

  let workspaces: RailwayWorkspace[] = [];
  try {
    workspaces = await withProgress(opts, `Finding Railway workspaces`, () =>
      opts.cli.listWorkspaces(),
    );
  } catch {
    workspaces = [];
  }

  if (workspaces.length === 0) return null;
  if (opts.projectName && workspaces.length === 1) {
    const workspace = workspaces[0]!;
    opts.logger.info(`Using Railway workspace "${workspace.name}".`);
    return workspace;
  }
  const selected = await opts.promptWorkspace(workspaces);
  return (
    workspaces.find((workspace) => workspace.id === selected || workspace.name === selected) ?? {
      id: selected,
      name: selected,
    }
  );
}

async function listProjectsForWorkspace(
  opts: DeployOptions,
  workspace: string,
): Promise<RailwayProject[]> {
  try {
    return await withProgress(opts, `Finding Railway projects`, () =>
      opts.cli.listProjects({ workspace }),
    );
  } catch {
    return [];
  }
}

type RailwayDeploymentWaitResult =
  | { state: "ready"; status: unknown; statusText: string }
  | { state: "failed"; status: unknown; statusText: string }
  | { state: "unknown"; status?: unknown; reason: string };

async function waitForRailwayDeployment(
  opts: DeployOptions,
  stagingDir: string,
): Promise<RailwayDeploymentWaitResult> {
  const wait: DeployWaitOptions = opts.deployWait === false ? {} : (opts.deployWait ?? {});
  const sleep =
    wait.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = wait.now ?? (() => Date.now());
  const timeoutMs = wait.timeoutMs ?? DEFAULT_DEPLOY_WAIT_TIMEOUT_MS;
  const intervalMs = wait.intervalMs ?? DEFAULT_DEPLOY_WAIT_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let lastStatus: unknown;
  let lastStatusText: string | null = null;

  while (true) {
    const status = await opts.cli.status({ cwd: stagingDir });
    lastStatus = status;
    const statusText = findRailwayStatusValue(status);
    if (!statusText) {
      return { state: "unknown", status, reason: "Railway CLI did not report deployment status" };
    }
    lastStatusText = statusText;
    const category = categorizeRailwayDeploymentStatus(statusText);
    if (category === "ready") return { state: "ready", status, statusText };
    if (category === "failed") return { state: "failed", status, statusText };

    if (now() >= deadline) {
      return {
        state: "unknown",
        status: lastStatus,
        reason: `timed out waiting for terminal status; last status ${lastStatusText}`,
      };
    }

    await sleep(intervalMs);
  }
}

function categorizeRailwayDeploymentStatus(status: string): "ready" | "failed" | "pending" {
  const normalized = status
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, "_");
  if (["SUCCESS", "SUCCEEDED", "DEPLOYED", "HEALTHY", "READY", "ACTIVE"].includes(normalized)) {
    return "ready";
  }
  if (
    ["FAILED", "FAILURE", "CRASHED", "REMOVED", "CANCELED", "CANCELLED", "ERROR"].includes(
      normalized,
    )
  ) {
    return "failed";
  }
  return "pending";
}

function formatRailwayServiceStatus(status: unknown, healthOk: boolean): string {
  const deploymentStatus = findRailwayStatusValue(status);
  if (deploymentStatus) return deploymentStatus;
  return healthOk ? "healthy" : "not reported yet; build may still be deploying";
}

function findRailwayStatusValue(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const root = value as Record<string, unknown>;

  for (const key of ["deployment", "latestDeployment", "activeDeployment"]) {
    const found = statusField(root[key]);
    if (found) return found;
  }

  const direct =
    stringField(root.deploymentStatus) ??
    stringField(root.deploymentState) ??
    stringField(root.status) ??
    stringField(root.state);
  if (direct) return direct;

  for (const key of ["deployments", "serviceInstances"]) {
    const list = root[key];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const found = statusField(item);
      if (found) return found;
    }
  }

  const serviceStatus = statusField(root.service);
  if (serviceStatus) return serviceStatus;

  return null;
}

function statusField(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const obj = value as Record<string, unknown>;
  return (
    stringField(obj.status) ??
    stringField(obj.state) ??
    stringField(obj.deploymentStatus) ??
    stringField(obj.deploymentState)
  );
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}
