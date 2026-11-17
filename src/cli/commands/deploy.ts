/**
 * Railway adapter for a project-owned agent and its passive deployment profile.
 *
 * Portable export creates the unchanged source/lock context. The adapter selects
 * an explicit Railway target, verifies its ingress and durable volume, then
 * uploads configuration and code. The external-runtime-tarball compatibility
 * path is explicitly unfrozen and is not portable-build certification.
 *
 * Public domains and PORT exist only for configured HTTP listeners. Platform,
 * optional HTTP readiness and unverified channel execution remain distinct.
 * All hosted operations go through the injected RailwayCli boundary.
 */

import {
  closeSync,
  mkdtempSync,
  constants,
  fstatSync,
  openSync,
  opendirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  getAgentFromDir,
  normalizeCloudRecord,
  readBoundCloudRecord,
  setCloudForDir,
} from "../agent-index";
import { parseConfig } from "../config-parser";
import { formatDoctorChecks, hasDoctorFailures, runDoctor } from "./doctor";
import { readAgentName, resolveConfigPath } from "../resolve-config";
import { stageBundleWithManifest } from "../deploy/bundle";
import {
  generateRailwayCompatibilityDockerfile,
  generateRailwayEntrypoint,
} from "../deploy/dockerfile";
import { readAuthoringDocument } from "../authoring/document";
import { decodeSnapshotText, readFileSnapshot } from "../authoring/document-io";
import { assertImmutableAgentId } from "../agent-isolation";
import {
  exportDocker,
  inspectDeploymentSources,
  validateStagedDeploymentSources,
} from "../deploy/portable-export";
import { readDeploymentManifest, validateDeploymentManifest } from "../deploy/manifest";
import { reconcileDeploymentProfile, resolveDeploymentProfile } from "../deploy/profile";
import {
  DEPLOYMENT_FILES,
  DEPLOYMENT_LIMITS,
  DEPLOYMENT_READINESS_DEFAULTS,
  type DeploymentProfile,
  type DeploymentReadiness,
  type IngressSelection,
  type ProfileAwareDeployResult,
} from "../deploy/contracts";
import {
  HEALTH_TIMEOUT_ERROR,
  validateHealthCheckOptions,
  waitForHealth,
  type HealthCheckOptions,
  type HealthCheckResult,
} from "../deploy/health";
import {
  RailwayWorkspaceRequiredError,
  RailwaySubprocessCleanupError,
  RailwayDeploymentPolicyError,
  assertNoRailwayBuildVariables,
  assertNoAmbientRailwayTarget,
  type RailwayCli,
  type RailwayIngress,
  type RailwayStatus,
  type RailwayProject,
  type RailwayWorkspace,
} from "../deploy/railway-cli";
import { loadSecretsPlan } from "../deploy/secrets";
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
  config?: string;
  ingress?: IngressSelection;
  port?: number;
  healthPath?: string;
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

export type DeployResult = ProfileAwareDeployResult;

const VOLUME_MOUNT_PATH = "/app/data";

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
  const stagedPackagePath = join(args.stagingDir, "package.json");
  const stagedPackageBytes = readRegularFileNoFollow(stagedPackagePath, maxStagedPackageBytes);
  if (!stagedPackageBytes) return null;
  const parsed = JSON.parse(new TextDecoder().decode(stagedPackageBytes)) as {
    dependencies?: Record<string, string>;
  };
  const deps = parsed.dependencies;
  if (!deps?.auggy) return null;
  const explicitTarball = resolveFileAuggyTarball(deps.auggy, args.agentDir);
  // Only the project's explicit file dependency can select a local artifact.
  // A nearby archive with an equal version is not the installed runtime.
  const tarballCandidates = explicitTarball ? [explicitTarball] : [];
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
      constants.O_RDONLY |
        (constants.O_NONBLOCK ?? 0) |
        (process.platform === "win32" ? 0 : (constants.O_NOFOLLOW ?? 0)),
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

