/** Installed-worker acceptance. Unit tests of this driver do not certify the installed path. */
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import {
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
} from "./application-consumer";
import type { CreateAuthoringConsumerOptions } from "./authoring-contract";
import {
  createIntegrationConsumer,
  materializeIntegrationDependencies,
  readIntegrationFile,
  withIntegrationChild,
  type IntegrationBudget,
} from "./integration-consumer";
import {
  INTEGRATION_LIMITS,
  INTEGRATION_OVERLAYS,
  type IntegrationScenarioEvidence,
  type IntegrationSourceIdentity,
} from "./integration-contracts";
import { writeIntegrationEvidence } from "./integration-evidence";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  type ProviderFixtureEvidence,
} from "./provider-fixture";
import {
  createTelegramProtocolFixture,
  telegramFixtureUpdate,
  type FixtureUpdate,
  type TelegramJournalEvent,
} from "./integration-fixtures/telegram/protocol-fixture";
import {
  TELEGRAM_FIXTURE_INSTALL_MARKER,
  TELEGRAM_FIXTURE_TOKEN,
} from "./integration-fixtures/telegram/telegram-network";

const MAIN = "export const main: ApplicationMain = async (launch) => {";
const INSTALL = `  installTelegramFixtureNetwork("${TELEGRAM_FIXTURE_INSTALL_MARKER}");`;
const IMPORT = 'import { installTelegramFixtureNetwork } from "./fixtures/telegram-network";';
const PROOF_PATH = "src/augments/telegram-proof/index.ts";
const REPLAY_PATH = "data/telegram-replay.db";
const BASELINE_MARKER = "telegram-proof:baseline";
const EDITED_MARKER = "telegram-proof:edited";
type Change = IntegrationScenarioEvidence["changes"][number];
type FixtureIdentity = "creator" | "recognized" | "anonymous" | "creator-group" | "agent";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** Independent expected identity, including public state; a public trust label alone is insufficient. */
export function assertTelegramDeliveryIdentity(
  events: readonly TelegramJournalEvent[],
  update: FixtureUpdate,
  identity: FixtureIdentity,
): void {
  const threadId = `tg-bot-123456789-chat-${update.message.chat.id}`;
  const expected =
    identity === "creator"
      ? { trust: "creator", peerKind: "human", peerId: "creator", publicSubstate: null }
      : identity === "agent"
        ? { trust: "agent", peerKind: "agent", peerId: "fixture-agent", publicSubstate: null }
        : identity === "recognized"
          ? {
              trust: "public",
              peerKind: "human",
              peerId: `tg_user_${update.message.from.id}`,
              publicSubstate: "recognized",
            }
          : {
              trust: "public",
              peerKind: "human",
              peerId: `tg_anon_${threadId}`,
              publicSubstate: "anonymous",
            };
  const observations = events.filter(
    (event): event is Extract<TelegramJournalEvent, { kind: "attempt" | "effect" }> =>
      event.kind === "attempt" || event.kind === "effect",
  );
  check(
    observations.filter((event) => event.kind === "attempt").length === 1,
    "Telegram delivery must have exactly one observed attempt",
  );
  for (const event of observations) {
    check(
      event.threadId === threadId &&
        event.trust === expected.trust &&
        event.peerId === expected.peerId &&
        event.peerKind === expected.peerKind &&
        event.publicSubstate === expected.publicSubstate,
      "Telegram mapped the wrong delivery identity",
    );
  }
}

