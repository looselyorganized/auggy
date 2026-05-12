/**
 * `auggy deploy <name> --to railway` command.
 *
 * Orchestrates the first-deploy + redeploy flows:
 *
 *   first-deploy: presence + auth checks → operator prompt for projectId →
 *     stage bundle → write Dockerfile + entrypoint → link → addVolume →
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
import { stageBundle } from "../deploy/bundle";
import { generateDockerfile, generateEntrypoint } from "../deploy/dockerfile";
import type { RailwayCli } from "../deploy/railway-cli";
import { loadSecretsPlan } from "../deploy/secrets";

export interface DeployLogger {
  info(msg: string): void;
  warn(msg: string): void;
  error(msg: string): void;
}

export interface DeployOptions {
  to: "railway";
  yes: boolean;
  auggyDir?: string;
  cli: RailwayCli;
  /** Prompt the operator for a Railway project ID. */
  promptProjectId: () => Promise<string>;
  /** Prompt the operator for yes/no confirmation. Receives a human-readable message. */
  promptConfirm: (message: string) => Promise<boolean>;
  logger: DeployLogger;
}

export interface DeployResult {
  url: string;
  projectId: string;
  serviceId: string;
  volumeId: string;
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

  // 1) Presence + auth checks (fail fast before any subprocess work).
  await opts.cli.checkPresence();
  await opts.cli.checkAuth();
  opts.logger.info(`Railway CLI ready.`);

  // 2) Determine first-deploy vs redeploy from existing CloudRecord.
  const existingCloud = entry.cloud;
  const isRedeploy = existingCloud !== null;

  let projectId: string;
  if (isRedeploy && existingCloud) {
    projectId = existingCloud.projectId;
    opts.logger.info(`Redeploying ${name} to Railway project ${projectId}.`);
  } else {
    projectId = await opts.promptProjectId();
    opts.logger.info(`First deploy of ${name} to Railway project ${projectId}.`);
  }

  // 3) Stage the bundle (excludes secrets + volume-bound state).
  const stagingDir = stageBundle({ agentDir, agentName: name });
  opts.logger.info(`Bundle staged at ${stagingDir}.`);

  // 4) Write Dockerfile + entrypoint into the staging dir.
  writeFileSync(join(stagingDir, "Dockerfile"), generateDockerfile({ agentName: name }));
  writeFileSync(join(stagingDir, "auggy-entrypoint.sh"), generateEntrypoint());

  // 5) Load secrets plan and confirm with operator unless --yes.
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

  // 6) Link the staging dir to the Railway service. First deploy: Railway
  //    auto-creates the service if --service name doesn't exist in the
  //    project. Redeploy: idempotent — re-links the same service.
  await opts.cli.link({ projectId, serviceName: name, cwd: stagingDir });
  opts.logger.info(`Linked staging dir to project ${projectId}, service ${name}.`);

  // 7) Volume: only add on first deploy. Redeploys keep the existing volume
  //    (Railway preserves it via the volumeId in the existing CloudRecord).
  if (!isRedeploy) {
    await opts.cli.addVolume({
      name: `${name}-data`,
      mountPath: VOLUME_MOUNT_PATH,
      cwd: stagingDir,
    });
    opts.logger.info(`Volume "${name}-data" mounted at ${VOLUME_MOUNT_PATH}.`);
  }

  // 8) Generate (or recover) the public domain. Idempotent: second call
  //    returns the existing URL.
  const url = await opts.cli.generateDomain({ cwd: stagingDir });
  opts.logger.info(`Public URL: ${url}`);

  // 9) Push secrets (.env keys + AUGGY_PUBLIC_URL). D7: AUGGY_PUBLIC_URL must
  //    be set BEFORE `up` so visitorAuth sees the publicUrl on first boot.
  for (const v of plan.variables) {
    await opts.cli.setVariable({ key: v.key, value: v.value, cwd: stagingDir });
  }
  await opts.cli.setVariable({ key: "AUGGY_PUBLIC_URL", value: url, cwd: stagingDir });
  opts.logger.info(`Pushed ${plan.variables.length + 1} env var(s) to Railway.`);

  // 10) Trigger the build + deploy. --detach so we return without tailing
  //     build logs; operator follows progress via Railway UI / `railway logs`.
  await opts.cli.up({ cwd: stagingDir });
  opts.logger.info(`Build queued.`);

  // 11) Capture service metadata for the CloudRecord.
  const status = await opts.cli.status({ cwd: stagingDir });
  opts.logger.info(`Service status: ${status.deployment.status}.`);

  // 12) Write CloudRecord to the agent index.
  const result: DeployResult = {
    url,
    projectId,
    serviceId: status.service.id,
    volumeId: `${name}-data`,
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
