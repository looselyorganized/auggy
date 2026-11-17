/** Existing channel assertions over one bounded, exact-instance SSH command path. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";
import { prepareHostedSshArguments, hostedSshPublicIdentity } from "./integration-hosted-transport";
import { observeHostedHttpGeneration } from "./integration-hosted-http";
import {
  parseTelegramContainerSnapshot,
  assertSealedTelegramContainerSnapshot,
  assertContainerTelegramReplay,
} from "./integration-telegram-container";
import { assertTelegramDeliveryIdentity, assertTelegramSourceMarker } from "./integration-telegram";
import { telegramFixtureUpdate } from "./integration-fixtures/telegram/protocol-fixture";
import { parseHostedCommandRegistry } from "./integration-fixtures/hosted/remote-command";
import type { HostedHttpCheckpoint } from "./integration-fixtures/http-container/startup";
import { hostedCheck as check, hostedHash as hash, type HostedContext } from "./hosted-context";
import { HOSTED_HTTP_ASSERTION_TTL_SECONDS } from "./hosted-http-recovery";
import type { ScenarioDeployment } from "./hosted-railway";

const digest = z.string().regex(/^[a-f0-9]{64}$/);
const receiptSchema = z
  .object({
    version: z.literal(1),
    requestId: z.string(),
    commandId: z.string(),
    inputSHA256: digest,
    registrySHA256: digest,
    bundleSHA256: digest,
    sourceSHA256: digest,
    status: z.enum(["passed", "failed"]),
    interrupted: z.string().nullable(),
    acknowledged: z.boolean(),
    result: z.unknown(),
    child: z
      .object({
        exitCode: z.number().nullable(),
        signal: z.string().nullable(),
        spawnFailed: z.boolean(),
        timedOut: z.boolean(),
        exceededOutput: z.boolean(),
        orphanedGroup: z.boolean(),
        cleanupConfirmed: z.boolean(),
        inputComplete: z.boolean(),
        inputFailed: z.boolean(),
        stdoutSHA256: digest,
        stderrSHA256: digest,
      })
      .strict()
      .nullable(),
  })
  .strict();
export function createScenarioControl(
  ctx: HostedContext,
  d: ScenarioDeployment,
  consumer: string,
  maintenance = false,
) {
  const rel = maintenance ? "src/fixtures/g4-maintenance" : "src/g4-remote";
  const entry = maintenance
    ? "/app/src/fixtures/g4-maintenance/remote-command.js"
    : "/app/src/g4-remote/remote-command.js";
  const bundleHash = hash(readFileSync(join(consumer, rel, "remote-command.js")));
  const registryBytes = readFileSync(join(consumer, rel, "commands.json")),
    registry = parseHostedCommandRegistry(registryBytes),
    registryHash = hash(registryBytes);
  const authDirectory = join(ctx.root, "auth"),
    knownHosts = readFileSync(join(authDirectory, "known_hosts"));
  const match = /^ssh\.railway\.com (ssh-ed25519 [A-Za-z0-9+/=]+)\n$/.exec(knownHosts.toString());
  check(match, "Unexpected SSH relay pin");
  const ssh = {
    scope: "workspace" as const,
    keyName: ctx.runId,
    ...hostedSshPublicIdentity(readFileSync(join(authDirectory, "identity.pub"), "utf8")),
    relay: {
      hostname: "ssh.railway.com" as const,
      port: 22 as const,
      trust: "explicit-first-use-pin" as const,
      providerAuthenticated: false as const,
      ...hostedSshPublicIdentity(match[1]!),
      knownHostsSHA256: hash(knownHosts),
    },
  };
  let count = 0,
    failed = false;
  return async (
    commandId: string,
    payload: Record<string, unknown>,
    options: { snapshotDeadline?: number } = {},
  ) => {
    check(!failed && count < 32, "Remote phase consumed or exceeded its command limit");
    const deadline = options.snapshotDeadline;
    if (deadline !== undefined)
      check(
        commandId === "http-control" &&
          payload.operation === "snapshot" &&
          Object.keys(payload).length === 1 &&
          Number.isFinite(deadline) &&
          deadline > performance.now() + 5000,
        "Bounded readiness requires a read-only snapshot and remaining time",
      );
    const def = registry.commands.find((c) => c.commandId === commandId);
    check(def, "Unknown fixture command");
    const requestId = `scenario-${++count}-${randomUUID()}`;
    const input = Buffer.from(
      JSON.stringify({ version: 1, operation: "execute", requestId, commandId, payload }),
    );
    const prepared = prepareHostedSshArguments({
      ssh,
      authDirectory,
      instanceId: d.instanceId,
      remoteEntry: entry,
      remoteEntrySHA256: bundleHash,
    });
    try {
      const result = await ctx.command(`remote-${commandId}`, prepared.command, {
        input,
        timeoutMs:
          deadline === undefined ? 60000 : Math.min(15000, deadline - performance.now() - 5000),
        allowFailure: true,
      });
      // A fully reaped SSH disconnect during restart is pending only for this read.
      // Commands, malformed receipts and remote operation failures remain fatal.
      if (deadline !== undefined && result.exitCode === 255 && result.stdout.trim() === "")
        return null;
      const receipt = receiptSchema.parse(JSON.parse(result.stdout));
      // Validate decoded content before allowing it to influence assertions or returned evidence.
      const decoded = JSON.stringify(receipt);
      check(
        ctx.secrets.every((s) => s.length < 8 || !decoded.includes(s)),
        "Fixture receipt contains private values",
      );
      check(
        receipt.requestId === requestId &&
          receipt.commandId === commandId &&
          receipt.inputSHA256 === hash(input) &&
          receipt.bundleSHA256 === bundleHash &&
          receipt.registrySHA256 === registryHash &&
          receipt.sourceSHA256 === def.sourceSHA256,
        "Remote receipt/input/source identity mismatch",
      );
      const c = receipt.child;
      check(
        result.exitCode === 0 &&
          receipt.status === "passed" &&
          receipt.acknowledged &&
          receipt.interrupted === null &&
          c &&
          c.exitCode === 0 &&
          c.signal === null &&
          !c.spawnFailed &&
          !c.timedOut &&
          !c.exceededOutput &&
          !c.orphanedGroup &&
          c.cleanupConfirmed &&
          c.inputComplete &&
          !c.inputFailed,
        "Remote fixture rejected the operation; inspect retained command receipt",
      );
      return receipt.result;
    } catch (error) {
      failed = true;
      throw error;
    }
  };
}
export type ScenarioControl = ReturnType<typeof createScenarioControl>;
export async function observeScenarioHttp(
  ctx: HostedContext,
  control: ScenarioControl,
  origin: string,
  previous?: {
    checkpoint: HostedHttpCheckpoint;
    operationId: string;
    threadId: string;
  },
  edited = false,
  generationId?: string,
) {
  const operationId = randomUUID(),
    threadId = randomUUID();
  const v = ctx.variables;
  check(
    v.AUGGY_AUTH_SECRET && v.AUGGY_AUTH_KEY_ID && v.AUGGY_AUTH_AUDIENCE,
    "Missing HTTP fixture signing configuration",
  );
  const result = await observeHostedHttpGeneration({
    agentOrigin: origin,
    signer: (opts) =>
      createExternalAuthAssertion({ ...opts, ttlSeconds: HOSTED_HTTP_ASSERTION_TTL_SECONDS }),
    secret: v.AUGGY_AUTH_SECRET,
    keyId: v.AUGGY_AUTH_KEY_ID,
    audience: v.AUGGY_AUTH_AUDIENCE,
    checkpoint: previous?.checkpoint ?? null,
    operationId,
    threadId,
    ...(previous
      ? { previousOperation: { operationId: previous.operationId, threadId: previous.threadId } }
      : {}),
    expectedSourceMarker: edited ? "g4-http-owned-source" : null,
    control: async (payload, signal) => {
      signal.throwIfAborted();
      const result = z
        .object({ generationId: z.string(), snapshot: z.string() })
        .parse(await control("http-control", payload));
      check(
        !generationId || result.generationId === generationId,
        "HTTP control returned another generation",
      );
      return result.snapshot;
    },
  });
  return { ...result, operationId, threadId };
}
export async function observeScenarioPolling(
  control: ScenarioControl,
  generation: "baseline" | "edited" | "restored",
  generationId: string,
) {
  let previous: ReturnType<typeof parseTelegramContainerSnapshot> | undefined;
  const read = async (name: string) => {
    const snapshot = parseTelegramContainerSnapshot(JSON.stringify(await control(name, {})));
    check(snapshot.generationId === generationId, "Fixture generation changed");
    check(
      !previous ||
        JSON.stringify(snapshot.protocol.events.slice(0, previous.protocol.events.length)) ===
          JSON.stringify(previous.protocol.events),
      "Fixture rewrote its operation history",
    );
    previous = snapshot;
    return snapshot;
  };
  await read("worker-ready");
  if (generation !== "baseline") {
    const duplicate = await read("worker-duplicate");
    assertContainerTelegramReplay(duplicate.protocol.events, 1);
    check(
      duplicate.provider.calls === 0 && !duplicate.protocol.events.some((e) => e.kind === "effect"),
      "Duplicate performed new work",
    );
  }
  const before = await read("worker-snapshot");
  const updateId = { baseline: 1, edited: 3, restored: 4 }[generation];
  const positive = await read(
    { baseline: "worker-first", edited: "worker-second", restored: "worker-third" }[generation],
  );
  const events = positive.protocol.events.slice(before.protocol.events.length);
  assertTelegramDeliveryIdentity(events, telegramFixtureUpdate(updateId, 101), "creator");
  assertTelegramSourceMarker(
    events,
    generation === "baseline" ? "telegram-proof:baseline" : "telegram-proof:hosted-edit",
  );
  check(
    events.filter((e) => e.kind === "effect").length === 1 &&
      positive.provider.calls === 2 &&
      positive.provider.validatedToolResults === 1,
    "Delivery did not perform exactly one tool operation",
  );
  if (generation === "baseline") {
    const denied = await read("worker-denied");
    const added = denied.protocol.events.slice(positive.protocol.events.length);
    assertTelegramDeliveryIdentity(added, telegramFixtureUpdate(2, 202), "recognized");
    check(!added.some((e) => e.kind === "effect"), "Denied delivery had a business effect");
  }
  const sealed = await read("worker-seal");
  assertSealedTelegramContainerSnapshot(sealed);
  const terminal = sealed.protocol.events.filter((e) => e.kind !== "poll"),
    turns = generation === "baseline" ? 2 : 1;
  check(
    terminal.length === turns * 2 + 1 &&
      terminal.filter((e) => e.kind === "attempt").length === turns &&
      terminal.filter((e) => e.kind === "reply").length === turns &&
      terminal.filter((e) => e.kind === "effect").length === 1,
    "Worker terminal journal omitted or added work",
  );
  const calls = generation === "baseline" ? [0, 2, 2] : [0, 0, 2];
  check(
    sealed.providerGenerations.length === calls.length &&
      sealed.providerGenerations.every(
        (p, i) =>
          p.calls === calls[i] &&
          p.toolRequests === calls[i]! / 2 &&
          p.validatedToolResults === calls[i]! / 2 &&
          p.finalResponses === calls[i]! / 2 &&
          p.rejectedRequests === 0,
      ),
    "Provider generation history differs",
  );
  check(
    JSON.stringify(sealed) === JSON.stringify(await read("worker-final")),
    "Terminal receipt changed",
  );
  return { sealed, updateId, effects: 1, duplicateEffects: 0, unauthorizedEffects: 0 };
}
