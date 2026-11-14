/** Actual Docker acceptance from CLI-created, packed consumers. No hosted platform claim. */
import { cpSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";
import type { DeploymentProfile } from "../../src/cli/deploy/contracts";
import { applicationEnvironment, applicationHash } from "./application-consumer";
import type { CreateAuthoringConsumerOptions } from "./authoring-contract";
import {
  createIntegrationBudget,
  createIntegrationConsumer,
  materializeIntegrationDependencies,
  readIntegrationFile,
  redactIntegrationDiagnostic,
  waitForIntegrationHttpReady,
  withIntegrationChild,
} from "./integration-consumer";
import { withIntegrationDocker, type IntegrationDockerScope } from "./integration-container";
import {
  INTEGRATION_LIMITS,
  CONTAINER_STORAGE_SCENARIO,
  type IntegrationScenarioEvidence,
  type IntegrationSourceIdentity,
} from "./integration-contracts";
import { writeIntegrationEvidence } from "./integration-evidence";

const HTTP_PROFILE = {
  kind: "http",
  port: 8080,
  healthPath: "/health",
  consolePath: null,
} as const;
const NONE_PROFILE = { kind: "none" } as const;
const TTL_SECONDS = 20;
const GUARD = ".auggy-auth-replay-guard.json";
const CLI = [
  "bun",
  "--no-env-file",
  "--no-install",
  "--config=/dev/null",
  "/app/node_modules/auggy/src/cli/index.ts",
];
type Change = IntegrationScenarioEvidence["changes"][number];

class ContainerObservationFailure extends Error {}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new ContainerObservationFailure(message);
}

const ADMISSION_REASONS = {
  missing: /runtime data root.*does not exist/,
  mode: /runtime data root must have mode 0700/,
  owner: /runtime data root.*(?:must be owned by the current user|could not pin directory)/,
  symlink: /runtime data root.*must not be a symlink/,
  identity: /runtime state belongs to a different agent id/,
  singleton: /another live replica owns this agent volume/,
  restore: /reconcile downstream effects before startup/,
} as const;

/** A missing env key, unrelated crash, or wrong rejection cannot satisfy storage admission. */
export function assertContainerAdmission(logs: string, reason: keyof typeof ADMISSION_REASONS) {
  check(!logs.includes("container-proof:factory"), "Invalid root reached augment construction");
  check(
    ADMISSION_REASONS[reason].test(logs),
    `Admission did not report expected ${reason} refusal`,
  );
}

/** Journal markers contain only fixture-generated UUIDs, never identity assertions. */
export function readContainerEffectJournal(logs: string): string[] {
  return logs
    .split("\n")
    .filter((line) => line.startsWith("container-proof:effect:"))
    .map((line) => {
      const match = /^container-proof:effect:([a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12})$/.exec(
        line,
      );
      check(match, "Malformed container effect journal");
      return match[1]!;
    });
}

interface ContainerRequestObservation {
  id: string;
  authorityGroup: string | null;
  kind: "authorized" | "duplicate" | "unauthorized" | "held";
  status?: number;
  acceptedRequests?: number | null;
}

export function containerAcceptedRequestCount(body: unknown): number | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const count = (body as Record<string, unknown>).acceptedRequests;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : null;
}

interface ContainerImageObservation {
  role: "admission-http" | "worker" | "durability-http" | "longer-ttl-http";
  imageDigest: string;
  exportSHA256: string;
  profile: DeploymentProfile;
}

/** Admission builds and TTL controls must not be attributed to the durability proof. */
export function selectContainerDurabilityImage(
  images: readonly ContainerImageObservation[],
): string | null {
  const durability = images.filter((image) => image.role === "durability-http");
  check(durability.length <= 1, "Ambiguous durability image identity");
  return durability[0]?.imageDigest ?? null;
}

/** Redact every diagnostic string before JSON escaping, including nested command/response fields. */
export function serializeContainerDiagnostics(
  value: unknown,
  privateValues: readonly string[],
): Buffer {
  const bytes = Buffer.from(
    `${JSON.stringify(value, (_key, field) => (typeof field === "string" ? redactIntegrationDiagnostic(field, privateValues) : field), 2)}\n`,
  );
  check(bytes.length <= INTEGRATION_LIMITS.evidenceBytes, "Container diagnostics exceeded bound");
  return bytes;
}

