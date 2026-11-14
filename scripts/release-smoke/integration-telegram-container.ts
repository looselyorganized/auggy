/** A12 polling-image execution. Distinct from local Telegram and generic container storage proof. */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, stringify } from "yaml";
import { applicationEnvironment, applicationHash } from "./application-consumer";
import type { CreateAuthoringConsumerOptions } from "./authoring-contract";
import {
  createIntegrationConsumer,
  materializeIntegrationDependencies,
  readIntegrationFile,
  redactIntegrationDiagnostic,
  withIntegrationChild,
} from "./integration-consumer";
import { withIntegrationDocker } from "./integration-container";
import {
  INTEGRATION_LIMITS,
  TELEGRAM_CONTAINER_SCENARIO,
  type IntegrationScenarioEvidence,
  type IntegrationSourceIdentity,
} from "./integration-contracts";
import { writeIntegrationEvidence } from "./integration-evidence";
import { assertTelegramDeliveryIdentity, assertTelegramSourceMarker } from "./integration-telegram";
import {
  telegramFixtureUpdate,
  type TelegramJournalEvent,
} from "./integration-fixtures/telegram/protocol-fixture";
import {
  TELEGRAM_FIXTURE_TOKEN,
  TELEGRAM_FIXTURE_INSTALL_MARKER,
} from "./integration-fixtures/telegram/telegram-network";
import { PROVIDER_FIXTURE_API_KEY, type ProviderFixtureEvidence } from "./provider-fixture";

const PROXY = "http://127.0.0.1:43141";
const CONTROL = "http://127.0.0.1:43142/control";
const MAIN = "export const main: ApplicationMain = async (launch) => {";
const INSTALL = `  installTelegramFixtureNetwork("${TELEGRAM_FIXTURE_INSTALL_MARKER}", await startContainerTelegramFixture());`;
const QUIESCENT = "auggy-telegram-container-fixtures:quiescent";
type Change = IntegrationScenarioEvidence["changes"][number];
type HashedFile = { path: string; sha256: string };
type Snapshot = {
  version: 1;
  protocol: { events: TelegramJournalEvent[]; activeRequests: number; rejectedRequests: number };
  provider: ProviderFixtureEvidence;
};

class PollingContainerFailure extends Error {}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new PollingContainerFailure(message);
}

