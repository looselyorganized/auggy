/** Preparation and observations for the standalone hosted HTTP fixture. No Railway mutation. */
import { closeSync, fstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import { parse, stringify } from "yaml";
import { z } from "zod";
import type { CreateExternalAuthAssertionOptions } from "../../src/auth/external-auth";
import { createPinnedFile, pinDirectory } from "../../src/lib/anchored-files";
import { createSyntheticOrdersStore } from "../../examples/company-app/fixtures/synthetic-orders";
import { applicationHash } from "./application-consumer";
import {
  createIntegrationBudget,
  observeIntegrationSse,
  readIntegrationFile,
} from "./integration-consumer";
import { INTEGRATION_LIMITS, type IntegrationScenarioEvidence } from "./integration-contracts";
import { PROVIDER_FIXTURE_FINAL_TEXT } from "./provider-fixture";
import {
  HOSTED_HTTP_LIMITS,
  HOSTED_HTTP_PORTS,
  hostedCheckpoint,
  type HostedHttpCheckpoint,
  type HostedHttpControl,
} from "./integration-fixtures/http-container/startup";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const integer = z.number().int().min(0).max(1000);
const providerSchema = z
  .object({
    scenario: z.enum(["success", "answer-only", "invalid-tool-arguments", "provider-failure"]),
    generation: integer,
    calls: integer,
    toolRequests: integer,
    validatedToolResults: integer,
    finalResponses: integer,
    rejectedRequests: integer,
    summaries: z
      .array(
        z
          .object({
            call: integer,
            streaming: z.boolean(),
            outcome: z.enum([
              "tool-request",
              "direct-answer",
              "verified-tool-result",
              "verified-validation-error",
              "provider-failure",
              "invalid-request",
              "call-limit",
            ]),
            status: z.number().int().min(100).max(599),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const modelSchema = z
  .object({
    generation: integer,
    state: z.enum(["running", "sealing", "sealed", "stopped", "failed"]),
    active: integer,
    totalRequests: integer,
    lateRequests: integer,
    rejectedRequests: integer,
    provider: providerSchema.nullable(),
    providers: z
      .array(z.object({ generation: integer, evidence: providerSchema }).strict())
      .max(100),
    requests: z
      .array(
        z
          .object({
            generation: integer,
            containsA: z.boolean(),
            containsB: z.boolean(),
            authorizationDenied: z.boolean(),
            offeredTools: z.array(z.string().max(128)).max(100),
            creatorPreamble: z.boolean(),
          })
          .strict(),
      )
      .max(100),
  })
  .strict();
const snapshotSchema = z
  .object({
    version: z.literal(1),
    state: z.enum(["waiting", "active", "sealing", "sealed", "failed", "stopped"]),
    initializedFrom: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable(),
    initialEffects: integer,
    domain: z
      .object({ calls: integer, active: integer, late: integer, rejected: integer })
      .strict(),
    model: modelSchema,
    checkpoint: z.unknown(),
    checkpointSHA256: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();

function assertCompleteModelJournal(model: z.infer<typeof modelSchema>) {
  check(
    model.totalRequests === model.requests.length &&
      model.providers.length === model.generation &&
      model.providers.every((provider, index) => provider.generation === index + 1) &&
      (model.generation === 0
        ? model.provider === null && model.totalRequests === 0
        : model.provider !== null &&
          JSON.stringify(model.provider) === JSON.stringify(model.providers.at(-1)!.evidence)),
    "HTTP model generation history or current provider is incomplete",
  );
  check(
    model.requests.every(
      (request, index) =>
        request.generation >= 1 &&
        request.generation <= model.generation &&
        (index === 0 || request.generation >= model.requests[index - 1]!.generation),
    ),
    "HTTP model request generation is invalid",
  );
  const statuses = {
    "tool-request": 200,
    "direct-answer": 200,
    "verified-tool-result": 200,
    "verified-validation-error": 200,
    "provider-failure": 503,
    "invalid-request": 400,
    "call-limit": 429,
  } as const;
  for (const { generation, evidence } of model.providers) {
    const count = (outcomes: readonly string[]) =>
      evidence.summaries.filter((summary) => outcomes.includes(summary.outcome)).length;
    const successfulOutcomes = evidence.summaries
      .filter((summary) => summary.status === 200)
      .map((summary) => summary.outcome);
    const expectedOutcomes = {
      success: ["tool-request", "verified-tool-result"],
      "answer-only": ["direct-answer"],
      "invalid-tool-arguments": ["tool-request", "verified-validation-error"],
      "provider-failure": [],
    }[evidence.scenario];
    check(
      // configure() creates a new provider, whose own generation always starts at one.
      evidence.generation === 1 &&
        evidence.calls <= 5 &&
        evidence.toolRequests <= 1 &&
        evidence.finalResponses <= 1 &&
        evidence.validatedToolResults <= evidence.toolRequests &&
        evidence.validatedToolResults <= evidence.finalResponses &&
        evidence.calls ===
          model.requests.filter((request) => request.generation === generation).length &&
        evidence.calls === evidence.summaries.length &&
        evidence.summaries.every(
          (summary, index) =>
            summary.call === index + 1 &&
            summary.status === statuses[summary.outcome] &&
            (summary.outcome !== "call-limit" || summary.call > 4),
        ) &&
        successfulOutcomes.every((outcome, index) => outcome === expectedOutcomes[index]) &&
        evidence.toolRequests === count(["tool-request"]) &&
        evidence.validatedToolResults ===
          count(["verified-tool-result", "verified-validation-error"]) &&
        evidence.finalResponses ===
          count(["direct-answer", "verified-tool-result", "verified-validation-error"]) &&
        evidence.rejectedRequests >= count(["provider-failure", "invalid-request", "call-limit"]),
      "HTTP provider request/summary counters are incomplete",
    );
  }
}

export function parseHostedHttpSnapshot(bytes: string) {
  check(
    Buffer.byteLength(bytes) <= HOSTED_HTTP_LIMITS.snapshotBytes,
    "HTTP snapshot exceeded bound",
  );
  const parsed = snapshotSchema.parse(JSON.parse(bytes));
  const checkpoint = hostedCheckpoint(parsed.checkpoint);
  check(
    checkpoint.sha256 === parsed.checkpointSHA256 &&
      parsed.initialEffects <= checkpoint.checkpoint.effects.length,
    "HTTP checkpoint identity or effect baseline is invalid",
  );
  assertCompleteModelJournal(parsed.model);
  return { ...parsed, checkpoint: checkpoint.checkpoint };
}
export type HostedHttpSnapshot = ReturnType<typeof parseHostedHttpSnapshot>;
function assertQuiescentHttpJournal(snapshot: HostedHttpSnapshot) {
  check(
    snapshot.domain.active === 0 &&
      snapshot.domain.late === 0 &&
      snapshot.domain.rejected === 0 &&
      snapshot.model.active === 0 &&
      snapshot.model.lateRequests === 0 &&
      snapshot.model.rejectedRequests === 0 &&
      (snapshot.model.provider === null || snapshot.model.provider.rejectedRequests === 0) &&
      snapshot.model.providers.every((provider) => provider.evidence.rejectedRequests === 0),
    "HTTP journal is not quiescent and clean",
  );
}

function assertUnchangedHttpJournal(before: HostedHttpSnapshot, after: HostedHttpSnapshot) {
  assertQuiescentHttpJournal(before);
  assertQuiescentHttpJournal(after);
  check(
    before.state === "active" &&
      before.model.state === "running" &&
      ((after.state === "active" && after.model.state === "running") ||
        (after.state === "sealed" && after.model.state === "sealed")),
    "Unexpected HTTP observation lifecycle state",
  );
  const journal = (snapshot: HostedHttpSnapshot) => {
    const { state: _modelState, ...model } = snapshot.model;
    return {
      initializedFrom: snapshot.initializedFrom,
      initialEffects: snapshot.initialEffects,
      checkpoint: snapshot.checkpoint,
      checkpointSHA256: snapshot.checkpointSHA256,
      domain: snapshot.domain,
      model,
    };
  };
  check(
    JSON.stringify(journal(before)) === JSON.stringify(journal(after)),
    "Unexpected HTTP work changed the completed journal",
  );
}

export function assertSealedHostedHttpSnapshot(bytes: string) {
  const snapshot = parseHostedHttpSnapshot(bytes);
  check(
    snapshot.state === "sealed" && snapshot.model.state === "sealed",
    "HTTP terminal snapshot is not a clean seal",
  );
  assertQuiescentHttpJournal(snapshot);
  return snapshot;
}

export function persistHostedHttpGeneration(options: {
  evidenceDirectory: string;
  name: string;
  snapshot: string;
  identity: {
    generation: string;
    imageDigest: string;
    deploymentId: string | null;
    volumeId: string;
    sourceSHA256: string;
  };
}) {
  check(
    /^http-generation-[a-z0-9-]{1,80}\.json$/.test(options.name),
    "Invalid HTTP generation evidence name",
  );
  const snapshot = assertSealedHostedHttpSnapshot(options.snapshot);
  const { identity } = options;
  check(
    /^sha256:[a-f0-9]{64}$/.test(identity.imageDigest) &&
      /^[a-f0-9]{64}$/.test(identity.sourceSHA256) &&
      [
        identity.generation,
        identity.volumeId,
        ...(identity.deploymentId === null ? [] : [identity.deploymentId]),
      ].every((id) => /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,255}$/.test(id)),
    "Invalid HTTP generation identity",
  );
  const bytes = JSON.stringify({
    version: 1,
    identity: {
      generation: identity.generation,
      imageDigest: identity.imageDigest,
      deploymentId: identity.deploymentId,
      volumeId: identity.volumeId,
      sourceSHA256: identity.sourceSHA256,
    },
    snapshotSHA256: applicationHash(options.snapshot),
    snapshot,
  });
  check(
    Buffer.byteLength(bytes) <= INTEGRATION_LIMITS.evidenceBytes,
    "HTTP generation evidence exceeded bound",
  );
  const directory = pinDirectory(options.evidenceDirectory, "HTTP generation evidence");
  try {
    check(
      (fstatSync(directory.fd).mode & 0o777) === 0o700,
      "HTTP generation evidence directory must be private",
    );
    check(
      createPinnedFile(directory.fd, options.name, bytes, "HTTP generation evidence"),
      "HTTP generation evidence already exists",
    );
  } finally {
    closeSync(directory.fd);
  }
  return {
    path: options.name,
    sha256: applicationHash(bytes),
    checkpointSHA256: snapshot.checkpointSHA256,
  };
}

/** Only explicit copied fixture sources and generated-owned entry/YAML are modified. */
export function prepareHostedHttpFixtures(consumer: string) {
  type Change = IntegrationScenarioEvidence["changes"][number];
  const changes: Change[] = [];
  const files: { path: string; sha256: string }[] = [];
  const copies: { source: string; sourceSHA256: string; target: string; targetSHA256: string }[] =
    [];
  const root = new URL("../../", import.meta.url);
  const put = (
    path: string,
    bytes: Buffer | string,
    kind: Change["kind"],
    before: Buffer | null = null,
  ) => {
    mkdirSync(dirname(join(consumer, path)), { recursive: true, mode: 0o700 });
    writeFileSync(join(consumer, path), bytes, { flag: before === null ? "wx" : "w", mode: 0o600 });
    const sha256 = applicationHash(bytes);
    files.push({ path, sha256 });
    changes.push({
      path,
      kind,
      beforeSHA256: before === null ? null : applicationHash(before),
      afterSHA256: sha256,
    });
  };
  const rewrite = (source: string, before: string, after: string) => {
    check(source.split(before).length === 2, "HTTP fixture import/ownership anchor changed");
    return source.replace(before, after);
  };
  const copy = (
    source: string,
    target: string,
    transform?: (source: string) => string,
    kind: Change["kind"] = "fixture-overlay",
  ) => {
    const bytes = readIntegrationFile(fileURLToPath(root), source, 256 * 1024);
    const output = transform ? Buffer.from(transform(bytes.toString("utf8"))) : bytes;
    put(target, output, kind);
    copies.push({
      source,
      sourceSHA256: applicationHash(bytes),
      target,
      targetSHA256: applicationHash(output),
    });
  };
  for (const leaf of ["contracts.ts", "service-client.ts", "index.ts"]) {
    copy(
      `examples/company-app/agent-integration/orders/${leaf}`,
      `src/augments/orders/${leaf}`,
      leaf === "index.ts"
        ? (source) =>
            `import { stopContainerHttpFixture } from "../../fixtures/hosted-http-startup";\n${rewrite(source, '    name: "orders",', '    name: "orders",\n    onShutdown: stopContainerHttpFixture,')}`
        : undefined,
      "source-edit",
    );
  }
  copy(
    "examples/company-app/fixtures/synthetic-orders.ts",
    "src/fixtures/synthetic-orders.ts",
    (source) =>
      rewrite(
        rewrite(
          source,
          'from "../agent-integration/orders/contracts"',
          'from "../augments/orders/contracts"',
        ),
        'from "../agent-integration/orders/service-client"',
        'from "../augments/orders/service-client"',
      ),
  );
  copy("scripts/release-smoke/provider-fixture.ts", "src/fixtures/hosted-http-provider.ts");
  copy(
    "scripts/release-smoke/integration-fixtures/application/model-fixture.ts",
    "src/fixtures/hosted-http-model.ts",
    (source) =>
      rewrite(
        rewrite(source, 'from "../../provider-fixture"', 'from "./hosted-http-provider"'),
        'from "../../integration-contracts"',
        'from "./integration-limits"',
      ),
  );
  copy(
    "scripts/release-smoke/integration-fixtures/http-container/startup.ts",
    "src/fixtures/hosted-http-startup.ts",
    (source) =>
      rewrite(
        rewrite(
          source,
          'from "../../../../examples/company-app/fixtures/synthetic-orders"',
          'from "./synthetic-orders"',
        ),
        'from "../application/model-fixture"',
        'from "./hosted-http-model"',
      ),
  );
  copy(
    "scripts/release-smoke/integration-fixtures/http-container/control.ts",
    "src/fixtures/hosted-http-control.ts",
    (source) =>
      rewrite(
        rewrite(source, 'from "../application/model-fixture"', 'from "./hosted-http-model"'),
        'from "./startup"',
        'from "./hosted-http-startup"',
      ),
  );
  put(
    "src/fixtures/integration-limits.ts",
    `export const INTEGRATION_LIMITS = ${JSON.stringify(INTEGRATION_LIMITS)} as const;\n`,
    "fixture-overlay",
  );
  const beforeMain = readIntegrationFile(consumer, "src/index.ts", 32768);
  const main = "export const main: ApplicationMain = async (launch) => {";
  const injected = rewrite(
    rewrite(
      beforeMain.toString("utf8"),
      main,
      `${main}\n  await startContainerHttpFixture();\n  try {`,
    ),
    "\n};",
    "\n  } catch (error) { await stopContainerHttpFixture(); throw error; }\n};",
  );
  put(
    "src/index.ts",
    `import { startContainerHttpFixture, stopContainerHttpFixture } from "./fixtures/hosted-http-startup";\n${injected}`,
    "fixture-overlay",
    beforeMain,
  );
  const beforeConfig = readIntegrationFile(consumer, "agent.yaml", 256 * 1024);
  const config = parse(beforeConfig.toString("utf8"));
  const fragmentPath = "examples/company-app/agent-integration/agent-yaml.fragment.yaml";
  const fragmentBytes = readIntegrationFile(fileURLToPath(root), fragmentPath, 32768);
  const fragment = parse(fragmentBytes.toString("utf8"));
  check(
    config.engine && typeof config.id === "string" && Array.isArray(fragment.augments),
    "Generated HTTP configuration changed",
  );
  config.engine = {
    ...config.engine,
    baseURL: `http://127.0.0.1:${HOSTED_HTTP_PORTS.model}`,
    requestTimeoutMs: 10000,
  };
  config.settings = { ...config.settings, maxInferenceLoops: 3 };
  config.augments = fragment.augments;
  const web = config.augments.find((entry: { name: string }) => entry.name === "web");
  web.options.port = 8080;
  web.options.securityNamespace = config.id;
  delete web.options.cors;
  web.options.externalAuth.allowedProviders = ["fixture-app"];
  put("agent.yaml", stringify(config), "source-edit", beforeConfig);
  copies.push({
    source: fragmentPath,
    sourceSHA256: applicationHash(fragmentBytes),
    target: "agent.yaml",
    targetSHA256: files.at(-1)!.sha256,
  });
  assertHostedHttpFixtures(consumer, files);
  return { files, copies, changes };
}

export function assertHostedHttpFixtures(
  consumer: string,
  files: readonly { path: string; sha256: string }[],
) {
  const expected = [
    "agent.yaml",
    "src/index.ts",
    "src/augments/orders/index.ts",
    "src/augments/orders/contracts.ts",
    "src/augments/orders/service-client.ts",
    "src/fixtures/synthetic-orders.ts",
    "src/fixtures/hosted-http-provider.ts",
    "src/fixtures/hosted-http-model.ts",
    "src/fixtures/hosted-http-startup.ts",
    "src/fixtures/hosted-http-control.ts",
    "src/fixtures/integration-limits.ts",
  ];
  check(
    files.length === expected.length &&
      new Set(files.map((file) => file.path)).size === expected.length &&
      expected.every((path) => files.some((file) => file.path === path)),
    "Incomplete hosted HTTP source inventory",
  );
  for (const file of files)
    check(
      applicationHash(readIntegrationFile(consumer, file.path, 256 * 1024)) === file.sha256,
      "Hosted HTTP source identity changed",
    );
}

export function editHostedHttpSource(consumer: string, marker: string) {
  check(/^[a-z0-9-]{1,80}$/.test(marker), "Invalid owned HTTP marker");
  const path = "src/http.ts";
  const before = readIntegrationFile(consumer, path, 32768);
  const anchor = "          const response = await web.agentRun(request);";
  const source = before.toString("utf8");
  check(
    source.split(anchor).length === 2 && !source.includes("x-auggy-hosted-source"),
    "Owned HTTP edit anchor changed",
  );
  const after = source.replace(
    anchor,
    `${anchor}\n          response.headers.set("x-auggy-hosted-source", "${marker}");`,
  );
  writeFileSync(join(consumer, path), after, { mode: 0o600 });
  return {
    path,
    kind: "source-edit" as const,
    beforeSHA256: applicationHash(before),
    afterSHA256: applicationHash(after),
  };
}
export function assertHostedHttpSourceMarker(observed: string | null, expected: string | null) {
  check(observed === expected, "Owned HTTP marker was not observed");
}

/** A bounded scenario usable through local HTTP and an independently bounded remote control adapter. */
export async function observeHostedHttpGeneration(options: {
  agentOrigin: string;
  control: (operation: HostedHttpControl, signal: AbortSignal) => Promise<string>;
  signer: (options: CreateExternalAuthAssertionOptions) => string;
  secret: string;
  keyId: string;
  audience: string;
  checkpoint: HostedHttpCheckpoint | null;
  operationId: string;
  threadId: string;
  expectedSourceMarker: string | null;
  previousOperation?: { operationId: string; threadId: string };
  signal?: AbortSignal;
}) {
  const origin = new URL(options.agentOrigin);
  check(
    ["http:", "https:"].includes(origin.protocol) &&
      origin.origin === options.agentOrigin &&
      !origin.username &&
      !origin.password,
    "Invalid observed HTTP origin",
  );
  check(
    /^[a-zA-Z0-9-]{16,128}$/.test(options.operationId) &&
      /^[a-zA-Z0-9-]{16,128}$/.test(options.threadId),
    "Invalid scenario operation identity",
  );
  const budget = createIntegrationBudget(INTEGRATION_LIMITS.scenarioMs, options.signal);
  const policy = createSyntheticOrdersStore(":memory:");
  const checkpoints: HostedHttpSnapshot[] = [];
  const control = async (operation: HostedHttpControl) => {
    const bytes = await budget.run(HOSTED_HTTP_LIMITS.drainMs + 2000, (signal) =>
      options.control(operation, signal),
    );
    const snapshot = parseHostedHttpSnapshot(bytes);
    checkpoints.push(snapshot);
    return { bytes, snapshot };
  };
  const auth = (subject: string, audience = options.audience) =>
    options.signer({
      secret: options.secret,
      keyId: options.keyId,
      audience,
      provider: "fixture-app",
      subject,
      orgId: "synthetic-company",
      ...policy.authorizationFor({
        provider: "fixture-app",
        userId: subject,
        orgId: "synthetic-company",
        roles: [],
      }),
      ttlSeconds: 60,
      jti: randomUUID(),
    });
  const runBody = (operationId: string, threadId: string) =>
    JSON.stringify({
      threadId,
      messages: [
        {
          id: `message-${operationId}`,
          role: "user",
          content: "Simulate the authorized synthetic refund",
        },
      ],
    });
  const body = runBody(options.operationId, options.threadId);
  const request = (path: string, init: RequestInit) =>
    fetch(`${options.agentOrigin}${path}`, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.any([
        budget.signal,
        AbortSignal.timeout(INTEGRATION_LIMITS.fixtureRequestMs),
      ]),
    });
  const post = (assertion: string, operationId = options.operationId, input = body) =>
    request("/agent/run", {
      method: "POST",
      body: input,
      headers: {
        "content-type": "application/json",
        "x-auggy-auth-assertion": assertion,
        "idempotency-key": operationId,
      },
    });
  try {
    const baseline = (await control({ operation: "initialize", checkpoint: options.checkpoint }))
      .snapshot;
    assertQuiescentHttpJournal(baseline);
    check(
      baseline.state === "active" &&
        baseline.model.state === "running" &&
        baseline.model.generation === 0 &&
        baseline.domain.calls === 0 &&
        baseline.initialEffects === baseline.checkpoint.effects.length &&
        baseline.checkpointSHA256 ===
          hostedCheckpoint(
            options.checkpoint ?? {
              version: 1,
              policyVersion: baseline.checkpoint.policyVersion,
              effects: [],
            },
          ).sha256 &&
        baseline.initializedFrom ===
          (options.checkpoint === null ? null : baseline.checkpointSHA256),
      "HTTP initialized baseline differs from the selected checkpoint",
    );
    const configured = (await control({ operation: "configure", scenario: "refund" })).snapshot;
    assertQuiescentHttpJournal(configured);
    check(
      configured.state === "active" &&
        configured.model.state === "running" &&
        configured.model.generation === 1 &&
        configured.model.totalRequests === 0 &&
        configured.checkpointSHA256 === baseline.checkpointSHA256 &&
        configured.initializedFrom === baseline.initializedFrom &&
        configured.initialEffects === baseline.initialEffects &&
        JSON.stringify(configured.domain) === JSON.stringify(baseline.domain),
      "HTTP configuration performed unexpected work",
    );
    let previousReplay = false;
    if (options.previousOperation) {
      const previous = options.previousOperation;
      check(
        previous.operationId !== options.operationId &&
          [previous.operationId, previous.threadId].every((value) =>
            /^[a-zA-Z0-9-]{16,128}$/.test(value),
          ),
        "Invalid preceding operation identity",
      );
      const old = await post(
        auth("support-agent"),
        previous.operationId,
        runBody(previous.operationId, previous.threadId),
      );
      assertHostedHttpSourceMarker(
        old.headers.get("x-auggy-hosted-source"),
        options.expectedSourceMarker,
      );
      const replay = await observeIntegrationSse({
        response: old,
        budget,
        expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
      });
      const observed = (await control({ operation: "snapshot" })).snapshot;
      check(
        replay.terminal === "RUN_FINISHED" && replay.containsExpectedMarker === true,
        "Replacement replay repeated a model/domain effect",
      );
      assertUnchangedHttpJournal(configured, observed);
      previousReplay = true;
    }
    const first = await post(auth("support-agent"));
    const sourceMarker = first.headers.get("x-auggy-hosted-source");
    assertHostedHttpSourceMarker(sourceMarker, options.expectedSourceMarker);
    const stream = await observeIntegrationSse({
      response: first,
      budget,
      expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
    });
    check(
      stream.terminal === "RUN_FINISHED" &&
        stream.containsExpectedMarker === true &&
        stream.firstChunkBeforeTerminal,
      "Hosted HTTP turn did not stream the expected successful result",
    );
    const after = (await control({ operation: "snapshot" })).snapshot;
    assertQuiescentHttpJournal(after);
    const delta = after.checkpoint.effects.length - baseline.checkpoint.effects.length;
    check(
      delta === 1 &&
        after.state === "active" &&
        after.model.state === "running" &&
        after.domain.calls === configured.domain.calls + 1 &&
        after.initializedFrom === baseline.initializedFrom &&
        after.initialEffects === baseline.initialEffects &&
        JSON.stringify(after.checkpoint.effects.slice(0, baseline.initialEffects)) ===
          JSON.stringify(baseline.checkpoint.effects),
      "Unexpected hosted HTTP domain effect count or checkpoint mutation",
    );
    check(
      after.model.generation === configured.model.generation &&
        after.model.totalRequests === 2 &&
        after.model.provider?.scenario === "success" &&
        after.model.provider.calls === 2 &&
        after.model.provider.toolRequests === 1 &&
        after.model.provider.validatedToolResults === 1 &&
        after.model.provider.finalResponses === 1 &&
        after.model.provider.summaries[0]?.outcome === "tool-request" &&
        after.model.provider.summaries[1]?.outcome === "verified-tool-result",
      "Hosted HTTP model/tool execution or replay failed",
    );
    const retry = await post(auth("support-agent"));
    assertHostedHttpSourceMarker(
      retry.headers.get("x-auggy-hosted-source"),
      options.expectedSourceMarker,
    );
    const replay = await observeIntegrationSse({
      response: retry,
      budget,
      expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
    });
    check(
      replay.terminal === "RUN_FINISHED" && replay.contentSHA256 === stream.contentSHA256,
      "Fresh assertion retry changed the completed result",
    );
    const afterRetry = (await control({ operation: "snapshot" })).snapshot;
    assertUnchangedHttpJournal(after, afterRetry);
    const unauthorized = await request("/agent/run", {
      method: "POST",
      body,
      headers: { "content-type": "application/json" },
    });
    check(unauthorized.status === 401, "Unsigned hosted HTTP request succeeded");
    await unauthorized.body?.cancel();
    const wrongAudience = await post(auth("support-agent", `${options.audience}-wrong`));
    check(wrongAudience.status === 401, "Another deployment's assertion succeeded");
    await wrongAudience.body?.cancel();
    const forbidden = await request("/orders/order-b", {
      method: "GET",
      headers: { "x-auggy-auth-assertion": auth("customer-a") },
    });
    check(forbidden.status === 403, "Another customer's order became visible");
    await forbidden.body?.cancel();
    const final = (await control({ operation: "snapshot" })).snapshot;
    assertUnchangedHttpJournal(afterRetry, final);
    const sealed = await control({ operation: "seal" });
    const accepted = assertSealedHostedHttpSnapshot(sealed.bytes);
    assertUnchangedHttpJournal(final, accepted);
    const repeated = await control({ operation: "snapshot" });
    check(sealed.bytes === repeated.bytes, "Terminal HTTP snapshot changed");
    return {
      stream,
      replay,
      previousReplay,
      sourceMarker,
      effectCount: accepted.checkpoint.effects.length - baseline.checkpoint.effects.length,
      duplicateEffectCount: afterRetry.checkpoint.effects.length - after.checkpoint.effects.length,
      unauthorizedEffectCount:
        accepted.checkpoint.effects.length - afterRetry.checkpoint.effects.length,
      checkpoint: accepted.checkpoint,
      checkpointSHA256: accepted.checkpointSHA256,
      sealedSnapshot: sealed.bytes,
      snapshots: checkpoints,
    };
  } finally {
    policy.close();
    budget.dispose();
  }
}
