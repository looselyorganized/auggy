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

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { getAgent, setCloud } from "../agent-index";
import { formatDoctorChecks, hasDoctorFailures, runDoctor } from "./doctor";
import { stageBundle } from "../deploy/bundle";
import { generateDockerfile, generateEntrypoint } from "../deploy/dockerfile";
import { waitForHealth, type HealthCheckOptions, type HealthCheckResult } from "../deploy/health";
import type { RailwayCli } from "../deploy/railway-cli";
import { loadSecretsPlan } from "../deploy/secrets";

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
  cli: RailwayCli;
  /** Existing Railway project ID. When omitted on first deploy, operator chooses new/existing. */
  project?: string;
  /** Prompt the operator to create a new Railway project or use an existing one. */
  promptProjectTarget: () => Promise<"new" | "existing">;
  /** Prompt for a new Railway project name. */
  promptProjectName: (defaultName: string) => Promise<string>;
  /** Prompt the operator for a Railway project ID. */
  promptProjectId: () => Promise<string>;
  /** Prompt the operator for yes/no confirmation. Receives a human-readable message. */
  promptConfirm: (message: string) => Promise<boolean>;
  logger: DeployLogger;
  healthCheck?: HealthCheckOptions | false;
  /**
   * Existing Railway service name/id to deploy into. Omit on first deploy to
   * create a new service named after the agent.
   */
  service?: string;
}

export interface DeployResult {
  url: string;
  projectId: string;
  serviceId: string;
  volumeId: string;
  health: HealthCheckResult;
}

const VOLUME_MOUNT_PATH = "/app/data";