/** Only these explicitly recorded fixture sources are copied; the generated host stays intact. */
export function prepareTelegramContainerFixtures(consumer: string) {
  const changes: Change[] = [];
  const files: HashedFile[] = [];
  const copies: { source: string; sourceSHA256: string; target: string; targetSHA256: string }[] =
    [];
  const put = (
    path: string,
    bytes: string | Buffer,
    kind: Change["kind"],
    before: Buffer | null = null,
  ) => {
    mkdirSync(dirname(join(consumer, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(consumer, path), bytes, { mode: 0o600 });
    const sha256 = applicationHash(bytes);
    changes.push({
      path,
      kind,
      beforeSHA256: before && applicationHash(before),
      afterSHA256: sha256,
    });
    files.push({ path, sha256 });
  };
  const copy = (source: string, target: string, rewrite?: (source: string) => string) => {
    const before = readFileSync(new URL(source, import.meta.url));
    const after = rewrite ? Buffer.from(rewrite(before.toString("utf8"))) : before;
    put(target, after, "fixture-overlay");
    copies.push({
      source: source.replace(/^\.\//, ""),
      sourceSHA256: applicationHash(before),
      target,
      targetSHA256: applicationHash(after),
    });
  };
  copy("./integration-fixtures/telegram/telegram-network.ts", "src/fixtures/telegram-network.ts");
  copy("./provider-fixture.ts", "src/fixtures/telegram-provider.ts");
  copy(
    "./integration-fixtures/telegram/protocol-fixture.ts",
    "src/fixtures/telegram-protocol.ts",
    (source) => {
      const original = 'from "../../integration-contracts"';
      check(source.split(original).length === 2, "Reviewed Telegram fixture import changed");
      return source.replace(original, 'from "./integration-limits"');
    },
  );
  put(
    "src/fixtures/integration-limits.ts",
    `export const INTEGRATION_LIMITS = ${JSON.stringify(INTEGRATION_LIMITS, null, 2)} as const;\n`,
    "fixture-overlay",
  );
  copy(
    "./integration-fixtures/telegram-container/startup.ts.template",
    "src/fixtures/telegram-container-startup.ts",
  );
  const proof = readFileSync(
    new URL("./integration-fixtures/telegram/proof-augment.ts.template", import.meta.url),
    "utf8",
  );
  const lifecycle = `import { stopContainerTelegramFixture } from "../../fixtures/telegram-container-startup";\n${proof.replace('    name: "telegram-proof",', '    name: "telegram-proof",\n    onShutdown: stopContainerTelegramFixture,')}`;
  check(
    lifecycle.includes("onShutdown: stopContainerTelegramFixture"),
    "Fixture augment lifecycle anchor changed",
  );
  put("src/augments/telegram-proof/index.ts", lifecycle, "source-edit");
  copies.push({
    source: "integration-fixtures/telegram/proof-augment.ts.template",
    sourceSHA256: applicationHash(proof),
    target: "src/augments/telegram-proof/index.ts",
    targetSHA256: applicationHash(lifecycle),
  });
  const before = readIntegrationFile(consumer, "src/index.ts", 32_768);
  const main = before.toString("utf8");
  check(
    main.split(MAIN).length === 2 && !main.includes("TelegramFixture"),
    "Unexpected generated Telegram entrypoint",
  );
  put(
    "src/index.ts",
    `import { installTelegramFixtureNetwork } from "./fixtures/telegram-network";\nimport { startContainerTelegramFixture } from "./fixtures/telegram-container-startup";\n${main.replace(MAIN, `${MAIN}\n${INSTALL}`)}`,
    "fixture-overlay",
    before,
  );
  assertTelegramContainerFixtures(consumer, files);
  return { files, changes, copies };
}

export function assertTelegramContainerFixtures(consumer: string, files: readonly HashedFile[]) {
  check(
    files.length === 7 && new Set(files.map((file) => file.path)).size === 7,
    "Incomplete container fixture inventory",
  );
  for (const file of files)
    check(
      applicationHash(readIntegrationFile(consumer, file.path, 256 * 1024)) === file.sha256,
      "Container fixture source hash changed",
    );
  const startup = readIntegrationFile(consumer, "src/index.ts", 32_768).toString("utf8");
  check(
    startup.includes(`${MAIN}\n${INSTALL}\n`) && startup.split(INSTALL).length === 2,
    "Container fixture installation must be first in generated main",
  );
}

/** Require a new duplicate delivery AND its later acknowledgement; old offsets cannot pass. */
export function assertContainerTelegramReplay(
  events: readonly TelegramJournalEvent[],
  updateId: number,
) {
  const delivered = events.findIndex(
    (event) => event.kind === "poll" && event.offset === null && event.updateIds.includes(updateId),
  );
  check(delivered >= 0, "Container did not redeliver the duplicate update");
  check(
    events
      .slice(delivered + 1)
      .some((event) => event.kind === "poll" && event.offset === updateId + 1),
    "Container did not acknowledge duplicate delivery",
  );
  check(
    events.every((event) => !["attempt", "effect", "reply"].includes(event.kind)),
    "Duplicate container delivery executed work",
  );
}

function parseSnapshot(value: string): Snapshot {
  check(
    Buffer.byteLength(value) <= INTEGRATION_LIMITS.fixtureJournalBytes,
    "Container snapshot exceeded bound",
  );
  const snapshot = JSON.parse(value) as Snapshot;
  check(
    snapshot.version === 1 &&
      Array.isArray(snapshot.protocol?.events) &&
      snapshot.protocol.events.length <= INTEGRATION_LIMITS.fixtureEvents &&
      snapshot.protocol.rejectedRequests === 0 &&
      Number.isSafeInteger(snapshot.provider?.calls),
    "Invalid container fixture snapshot",
  );
  return snapshot;
}

const script = (code: string) => [
  "bun",
  "--no-env-file",
  "--no-install",
  "--config=/dev/null",
  "-e",
  code,
];
type ControlWait =
  | { kind: "ready" }
  | { kind: "reply"; count: number }
  | { kind: "duplicate"; updateId: number }
  | { kind: "snapshot" };

/** Secret is read inside the owned container, never embedded in command args or metadata. */
export function telegramContainerControlCommand(
  operation: Record<string, unknown>,
  wait: ControlWait,
): string[] {
  const input = JSON.stringify(operation);
  check(input.length <= 2048, "Container control request exceeded bound");
  return script(`
const request = async (body) => {
  const response = await fetch(${JSON.stringify(CONTROL)}, { method: "POST", headers: {"content-type":"application/json", "x-fixture-control":process.env.AUGGY_FIXTURE_CONTROL_TOKEN}, body:JSON.stringify(body), redirect:"manual", signal:AbortSignal.timeout(2000) });
  if (!response.ok) throw Error("private container fixture request rejected");
  const reader=response.body.getReader(); const chunks=[]; let bytes=0;
  for (;;) { const next=await reader.read(); if(next.done)break; bytes+=next.value.length;if(bytes>2097152){await reader.cancel();throw Error("snapshot limit");}chunks.push(next.value); }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
};
const operation=${input}; const wait=${JSON.stringify(wait)};
const deadline=Date.now()+15000; let initial=true;
while(Date.now()<deadline) {
  let snapshot;
  try { snapshot=await request(initial?operation:{operation:"snapshot"}); initial=false; }
  catch { if(!initial||operation.operation!=="snapshot")throw Error("private fixture request failed"); await Bun.sleep(100);continue; }
  const events=snapshot.protocol.events;
  const delivered=wait.kind==="duplicate"?events.findIndex(e=>e.kind==="poll"&&e.offset===null&&e.updateIds.includes(wait.updateId)):-1;
  const ready=wait.kind==="snapshot" || (wait.kind==="ready"&&events.some(e=>e.kind==="poll")) || (wait.kind==="reply"&&events.filter(e=>e.kind==="reply").length===wait.count) || (wait.kind==="duplicate"&&delivered>=0&&events.slice(delivered+1).some(e=>e.kind==="poll"&&e.offset===wait.updateId+1));
  if(ready){console.log(JSON.stringify(snapshot));process.exit(0);} await Bun.sleep(100);
}
throw Error("private fixture observation deadline exceeded");
`);
}

export interface TelegramContainerOptions {
  create: CreateAuthoringConsumerOptions;
  source: IntegrationSourceIdentity;
  runId: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  signal?: AbortSignal;
  dockerBinary?: string;
}

export async function runTelegramContainerIntegration(options: TelegramContainerOptions) {
  check(
    options.create.provider === "anthropic",
    "Polling image requires the actual Anthropic adapter",
  );
  const create = {
    ...options.create,
    artifacts: {
      ...options.create.artifacts,
      core: {
        ...options.create.artifacts.core,
        sourceFiles: [
          ...new Set([
            ...options.create.artifacts.core.sourceFiles,
            "src/http.ts",
            "src/telegram-client.ts",
            "src/augments/telegramTransport/index.ts",
            "src/augments/telegramTransport/polling.ts",
            "src/augments/telegramTransport/replay-store.ts",
            "src/augments/telegramTransport/replay-identity.ts",
            "src/lib/sqlite.ts",
            "src/runtime-data-admission.ts",
            "src/cli/runtime-state-inventory.ts",
            "src/cli/deploy/portable-export.ts",
          ]),
        ],
      },
    },
  };
  const generated = await createIntegrationConsumer(create);
  const consumer = generated.generated.consumer;
  const fixtures = prepareTelegramContainerFixtures(consumer);
  const changes = [...fixtures.changes];
  const before = readIntegrationFile(consumer, "agent.yaml", 256 * 1024);
  const config = parse(before.toString("utf8"));
  config.engine = { ...config.engine, baseURL: PROXY, requestTimeoutMs: 10000 };
  config.settings = { ...config.settings, maxInferenceLoops: 3 };
  config.augments = [
    {
      name: "telegram",
      type: "telegramTransport",
      options: {
        botToken: "${TELEGRAM_BOT_TOKEN}",
        inbound: { mode: "polling", polling: { timeoutSec: 1 } },
        auth: { creatorUserIds: [101], recognizedUserIds: [202] },
        replay: { dbPath: "./data/telegram-replay.db" },
      },
    },
    { name: "telegram-proof", type: "custom", source: "./src/augments/telegram-proof/index.ts" },
  ];
  const after = stringify(config);
  writeFileSync(join(consumer, "agent.yaml"), after, { mode: 0o600 });
  changes.push({
    path: "agent.yaml",
    kind: "source-edit",
    beforeSHA256: applicationHash(before),
    afterSHA256: applicationHash(after),
  });
  const env: Record<string, string> = applicationEnvironment(
    options.home,
    options.temporaryDirectory,
  );
  // Match the generic container runner: select a local socket explicitly while
  // keeping the operator's Docker config and credentials out of the fixture HOME.
  if (process.env.DOCKER_HOST) {
    check(
      /^unix:\/\/\//.test(process.env.DOCKER_HOST),
      "Container acceptance requires a local Docker socket",
    );
    env.DOCKER_HOST = process.env.DOCKER_HOST;
  }
  // Resolve before using the intentionally minimal child PATH (which need not
  // include Docker Desktop's /usr/local/bin installation).
  const dockerBinary = options.dockerBinary ?? Bun.which("docker");
  check(dockerBinary, "Docker CLI is unavailable");
  const secret = randomBytes(32).toString("hex");
  const privateValues = [
    secret,
    TELEGRAM_FIXTURE_TOKEN,
    PROVIDER_FIXTURE_API_KEY,
    consumer,
    options.create.workspace,
    options.create.repoRoot,
    options.evidenceDirectory,
  ];
  const commands: {
    label: string;
    status: string;
    cleanupConfirmed: boolean;
    diagnostic: string;
  }[] = [];
  const execute = async (label: string, command: string[]) => {
    const result = await withIntegrationChild(
      { label, command, cwd: consumer, env, secrets: privateValues, signal: options.signal },
      async ({ child }) => {
        check(
          (await child.finish()).exitCode === 0,
          "Installed polling preparation command failed",
        );
      },
    );
    commands.push({
      label,
      status: result.status,
      cleanupConfirmed: result.process.cleanupConfirmed,
      diagnostic: `${result.process.stdout}\n${result.process.stderr}`.slice(-8192),
    });
    check(result.status === "passed", "Installed polling preparation failed");
  };
  await execute("telegram-container-typecheck", [
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--config=/dev/null",
    "run",
    "typecheck",
  ]);
  const materialized = await materializeIntegrationDependencies({ create, consumer });
  changes.push(...materialized.changes);
  const context = join(options.create.workspace, `${options.create.name}-polling-image`);
  await execute("telegram-container-export", [
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
    context,
    "--ingress",
    "none",
  ]);
  assertTelegramContainerFixtures(context, fixtures.files);
  const manifest = readIntegrationFile(
    context,
    "auggy-deployment.json",
    INTEGRATION_LIMITS.evidenceBytes,
  );
  check(
    JSON.stringify(JSON.parse(manifest.toString("utf8")).profile) === '{"kind":"none"}',
    "Polling export invented ingress",
  );
  const exportSHA256 = applicationHash(manifest);
  const generations: {
    name: string;
    snapshot: Snapshot | null;
    beforeStopLogs: string;
    afterStopLogs: string;
  }[] = [];
  const deliveries: {
    generation: string;
    updateId: number;
    expectedTrust: "creator" | "recognized";
    observedEffects: number;
    provider: ProviderFixtureEvidence;
  }[] = [];
  const replay: unknown[] = [];
  let imageDigest: string | null = null;
  let phase = "docker-build";
  let failure: string | null = null;
  let duplicateEffectCount = 0;
  let unauthorizedEffectCount = 0;
  const containerEnv = {
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    TELEGRAM_BOT_TOKEN: TELEGRAM_FIXTURE_TOKEN,
    AUGGY_FIXTURE_CONTROL_TOKEN: secret,
    AUGGY_FIXTURE_TELEGRAM_ORIGIN: PROXY,
    AUGGY_FIXTURE_MODEL_ORIGIN: PROXY,
  };
  const docker = await withIntegrationDocker(
    {
      cwd: consumer,
      env,
      binary: dockerBinary,
      secrets: privateValues,
      runId: options.runId,
      signal: options.signal,
    },
    async (scope) => {
      try {
        const image = await scope.build({ context, exportSHA256 });
        imageDigest = image.imageId;
        const metadata = await scope.imageMetadata(image.imageId);
        check(
          metadata.exposedPorts.length === 0 && !metadata.hasPortEnvironment,
          "Polling image advertises an HTTP listener",
        );
        const volume = await scope.createVolume();
        const utility = await scope.startUtility({ imageId: image.imageId, volume, env: {} });
        await scope.exec(
          utility.containerId,
          script(
            "const fs=require('node:fs');const s=fs.statSync('/app/data');if(s.uid!==process.getuid()||fs.readdirSync('/app/data').length)throw Error('expected empty owned volume');fs.chmodSync('/app/data',448);",
          ),
        );
        const readReplay = async () => {
          const result = await scope.exec(
            utility.containerId,
            script(
              "const fs=require('node:fs'),{Database}=require('bun:sqlite'),{createHash}=require('node:crypto');const p='/app/data/telegram-replay.db',s=fs.lstatSync(p);if(!s.isFile()||s.isSymbolicLink()||s.size>16777216)throw Error('invalid replay file');const db=new Database(p,{readonly:true,create:false});try{const applicationId=db.query('PRAGMA application_id').get().application_id,schemaVersion=db.query('PRAGMA user_version').get().user_version;if(applicationId!==0x54475250||schemaVersion!==2)throw Error('wrong replay identity');const claims=db.query('SELECT namespace,update_id FROM telegram_update_claims ORDER BY update_id LIMIT 100').all().map(r=>({updateId:r.update_id,namespaceSHA256:createHash('sha256').update(r.namespace).digest('hex')}));console.log(JSON.stringify({applicationId,schemaVersion,claims}));}finally{db.close();}",
            ),
          );
          const value = JSON.parse(result.stdout) as {
            applicationId: number;
            schemaVersion: number;
            claims: { updateId: number; namespaceSHA256: string }[];
          };
          replay.push(value);
          return value;
        };
        const control = async (
          containerId: string,
          operation: Record<string, unknown>,
          wait: ControlWait,
        ) =>
          parseSnapshot(
            (await scope.exec(containerId, telegramContainerControlCommand(operation, wait)))
              .stdout,
          );
        const generation = async (
          name: string,
          operate: (containerId: string, observe: (snapshot: Snapshot) => void) => Promise<void>,
        ) => {
          phase = name;
          assertTelegramContainerFixtures(context, fixtures.files);
          const running = await scope.start({
            imageId: image.imageId,
            volume,
            profile: { kind: "none" },
            env: containerEnv,
          });
          check(running.origin === null, "Polling container invented a public origin");
          const observation = {
            name,
            snapshot: null as Snapshot | null,
            beforeStopLogs: "",
            afterStopLogs: "",
          };
          generations.push(observation);
          try {
            observation.snapshot = await control(
              running.containerId,
              { operation: "snapshot" },
              { kind: "ready" },
            );
            await operate(running.containerId, (snapshot) => {
              observation.snapshot = snapshot;
            });
            observation.snapshot = await control(
              running.containerId,
              { operation: "snapshot" },
              { kind: "snapshot" },
            );
            observation.beforeStopLogs = await scope.logs(running.containerId);
          } finally {
            await scope.stop(running.containerId);
            observation.afterStopLogs = await scope.logs(running.containerId);
            const stopped = await scope.status(running.containerId);
            check(
              !stopped.running &&
                stopped.exitCode === 0 &&
                observation.afterStopLogs.split(QUIESCENT).length === 2,
              "Polling runtime or fixture shutdown was not clean",
            );
          }
        };
        const deliver = async (
          containerId: string,
          observe: (snapshot: Snapshot) => void,
          generationName: string,
          updateId: number,
          userId: number,
          replyCount: number,
          creator: boolean,
        ) => {
          const beforeSnapshot = await control(
            containerId,
            { operation: "snapshot" },
            { kind: "snapshot" },
          );
          const update = telegramFixtureUpdate(updateId, userId);
          const snapshot = await control(
            containerId,
            { operation: "enqueue", update },
            { kind: "reply", count: replyCount },
          );
          observe(snapshot);
          const fresh = snapshot.protocol.events.slice(beforeSnapshot.protocol.events.length);
          const observedEffects = fresh.filter((event) => event.kind === "effect").length;
          // Record violations before checking runtime claims: an escalated input
          // must not authorize its own effects by reporting creator trust.
          if (!creator) unauthorizedEffectCount += observedEffects;
          deliveries.push({
            generation: generationName,
            updateId,
            expectedTrust: creator ? "creator" : "recognized",
            observedEffects,
            provider: snapshot.provider,
          });
          assertTelegramDeliveryIdentity(fresh, update, creator ? "creator" : "recognized");
          assertTelegramSourceMarker(fresh, "telegram-proof:baseline");
          check(
            fresh.filter((event) => event.kind === "effect").length === (creator ? 1 : 0),
            "Unexpected container delivery effect",
          );
          check(
            fresh.some(
              (event) =>
                event.kind === "reply" &&
                event.chatId === userId &&
                event.json &&
                event.runtimeUserAgent,
            ),
            "Container reply did not traverse serialized Bot HTTP",
          );
          check(
            snapshot.provider.calls === 2 &&
              snapshot.provider.toolRequests === 1 &&
              snapshot.provider.validatedToolResults === 1 &&
              snapshot.provider.rejectedRequests === 0,
            "Container model exchange was not verified",
          );
        };
        await generation("telegram-container-initial", async (containerId, observe) => {
          await deliver(containerId, observe, "initial", 1, 101, 1, true);
          await deliver(containerId, observe, "initial", 2, 202, 2, false);
        });
        const firstReplay = await readReplay();
        check(
          JSON.stringify(firstReplay.claims.map((claim) => claim.updateId)) === "[1,2]",
          "Container did not persist initial replay claims",
        );
        await generation("telegram-container-replacement", async (containerId, observe) => {
          const duplicate = await control(
            containerId,
            { operation: "enqueue", update: telegramFixtureUpdate(1, 101) },
            { kind: "duplicate", updateId: 1 },
          );
          observe(duplicate);
          duplicateEffectCount += duplicate.protocol.events.filter(
            (event) => event.kind === "effect",
          ).length;
          assertContainerTelegramReplay(duplicate.protocol.events, 1);
          check(duplicate.provider.calls === 0, "Duplicate container delivery called the model");
          await deliver(containerId, observe, "replacement", 3, 101, 1, true);
        });
        const secondReplay = await readReplay();
        check(
          JSON.stringify(secondReplay.claims.map((claim) => claim.updateId)) === "[1,2,3]",
          "Container replacement lost durable replay claims",
        );
        check(
          firstReplay.claims[0]?.namespaceSHA256 === secondReplay.claims[0]?.namespaceSHA256,
          "Container replacement changed replay namespace",
        );
        await scope.stop(utility.containerId);
        phase = "complete";
      } catch (error) {
        failure =
          error instanceof PollingContainerFailure
            ? error.message
            : "Polling container observation failed";
        throw error;
      }
    },
  );
  const events = generations.flatMap((generation) => generation.snapshot?.protocol.events ?? []);
  const effectCount = events.filter((event) => event.kind === "effect").length;
  const passed =
    docker.status === "passed" &&
    phase === "complete" &&
    effectCount === 2 &&
    duplicateEffectCount === 0 &&
    unauthorizedEffectCount === 0;
  const diagnostic = Buffer.from(
    `${JSON.stringify({ phase, failure, fixtureCopies: fixtures.copies, generations, deliveries, replay, commands, docker }, (_key, value) => (typeof value === "string" ? redactIntegrationDiagnostic(value, privateValues) : value), 2)}\n`,
  );
  check(
    diagnostic.length <= INTEGRATION_LIMITS.evidenceBytes,
    "Polling container diagnostics exceeded bound",
  );
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.evidenceDirectory, "telegram-container-journal.json"), diagnostic, {
    mode: 0o600,
    flag: "wx",
  });
  const evidence: IntegrationScenarioEvidence = {
    version: 1,
    scenarioId: TELEGRAM_CONTAINER_SCENARIO,
    runId: options.runId,
    stage: "container",
    buildKind: "standalone-fixture",
    source: {
      ...options.source,
      installedFiles: generated.installedFiles,
      lockfiles: [materialized.lockfile],
    },
    profile: { kind: "none" },
    baselineFiles: generated.baselineFiles,
    changes,
    execution: {
      commandLabels: [
        ...commands.map((command) => command.label),
        "docker-polling-image-execution",
      ],
      deadlinesMs: {
        build: INTEGRATION_LIMITS.phaseBuildMs,
        scenario: INTEGRATION_LIMITS.scenarioMs,
        shutdown: INTEGRATION_LIMITS.shutdownMs,
      },
      firstChunkBeforeTerminal: null,
      effectCount,
      duplicateEffectCount,
      unauthorizedEffectCount,
      startup: generations.some((generation) => generation.snapshot !== null) ? "ready" : "failed",
      channel: passed ? "verified" : "failed",
      observations: [
        "Actual Docker polling image uses normal Telegram resolver HTTP client Anthropic provider and replay SQLite",
        "Private loopback fixture control listener is test infrastructure and is not production ingress",
        "Live Telegram connectivity and operator reconciliation are not claimed by this row",
      ],
    },
    platform: {
      exportSHA256,
      imageDigest,
      deploymentId: null,
      resources: "resources" in docker ? docker.resources : [],
    },
    outcome: passed
      ? {
          status: "passed",
          checks: [
            "actual-cli-created-packed-polling-image",
            "serialized-telegram-model-tool-and-reply",
            "creator-only-domain-effect",
            "duplicate-redelivery-acknowledged-after-container-replacement",
            "same-volume-tgrp-identity-and-namespace",
            "no-published-port-or-http-profile",
            "quiescent-runtime-and-fixture-shutdown",
          ],
        }
      : {
          status: docker.status === "unavailable" ? "unavailable" : "failed",
          reason: failure ?? `Polling image did not complete phase ${phase}`,
        },
    cleanup: docker.cleanup,
    artifacts: [{ path: "telegram-container-journal.json", sha256: applicationHash(diagnostic) }],
    retainedUntil: null,
    independentReviewer: null,
  };
  const written = writeIntegrationEvidence(
    options.evidenceDirectory,
    "telegram-polling-container.json",
    JSON.stringify(evidence),
    privateValues,
  );
  return { evidence: written.evidence, consumer, context };
}