/** Count journal entries, including unexpected effects and concurrent reuse of the same authority. */
export function summarizeContainerEffects(
  requests: readonly ContainerRequestObservation[],
  effects: readonly string[],
) {
  const groups = new Map<string, number>();
  let unauthorizedEffectCount = 0;
  for (const id of effects) {
    const request = requests.find((candidate) => candidate.id === id);
    if (request?.status !== 200 || request.kind === "unauthorized" || request.kind === "held")
      unauthorizedEffectCount++;
    if (request?.authorityGroup)
      groups.set(request.authorityGroup, (groups.get(request.authorityGroup) ?? 0) + 1);
  }
  return {
    effectCount: effects.length,
    duplicateEffectCount: [...groups.values()].reduce(
      (sum, count) => sum + Math.max(0, count - 1),
      0,
    ),
    unauthorizedEffectCount,
  };
}
const script = (code: string) => [
  "bun",
  "--no-env-file",
  "--no-install",
  "--config=/dev/null",
  "-e",
  code,
];

export interface ContainerSuiteOptions {
  create: CreateAuthoringConsumerOptions;
  source: IntegrationSourceIdentity;
  runId: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  signal?: AbortSignal;
  dockerBinary?: string;
}

/** Only source files explicitly added or edited by this fixture are changed. */
async function prepareConsumer(options: ContainerSuiteOptions) {
  const core = options.create.artifacts.core;
  const create = {
    ...options.create,
    artifacts: {
      ...options.create.artifacts,
      core: {
        ...core,
        sourceFiles: [
          ...new Set([
            ...core.sourceFiles,
            "src/auth/external-auth.ts",
            "src/auth/external-auth-replay-store.ts",
            "src/auth/external-auth-replay-guard.ts",
            "src/cli/runtime-volume.ts",
            "src/cli/runtime-state-bundle.ts",
            "src/cli/runtime-state-inventory.ts",
            "src/cli/commands/state.ts",
            "src/runtime-data-admission.ts",
            "src/cli/deploy/portable-export.ts",
            "src/cli/deploy/manifest.ts",
          ]),
        ],
      },
    },
  };
  const generated = await createIntegrationConsumer(create);
  const consumer = generated.generated.consumer;
  const changes: Change[] = [];
  const env: Record<string, string> = applicationEnvironment(
    options.home,
    options.temporaryDirectory,
  );
  const source = (path: string, bytes: string | Buffer) => {
    mkdirSync(dirname(join(consumer, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(consumer, path), bytes, { mode: 0o600 });
  };
  for (const name of ["http-proof", "worker-proof"]) {
    const bytes = readFileSync(
      new URL(`./integration-fixtures/container/${name}.ts.template`, import.meta.url),
    );
    const path = `src/augments/${name}/index.ts`;
    source(path, bytes);
    changes.push({
      path,
      kind: "source-edit",
      beforeSHA256: null,
      afterSHA256: applicationHash(bytes),
    });
  }
  const initial = readIntegrationFile(consumer, "agent.yaml", 256 * 1024);
  const config = parse(initial.toString("utf8"));
  config.engine.baseURL = "http://127.0.0.1:1";
  config.engine.requestTimeoutMs = 1000;
  const httpAugments = [
    {
      name: "web",
      type: "webTransport",
      options: {
        port: 8080,
        auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
        allowAnonymous: false,
        publicIntegration: false,
        adminRoute: false,
        securityNamespace: config.id,
        externalAuth: {
          secret: "${AUGGY_AUTH_SECRET}",
          keyId: "container-key",
          audience: "container-audience",
          allowedProviders: ["container-app"],
          maxTtlSeconds: TTL_SECONDS,
          replayProtection: { enabled: true, dbPath: "./data/assertion-replay.sqlite" },
        },
        idempotency: { dbPath: "./data/web-runs.sqlite" },
      },
    },
    { name: "container-proof", type: "custom", source: "./src/augments/http-proof/index.ts" },
  ];
  config.augments = httpAugments;
  let previousConfig = initial;
  const writeConfig = () => {
    const bytes = Buffer.from(stringify(config));
    source("agent.yaml", bytes);
    changes.push({
      path: "agent.yaml",
      kind: "source-edit",
      beforeSHA256: applicationHash(previousConfig),
      afterSHA256: applicationHash(bytes),
    });
    previousConfig = bytes;
  };
  writeConfig();
  const typecheck = await withIntegrationChild(
    {
      label: "container-owned-source-typecheck",
      command: [process.execPath, "run", "typecheck"],
      cwd: consumer,
      env,
      secrets: [],
      signal: options.signal,
    },
    async ({ child }) => {
      check((await child.finish()).exitCode === 0, "Container source typecheck failed");
    },
  );
  check(typecheck.status === "passed", "Container owned source did not typecheck");
  const materialized = await materializeIntegrationDependencies({ create, consumer });
  changes.push(...materialized.changes);
  const exportContext = async (suffix: string, ingress: "http" | "none") => {
    const output = join(options.create.workspace, `${options.create.name}-${suffix}`);
    const exported = await withIntegrationChild(
      {
        label: `container-export-${suffix}`,
        command: [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--config=/dev/null",
          join(consumer, "node_modules/auggy/src/cli/index.ts"),
          "export",
          "docker",
          "--config",
          "agent.yaml",
          "--out",
          output,
          "--ingress",
          ingress,
        ],
        cwd: consumer,
        env,
        secrets: [],
        signal: options.signal,
      },
      async ({ child }) => {
        check((await child.finish()).exitCode === 0, "Installed Docker export failed");
      },
    );
    check(exported.status === "passed", "Installed Docker export did not pass");
    const manifest = readIntegrationFile(output, "auggy-deployment.json", 4 * 1024 * 1024);
    check(
      JSON.parse(manifest.toString("utf8")).profile.kind === ingress,
      "Unexpected exported profile",
    );
    return { context: output, exportSHA256: applicationHash(manifest) };
  };
  const http = await exportContext("http", "http");
  config.augments = [
    { name: "worker-proof", type: "custom", source: "./src/augments/worker-proof/index.ts" },
  ];
  writeConfig();
  const worker = await exportContext("worker", "none");
  config.augments = httpAugments;
  config.augments[0].options.externalAuth.maxTtlSeconds = 120;
  writeConfig();
  const longerTtl = await exportContext("longer-ttl", "http");
  const stale = join(options.create.workspace, `${options.create.name}-stale-lock`);
  cpSync(http.context, stale, { recursive: true, errorOnExist: true, force: false });
  const stalePackage = JSON.parse(
    readIntegrationFile(stale, "package.json", 1024 * 1024).toString("utf8"),
  );
  stalePackage.dependencies["is-number"] = "7.0.0";
  writeFileSync(join(stale, "package.json"), `${JSON.stringify(stalePackage, null, 2)}\n`, {
    mode: 0o600,
  });
  return {
    generated,
    consumer,
    changes,
    http,
    worker,
    longerTtl,
    stale: { context: stale, exportSHA256: http.exportSHA256 },
    source: {
      ...options.source,
      installedFiles: generated.installedFiles,
      lockfiles: [{ path: "bun.lock", sha256: materialized.lockfile.sha256 }],
    },
  };
}

async function waitForExit(scope: IntegrationDockerScope, container: string, signal?: AbortSignal) {
  const budget = createIntegrationBudget(15_000, signal);
  try {
    for (;;) {
      const state = await budget.run(5000, () => scope.status(container));
      if (!state.running) {
        check(state.exitCode !== 0, "Rejected runtime exited successfully");
        return;
      }
      await budget.run(500, () => Bun.sleep(250));
    }
  } finally {
    budget.dispose();
  }
}

async function ready(origin: string, signal?: AbortSignal) {
  const budget = createIntegrationBudget(INTEGRATION_LIMITS.readinessMs, signal);
  try {
    await waitForIntegrationHttpReady({
      url: `${origin}/health`,
      budget,
      ready: (response) => response.status === 200,
    });
  } finally {
    budget.dispose();
  }
}

export async function readContainerResponse(response: Response, signal?: AbortSignal) {
  const budget = createIntegrationBudget(5000, signal);
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (reader)
      for (;;) {
        const chunk = await budget.run(5000, () => reader.read());
        if (chunk.done) break;
        size += chunk.value.byteLength;
        check(size <= 4096, "Container response exceeded bound");
        chunks.push(chunk.value);
      }
    return {
      status: response.status,
      retryAfter: response.headers.get("retry-after"),
      body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>,
    };
  } finally {
    void reader?.cancel().catch(() => {});
    budget.dispose();
  }
}

/** Actual replay-store and restore-epoch observations; no raw assertions or credentials in evidence. */
export async function runContainerIntegration(options: ContainerSuiteOptions) {
  const prepared = await prepareConsumer(options);
  const env: Record<string, string> = applicationEnvironment(
    options.home,
    options.temporaryDirectory,
  );
  // Docker Desktop's client config is deliberately not inherited. Socket selection is explicit when needed.
  if (process.env.DOCKER_HOST) {
    check(
      /^unix:\/\/\//.test(process.env.DOCKER_HOST),
      "Container acceptance requires a local Docker socket",
    );
    env.DOCKER_HOST = process.env.DOCKER_HOST;
  }
  const binary = options.dockerBinary ?? Bun.which("docker");
  check(binary, "Docker CLI is unavailable");
  const secret = `container-assertion-${randomUUID()}`;
  const creator = `container-creator-${randomUUID()}`;
  const runtimeEnv = {
    AUGGY_DATA_DIR: "/app/data",
    ANTHROPIC_API_KEY: "container-unused-provider-key",
    AUGGY_WEB_TOKEN: creator,
    AUGGY_AUTH_SECRET: secret,
  };
  const privateValues = [secret, creator, runtimeEnv.ANTHROPIC_API_KEY];
  const mint = (changes: { audience?: string; secret?: string; ttlSeconds?: number } = {}) => {
    const assertion = createExternalAuthAssertion({
      secret: changes.secret ?? secret,
      keyId: "container-key",
      audience: changes.audience ?? "container-audience",
      provider: "container-app",
      subject: "container-fixture",
      scopes: ["container.probe"],
      jti: randomUUID(),
      ttlSeconds: changes.ttlSeconds ?? TTL_SECONDS,
    });
    privateValues.push(assertion);
    return assertion;
  };
  const observations: Record<string, unknown> = {};
  const images: ContainerImageObservation[] = [];
  observations.images = images;
  const recordImage = (
    role: ContainerImageObservation["role"],
    imageDigest: string,
    exported: typeof prepared.http,
    profile: DeploymentProfile,
  ) => {
    images.push({ role, imageDigest, exportSHA256: exported.exportSHA256, profile });
  };
  const requests: ContainerRequestObservation[] = [];
  const authorityGroups = new Map<string, string>();
  const effects: string[] = [];
  let readyCount = 0;
  const request = async (
    origin: string,
    assertion?: string,
    kind: (typeof requests)[number]["kind"] = "authorized",
  ) => {
    if (assertion && !authorityGroups.has(assertion)) authorityGroups.set(assertion, randomUUID());
    const observation: ContainerRequestObservation = {
      id: randomUUID(),
      authorityGroup: assertion ? authorityGroups.get(assertion)! : null,
      kind,
    };
    requests.push(observation);
    const budget = createIntegrationBudget(5000, options.signal);
    try {
      const result = await budget.run(5000, async (signal) => {
        const response = await fetch(`${origin}/container-proof`, {
          redirect: "manual",
          signal,
          headers: {
            "x-container-observation": observation.id,
            ...(assertion ? { "x-auggy-auth-assertion": assertion } : {}),
          },
        });
        return readContainerResponse(response, signal);
      });
      observation.status = result.status;
      observation.acceptedRequests = containerAcceptedRequestCount(result.body);
      return result;
    } finally {
      budget.dispose();
    }
  };
  observations.requests = requests;
  observations.effects = effects;
  const stages: {
    id: string;
    result: Awaited<ReturnType<typeof withIntegrationDocker>>;
    checks: string[];
    profile: DeploymentProfile;
    exportSHA256: string;
  }[] = [];
  let currentPhase = "admission";
  const executePhase = async (
    id: string,
    profile: DeploymentProfile,
    exported: typeof prepared.http,
    run: (scope: IntegrationDockerScope, checks: string[]) => Promise<unknown>,
  ) => {
    currentPhase = id;
    const checks: string[] = [];
    const result = await withIntegrationDocker(
      {
        cwd: options.create.workspace,
        env,
        binary,
        secrets: privateValues,
        runId: randomUUID(),
        signal: options.signal,
      },
      async (scope) => {
        try {
          return await run(scope, checks);
        } catch (error) {
          observations.failedObservation =
            error instanceof ContainerObservationFailure
              ? error.message
              : "Container command or bounded observation failed";
          throw error;
        }
      },
    );
    stages.push({ id, result, checks, profile, exportSHA256: exported.exportSHA256 });
    check(result.status === "passed", `Container phase ${id} failed`);
  };
  let failure: string | null = null;
  try {
    await executePhase(
      "admission-and-worker",
      NONE_PROFILE,
      prepared.worker,
      async (scope, checks) => {
        const http = await scope.build(prepared.http);
        recordImage("admission-http", http.imageId, prepared.http, HTTP_PROFILE);
        const worker = await scope.build(prepared.worker);
        recordImage("worker", worker.imageId, prepared.worker, NONE_PROFILE);
        await scope.assertFrozenLockFailure(prepared.stale);
        checks.push("actual-frozen-image-build", "stale-lock-build-rejected");
        const metadata = await scope.imageMetadata(worker.imageId);
        observations.workerImageMetadata = metadata;
        check(
          metadata.exposedPorts.length === 0 && !metadata.hasPortEnvironment,
          "Worker image fabricated HTTP ingress",
        );
        const volume = await scope.createVolume();
        const utility = await scope.startUtility({
          imageId: http.imageId,
          volume,
          env: runtimeEnv,
        });
        const initial = await scope.exec(
          utility.containerId,
          script(
            "const fs=require('node:fs'); const s=fs.statSync('/app/data'); console.log(JSON.stringify({mode:s.mode&511,uid:s.uid,entries:fs.readdirSync('/app/data')}));",
          ),
        );
        const mount = JSON.parse(initial.stdout);
        check(
          mount.mode !== 448 && mount.uid === 0 && mount.entries.length === 0,
          "Fresh volume was preconditioned or unexpectedly owned",
        );
        observations.freshVolume = mount;
        const denied = async (
          label: string,
          reason: keyof typeof ADMISSION_REASONS,
          variables = runtimeEnv,
        ) => {
          const instance = await scope.start({
            imageId: http.imageId,
            volume,
            profile: NONE_PROFILE,
            env: variables,
          });
          await waitForExit(scope, instance.containerId, options.signal);
          const logs = await scope.logs(instance.containerId);
          observations.lastAdmission = { label, log: logs.slice(-2048) };
          assertContainerAdmission(logs, reason);
          checks.push(label);
        };
        await denied("missing-root-refused-before-factory", "missing", {
          ...runtimeEnv,
          AUGGY_DATA_DIR: "/app/missing-root",
        });
        await denied("fresh-default-mode-root-refused-before-factory", "mode");
        await scope.exec(
          utility.containerId,
          script(
            "const fs=require('node:fs'); if(fs.readdirSync('/app/data').length)throw Error('expected empty operator volume');fs.chmodSync('/app/data',448);",
          ),
        );
        checks.push("explicit-empty-owned-volume-provisioning");
        await scope.exec(utility.containerId, ["chown", "12345:12345", "/app/data"]);
        await denied("wrong-owner-refused-before-factory", "owner");
        await scope.exec(utility.containerId, ["chown", "0:0", "/app/data"]);
        await scope.exec(
          utility.containerId,
          script("require('node:fs').symlinkSync('/app/data','/app/data/linked');"),
        );
        await denied("symlink-root-refused-before-factory", "symlink", {
          ...runtimeEnv,
          AUGGY_DATA_DIR: "/app/data/linked",
        });
        await scope.exec(
          utility.containerId,
          script(
            "const fs=require('node:fs');fs.unlinkSync('/app/data/linked');fs.writeFileSync('/app/data/.auggy-state-identity.json',JSON.stringify({version:1,agentId:'aug1_00000000-0000-4000-8000-000000000000'}),{mode:384});",
          ),
        );
        await denied("wrong-agent-id-refused-before-factory", "identity");
        await scope.exec(
          utility.containerId,
          script("require('node:fs').unlinkSync('/app/data/.auggy-state-identity.json');"),
        );
        const instance = await scope.start({
          imageId: worker.imageId,
          volume,
          profile: NONE_PROFILE,
          env: runtimeEnv,
        });
        let workerReady = false;
        for (let attempt = 0; attempt < 5; attempt++) {
          check(
            (await scope.status(instance.containerId)).running,
            "Worker did not remain running",
          );
          workerReady = (await scope.logs(instance.containerId)).includes("container-worker:ready");
          if (workerReady) break;
          await Bun.sleep(1000);
        }
        check(workerReady, "Owned worker capability did not boot");
        await scope.stop(instance.containerId);
        checks.push("worker-image-no-ingress", "worker-ordinary-entrypoint-boots-and-stops");
        return { imageId: worker.imageId };
      },
    );

    await executePhase(
      "durable-replay-and-restore",
      HTTP_PROFILE,
      prepared.http,
      async (scope, checks) => {
        const observedContainers: string[] = [];
        try {
          const image = await scope.build(prepared.http);
          recordImage("durability-http", image.imageId, prepared.http, HTTP_PROFILE);
          const sourceVolume = await scope.createVolume(),
            restoredVolume = await scope.createVolume();
          const utility = await scope.startUtility({
            imageId: image.imageId,
            volume: sourceVolume,
            restoreVolume: restoredVolume,
            env: runtimeEnv,
          });
          await scope.exec(
            utility.containerId,
            script(
              "const fs=require('node:fs');for(const root of ['/app/data','/restore']){const s=fs.statSync(root);if(s.uid!==process.getuid()||fs.readdirSync(root).length)throw Error('operator provisioning requires empty owned volume');fs.chmodSync(root,448);}",
            ),
          );
          const start = async (volume: string, selectedImage = image.imageId) => {
            const instance = await scope.start({
              imageId: selectedImage,
              volume,
              profile: HTTP_PROFILE,
              env: runtimeEnv,
            });
            observedContainers.push(instance.containerId);
            check(instance.origin, "HTTP image has no origin");
            await ready(instance.origin, options.signal);
            readyCount++;
            return { ...instance, origin: instance.origin };
          };
          let active = await start(sourceVolume);
          for (const assertion of [
            undefined,
            mint({ secret: "wrong-synthetic-key" }),
            mint({ audience: "other-company" }),
          ])
            check(
              (await request(active.origin, assertion, "unauthorized")).status === 401,
              "Invalid identity admitted container route",
            );
          const accepted = mint();
          const concurrent = await Promise.all([
            request(active.origin, accepted),
            request(active.origin, accepted),
          ]);
          check(
            concurrent
              .map((result) => result.status)
              .sort()
              .join(",") === "200,401" &&
              concurrent.find((result) => result.status === 200)?.body.acceptedRequests === 1,
            "Concurrent assertion reuse did not produce exactly one authorized effect",
          );
          check(
            (await request(active.origin, accepted, "duplicate")).status === 401,
            "Repeated assertion was admitted",
          );
          const competitor = await scope.start({
            imageId: image.imageId,
            volume: sourceVolume,
            profile: NONE_PROFILE,
            env: runtimeEnv,
          });
          await waitForExit(scope, competitor.containerId, options.signal);
          assertContainerAdmission(await scope.logs(competitor.containerId), "singleton");
          checks.push(
            "invalid-identity-zero-route-effects",
            "one-use-authenticated-route",
            "concurrent-assertion-reuse-one-effect",
            "singleton-competition-before-factory",
          );
          const beforeRestart = mint(),
            expiresAt = Date.now() + TTL_SECONDS * 1000;
          check(
            (await request(active.origin, beforeRestart)).body.acceptedRequests === 2,
            "Pre-restart assertion did not execute",
          );
          await scope.stop(active.containerId);
          active = await start(sourceVolume);
          check(
            Date.now() < expiresAt - 1000,
            "Restart replay assertion expired before its observation",
          );
          check(
            (await request(active.origin, beforeRestart, "duplicate")).status === 401,
            "Restart lost durable assertion replay",
          );
          check(
            (await request(active.origin, mint())).body.acceptedRequests === 1,
            "Replacement did not admit fresh authority",
          );
          const stored = await scope.exec(
            utility.containerId,
            script(
              "const {Database}=require('bun:sqlite');const db=new Database('/app/data/assertion-replay.sqlite',{readonly:true});console.log(JSON.stringify({applicationId:db.query('PRAGMA application_id').get().application_id,claims:db.query('SELECT COUNT(*) AS count FROM external_auth_replay_claims').get().count}));db.close();",
            ),
          );
          const replay = JSON.parse(stored.stdout);
          check(
            replay.applicationId === 0x45415250 && replay.claims >= 3,
            "Actual EARP SQLite state missing",
          );
          observations.replay = replay;
          checks.push("durable-earp-replay-after-container-replacement");
          await scope.stop(active.containerId);
          await scope.exec(utility.containerId, [
            ...CLI,
            "state",
            "backup",
            "--config",
            "/app/agent.yaml",
            "--root",
            "/app/data",
            "--out",
            "/tmp/fixture-backup",
            "--confirm-stopped",
            "--runtime-volume-only",
          ]);
          await scope.exec(utility.containerId, [...CLI, "state", "verify", "/tmp/fixture-backup"]);
          const bundle = await scope.exec(
            utility.containerId,
            script(
              "const fs=require('node:fs');const m=JSON.parse(fs.readFileSync('/tmp/fixture-backup/manifest.json','utf8'));console.log(JSON.stringify({paths:m.files.map(f=>f.path),schemas:m.inventory.stores.map(s=>s.schema)}));",
            ),
          );
          const bundled = JSON.parse(bundle.stdout);
          check(!bundled.paths.includes(GUARD), "Backup copied the local replay guard");
          check(
            bundled.paths.includes("assertion-replay.sqlite") &&
              bundled.paths.includes("web-runs.sqlite") &&
              bundled.schemas.includes("EARP/v1"),
            "Backup did not preserve the runtime-relative replay store topology",
          );
          observations.backup = {
            paths: bundled.paths,
            schemas: bundled.schemas,
            runtimeRoot: "/app/data",
            restoreRoot: "/restore",
          };
          await scope.exec(utility.containerId, [
            ...CLI,
            "state",
            "restore",
            "/tmp/fixture-backup",
            "--config",
            "/app/agent.yaml",
            "--root",
            "/restore",
            "--runtime-root",
            "/app/data",
            "--confirm-stopped",
            "--runtime-volume-only",
          ]);
          const guard = JSON.parse(
            (
              await scope.exec(
                utility.containerId,
                script(`console.log(require('node:fs').readFileSync('/restore/${GUARD}','utf8'));`),
              )
            ).stdout,
          );
          check(
            typeof guard.latestRestore?.restoreId === "string" &&
              Number.isSafeInteger(guard.latestRestore.restoredAtMs),
            "Restore did not establish a fresh replay epoch",
          );
          observations.restore = {
            restoreId: guard.latestRestore.restoreId,
            restoredAtMs: guard.latestRestore.restoredAtMs,
            guardExcludedFromBackup: !bundled.paths.includes(GUARD),
          };
          checks.push(
            "real-offline-backup-verify-restore",
            "fresh-destination-guard-excluded-from-backup",
          );
          const fenced = await scope.start({
            imageId: image.imageId,
            volume: restoredVolume,
            profile: NONE_PROFILE,
            env: runtimeEnv,
          });
          await waitForExit(scope, fenced.containerId, options.signal);
          assertContainerAdmission(await scope.logs(fenced.containerId), "restore");
          checks.push("restore-fence-before-factory");
          await scope.exec(utility.containerId, [
            ...CLI,
            "state",
            "reconcile",
            "--root",
            "/restore",
            "--restore-id",
            guard.latestRestore.restoreId,
            "--confirm-downstream-reconciled",
          ]);
          const reconciled = JSON.parse(
            (
              await scope.exec(
                utility.containerId,
                script(`console.log(require('node:fs').readFileSync('/restore/${GUARD}','utf8'));`),
              )
            ).stdout,
          );
          check(
            JSON.stringify(reconciled) === JSON.stringify(guard),
            "Reconcile changed the replay guard",
          );
          active = await start(restoredVolume);
          let held = await request(active.origin, mint(), "held");
          check(
            held.status === 503 && Number(held.retryAfter) > 0,
            "Fresh restore did not hold assertion ingress",
          );
          await scope.stop(active.containerId);
          active = await start(restoredVolume);
          held = await request(active.origin, mint(), "held");
          check(held.status === 503, "Restart cleared the restore epoch hold");
          checks.push("real-offline-reconcile", "restore-hold-survives-reconcile-and-restart");
          const until = guard.latestRestore.restoredAtMs + TTL_SECONDS * 1000 + 30_000;
          const wait = createIntegrationBudget(60_000, options.signal);
          try {
            while (Date.now() <= until + 500)
              await wait.run(5000, () =>
                Bun.sleep(Math.min(4000, Math.max(1, until + 501 - Date.now()))),
              );
          } finally {
            wait.dispose();
          }
          check(
            (await request(active.origin, beforeRestart, "unauthorized")).status === 401,
            "Expired assertion was admitted after restore hold",
          );
          check(
            (await request(active.origin, mint())).body.acceptedRequests === 1,
            "Expired restore hold did not admit fresh assertion",
          );
          checks.push("expired-assertion-denied-after-hold", "fresh-assertion-after-hold");
          await scope.stop(active.containerId);
          const extended = await scope.build(prepared.longerTtl);
          recordImage("longer-ttl-http", extended.imageId, prepared.longerTtl, HTTP_PROFILE);
          active = await start(restoredVolume, extended.imageId);
          check(
            (await request(active.origin, mint(), "held")).status === 503,
            "Increasing TTL failed to reopen restore hold",
          );
          const final = JSON.parse(
            (
              await scope.exec(
                utility.containerId,
                script(`console.log(require('node:fs').readFileSync('/restore/${GUARD}','utf8'));`),
              )
            ).stdout,
          );
          check(
            JSON.stringify(final.latestRestore) === JSON.stringify(guard.latestRestore),
            "Replay restore epoch changed after replacement",
          );
          observations.restore = {
            restoreId: guard.latestRestore.restoreId,
            restoredAtMs: guard.latestRestore.restoredAtMs,
            epochPreserved: true,
            guardExcludedFromBackup: true,
          };
          checks.push("ttl-increase-reopens-permanent-epoch-hold");
          return { imageId: image.imageId };
        } finally {
          observations.readyCount = readyCount;
          for (const container of observedContainers)
            effects.push(...readContainerEffectJournal(await scope.logs(container)));
        }
      },
    );
    check(
      effects.length === 4 && new Set(effects).size === effects.length,
      "Actual route effect journal differs from expected accepted requests",
    );
    check(
      effects.every((id) =>
        requests.some(
          (request) => request.id === id && request.kind === "authorized" && request.status === 200,
        ),
      ),
      "Unexpected route effect found in actual container journal",
    );
  } catch {
    failure = `Container acceptance failed during ${currentPhase}`;
  }

  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  const diagnosticBytes = serializeContainerDiagnostics(
    { stages, observations, failure },
    privateValues,
  );
  const safeDiagnostics = JSON.parse(diagnosticBytes.toString("utf8")) as {
    stages: typeof stages;
    observations: typeof observations;
  };
  writeFileSync(join(options.evidenceDirectory, "container-diagnostics.json"), diagnosticBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const evidence: IntegrationScenarioEvidence = {
    version: 1,
    scenarioId: CONTAINER_STORAGE_SCENARIO,
    runId: options.runId,
    stage: "container",
    buildKind: "standalone-fixture",
    source: prepared.source,
    profile: HTTP_PROFILE,
    baselineFiles: prepared.generated.baselineFiles,
    changes: prepared.changes,
    execution: {
      commandLabels: stages
        .flatMap(({ result }) =>
          "commands" in result ? result.commands.map((command) => command.label) : [],
        )
        .slice(0, 1000),
      deadlinesMs: {
        phase: INTEGRATION_LIMITS.phaseBuildMs,
        command: INTEGRATION_LIMITS.scenarioMs,
      },
      firstChunkBeforeTerminal: null,
      ...summarizeContainerEffects(requests, effects),
      startup:
        readyCount > 0
          ? "ready"
          : stages.some(({ result }) => result.status !== "unavailable")
            ? "failed"
            : "not-run",
      channel: "unverified",
      observations: [
        ...stages.flatMap((stage) => stage.checks),
        "Worker startup is not a channel-turn certification",
        "Generic Docker proof is separate from hosted Railway proof",
      ],
    },
    platform: {
      exportSHA256: prepared.http.exportSHA256,
      imageDigest: selectContainerDurabilityImage(images),
      deploymentId: null,
      resources: stages.flatMap(({ result }) => ("resources" in result ? result.resources : [])),
    },
    outcome: failure
      ? {
          status: stages.some(({ result }) => result.status === "unavailable")
            ? "unavailable"
            : "failed",
          reason: failure,
        }
      : { status: "passed", checks: stages.flatMap((stage) => stage.checks) },
    cleanup: {
      status: stages.some(({ result }) => result.cleanup.status === "failed")
        ? "failed"
        : stages.some(({ result }) => result.cleanup.status === "complete")
          ? "complete"
          : "not-needed",
      remainingOwnedIds: stages.flatMap(({ result }) => result.cleanup.remainingOwnedIds),
    },
    artifacts: [{ path: "container-diagnostics.json", sha256: applicationHash(diagnosticBytes) }],
    retainedUntil: null,
    independentReviewer: null,
  };
  writeIntegrationEvidence(
    options.evidenceDirectory,
    "container-storage-recovery.json",
    JSON.stringify(evidence),
    privateValues,
  );
  return {
    evidence,
    consumer: prepared.consumer,
    exports: { http: prepared.http, worker: prepared.worker, longerTtl: prepared.longerTtl },
    diagnostics: safeDiagnostics,
  };
}