export async function runDeploy(name: string, opts: DeployOptions): Promise<DeployResult> {
  if (opts.to !== "railway") {
    throw new Error(
      `Only "railway" is supported in v1.0 (got "${opts.to}"). Other targets: deferred.`,
    );
  }

  const entry = getAgent(name, { auggyDir: opts.auggyDir });
  if (!entry) {
    throw new Error(
      `Agent "${name}" not registered. Run \`auggy create ${name}\` first, then \`auggy deploy ${name}\`.`,
    );
  }
  const agentDir = entry.localDir;

  // 1) Local preflight before touching Railway or staging a deploy bundle.
  const preflight = await runDoctor(name, {
    auggyDir: opts.auggyDir,
    isPortAvailable: async () => true,
  });
  const warnings = preflight.filter((check) => check.status === "warn");
  for (const warning of warnings) {
    opts.logger.warn(`${warning.name}: ${warning.message}`);
  }
  if (hasDoctorFailures(preflight)) {
    throw new Error(`Deploy preflight failed:\n${formatDoctorChecks(preflight)}`);
  }
  opts.logger.info(`Deploy preflight passed.`);

  // 2) Presence + auth checks (fail fast before any subprocess work).
  await opts.cli.checkPresence();
  await opts.cli.checkAuth();
  opts.logger.info(`Railway CLI ready.`);

  // 3) Determine first-deploy vs redeploy from existing CloudRecord.
  const existingCloud = entry.cloud;
  const isRedeploy = existingCloud !== null;

  // 4) Stage the bundle (excludes secrets + volume-bound state). New Railway
  //    project creation links the current directory, so staging must exist
  //    before we can create/link project state.
  const stagingDir = stageBundle({ agentDir, agentName: name });
  opts.logger.info(`Bundle staged at ${stagingDir}.`);

  // 5) Write Dockerfile + entrypoint into the staging dir.
  writeFileSync(join(stagingDir, "Dockerfile"), generateDockerfile({ agentName: name }));
  writeFileSync(join(stagingDir, "auggy-entrypoint.sh"), generateEntrypoint());

  let projectId: string;
  let projectAlreadyLinked = false;
  if (isRedeploy && existingCloud) {
    projectId = existingCloud.projectId;
    opts.logger.info(`Redeploying ${name} to Railway project ${projectId}.`);
  } else if (opts.project) {
    projectId = opts.project;
    opts.logger.info(`First deploy of ${name} to existing Railway project ${projectId}.`);
  } else {
    const target = await opts.promptProjectTarget();
    if (target === "new") {
      const projectName = await opts.promptProjectName(name);
      projectId = await withProgress(opts, `Creating Railway project ${projectName}`, () =>
        opts.cli.createProject({ projectName, cwd: stagingDir }),
      );
      projectAlreadyLinked = true;
      opts.logger.info(`Created Railway project ${projectName} (${projectId}).`);
    } else {
      projectId = await opts.promptProjectId();
      opts.logger.info(`First deploy of ${name} to existing Railway project ${projectId}.`);
    }
  }

  // 6) Load secrets plan and confirm with operator unless --yes.
  const envPath = join(agentDir, ".env");
  const plan = loadSecretsPlan(envPath);
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
    if (opts.service) {
      await withProgress(opts, `Linking Railway service ${opts.service}`, () =>
        opts.cli.linkService({ serviceName: opts.service!, cwd: stagingDir }),
      );
      opts.logger.info(`Using existing Railway service ${opts.service}.`);
    } else {
      await withProgress(opts, `Creating Railway service ${name}`, () =>
        opts.cli.createService({ serviceName: name, cwd: stagingDir }),
      );
      opts.logger.info(`Created Railway service ${name}.`);
    }
  } else if (existingCloud) {
    const serviceName = opts.service ?? existingCloud.serviceId;
    await withProgress(opts, `Linking Railway service ${serviceName}`, () =>
      opts.cli.link({ projectId, serviceName, cwd: stagingDir }),
    );
    opts.logger.info(`Linked staging dir to project ${projectId}, service ${serviceName}.`);
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

  // 11) Trigger the build + deploy. --detach so we return without tailing
  //     build logs; operator follows progress via Railway UI / `railway logs`.
  await withProgress(opts, `Queueing Railway build`, () => opts.cli.up({ cwd: stagingDir }));
  opts.logger.info(`Build queued.`);

  // 12) Verify the public health endpoint. Timeout is non-destructive: the
  //     deploy may still finish, but the operator needs recovery commands.
  const healthCheckOptions = opts.healthCheck === false ? undefined : opts.healthCheck;
  const health =
    opts.healthCheck === false
      ? { ok: false, url: new URL("/health", ensureTrailingSlash(url)).toString(), attempts: 0 }
      : await withProgress(opts, `Checking health endpoint`, () =>
          waitForHealth(url, healthCheckOptions),
        );
  if (health.ok) {
    opts.logger.info(`Health check passed: ${health.url}`);
  } else {
    const reason = health.status
      ? `last HTTP status ${health.status}`
      : health.error
        ? `last error: ${health.error}`
        : "no attempts completed";
    opts.logger.warn(
      `Health check did not pass yet (${reason}). Try \`railway logs\`, then \`auggy deploy ${name} --yes\` after fixing the service.`,
    );
  }

  // 13) Capture service metadata for the CloudRecord.
  const status = await withProgress(opts, `Reading Railway service status`, () =>
    opts.cli.status({ cwd: stagingDir }),
  );
  opts.logger.info(`Service status: ${status.deployment.status}.`);

  // 14) Write CloudRecord to the agent index.
  const result: DeployResult = {
    url,
    projectId,
    serviceId: status.service.id,
    volumeId: `${name}-data`,
    health,
  };
  setCloud(
    name,
    {
      provider: "railway",
      projectId: result.projectId,
      serviceId: result.serviceId,
      url: result.url,
      volumeId: result.volumeId,
      deployedAt: new Date().toISOString(),
    },
    { auggyDir: opts.auggyDir },
  );

  return result;
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}

function withProgress<T>(
  opts: DeployOptions,
  message: string,
  run: () => Promise<T>,
): Promise<T> {
  return opts.logger.task ? opts.logger.task(message, run) : run();
}