function writeSource(consumer: string, path: string, source: string): void {
  mkdirSync(dirname(join(consumer, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(consumer, path), source, { mode: 0o600 });
}

export interface TelegramOverlayIdentity {
  networkSHA256: string;
  startupSHA256: string;
}

/** Parent must call before EVERY worker launch; a missing overlay never contacts Telegram. */
export function assertTelegramFixtureOverlay(
  consumer: string,
  expected: TelegramOverlayIdentity,
): void {
  const network = readIntegrationFile(consumer, INTEGRATION_OVERLAYS.telegramNetwork, 32_768);
  const startup = readIntegrationFile(consumer, INTEGRATION_OVERLAYS.telegramStartup, 32_768);
  check(
    applicationHash(network) === expected.networkSHA256,
    "Telegram network overlay hash mismatch",
  );
  check(
    applicationHash(startup) === expected.startupSHA256,
    "Telegram startup overlay hash mismatch",
  );
  const source = startup.toString("utf8");
  check(source.startsWith(`${IMPORT}\n`), "Telegram fixture import is missing");
  check(source.includes(`${MAIN}\n${INSTALL}\n`), "Telegram fixture must install first in main");
  check(source.split(INSTALL).length === 2, "Telegram fixture installation must be unique");
}

/** Copies one reviewed fixture module; leaves the CLI-generated launch/host implementation intact. */
export function prepareTelegramFixtureOverlay(consumer: string): {
  identity: TelegramOverlayIdentity;
  changes: Change[];
} {
  const original = readIntegrationFile(consumer, INTEGRATION_OVERLAYS.telegramStartup, 32_768);
  const source = original.toString("utf8");
  check(
    source.split(MAIN).length === 2 && !source.includes("installTelegramFixtureNetwork"),
    "Unexpected generated main source",
  );
  const network = readFileSync(
    new URL("./integration-fixtures/telegram/telegram-network.ts", import.meta.url),
  );
  const startup = `${IMPORT}\n${source.replace(MAIN, `${MAIN}\n${INSTALL}`)}`;
  check(
    !existsSync(join(consumer, INTEGRATION_OVERLAYS.telegramNetwork)),
    "Telegram overlay already exists",
  );
  writeSource(consumer, INTEGRATION_OVERLAYS.telegramNetwork, network.toString("utf8"));
  writeSource(consumer, INTEGRATION_OVERLAYS.telegramStartup, startup);
  const identity = {
    networkSHA256: applicationHash(network),
    startupSHA256: applicationHash(startup),
  };
  assertTelegramFixtureOverlay(consumer, identity);
  return {
    identity,
    changes: [
      {
        path: INTEGRATION_OVERLAYS.telegramNetwork,
        kind: "fixture-overlay",
        beforeSHA256: null,
        afterSHA256: identity.networkSHA256,
      },
      {
        path: INTEGRATION_OVERLAYS.telegramStartup,
        kind: "fixture-overlay",
        beforeSHA256: applicationHash(original),
        afterSHA256: identity.startupSHA256,
      },
    ],
  };
}

export function assertTelegramSourceMarker(
  events: readonly TelegramJournalEvent[],
  expected: string,
): void {
  const attempt = events.filter((event) => event.kind === "attempt").at(-1);
  check(
    attempt?.kind === "attempt" && attempt.marker === expected,
    "Owned Telegram source edit was not executed",
  );
}

/** Read-only inspection of the actual worker database; never supplies or repairs replay state. */
export function inspectTelegramReplay(consumer: string) {
  readIntegrationFile(consumer, REPLAY_PATH, 16 * 1024 * 1024);
  const db = new Database(join(consumer, REPLAY_PATH), { readonly: true, create: false });
  try {
    const applicationId = (db.query("PRAGMA application_id").get() as { application_id: number })
      .application_id;
    const schemaVersion = (db.query("PRAGMA user_version").get() as { user_version: number })
      .user_version;
    check(
      applicationId === 0x54475250 && schemaVersion === 2,
      "Unexpected Telegram replay database identity",
    );
    const claims = db
      .query("SELECT namespace, update_id FROM telegram_update_claims ORDER BY update_id LIMIT 100")
      .all() as { namespace: string; update_id: number }[];
    const conflicts = db
      .query(
        "SELECT update_id, canonical_hash, conflicting_hash FROM telegram_replay_conflicts LIMIT 10",
      )
      .all() as { update_id: number; canonical_hash: string; conflicting_hash: string }[];
    return {
      applicationId,
      schemaVersion,
      claims: claims.map((claim) => ({
        updateId: claim.update_id,
        namespaceSHA256: applicationHash(claim.namespace),
      })),
      conflicts: conflicts.map((conflict) => ({
        updateId: conflict.update_id,
        unequalPayloads: conflict.canonical_hash !== conflict.conflicting_hash,
      })),
    };
  } finally {
    db.close();
  }
}

async function waitFor(budget: IntegrationBudget, predicate: () => boolean): Promise<void> {
  await budget.run(
    Math.min(INTEGRATION_LIMITS.readinessMs, budget.remainingMs()),
    async (signal) => {
      while (!predicate()) {
        signal.throwIfAborted();
        await new Promise<void>((resolve, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Telegram observation aborted"));
          };
          const timer = setTimeout(() => {
            signal.removeEventListener("abort", abort);
            resolve();
          }, 25);
          signal.addEventListener("abort", abort, { once: true });
          if (signal.aborted) abort();
        });
      }
    },
  );
}

export interface TelegramIntegrationOptions {
  create: CreateAuthoringConsumerOptions;
  source: IntegrationSourceIdentity;
  runId: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  signal?: AbortSignal;
  /** Root-owned exact tarball materialization before passive export, never a runtime replacement. */
  prepareExport?: (consumer: string) => Promise<{ changes: readonly Change[] }>;
}

/** Actual installed acceptance, separate from fixture/helper unit tests and live Telegram connectivity. */
export async function runTelegramIntegration(options: TelegramIntegrationOptions) {
  check(
    options.create.provider === "anthropic",
    "Telegram acceptance requires the packed Anthropic adapter",
  );
  options.signal?.throwIfAborted();
  const generated = await createIntegrationConsumer(options.create);
  const consumer = generated.generated.consumer;
  const cli = assertInstalledApplicationArtifact(
    consumer,
    options.create.repoRoot,
    generated.generated.core,
    "auggy/cli",
  );
  const changes: Change[] = [];
  const checks: string[] = [];
  const diagnostics: {
    label: string;
    status: string;
    cleanupConfirmed: boolean;
    stdoutSHA256: string;
    stderrSHA256: string;
    stderr: string;
  }[] = [];
  const modelObservations: ProviderFixtureEvidence[] = [];
  const replayObservations: ReturnType<typeof inspectTelegramReplay>[] = [];
  const environment = applicationEnvironment(options.home, options.temporaryDirectory);
  const network = createTelegramProtocolFixture();
  const provider = await (async () => {
    try {
      return createProviderFixture({
        toolResultSentinel: "telegram-proof:",
        tool: {
          name: "telegram_proof_effect",
          input: { operation: "probe" },
          invalidInput: { operation: 7 },
        },
        maxCalls: 4,
        maxRequestBytes: INTEGRATION_LIMITS.fixtureRequestBytes,
      });
    } catch {
      await network.stop();
      throw new Error("Telegram model fixture failed to start");
    }
  })();
  let succeeded = false;
  let cleanupComplete = true;
  let startup = false;
  let exportSHA256: string | null = null;
  let exportDirectory: string | null = null;
  let phase = "prepare";
  const privateValues = [
    TELEGRAM_FIXTURE_TOKEN,
    PROVIDER_FIXTURE_API_KEY,
    consumer,
    options.home,
    options.temporaryDirectory,
    options.create.repoRoot,
    options.evidenceDirectory,
  ];
  const env = {
    ...environment,
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    TELEGRAM_BOT_TOKEN: TELEGRAM_FIXTURE_TOKEN,
    AUGGY_FIXTURE_TELEGRAM_ORIGIN: network.origin,
    AUGGY_FIXTURE_MODEL_ORIGIN: provider.baseURL,
  };
  const command = (args: string[]) => [
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--config=/dev/null",
    cli.entry,
    ...args,
  ];
  const events = () => network.snapshot().events;
  const effects = () => events().filter((event) => event.kind === "effect");
  const replies = () => events().filter((event) => event.kind === "reply");
  let overlay: ReturnType<typeof prepareTelegramFixtureOverlay>;
  try {
    const configBefore = readIntegrationFile(consumer, "agent.yaml", 256 * 1024);
    const config = parse(configBefore.toString("utf8"));
    config.engine = {
      ...config.engine,
      baseURL: "${AUGGY_FIXTURE_MODEL_ORIGIN}",
      requestTimeoutMs: 10_000,
    };
    config.settings = { ...config.settings, maxInferenceLoops: 3 };
    config.augments = [
      {
        name: "telegram",
        type: "telegramTransport",
        options: {
          botToken: "${TELEGRAM_BOT_TOKEN}",
          inbound: { mode: "polling", polling: { timeoutSec: 1 } },
          auth: {
            creatorUserIds: [101],
            recognizedUserIds: [202],
            admittedAgents: [{ id: "fixture-agent", telegramUserId: 303 }],
          },
          replay: { dbPath: `./${REPLAY_PATH}` },
        },
      },
      { name: "telegram-proof", type: "custom", source: `./${PROOF_PATH}` },
    ];
    const configAfter = stringify(config);
    writeSource(consumer, "agent.yaml", configAfter);
    changes.push({
      path: "agent.yaml",
      kind: "source-edit",
      beforeSHA256: applicationHash(configBefore),
      afterSHA256: applicationHash(configAfter),
    });
    const proof = readFileSync(
      new URL("./integration-fixtures/telegram/proof-augment.ts.template", import.meta.url),
      "utf8",
    );
    writeSource(consumer, PROOF_PATH, proof);
    changes.push({
      path: PROOF_PATH,
      kind: "source-edit",
      beforeSHA256: null,
      afterSHA256: applicationHash(proof),
    });
    let missingRejected = false;
    try {
      assertTelegramFixtureOverlay(consumer, {
        networkSHA256: "0".repeat(64),
        startupSHA256: "0".repeat(64),
      });
    } catch {
      missingRejected = true;
    }
    check(missingRejected && events().length === 0, "Missing fixture overlay did not fail closed");
    checks.push("missing-overlay-rejected-before-launch");
    overlay = prepareTelegramFixtureOverlay(consumer);
    changes.push(...overlay.changes);
    const startupSource = readIntegrationFile(consumer, "src/index.ts", 32_768).toString("utf8");
    writeSource(
      consumer,
      "src/index.ts",
      startupSource.replace(TELEGRAM_FIXTURE_INSTALL_MARKER, "wrong-fixture-marker"),
    );
    let markerRejected = false;
    try {
      assertTelegramFixtureOverlay(consumer, overlay.identity);
    } catch {
      markerRejected = true;
    }
    writeSource(consumer, "src/index.ts", startupSource);
    check(markerRejected && events().length === 0, "Wrong fixture marker did not fail closed");
    checks.push("wrong-overlay-marker-rejected-before-launch");

    phase = "telegram-source-typecheck";
    const typechecked = await withIntegrationChild(
      {
        label: phase,
        command: [
          process.execPath,
          "--no-env-file",
          "--no-install",
          "--config=/dev/null",
          "run",
          "typecheck",
        ],
        cwd: consumer,
        env,
        secrets: privateValues,
        signal: options.signal,
      },
      async ({ child }) => {
        const result = await child.finish();
        check(result.exitCode === 0, "Edited generated consumer failed typechecking");
      },
    );
    cleanupComplete &&= typechecked.process.cleanupConfirmed;
    diagnostics.push({
      label: phase,
      status: typechecked.status,
      cleanupConfirmed: typechecked.process.cleanupConfirmed,
      stdoutSHA256: typechecked.process.stdoutSHA256,
      stderrSHA256: typechecked.process.stderrSHA256,
      stderr: typechecked.process.stderr.slice(-8192),
    });
    check(typechecked.status === "passed", "Edited generated consumer failed typechecking");
    checks.push("edited-generated-consumer-typechecked");

    const worker = async (label: string, observe: (budget: IntegrationBudget) => Promise<void>) => {
      phase = label;
      assertTelegramFixtureOverlay(consumer, overlay.identity);
      const result = await withIntegrationChild(
        {
          label,
          command: command(["run", "--config", "agent.yaml", "--no-open"]),
          cwd: consumer,
          env,
          secrets: privateValues,
          signal: options.signal,
        },
        async ({ budget }) => {
          await observe(budget);
        },
      );
      cleanupComplete &&= result.process.cleanupConfirmed;
      diagnostics.push({
        label,
        status: result.status,
        cleanupConfirmed: result.process.cleanupConfirmed,
        stdoutSHA256: result.process.stdoutSHA256,
        stderrSHA256: result.process.stderrSHA256,
        stderr: result.process.stderr.slice(-8192),
      });
      check(result.status === "passed", "Installed Telegram worker phase failed");
    };
    const deliver = async (
      budget: IntegrationBudget,
      update: FixtureUpdate,
      identity: FixtureIdentity,
      expectedEffects: number,
      marker: string,
    ) => {
      provider.reset();
      const before = events().length;
      const replyCount = replies().length;
      network.enqueue(update);
      await waitFor(budget, () => replies().length === replyCount + 1);
      const observed = events().slice(before);
      assertTelegramDeliveryIdentity(observed, update, identity);
      check(
        observed.filter((event) => event.kind === "effect").length === expectedEffects,
        "Unexpected Telegram domain effects",
      );
      check(
        observed.some((event) => event.kind === "reply" && event.chatId === update.message.chat.id),
        "Telegram reply destination mismatch",
      );
      assertTelegramSourceMarker(observed, marker);
      const model = provider.evidence();
      check(
        model.calls === 2 &&
          model.toolRequests === 1 &&
          model.validatedToolResults === 1 &&
          model.rejectedRequests === 0,
        "Real provider tool exchange was not verified",
      );
      modelObservations.push(model);
    };
    await worker("telegram-initial", async (budget) => {
      await waitFor(budget, () => events().some((event) => event.kind === "poll"));
      startup = true;
      await deliver(budget, telegramFixtureUpdate(1, 101), "creator", 1, BASELINE_MARKER);
      let wrongSourceRejected = false;
      try {
        assertTelegramSourceMarker(events(), EDITED_MARKER);
      } catch {
        wrongSourceRejected = true;
      }
      check(wrongSourceRejected, "Unedited source incorrectly satisfied edited marker");
      await deliver(budget, telegramFixtureUpdate(2, 202), "recognized", 0, BASELINE_MARKER);
      await deliver(budget, telegramFixtureUpdate(3, 404), "anonymous", 0, BASELINE_MARKER);
      await deliver(
        budget,
        telegramFixtureUpdate(4, 101, -1001, "group"),
        "creator-group",
        0,
        BASELINE_MARKER,
      );
      await deliver(budget, telegramFixtureUpdate(5, 303), "agent", 0, BASELINE_MARKER);
      check(
        events().some(
          (event) => event.kind === "poll" && event.offset !== null && event.offset >= 2,
        ),
        "Polling offsets did not advance",
      );
    });
    checks.push(
      "serialized-poll-model-tool-effect-reply",
      "creator-private-only",
      "recognized-anonymous-group-and-admitted-agent-mapping",
      "wrong-source-marker-rejected",
    );
    const firstReplay = inspectTelegramReplay(consumer);
    check(
      firstReplay.claims.length === 5 && firstReplay.conflicts.length === 0,
      "Initial durable replay claims missing",
    );
    replayObservations.push(firstReplay);

    const edited = proof.replace(BASELINE_MARKER, EDITED_MARKER);
    check(edited !== proof, "Domain edit did not change source");
    writeSource(consumer, PROOF_PATH, edited);
    changes.push({
      path: PROOF_PATH,
      kind: "source-edit",
      beforeSHA256: applicationHash(proof),
      afterSHA256: applicationHash(edited),
    });
    await worker("telegram-replacement", async (budget) => {
      const beforeEffects = effects().length;
      const beforeReplies = replies().length;
      const beforeEvents = events().length;
      network.enqueue(telegramFixtureUpdate(1, 101));
      await waitFor(budget, () => {
        const replacementEvents = events().slice(beforeEvents);
        const delivered = replacementEvents.findIndex(
          (event) => event.kind === "poll" && event.updateIds.includes(1),
        );
        return (
          delivered >= 0 &&
          replacementEvents
            .slice(delivered + 1)
            .some((event) => event.kind === "poll" && event.offset === 2)
        );
      });
      check(
        effects().length === beforeEffects &&
          replies().length === beforeReplies &&
          !events()
            .slice(beforeEvents)
            .some((event) => event.kind === "attempt"),
        "Restart duplicated an admitted effect or reply",
      );
      await deliver(budget, telegramFixtureUpdate(6, 101), "creator", 1, EDITED_MARKER);
    });
    replayObservations.push(inspectTelegramReplay(consumer));
    checks.push(
      "sqlite-identity-and-durable-replay-after-replacement",
      "owned-domain-edit-executed-after-restart",
    );

    await worker("telegram-conflict", async (budget) => {
      const conflicting = telegramFixtureUpdate(1, 101);
      conflicting.message.text = "Conflicting payload for the same delivery.";
      network.enqueue(conflicting);
      await waitFor(budget, () => inspectTelegramReplay(consumer).conflicts.length === 1);
      const snapshot = inspectTelegramReplay(consumer);
      check(
        snapshot.conflicts[0]?.unequalPayloads,
        "Replay conflict did not retain unequal payload identity",
      );
      replayObservations.push(snapshot);
      check(effects().length === 2, "Conflicting delivery repeated an effect");
    });
    await worker("telegram-quarantine-replacement", async (budget) => {
      const before = network.snapshot().events.length;
      network.enqueue(telegramFixtureUpdate(7, 101));
      await waitFor(budget, () =>
        events()
          .slice(before)
          .some((event) => event.kind === "validate-agent"),
      );
      await budget.run(1500, () => new Promise<void>((resolve) => setTimeout(resolve, 1200)));
      check(
        events()
          .slice(before)
          .every(
            (event) => event.kind !== "poll" && event.kind !== "effect" && event.kind !== "reply",
          ),
        "Persistent quarantine admitted later work",
      );
      check(
        inspectTelegramReplay(consumer).conflicts.length === 1,
        "Quarantine did not survive restart",
      );
    });
    checks.push("conflicting-payload-quarantined", "persistent-quarantine-blocks-new-deliveries");

    phase = "telegram-export";
    const materialized = options.prepareExport
      ? await options.prepareExport(consumer)
      : await materializeIntegrationDependencies({ create: options.create, consumer });
    changes.push(...materialized.changes);
    exportDirectory = join(options.create.workspace, `${options.create.name}-worker-export`);
    const exported = await withIntegrationChild(
      {
        label: "telegram-export",
        command: command([
          "export",
          "docker",
          "--config",
          "agent.yaml",
          "--out",
          exportDirectory,
          "--ingress",
          "none",
        ]),
        cwd: consumer,
        env,
        secrets: privateValues,
        signal: options.signal,
      },
      async ({ child }) => {
        const result = await child.finish();
        check(result.exitCode === 0, "Installed worker export failed");
      },
    );
    cleanupComplete &&= exported.process.cleanupConfirmed;
    diagnostics.push({
      label: "telegram-export",
      status: exported.status,
      cleanupConfirmed: exported.process.cleanupConfirmed,
      stdoutSHA256: exported.process.stdoutSHA256,
      stderrSHA256: exported.process.stderrSHA256,
      stderr: exported.process.stderr.slice(-8192),
    });
    check(exported.status === "passed", "Installed worker export failed");
    const manifestBytes = readIntegrationFile(
      exportDirectory,
      "auggy-deployment.json",
      INTEGRATION_LIMITS.evidenceBytes,
    );
    const manifest = JSON.parse(manifestBytes.toString("utf8"));
    check(
      manifest.profile.kind === "none" && Object.keys(manifest.profile).length === 1,
      "Worker export invented HTTP ingress",
    );
    const dockerfile = readIntegrationFile(exportDirectory, "Dockerfile", 64 * 1024).toString(
      "utf8",
    );
    check(
      !/^\s*(EXPOSE|HEALTHCHECK)\b/m.test(dockerfile),
      "Worker export invented a port or health probe",
    );
    exportSHA256 = applicationHash(manifestBytes);
    checks.push("installed-worker-export-no-ingress", "quiescent-process-group-shutdown");
    check(
      network.snapshot().rejectedRequests === 0,
      "Protocol fixture rejected serialized runtime traffic",
    );
    succeeded = true;
  } catch {
    // Preserve static failing phase and bounded sanitized diagnostics, never raw thrown secrets.
  } finally {
    try {
      await provider.stop();
    } catch {
      cleanupComplete = false;
    }
    try {
      await network.stop();
    } catch {
      cleanupComplete = false;
    }
  }
  const finalEvents = network.snapshot().events;
  const effectCount = finalEvents.filter((event) => event.kind === "effect").length;
  const unauthorizedEffectCount = finalEvents.filter(
    (event) => event.kind === "effect" && event.trust !== "creator",
  ).length;
  const journal = `${JSON.stringify({ events: finalEvents, provider: modelObservations, replay: replayObservations, diagnostics }, null, 2)}\n`;
  check(
    Buffer.byteLength(journal) <= INTEGRATION_LIMITS.fixtureJournalBytes,
    "Telegram evidence journal exceeded bound",
  );
  mkdirSync(options.evidenceDirectory, { recursive: true, mode: 0o700 });
  writeFileSync(join(options.evidenceDirectory, "telegram-journal.json"), journal, {
    mode: 0o600,
    flag: "wx",
  });
  const evidence: IntegrationScenarioEvidence = {
    version: 1,
    scenarioId: "telegram-installed-worker",
    runId: options.runId,
    stage: "local",
    buildKind: "standalone-fixture",
    source: {
      ...options.source,
      lockfiles: [
        {
          path: "bun.lock",
          sha256: applicationHash(readIntegrationFile(consumer, "bun.lock", 4 * 1024 * 1024)),
        },
      ],
      installedFiles: generated.installedFiles,
    },
    profile: { kind: "none" },
    baselineFiles: generated.baselineFiles,
    changes,
    execution: {
      commandLabels: diagnostics.map((entry) => entry.label),
      deadlinesMs: {
        scenario: INTEGRATION_LIMITS.scenarioMs,
        shutdown: INTEGRATION_LIMITS.shutdownMs,
      },
      firstChunkBeforeTerminal: null,
      effectCount,
      duplicateEffectCount: Math.max(0, effectCount - 2),
      unauthorizedEffectCount,
      startup: startup ? "ready" : "failed",
      channel: succeeded ? "verified" : "failed",
      observations: [
        "Real installed Telegram HTTP fixture execution; live Telegram network unverified",
        "Replay quarantine and operator reconciliation have separate acceptance scopes",
        "Worker operator reconciliation and container execution remain separate acceptance rows",
      ],
    },
    platform: { exportSHA256, imageDigest: null, deploymentId: null, resources: [] },
    outcome:
      succeeded && cleanupComplete
        ? { status: "passed", checks }
        : { status: "failed", reason: `Telegram installed acceptance failed during ${phase}` },
    cleanup: { status: cleanupComplete ? "complete" : "failed", remainingOwnedIds: [] },
    artifacts: [{ path: "telegram-journal.json", sha256: applicationHash(journal) }],
    retainedUntil: null,
    independentReviewer: null,
  };
  const written = writeIntegrationEvidence(
    realpathSync(options.evidenceDirectory),
    "telegram-installed-worker.json",
    JSON.stringify(evidence),
    privateValues,
  );
  return { evidence: written.evidence, consumer, exportDirectory, diagnostics };
}