function assertDeployableRuntimeDependency(agentDir: string): void {
  const manifestBytes = readRegularFileNoFollow(join(agentDir, "package.json"), 1024 * 1024);
  if (!manifestBytes) return; // Doctor owns absent/invalid project manifest diagnostics.
  const manifest: unknown = JSON.parse(new TextDecoder().decode(manifestBytes));
  const dependency = asRecord(asRecord(manifest)?.dependencies)?.auggy;
  if (typeof dependency !== "string") return;
  const spec = dependency.trim();
  if (!/^(?:file:|link:|workspace:|\.?\.?\/|\/)/i.test(spec)) return;
  const tarball = resolveFileAuggyTarball(spec, agentDir);
  if (tarball && readRegularFileNoFollow(tarball, 256 * 1024 * 1024)) return;
  throw new Error(
    "Deploy requires a registry Auggy dependency or an explicit regular file: .tgz artifact. " +
      "Pack the linked/source runtime and materialize that tarball as this project's Auggy dependency before deploying; no nearby archive is selected automatically.",
  );
}

export async function runDeploy(
  nameArg: string | undefined,
  opts: DeployOptions,
): Promise<DeployResult> {
  if (opts.to !== "railway") {
    throw new Error(
      `Only "railway" is supported by deploy (got "${opts.to}"). Use export docker for another host.`,
    );
  }

  assertNoAmbientRailwayTarget();
  validateDeployWaitOptions(opts.deployWait);
  if (opts.healthCheck !== false) validateHealthCheckOptions(opts.healthCheck ?? {});
  if (opts.config !== undefined && !opts.config.trim())
    throw new Error("--config requires an explicit non-empty path.");
  let configPath: string;
  try {
    configPath = resolveConfigPath(nameArg, opts.config, {
      auggyDir: opts.auggyDir,
      cwd: opts.cwd,
    });
  } catch {
    const nameForMessage = nameArg ?? "<name>";
    throw new Error(
      `Agent "${nameForMessage}" not found. Run \`auggy create ${nameForMessage}\` first, then \`auggy deploy ${nameForMessage}\`.`,
    );
  }
  const name = readAgentName(configPath);
  const agentDir = dirname(configPath);
  assertNoRailwayProjectOverrides(agentDir);
  assertDeployableRuntimeDependency(agentDir);
  const selection = {
    ingress: opts.ingress ?? "auto",
    port: opts.port,
    healthPath: opts.healthPath,
  } as const;
  const document = readAuthoringDocument(configPath);
  assertCanonicalDeploymentIdentity(document.configPath, document.value.id);
  const { profile } = resolveDeploymentProfile(document, selection);
  if (
    opts.healthCheck &&
    opts.healthCheck.healthPath !== undefined &&
    (profile.kind !== "http" || opts.healthCheck.healthPath !== profile.healthPath)
  ) {
    throw new Error("Health check options must match the selected deployment health path.");
  }
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
  reconcileDeploymentProfile(profile, config.augments);
  // An unfrozen dependency install does not weaken private-state exclusions.
  // Inspect raw declarations before Railway access; effective config can rebase
  // durable paths away from their original local files.
  const sourceInventory = inspectDeploymentSources(document);
  const savedCloud = readBoundCloudRecord(agentDir, config.id);
  await acknowledgeBudgetsDeployPosture(config, opts);
  opts.logger.info(`Deploy preflight passed.`);

  // Validate all local deployment inputs and confirm before any hosted creation.
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
  if (
    profile.kind === "none" &&
    plan.variables.some((variable) =>
      [
        "PORT",
        "AUGGY_PUBLIC_URL",
        "RAILWAY_PUBLIC_DOMAIN",
        "RAILWAY_HEALTHCHECK_TIMEOUT_SEC",
      ].includes(variable.key),
    )
  ) {
    throw new Error(
      "Worker deployment cannot push HTTP variables. Review and remove PORT/public URL/HTTP health variables from .env, or select an HTTP profile for an existing listener.",
    );
  }
  if (
    plan.variables.some((variable) =>
      [
        "RAILWAY_PROJECT_ID",
        "RAILWAY_SERVICE_ID",
        "RAILWAY_ENVIRONMENT_ID",
        "RAILWAY_VOLUME_MOUNT_PATH",
        "AUGGY_DATA_DIR",
        "AUGGY_DEPLOYMENT_MANIFEST",
      ].includes(variable.key),
    )
  ) {
    throw new Error(
      "Deployment .env must not override Railway target, advertised mount or Auggy deployment metadata/data-root variables.",
    );
  }
  assertNoRailwayBuildVariables(
    Object.fromEntries(plan.variables.map((variable) => [variable.key, variable.value])),
  );
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

  // Portable export remains the primary artifact producer. Only an explicit
  // external runtime archive takes the documented unfrozen compatibility path.
  const cleanupRoot = mkdtempSync(join(tmpdir(), "auggy-railway-"));
  let stagingDir = join(cleanupRoot, "context");
  try {
    const packageValue = JSON.parse(readFileSync(join(agentDir, "package.json"), "utf8"));
    const runtimeSpec = asRecord(packageValue.dependencies)?.auggy;
    const runtimeTarball =
      typeof runtimeSpec === "string" ? resolveFileAuggyTarball(runtimeSpec, agentDir) : null;
    const archiveRelative = runtimeTarball ? relative(agentDir, runtimeTarball) : null;
    const externalArchive =
      archiveRelative !== null &&
      (archiveRelative === ".." ||
        archiveRelative.startsWith(`..${sep}`) ||
        isAbsolute(archiveRelative));
    if (externalArchive) {
      const staged = stageBundleWithManifest({
        agentDir,
        agentName: name,
        excludedPaths: sourceInventory.excluded,
      });
      stagingDir = staged.directory;
      validateStagedDeploymentSources(document, sourceInventory, staged);
      staged.verifySource();
      const vendoredRuntime = maybeVendorLocalAuggyTarball({ agentDir, stagingDir, cwd: opts.cwd });
      if (!vendoredRuntime)
        throw new Error("The explicitly selected external Auggy archive is unavailable.");
      opts.logger.warn(
        "External Auggy archive compatibility build: dependencies are not frozen; this is outside portable export certification.",
      );
      opts.logger.info(`Vendored local Auggy runtime ${vendoredRuntime} into deploy bundle.`);
      writeFileSync(
        join(stagingDir, DEPLOYMENT_FILES.dockerfile),
        generateRailwayCompatibilityDockerfile({
          agentName: name,
          configPath: basename(configPath),
          profile,
          runtimeTarballName: vendoredRuntime,
        }),
      );
      writeFileSync(join(stagingDir, DEPLOYMENT_FILES.entrypoint), generateRailwayEntrypoint(), {
        mode: 0o755,
      });
    } else {
      const exported = await exportDocker({
        config: configPath,
        cwd: agentDir,
        out: stagingDir,
        ...selection,
      });
      stagingDir = exported.outputDir;
      const manifest = readDeploymentManifest(exported.manifestPath, stagingDir, {
        agentId: config.id,
        agentName: name,
        configPath: basename(configPath),
      });
      const entrypoint = Buffer.from(generateRailwayEntrypoint());
      writeFileSync(join(stagingDir, DEPLOYMENT_FILES.entrypoint), entrypoint, { mode: 0o755 });
      const adapted = {
        ...manifest,
        generatedFiles: manifest.generatedFiles.map((file) =>
          file.path === DEPLOYMENT_FILES.entrypoint
            ? {
                ...file,
                bytes: entrypoint.length,
                sha256: createHash("sha256").update(entrypoint).digest("hex"),
              }
            : file,
        ),
      };
      validateDeploymentManifest(adapted, {
        agentId: config.id,
        agentName: name,
        configPath: basename(configPath),
      });
      writeFileSync(exported.manifestPath, `${JSON.stringify(adapted, null, 2)}\n`);
    }
    assertNoRailwayProjectOverrides(stagingDir);
    assertRailwayUploadIgnoresAbsent(stagingDir);
    opts.logger.info(`Bundle staged at ${stagingDir}.`);

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

    // Read-only admission precedes any mutation of the selected service.
    const ingress = await opts.cli.inspectIngress({ cwd: stagingDir });
    if (ingress.projectId !== projectId)
      throw new Error(
        "Railway linked project differs from the selected project; deployment stopped.",
      );
    if (
      isRedeploy &&
      existingCloud &&
      !opts.service &&
      ingress.serviceId !== existingCloud.serviceId &&
      ingress.serviceName !== existingCloud.serviceId
    ) {
      throw new Error("Railway linked service differs from the saved immutable deployment target.");
    }
    if (
      opts.service &&
      existingCloud &&
      ingress.serviceId !== existingCloud.serviceId &&
      ingress.serviceName !== existingCloud.serviceId
    ) {
      existingCloud = null;
      isRedeploy = false;
    }
    assertRailwayIngress(profile, ingress, existingCloud);
    let volumeId = await opts.cli.inspectVolume({ cwd: stagingDir, target: ingress });
    if (isRedeploy && volumeId === null)
      throw new Error(
        "The saved Railway service has no verified durable volume; restore/reconcile its state before deploying.",
      );
    if (existingCloud?.version === 2 && volumeId !== existingCloud.volumeId)
      throw new Error(
        "Railway volume identity differs from the saved deployment; reconcile state before deploying.",
      );
    if (volumeId === null) {
      await withProgress(opts, "Mounting Railway volume", () =>
        opts.cli.addVolume({
          name: `${name}-data`,
          mountPath: VOLUME_MOUNT_PATH,
          cwd: stagingDir,
        }),
      );
      volumeId = await opts.cli.inspectVolume({ cwd: stagingDir, target: ingress });
      if (volumeId === null)
        throw new Error(
          "Railway did not verify the new /app/data volume; deployment stopped before pushing variables or code.",
        );
      opts.logger.info(`Railway volume mounted at ${VOLUME_MOUNT_PATH}.`);
    }

    let url: string | null = null;
    if (profile.kind === "http") {
      url = await withProgress(opts, "Generating public Railway URL", () =>
        opts.cli.generateDomain({ cwd: stagingDir, port: profile.port }),
      );
      const parsed = new URL(url);
      if (
        !/^https?:\/\/[^/?#]+\/?$/.test(url) ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      )
        throw new Error("Railway did not return a valid HTTP deployment origin.");
      url = parsed.origin;
      opts.logger.info(`Public URL: ${url}`);
    }
    // A channel's existing configuration decides whether these variables exist.
    const variables =
      profile.kind === "http"
        ? plan.variables.filter((v) => v.key !== "PORT" && v.key !== "AUGGY_PUBLIC_URL")
        : plan.variables;
    if (profile.kind === "http")
      variables.push(
        { key: "PORT", value: String(profile.port), redactedValue: String(profile.port) },
        { key: "AUGGY_PUBLIC_URL", value: url!, redactedValue: "<deployment origin>" },
      );
    await withProgress(opts, `Pushing ${variables.length} env var(s)`, async () => {
      for (const v of variables)
        await opts.cli.setVariable({ key: v.key, value: v.value, cwd: stagingDir });
    });
    opts.logger.info(`Pushed ${variables.length} env var(s) to Railway.`);

    // 11) Start the build + deploy. --detach so we return without tailing
    //     build logs; operator follows progress via Railway UI / `railway logs`.
    await withProgress(opts, `Starting Railway build`, () => opts.cli.up({ cwd: stagingDir }));
    opts.logger.info(
      `Build started. Railway will build the image, deploy it, then start the service.`,
    );

    const deployWait =
      opts.deployWait === false
        ? { state: "unverified" as const, reason: "wait-disabled" as const }
        : await withProgress(opts, "Waiting for Railway deployment", () =>
            waitForRailwayDeployment(opts, stagingDir, ingress),
          );
    if (deployWait.state === "failed")
      throw new Error(
        `Railway deployment failed with status ${deployWait.statusText}. Check \`railway logs\` for details.`,
      );
    if (deployWait.state === "ready")
      opts.logger.info(`Railway deployment finished: ${deployWait.statusText}.`);

    let health: HealthCheckResult | null = null;
    let http: DeploymentReadiness["http"];
    if (profile.kind === "none") http = { state: "not-applicable", reason: "no-ingress" };
    else if (profile.healthPath === null)
      http = { state: "not-configured", reason: "no-health-path" };
    else if (opts.healthCheck === false) http = { state: "not-checked", reason: "check-disabled" };
    else if (deployWait.state === "timed-out")
      http = { state: "not-attempted", reason: "platform-not-ready" };
    else {
      health = await withProgress(opts, "Verifying deployment health", () =>
        waitForHealth(url!, { ...opts.healthCheck, healthPath: profile.healthPath! }),
      );
      http = {
        state: health.ok ? "ready" : health.error === HEALTH_TIMEOUT_ERROR ? "timed-out" : "failed",
        result: health,
      };
      opts.logger.info(
        health.ok
          ? `Deployment health verified: ${health.url}`
          : "Deployment health is pending; inspect Railway logs and retry the configured health endpoint.",
      );
    }
    const readiness: DeploymentReadiness =
      deployWait.state === "unverified"
        ? {
            platform: "unverified",
            platformReason: deployWait.reason,
            http,
            channel: { state: "unverified" },
          }
        : { platform: deployWait.state, http, channel: { state: "unverified" } };
    opts.logger.info(
      `Platform readiness: ${readiness.platform}; HTTP readiness: ${http.state}; channel: unverified.`,
    );
    const finalIngress = await opts.cli.inspectIngress({ cwd: stagingDir });
    if (
      finalIngress.projectId !== ingress.projectId ||
      finalIngress.serviceId !== ingress.serviceId ||
      finalIngress.environmentId !== ingress.environmentId
    )
      throw new RailwayDeploymentPolicyError(
        "Railway target changed during deployment; metadata was not written.",
      );
    assertRailwayIngress(profile, finalIngress, existingCloud);
    const common = {
      name,
      projectId: ingress.projectId,
      serviceId: ingress.serviceId,
      volumeId,
      health,
      readiness,
    };
    const result: DeployResult =
      profile.kind === "none"
        ? { ...common, profile, url: null }
        : { ...common, profile, url: url! };
    if ((await opts.cli.inspectVolume({ cwd: stagingDir, target: ingress })) !== volumeId)
      throw new Error(
        "Railway volume binding changed during deployment; cloud metadata was not written.",
      );
    const cloudCommon = {
      version: 2 as const,
      agentId: config.id,
      provider: "railway" as const,
      projectId: result.projectId,
      serviceId: result.serviceId,
      volumeId: result.volumeId,
      deployedAt: new Date().toISOString(),
    };
    setCloudForDir(
      agentDir,
      profile.kind === "none"
        ? { ...cloudCommon, profile, url: null }
        : { ...cloudCommon, profile, url: url! },
    );

    return result;
  } finally {
    try {
      rmSync(stagingDir, { recursive: true, force: true });
      rmSync(cleanupRoot, { recursive: true, force: true });
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

/** A directory's one cloud record is always bound to its canonical agent.yaml. */
function assertCanonicalDeploymentIdentity(configPath: string, selectedId: unknown): void {
  try {
    if (typeof selectedId !== "string") throw new Error();
    assertImmutableAgentId(selectedId);
  } catch {
    throw new RailwayDeploymentPolicyError(
      "Railway deployment requires a valid literal immutable agent id in the selected configuration.",
    );
  }
  const canonicalPath = join(dirname(configPath), "agent.yaml");
  if (configPath === canonicalPath) return;
  let canonicalId: unknown;
  try {
    const snapshot = readFileSnapshot(canonicalPath, DEPLOYMENT_LIMITS.documentBytes);
    if (!snapshot.exists) throw new Error();
    const value = asRecord(
      parseYaml(decodeSnapshotText(snapshot.bytes), {
        maxAliasCount: 0,
        prettyErrors: false,
        logLevel: "silent",
      }),
    );
    canonicalId = value?.id;
    if (typeof canonicalId !== "string") throw new Error();
    assertImmutableAgentId(canonicalId);
  } catch {
    throw new RailwayDeploymentPolicyError(
      "Railway deployment requires an adjacent canonical agent.yaml with a valid immutable agent id. Each agent directory owns one identity and one cloud record; restore agent.yaml before deploying an alternate configuration.",
    );
  }
  if (selectedId !== canonicalId)
    throw new RailwayDeploymentPolicyError(
      "The selected configuration must use the same immutable agent id as adjacent agent.yaml. Use a separate agent project directory for a different identity.",
    );
}

function assertNoRailwayProjectOverrides(root: string): void {
  const directory = opendirSync(root);
  let entries = 0;
  try {
    for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
      if (++entries > DEPLOYMENT_LIMITS.visitedEntries)
        throw new Error("Railway source preflight exceeds the supported entry bound.");
      if (
        ["railway.json", "railway.toml", ".railwayignore", ".ignore"].includes(
          entry.name.toLowerCase(),
        )
      )
        throw new RailwayDeploymentPolicyError(
          "Managed Railway deployment does not accept railway.json, railway.toml, .railwayignore or .ignore overrides. Review/archive that configuration or deploy the exported Docker context manually.",
        );
    }
  } finally {
    directory.closeSync();
  }
}

/** The Railway uploader uses ignore::WalkBuilder, including parent ignores. */
function assertRailwayUploadIgnoresAbsent(stagingDir: string): void {
  let visited = 0;
  const inspect = (path: string, ancestor: boolean): string[] => {
    const children: string[] = [];
    const directory = opendirSync(path);
    try {
      for (let entry = directory.readSync(); entry !== null; entry = directory.readSync()) {
        if (++visited > DEPLOYMENT_LIMITS.visitedEntries)
          throw new RailwayDeploymentPolicyError(
            "Railway upload preflight exceeds the supported entry bound.",
          );
        const name = entry.name.toLowerCase();
        if (name === ".railwayignore" || name === ".ignore" || (ancestor && name === ".git"))
          throw new RailwayDeploymentPolicyError(
            "Railway upload ignore files or ancestor Git metadata could omit generated application files. Review/remove the ignore input or choose a temporary directory outside that ancestor before deploying; no input was rewritten.",
          );
        if (!ancestor && entry.isDirectory()) children.push(join(path, entry.name));
      }
    } finally {
      directory.closeSync();
    }
    return children;
  };
  const pending = [stagingDir];
  while (pending.length) pending.push(...inspect(pending.pop()!, false));
  for (let path = dirname(stagingDir); ; path = dirname(path)) {
    inspect(path, true);
    if (dirname(path) === path) break;
  }
}

function assertRailwayIngress(
  profile: DeploymentProfile,
  ingress: RailwayIngress,
  cloud: CloudRecord,
): void {
  if (ingress.replicas !== 1)
    throw new Error(
      "Railway deployment requires exactly one replica for SQLite state. Review the service topology before deploying.",
    );
  if (profile.kind === "none") {
    const historicalHttp = cloud && normalizeCloudRecord(cloud).profile.kind === "http";
    if (
      historicalHttp ||
      ingress.domains.length ||
      ingress.httpVariables.length ||
      ingress.healthPath !== null
    ) {
      throw new Error(
        "This Railway target has existing HTTP ingress, variables, a health check or saved HTTP deployment metadata. Review/remove these explicitly and clear the reviewed local deployment record, or choose a new worker service. Auggy will not delete existing ingress silently.",
      );
    }
    return;
  }
  if (ingress.domains.some((domain) => domain.targetPort !== profile.port))
    throw new Error(
      "Existing Railway domain target ports do not match the selected HTTP listener. Review/update domain routing in Railway or choose a new service before deploying.",
    );
  if (ingress.healthPath !== null && ingress.healthPath !== profile.healthPath)
    throw new Error(
      "Existing Railway health check differs from the selected profile. Review/update it in Railway or choose a new service before deploying.",
    );
}

type RailwayDeploymentWaitResult =
  | { state: "ready" | "failed"; statusText: string }
  | { state: "timed-out" }
  | { state: "unverified"; reason: "status-unavailable" };

function validateDeployWaitOptions(options: DeployWaitOptions | false | undefined): void {
  if (options === false) return;
  for (const value of [
    options?.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayTimeoutMs,
    options?.intervalMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayIntervalMs,
  ]) {
    if (
      !Number.isFinite(value) ||
      value <= 0 ||
      value > DEPLOYMENT_READINESS_DEFAULTS.railwayTimeoutMs
    )
      throw new Error(
        "Railway polling durations must be finite positive milliseconds, at most ten minutes.",
      );
  }
  if (options?.now) {
    let current: number;
    try {
      current = options.now();
    } catch {
      throw new Error("Railway polling clock must be finite and monotonic.");
    }
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      !Number.isSafeInteger(
        Math.ceil(current + (options.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayTimeoutMs)),
      )
    )
      throw new Error("Railway polling clock must be finite and monotonic.");
  }
}

async function waitForRailwayDeployment(
  opts: DeployOptions,
  stagingDir: string,
  target: RailwayIngress,
): Promise<RailwayDeploymentWaitResult> {
  const wait = opts.deployWait === false ? {} : (opts.deployWait ?? {});
  const timeoutMs = wait.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayTimeoutMs;
  const intervalMs = wait.intervalMs ?? DEPLOYMENT_READINESS_DEFAULTS.railwayIntervalMs;
  const now = wait.now ?? (() => performance.now());
  let last = now();
  if (!Number.isFinite(last) || last < 0 || !Number.isSafeInteger(Math.ceil(last + timeoutMs)))
    throw new Error("Railway polling clock must be finite and monotonic.");
  const deadline = last + timeoutMs;
  const wallDeadline = performance.now() + timeoutMs;
  const remaining = () => {
    const current = now();
    if (!Number.isFinite(current) || current < last)
      throw new Error("Railway polling clock must remain finite and monotonic.");
    last = current;
    return Math.max(0, Math.min(deadline - current, wallDeadline - performance.now()));
  };
  const bounded = async <T>(
    operation: Promise<T>,
    ms: number,
    abort: () => void,
  ): Promise<T | null> => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        operation,
        new Promise<null>((resolve) => {
          timer = setTimeout(() => {
            abort();
            resolve(null);
          }, ms);
        }),
      ]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  };
  while (remaining() > 0) {
    const controller = new AbortController();
    let status: RailwayStatus | null;
    try {
      const time = remaining();
      status = await bounded(
        Promise.resolve().then(() =>
          opts.cli.status({
            cwd: stagingDir,
            target,
            timeoutMs: Math.min(time, DEPLOYMENT_READINESS_DEFAULTS.railwayStatusRequestTimeoutMs),
            signal: controller.signal,
          }),
        ),
        time,
        () => controller.abort(),
      );
    } catch (error) {
      if (
        error instanceof RailwaySubprocessCleanupError ||
        error instanceof RailwayDeploymentPolicyError
      )
        throw error;
      if (remaining() <= 0) return { state: "timed-out" };
      return { state: "unverified", reason: "status-unavailable" };
    } finally {
      controller.abort();
    }
    // An adapter that did not settle by its deadline has not proved process cleanup.
    if (!status) throw new RailwaySubprocessCleanupError();
    if (remaining() <= 0) return { state: "timed-out" };
    const deployment = status.deployment;
    if (
      !deployment?.id ||
      !deployment.status ||
      status.project?.id !== target.projectId ||
      status.service?.id !== target.serviceId
    )
      return { state: "unverified", reason: "status-unavailable" };
    const statusText = deployment.status.toUpperCase();
    // A previous successful deployment cannot verify the newly queued build.
    if (deployment.id !== target.latestDeploymentId) {
      if (statusText === "SUCCESS") return { state: "ready", statusText };
      if (["FAILED", "CRASHED", "REMOVED", "CANCELED", "CANCELLED", "SKIPPED"].includes(statusText))
        return { state: "failed", statusText };
      if (!["BUILDING", "DEPLOYING", "INITIALIZING", "QUEUED", "WAITING"].includes(statusText))
        return { state: "unverified", reason: "status-unavailable" };
    }
    const time = remaining();
    if (time <= 0) break;
    if (wait.sleep) {
      const slept = await bounded(
        Promise.resolve()
          .then(() => wait.sleep!(Math.min(intervalMs, time)))
          .then(() => true),
        time,
        () => {},
      );
      if (slept === null) return { state: "timed-out" };
    } else await new Promise<void>((resolve) => setTimeout(resolve, Math.min(intervalMs, time)));
  }
  return { state: "timed-out" };
}
