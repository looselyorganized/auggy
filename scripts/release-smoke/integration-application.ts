/** Installed HTTP and real-browser acceptance. Fixture code never replaces the agent runtime. */
import { Database } from "bun:sqlite";
import { randomBytes, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { parse, stringify } from "yaml";
import type { CreateExternalAuthAssertionOptions } from "../../src/auth/external-auth";
import {
  createSyntheticOrdersHandler,
  createSyntheticOrdersStore,
} from "../../examples/company-app/fixtures/synthetic-orders";
import {
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
} from "./application-consumer";
import type { CreateAuthoringConsumerOptions } from "./authoring-contract";
import {
  assertProductionFixtureExclusion,
  runIntegrationBrowser,
  stageIntegrationBrowserRuntime,
} from "./integration-browser";
import {
  createIntegrationConsumer,
  observeIntegrationSse,
  readIntegrationFile,
  waitForIntegrationHttpReady,
  withIntegrationChild,
  type IntegrationBudget,
  redactIntegrationDiagnostic,
} from "./integration-consumer";
import {
  INTEGRATION_LIMITS,
  type IntegrationScenarioEvidence,
  type IntegrationSourceIdentity,
  type HashedIntegrationFile,
} from "./integration-contracts";
import { writeIntegrationEvidence } from "./integration-evidence";
import { PROVIDER_FIXTURE_API_KEY, PROVIDER_FIXTURE_FINAL_TEXT } from "./provider-fixture";
import {
  boundedFixtureBody,
  createApplicationModelFixture,
  type ApplicationModelScenario,
} from "./integration-fixtures/application/model-fixture";
import {
  COMPANY_APP_SOURCE_FILES,
  COMPANY_APP_ADAPTER_PATH,
  COMPANY_APP_FIXTURE_MARKER,
  type ApplicationBrowserObservation,
  type CompanyAppBuildKind,
  type PreparedCompanyApp,
} from "./integration-fixtures/application/contracts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

/** A supervisor timeout or cleanup kill is never the deliberately injected crash. */
export function assertExpectedApplicationCrash(
  result: Awaited<ReturnType<typeof withIntegrationChild>>,
  observationCompleted: boolean,
): void {
  const process = result.process;
  check(
    observationCompleted &&
      process.cleanupConfirmed &&
      process.signal === "SIGKILL" &&
      !process.timedOut &&
      !process.spawnFailed &&
      !process.exceededOutput &&
      !process.orphanedGroup &&
      !process.forced,
    "Expected crash observation did not complete cleanly",
  );
}
type Change = IntegrationScenarioEvidence["changes"][number];
type Diagnostic = {
  label: string;
  status: string;
  cleanupConfirmed: boolean;
  stdoutSHA256: string;
  stderrSHA256: string;
  stderr: string;
  process: Pick<
    Awaited<ReturnType<typeof withIntegrationChild>>["process"],
    | "exitCode"
    | "signal"
    | "timedOut"
    | "exceededOutput"
    | "spawnFailed"
    | "orphanedGroup"
    | "forced"
    | "wasRunning"
    | "durationMs"
  >;
};
const READ_A: ApplicationModelScenario = {
  tool: { name: "read_order", input: { orderId: "order-a" }, invalidInput: { orderId: 1 } },
  sentinel: "customer-a-private-marker",
};
const READ_B: ApplicationModelScenario = {
  tool: { name: "read_order", input: { orderId: "order-b" }, invalidInput: { orderId: 1 } },
  sentinel: "customer-b-private-marker",
};
const REFUND: ApplicationModelScenario = {
  tool: {
    name: "simulate_refund",
    input: { orderId: "order-a", amountCents: 1250, reason: "integration-proof" },
    invalidInput: { orderId: 1 },
  },
  sentinel: '"simulated":true',
  terminalDelayMs: 1500,
};
const HTTP_MARKER = "m5-owned-http-edit";

export interface ApplicationIntegrationOptions {
  create: CreateAuthoringConsumerOptions;
  source: IntegrationSourceIdentity;
  runId: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  prepareApp(buildKind: CompanyAppBuildKind): Promise<PreparedCompanyApp>;
  chromium: { path: string; sha256: string };
  signal?: AbortSignal;
}

function sourceWrite(root: string, path: string, bytes: string | Buffer): void {
  mkdirSync(dirname(join(root, path)), { recursive: true, mode: 0o700 });
  writeFileSync(join(root, path), bytes, { mode: 0o600 });
}

export function productionBundleFiles(root: string): string[] {
  const files: string[] = [];
  let visited = 0;
  function visit(path: string, depth: number) {
    check(++visited <= 3000 && depth <= 32, "Production output inventory exceeded bound");
    const stat = lstatSync(join(root, path));
    check(!stat.isSymbolicLink(), "Production bundle contains a symbolic link");
    if (stat.isDirectory()) {
      for (const child of readdirSync(join(root, path)).sort())
        visit(`${path}/${child}`, depth + 1);
    } else if (stat.isFile() && path.endsWith(".js")) files.push(path);
  }
  visit(".next/server", 0);
  visit(".next/static", 0);
  return files;
}

export function assertApplicationBrowserObservation(
  value: unknown,
): asserts value is ApplicationBrowserObservation {
  check(
    value !== null && typeof value === "object" && !Array.isArray(value),
    "Browser observations missing",
  );
  const v = value as ApplicationBrowserObservation;
  check(
    v.version === 1 &&
      v.firstChunkBeforeTerminal === true &&
      v.directAgentRequests === 3 &&
      v.freshAssertionCount === 3 &&
      v.stableRetryKey === true &&
      v.applicationCookiesSentToAgent === false &&
      v.creatorCredentialSentToAgent === false &&
      v.interruptedThenCompleted === true &&
      v.mobileOverflow === false &&
      v.desktopOverflow === false &&
      v.keyboardFocusVisible === true &&
      Array.isArray(v.checks) &&
      v.checks.length >= 5 &&
      v.checks.length <= 20 &&
      v.checks.every((item) => typeof item === "string" && /^[a-z-]{1,100}$/.test(item)),
    "Browser observations failed their independent oracle",
  );
  for (const [size, expectedWidth] of [
    ["desktop", 1365],
    ["mobile", 390],
  ] as const) {
    for (const moment of ["before", "after"] as const) {
      const layout = v.layout?.[size]?.[moment];
      check(
        layout &&
          layout.innerWidth === expectedWidth &&
          Number.isFinite(layout.clientWidth) &&
          layout.clientWidth > 0 &&
          layout.clientWidth <= expectedWidth &&
          layout.scrollWidth === layout.clientWidth,
        "Browser layout failed its client-width oracle",
      );
      for (const region of [layout.app, layout.conversation]) {
        check(
          region &&
            [region.left, region.right, region.width].every(Number.isFinite) &&
            region.left >= 0 &&
            region.right <= layout.clientWidth &&
            region.width > 0 &&
            Math.abs(region.right - region.left - region.width) < 0.5,
          "Browser layout failed its region-bounds oracle",
        );
      }
      check(
        layout.conversation.left >= Math.max(8, layout.app.left) &&
          layout.conversation.right <= Math.min(layout.clientWidth - 8, layout.app.right),
        "Browser layout failed its outer-gutter oracle",
      );
    }
  }
}

export function assertPreparedCompanyApp(app: PreparedCompanyApp): void {
  const expected = new Map(app.baselineFiles.map((file) => [file.path, file.sha256]));
  check(
    expected.size === COMPANY_APP_SOURCE_FILES.length &&
      COMPANY_APP_SOURCE_FILES.every((path) => expected.has(path)),
    "Application source baseline does not match its reviewed inventory",
  );
  check(app.changes.length <= 128, "Application changes exceeded bound");
  for (const change of app.changes) {
    check(
      (expected.get(change.path) ?? null) === change.beforeSHA256,
      "Application source change chain is invalid",
    );
    expected.set(change.path, change.afterSHA256);
  }
  for (const [path, sha256] of expected) {
    const bytes = readIntegrationFile(
      app.directory,
      path,
      path.endsWith(".tgz") ? 256 * 1024 * 1024 : 2 * 1024 * 1024,
    );
    check(
      applicationHash(bytes) === sha256,
      "Prepared application source changed outside its recorded edits",
    );
  }
  check(
    applicationHash(readIntegrationFile(app.directory, app.lockfile.path, 16 * 1024 * 1024)) ===
      app.lockfile.sha256,
    "Prepared application lock changed",
  );
}

export interface ApplicationEffectPhase {
  kind: "production" | "http" | "browser";
  expectedRefund: boolean;
  start: number;
  end: number;
}
export function applicationEffectCounts(
  rows: readonly {
    subject: string;
    receipt: { orderId: string; amountCents: number; simulated: boolean };
  }[],
  phases: readonly ApplicationEffectPhase[],
) {
  const counts = {
    production: { effects: 0, duplicates: 0, unauthorized: 0 },
    http: { effects: 0, duplicates: 0, unauthorized: 0 },
    browser: { effects: 0, duplicates: 0, unauthorized: 0 },
  };
  let previous = 0;
  for (const phase of phases) {
    check(
      phase.start === previous && phase.end >= phase.start && phase.end <= rows.length,
      "Effect journal phase coverage is invalid",
    );
    const observed = rows.slice(phase.start, phase.end);
    const matching = phase.expectedRefund
      ? observed.filter(
          (row) =>
            row.subject === "support-agent" &&
            row.receipt.orderId === "order-a" &&
            row.receipt.amountCents === 1250 &&
            row.receipt.simulated === true,
        ).length
      : 0;
    counts[phase.kind].effects += observed.length;
    counts[phase.kind].duplicates += Math.max(0, matching - 1);
    counts[phase.kind].unauthorized += observed.length - matching;
    previous = phase.end;
  }
  check(previous === rows.length, "Effect journal has unaccounted entries");
  return counts;
}

async function availablePort(): Promise<number> {
  const reservation = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(null),
  });
  const port = reservation.port;
  await reservation.stop(true);
  check(port, "Could not reserve integration port");
  return port;
}
async function waitFor(budget: IntegrationBudget, predicate: () => boolean): Promise<void> {
  await budget.run(Math.min(10000, budget.remainingMs()), async (signal) => {
    while (!predicate()) {
      signal.throwIfAborted();
      await Bun.sleep(20);
    }
  });
}

export async function runApplicationIntegration(options: ApplicationIntegrationOptions) {
  check(
    options.create.provider === "anthropic",
    "HTTP integration requires the real packed Anthropic adapter",
  );
  options.signal?.throwIfAborted();
  const generated = await createIntegrationConsumer(options.create);
  const consumer = generated.generated.consumer;
  const durableDirectory = join(options.create.workspace, `${options.create.name}-durable`);
  mkdirSync(durableDirectory, { mode: 0o700 });
  check(
    (lstatSync(durableDirectory).mode & 0o7777) === 0o700,
    "Integration durable root must be operator-provisioned private storage",
  );
  const cli = assertInstalledApplicationArtifact(
    consumer,
    options.create.repoRoot,
    generated.generated.core,
    "auggy/cli",
  );
  const authEntry = realpathSync(
    createRequire(join(consumer, "package.json")).resolve("auggy/auth"),
  );
  check(
    authEntry.startsWith(`${cli.packageRoot}/`),
    "Assertion signing entry escaped the installed package",
  );
  const signer = (await import(authEntry)) as {
    createExternalAuthAssertion(options: CreateExternalAuthAssertionOptions): string;
  };
  const production = await options.prepareApp("production-reference");
  const fixture = await options.prepareApp("fixture-auth");
  assertPreparedCompanyApp(production);
  assertPreparedCompanyApp(fixture);
  check(
    !readIntegrationFile(production.directory, COMPANY_APP_ADAPTER_PATH, 65536).includes(
      Buffer.from(COMPANY_APP_FIXTURE_MARKER),
    ),
    "Production app contains fixture adapter",
  );
  check(
    readIntegrationFile(fixture.directory, COMPANY_APP_ADAPTER_PATH, 65536).includes(
      Buffer.from(COMPANY_APP_FIXTURE_MARKER),
    ),
    "Fixture app marker missing",
  );
  const agentPort = await availablePort();
  const appPort = await availablePort();
  check(agentPort !== appPort, "Independent services require different ports");
  const agentOrigin = `http://127.0.0.1:${agentPort}`;
  const appOrigin = `http://127.0.0.1:${appPort}`;
  const secret = randomBytes(32).toString("hex"),
    serviceToken = randomBytes(32).toString("hex"),
    creatorToken = randomBytes(32).toString("hex"),
    controlToken = randomBytes(32).toString("hex");
  const cookies = {
    customerA: randomBytes(32).toString("hex"),
    support: randomBytes(32).toString("hex"),
  };
  const audience = `m5-company-${options.runId}`,
    keyId = "m5-fixture-key";
  const privateValues = [
    secret,
    serviceToken,
    creatorToken,
    controlToken,
    ...Object.values(cookies),
    PROVIDER_FIXTURE_API_KEY,
    consumer,
    options.create.workspace,
    options.create.repoRoot,
    options.home,
    options.temporaryDirectory,
    production.directory,
    fixture.directory,
  ];
  const nodeCandidate = Bun.which("node");
  check(nodeCandidate, "Node executable is required for the optional application");
  const node = realpathSync(nodeCandidate);
  const sourceRuntime = {
    path: node,
    sha256: applicationHash(
      readIntegrationFile(dirname(node), node.split("/").at(-1)!, 256 * 1024 * 1024),
    ),
  };
  const baseEnv = applicationEnvironment(options.home, options.temporaryDirectory);
  // Runtime secrets and raw domain state are private workspace inputs, never CI
  // artifacts. The suite retains this workspace on failure and removes it only
  // after every owned process has been reaped on success.
  const privateDirectory = mkdtempSync(join(options.create.workspace, "application-private-"));
  const driverRuntime = stageIntegrationBrowserRuntime(sourceRuntime, privateDirectory);
  const model = createApplicationModelFixture();
  const store = await (async () => {
    try {
      return createSyntheticOrdersStore(join(privateDirectory, "company-effects.sqlite"));
    } catch (error) {
      await model.stop();
      throw error;
    }
  })();
  const domainHandler = createSyntheticOrdersHandler(store, serviceToken);
  let holdEffectResponse = false;
  let heldResponseRelease: (() => void) | undefined;
  let domainCalls = 0;
  const domainServer = await (async () => {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 10,
        maxRequestBodySize: 16384,
        async fetch(request) {
          if (++domainCalls > 100) return new Response(null, { status: 429 });
          const response = await domainHandler(request);
          if (
            holdEffectResponse &&
            new URL(request.url).pathname === "/refunds/simulate" &&
            response.ok
          )
            await new Promise<void>((resolve) => {
              heldResponseRelease = resolve;
            });
          return response;
        },
      });
    } catch (error) {
      store.close();
      await model.stop();
      throw error;
    }
  })();
  const domainOrigin = `http://127.0.0.1:${domainServer.port}`;
  const env = {
    ...baseEnv,
    AUGGY_DATA_DIR: durableDirectory,
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: creatorToken,
    AUGGY_AUTH_SECRET: secret,
    AUGGY_AUTH_KEY_ID: keyId,
    AUGGY_AUTH_AUDIENCE: audience,
    APP_ORIGIN: appOrigin,
    AUGGY_AGENT_URL: agentOrigin,
    ORDERS_SERVICE_URL: domainOrigin,
    ORDERS_SERVICE_TOKEN: serviceToken,
    AUGGY_FIXTURE_MODEL_ORIGIN: model.origin,
    NEXT_TELEMETRY_DISABLED: "1",
  };
  const diagnostics: Diagnostic[] = [],
    changes: Change[] = [],
    httpChecks: string[] = [],
    productionChecks: string[] = [],
    browserChecks: string[] = [];
  let phase = "prepare",
    cleanupComplete = true,
    succeeded = false,
    httpReady = false,
    browserObserved: ApplicationBrowserObservation | null = null;
  let productError: string | null = null;
  let unknownKey = "",
    unknownBody = "";
  let browserEffectBaseline = 0;
  const effectPhases: ApplicationEffectPhase[] = [];
  let currentEffectPhase: Omit<ApplicationEffectPhase, "end"> = {
    kind: "production",
    expectedRefund: false,
    start: 0,
  };
  const switchEffectPhase = (kind: ApplicationEffectPhase["kind"], expectedRefund = false) => {
    const end = store.journal().length;
    effectPhases.push({ ...currentEffectPhase, end });
    currentEffectPhase = { kind, expectedRefund, start: end };
  };
  let consumedAssertion = "";
  const toolSnapshot = () => ({
    effects: store.journal().length,
    calls: model.snapshot().totalRequests,
  });
  const unchanged = (before: ReturnType<typeof toolSnapshot>) =>
    check(
      JSON.stringify(before) === JSON.stringify(toolSnapshot()),
      "Denied or replayed request changed authoritative effects or model calls",
    );
  const auth = (subject: string, overrides: Partial<CreateExternalAuthAssertionOptions> = {}) => {
    const authorization = store.authorizationFor({
      provider: "fixture-app",
      userId: subject,
      orgId: "synthetic-company",
      roles: [],
    });
    return signer.createExternalAuthAssertion({
      secret,
      keyId,
      audience,
      provider: "fixture-app",
      subject,
      orgId: "synthetic-company",
      roles: subject === "app-admin" ? ["admin"] : [],
      ...authorization,
      ttlSeconds: 60,
      jti: randomUUID(),
      ...overrides,
    });
  };
  const runBody = (thread: string, message: string, key: string) =>
    JSON.stringify({
      threadId: thread,
      messages: [{ id: `message-${key}`, role: "user", content: message }],
    });
  const request = (budget: IntegrationBudget, path: string, init: RequestInit = {}) =>
    fetch(`${agentOrigin}${path}`, {
      ...init,
      signal: AbortSignal.any([
        budget.signal,
        AbortSignal.timeout(INTEGRATION_LIMITS.fixtureRequestMs),
      ]),
      redirect: "manual",
    });
  const postRun = (budget: IntegrationBudget, assertion: string, key: string, body: string) =>
    request(budget, "/agent/run", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-auggy-auth-assertion": assertion,
        "idempotency-key": key,
      },
      body,
    });
  const command = (args: string[]) => [
    process.execPath,
    "--no-env-file",
    "--no-install",
    "--config=/dev/null",
    cli.entry,
    ...args,
  ];
  function note(label: string, result: Awaited<ReturnType<typeof withIntegrationChild>>) {
    cleanupComplete &&= result.process.cleanupConfirmed;
    diagnostics.push({
      label,
      status: result.status,
      cleanupConfirmed: result.process.cleanupConfirmed,
      stdoutSHA256: result.process.stdoutSHA256,
      stderrSHA256: result.process.stderrSHA256,
      stderr: result.process.stderr.slice(-8192),
      process: {
        exitCode: result.process.exitCode,
        signal: result.process.signal,
        timedOut: result.process.timedOut,
        exceededOutput: result.process.exceededOutput,
        spawnFailed: result.process.spawnFailed,
        orphanedGroup: result.process.orphanedGroup,
        forced: result.process.forced,
        wasRunning: result.process.wasRunning,
        durationMs: result.process.durationMs,
      },
    });
  }
  const boundedCommand = async (label: string, cwd: string, argv: string[], commandEnv = env) => {
    phase = label;
    const result = await withIntegrationChild(
      {
        label,
        cwd,
        command: argv,
        env: commandEnv,
        secrets: privateValues,
        signal: options.signal,
      },
      async ({ child }) => {
        const ended = await child.finish();
        check(ended.exitCode === 0, "Integration build command failed");
      },
    );
    note(label, result);
    check(result.status === "passed", "Integration build command failed");
  };
  const withAgent = async (
    label: string,
    observe: (
      budget: IntegrationBudget,
      child: Parameters<Parameters<typeof withIntegrationChild>[1]>[0]["child"],
    ) => Promise<void> | Promise<"deliberate-crash">,
    expectedCrash = false,
  ) => {
    phase = label;
    let crashObservationCompleted = false;
    const result = await withIntegrationChild(
      {
        label,
        cwd: consumer,
        command: command(["run", "--config", "agent.yaml", "--no-open"]),
        env,
        secrets: privateValues,
        signal: options.signal,
      },
      async ({ budget, child }) => {
        await waitForIntegrationHttpReady({
          url: `${agentOrigin}/health`,
          budget,
          exited: child.exited,
          ready: (response) => response.status === 200,
        });
        httpReady = true;
        try {
          crashObservationCompleted = (await observe(budget, child)) === "deliberate-crash";
        } catch (error) {
          productError ??= redactIntegrationDiagnostic(
            error instanceof Error ? error.message : "Application observation failed",
            privateValues,
          );
          throw error;
        }
      },
    );
    note(label, result);
    if (expectedCrash) {
      assertExpectedApplicationCrash(result, crashObservationCompleted);
      diagnostics[diagnostics.length - 1]!.status = "expected-crash";
    } else check(result.status === "passed", "Installed HTTP agent phase failed");
  };
  let controlServer: ReturnType<typeof Bun.serve> | undefined;
  try {
    const configBefore = readIntegrationFile(consumer, "agent.yaml", 256 * 1024);
    const config = parse(configBefore.toString("utf8"));
    const fragment = parse(
      readIntegrationFile(
        join(options.create.repoRoot, "examples/company-app"),
        "agent-integration/agent-yaml.fragment.yaml",
        32768,
      ).toString("utf8"),
    );
    config.engine = {
      ...config.engine,
      baseURL: "${AUGGY_FIXTURE_MODEL_ORIGIN}",
      requestTimeoutMs: 10000,
    };
    config.settings = { ...config.settings, maxInferenceLoops: 3 };
    config.augments = fragment.augments;
    const web = config.augments.find((entry: { name: string }) => entry.name === "web");
    web.options.port = agentPort;
    web.options.securityNamespace = config.id;
    web.options.externalAuth.allowedProviders = ["fixture-app"];
    const configAfter = stringify(config);
    sourceWrite(consumer, "agent.yaml", configAfter);
    changes.push({
      path: "agent.yaml",
      kind: "source-edit",
      beforeSHA256: applicationHash(configBefore),
      afterSHA256: applicationHash(configAfter),
    });
    for (const leaf of ["index.ts", "contracts.ts", "service-client.ts"]) {
      const source = readIntegrationFile(
        join(options.create.repoRoot, "examples/company-app"),
        `agent-integration/orders/${leaf}`,
        65536,
      );
      const path = `src/augments/orders/${leaf}`;
      check(!existsSync(join(consumer, path)), "Orders ingredient destination already exists");
      sourceWrite(consumer, path, source);
      changes.push({
        path,
        kind: "source-edit",
        beforeSHA256: null,
        afterSHA256: applicationHash(source),
      });
    }
    await boundedCommand("http-source-typecheck", consumer, [process.execPath, "run", "typecheck"]);
    for (const [kind, app] of [
      ["production", production],
      ["fixture", fixture],
    ] as const)
      await boundedCommand(`app-${kind}-build`, app.directory, [
        node,
        join(app.directory, "node_modules/next/dist/bin/next"),
        "build",
        "--webpack",
      ]);
    assertPreparedCompanyApp(production);
    assertPreparedCompanyApp(fixture);
    const exclusion = assertProductionFixtureExclusion({
      appDirectory: production.directory,
      builtFiles: productionBundleFiles(production.directory),
      forbiddenMarkers: [
        COMPANY_APP_FIXTURE_MARKER,
        "auggy_fixture_session",
        "AUGGY_FIXTURE_SESSIONS_FILE",
        "customer-a-private-marker",
        "customer-b-private-marker",
      ],
    });
    check(exclusion.files > 0, "Production exclusion has no output files");
    productionChecks.push(
      "real-node-next-production-build",
      "production-bundles-exclude-fixture-identity",
    );
    const productionRun = await withIntegrationChild(
      {
        label: "app-production-server",
        cwd: production.directory,
        command: [
          node,
          join(production.directory, "node_modules/next/dist/bin/next"),
          "start",
          "--hostname",
          "127.0.0.1",
          "--port",
          String(appPort),
        ],
        env,
        secrets: privateValues,
        signal: options.signal,
      },
      async ({ budget, child }) => {
        await waitForIntegrationHttpReady({
          url: `${appOrigin}/api/auggy-config`,
          budget,
          exited: child.exited,
          ready: (response) => response.status === 200,
        });
        const baseline = toolSnapshot();
        for (const [method, origin, expected] of [
          ["GET", appOrigin, 405],
          ["POST", "http://hostile.invalid", 403],
          ["POST", appOrigin, 503],
        ] as const) {
          const response = await fetch(`${appOrigin}/api/auggy-auth-assertion`, {
            method,
            headers: { origin, "x-auggy-csrf-request": "1" },
            signal: AbortSignal.any([budget.signal, AbortSignal.timeout(10000)]),
            redirect: "manual",
          });
          check(
            response.status === expected &&
              response.headers.get("cache-control")?.includes("no-store") &&
              response.headers.get("x-content-type-options") === "nosniff",
            "Production assertion refusal or cache boundary failed",
          );
          const body = await boundedFixtureBody(response);
          check(!body.includes('assertion":'), "Production unconfigured verifier issued assertion");
        }
        unchanged(baseline);
      },
    );
    note("app-production-server", productionRun);
    check(productionRun.status === "passed", "Production app server checks failed");
    productionChecks.push(
      "unconfigured-verifier-fails-closed-before-agent-effects",
      "method-origin-and-private-response-controls",
    );

    switchEffectPhase("http");
    await withAgent("standalone-http-agent", async (budget) => {
      const sameThread = randomUUID();
      await model.configure(READ_A);
      const firstKey = randomUUID(),
        firstBody = runBody(sameThread, "Read order-a", firstKey);
      const original = await observeIntegrationSse({
        response: await postRun(budget, auth("customer-a"), firstKey, firstBody),
        budget,
        expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
      });
      check(
        original.terminal === "RUN_FINISHED" &&
          original.firstChunkBeforeTerminal &&
          original.containsExpectedMarker &&
          model.snapshot().provider?.validatedToolResults === 1 &&
          !model.snapshot().requests.some((x) => x.containsB),
        "Standalone actual tool/stream proof failed",
      );
      const beforeReplay = toolSnapshot();
      const replay = await observeIntegrationSse({
        response: await postRun(budget, auth("customer-a"), firstKey, firstBody),
        budget,
        expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
      });
      check(
        replay.contentSHA256 === original.contentSHA256 && replay.terminal === "RUN_FINISHED",
        "Keyed response changed on fresh-assertion retry",
      );
      unchanged(beforeReplay);
      const changed = await postRun(
        budget,
        auth("customer-a", { grants: [], scopes: [], authzVersion: "changed-policy" }),
        firstKey,
        firstBody,
      );
      check(changed.status === 409, "Changed authority retrieved prior operation");
      await changed.body?.cancel();
      unchanged(beforeReplay);
      httpChecks.push(
        "standalone-http-without-next-executed-real-tool",
        "actual-content-before-terminal",
        "fresh-assertion-same-key-replays-without-effects",
        "changed-grants-cannot-retrieve-prior-response",
      );
      const crossKey = await postRun(budget, auth("customer-b"), firstKey, firstBody);
      check(crossKey.status === 409, "Another principal retrieved a prior keyed response");
      check(
        !(await boundedFixtureBody(crossKey)).includes("customer-a-private-marker"),
        "Key conflict leaked prior private content",
      );
      unchanged(beforeReplay);
      httpChecks.push("cross-principal-operation-key-cannot-retrieve-prior-result");
      await model.configure(READ_A);
      consumedAssertion = auth("customer-a");
      const duplicateKeys = [randomUUID(), randomUUID()];
      const claims = await Promise.all(
        duplicateKeys.map((key) =>
          postRun(
            budget,
            consumedAssertion,
            key,
            runBody(randomUUID(), "Read one single-use assertion", key),
          ),
        ),
      );
      check(
        claims.filter((response) => response.status === 200).length === 1 &&
          claims.filter((response) => response.status === 401).length === 1,
        "Concurrent single-use assertion admission was not atomic",
      );
      for (const response of claims) {
        if (response.status === 200)
          check(
            (
              await observeIntegrationSse({
                response,
                budget,
                expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
              })
            ).terminal === "RUN_FINISHED",
            "Admitted atomic-claim run failed",
          );
        else await response.body?.cancel();
      }
      check(
        model.snapshot().provider?.validatedToolResults === 1,
        "Concurrent assertion claim executed more than one turn",
      );
      httpChecks.push("concurrent-assertion-claim-admits-one-turn");
      await model.configure(READ_B);
      const beforeB = model.snapshot().requests.length;
      const otherKey = randomUUID();
      const other = await observeIntegrationSse({
        response: await postRun(
          budget,
          auth("customer-b"),
          otherKey,
          runBody(sameThread, "Read order-b", otherKey),
        ),
        budget,
        expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
      });
      check(
        other.terminal === "RUN_FINISHED" &&
          !model
            .snapshot()
            .requests.slice(beforeB)
            .some((x) => x.containsA),
        "Cross-principal thread exposed prior private record",
      );
      httpChecks.push("supplied-thread-id-is-partitioned-by-authenticated-principal");
      for (const [subject, order, status] of [
        ["customer-a", "order-a", 200],
        ["customer-b", "order-b", 200],
        ["customer-a", "order-b", 403],
        ["customer-b", "order-a", 403],
        ["app-admin", "order-a", 200],
      ] as const) {
        const before = toolSnapshot();
        const response = await request(budget, `/orders/${order}`, {
          headers: { "x-auggy-auth-assertion": auth(subject) },
        });
        check(response.status === status, "Order route resource policy failed");
        const body = await boundedFixtureBody(response);
        check(
          status !== 403 || !body.includes("private-marker"),
          "Denied route leaked private record",
        );
        unchanged(before);
      }
      const beforeUnauthorized = toolSnapshot();
      for (const overrides of [
        { secret: randomBytes(32).toString("hex") },
        { audience: "another-company-agent" },
      ]) {
        const key = randomUUID();
        const denied = await postRun(
          budget,
          auth("support-agent", overrides),
          key,
          runBody(randomUUID(), "Simulate refund", key),
        );
        check(denied.status === 401, "Another deployment credential was admitted");
        await denied.body?.cancel();
        unchanged(beforeUnauthorized);
      }
      const operator = await request(budget, "/console", {
        headers: { "x-auggy-auth-assertion": auth("app-admin") },
      });
      check(
        [401, 403, 404].includes(operator.status),
        "Application administrator reached operator surface",
      );
      await operator.body?.cancel();
      for (const [subject, order, amount] of [
        ["customer-a", "order-a", 100],
        ["app-admin", "order-a", 100],
        ["support-agent", "order-b", 100],
        ["support-agent", "order-a", 5001],
      ] as const) {
        const response = await request(budget, `/orders/${order}/refund-simulations`, {
          method: "POST",
          headers: { "x-auggy-auth-assertion": auth(subject), "content-type": "application/json" },
          body: JSON.stringify({
            amountCents: amount,
            reason: "negative-control",
            operationId: randomUUID(),
          }),
        });
        check(
          response.status >= 400 && response.status < 500,
          "Unauthorized refund route succeeded",
        );
        await response.body?.cancel();
        unchanged(beforeUnauthorized);
      }
      for (const assertion of [
        auth("support-agent", {
          grants: [
            {
              action: "orders.refund.simulate",
              resource: "order-a",
              constraints: { maxAmountCents: 1000 },
            },
          ],
        }),
        auth("customer-a", { roles: ["admin", "support"] }),
      ]) {
        const constrained = await request(budget, "/orders/order-a/refund-simulations", {
          method: "POST",
          headers: { "x-auggy-auth-assertion": assertion, "content-type": "application/json" },
          body: JSON.stringify({
            amountCents: 1250,
            reason: "constraint-control",
            operationId: randomUUID(),
          }),
        });
        check(
          constrained.status === 403,
          "Narrow amount constraint or forged role granted authority",
        );
        await constrained.body?.cancel();
        unchanged(beforeUnauthorized);
      }
      httpChecks.push(
        "customer-order-route-isolation",
        "company-admin-remains-public-recognized",
        "wrong-audience-and-signing-key-rejected-before-inference",
        "missing-grant-wrong-resource-and-excess-amount-have-no-effects",
      );
      await model.configure(READ_B);
      const negativeStart = model.snapshot().requests.length;
      const negativeKey = randomUUID();
      const negative = await observeIntegrationSse({
        response: await postRun(
          budget,
          auth("customer-a"),
          negativeKey,
          runBody(randomUUID(), "Read forbidden order-b", negativeKey),
        ),
        budget,
      });
      const negativeRequests = model.snapshot().requests.slice(negativeStart);
      check(
        negative.terminal === "RUN_ERROR" &&
          negativeRequests.some((x) => x.authorizationDenied) &&
          !negativeRequests.some((x) => x.containsB),
        "Cross-resource model tool request escaped authorization",
      );
      check(store.journal().length === 0, "Read-only controls produced a business effect");
      httpChecks.push("model-requested-cross-resource-tool-denied-before-private-data");
      const allowedCors = await request(budget, "/agent/run", {
        method: "OPTIONS",
        headers: {
          origin: appOrigin,
          "access-control-request-method": "POST",
          "access-control-request-headers": "content-type,x-auggy-auth-assertion,idempotency-key",
        },
      });
      check(
        allowedCors.headers.get("access-control-allow-origin") === appOrigin,
        "Exact application CORS origin unavailable",
      );
      await allowedCors.body?.cancel();
      const deniedCors = await request(budget, "/agent/run", {
        method: "OPTIONS",
        headers: { origin: "http://hostile.invalid", "access-control-request-method": "POST" },
      });
      check(
        deniedCors.headers.get("access-control-allow-origin") !== "http://hostile.invalid",
        "CORS reflected an unauthorized origin",
      );
      await deniedCors.body?.cancel();
      httpChecks.push(
        "exact-origin-cors-without-hostile-reflection",
        "enabled-graph-has-no-shared-mutable-private-memory",
      );
    });

    // Visible owned HTTP source changes behavior on the next ordinary launch.
    const httpBefore = readIntegrationFile(consumer, "src/http.ts", 65536);
    const anchor = "          return response;";
    check(
      httpBefore.toString("utf8").split(anchor).length === 2,
      "Generated HTTP source edit anchor changed",
    );
    const httpAfter = httpBefore
      .toString("utf8")
      .replace(
        anchor,
        `          response.headers.set("x-m5-owned-http", "${HTTP_MARKER}");\n${anchor}`,
      );
    sourceWrite(consumer, "src/http.ts", httpAfter);
    changes.push({
      path: "src/http.ts",
      kind: "source-edit",
      beforeSHA256: applicationHash(httpBefore),
      afterSHA256: applicationHash(httpAfter),
    });
    await withAgent("edited-http-and-browser-agent", async (budget) => {
      const beforeRestartReplay = toolSnapshot();
      const replayKey = randomUUID();
      const oldAssertion = await postRun(
        budget,
        consumedAssertion,
        replayKey,
        runBody(randomUUID(), "Replay prior assertion", replayKey),
      );
      check(oldAssertion.status === 401, "Consumed assertion revived after process replacement");
      await oldAssertion.body?.cancel();
      unchanged(beforeRestartReplay);
      httpChecks.push("consumed-assertion-remains-denied-after-process-replacement");
      await model.configure(READ_A);
      const key = randomUUID(),
        response = await postRun(
          budget,
          auth("customer-a"),
          key,
          runBody(randomUUID(), "Read source edit", key),
        );
      check(
        response.headers.get("x-m5-owned-http") === HTTP_MARKER &&
          response.headers.get("x-m5-owned-http") !== "wrong-owned-marker",
        "Owned HTTP source edit not executed",
      );
      check(
        (
          await observeIntegrationSse({
            response,
            budget,
            expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
          })
        ).terminal === "RUN_FINISHED",
        "Edited HTTP execution failed",
      );
      httpChecks.push("visible-owned-http-source-edit-observed-after-restart");
      browserEffectBaseline = store.journal().length;
      switchEffectPhase("browser");
      let refundCallsAtSettle = -1;
      let controlCalls = 0;
      let refundConfigured = false;
      controlServer = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        idleTimeout: 10,
        maxRequestBodySize: 4096,
        async fetch(request) {
          if (
            request.method !== "POST" ||
            request.headers.get("authorization") !== `Bearer ${controlToken}`
          )
            return new Response(null, { status: 401 });
          try {
            check(++controlCalls <= 20, "Browser control request bound exceeded");
            const body = JSON.parse(await boundedFixtureBody(request, 4096));
            const path = new URL(request.url).pathname;
            if (path === "/configure") {
              check(
                body.scenario === "read-a" || body.scenario === "refund",
                "Unknown browser model scenario",
              );
              if (body.scenario === "refund") {
                check(!refundConfigured, "Browser refund scenario already configured");
                refundConfigured = true;
                switchEffectPhase("browser", true);
              }
              await model.configure(
                body.scenario === "read-a" ? { ...READ_A, terminalDelayMs: 1500 } : REFUND,
              );
              return Response.json({ configured: true });
            }
            if (path === "/settled") {
              await waitFor(budget, () => model.snapshot().active === 0);
              // Observe actual committed run state; do not infer finalization from a delay.
              await waitFor(budget, () => {
                const path = join(durableDirectory, "data/web-runs.sqlite");
                const db = new Database(path, { readonly: true, create: false });
                try {
                  check(
                    (db.query("PRAGMA application_id").get() as { application_id: number })
                      .application_id === 0x41554944,
                    "Unexpected operation store identity",
                  );
                  return (
                    (
                      db
                        .query(
                          "SELECT COUNT(*) AS count FROM web_idempotency WHERE state = 'running'",
                        )
                        .get() as { count: number }
                    ).count === 0
                  );
                } finally {
                  db.close();
                }
              });
              refundCallsAtSettle = model.snapshot().totalRequests;
              return Response.json({ settled: true });
            }
            if (path === "/verify")
              return Response.json({
                oneBrowserEffect: store.journal().length === browserEffectBaseline + 1,
                noRetryModelCall:
                  refundCallsAtSettle >= 0 &&
                  model.snapshot().totalRequests === refundCallsAtSettle,
              });
            return new Response(null, { status: 404 });
          } catch {
            return Response.json({ error: "fixture_control_failed" }, { status: 400 });
          }
        },
      });
      const registryPath = join(privateDirectory, "fixture-sessions.private.json");
      writeFileSync(
        registryPath,
        JSON.stringify({
          version: 1,
          sessions: [
            {
              cookie: cookies.customerA,
              session: {
                provider: "fixture-app",
                userId: "customer-a",
                orgId: "synthetic-company",
                roles: [],
              },
            },
            {
              cookie: cookies.support,
              session: {
                provider: "fixture-app",
                userId: "support-agent",
                orgId: "synthetic-company",
                roles: ["support"],
              },
            },
          ],
        }),
        { flag: "wx", mode: 0o600 },
      );
      const appEnv = { ...env, AUGGY_FIXTURE_SESSIONS_FILE: registryPath };
      const appRun = await withIntegrationChild(
        {
          label: "app-fixture-server",
          cwd: fixture.directory,
          command: [
            node,
            join(fixture.directory, "node_modules/next/dist/bin/next"),
            "start",
            "--hostname",
            "127.0.0.1",
            "--port",
            String(appPort),
          ],
          env: appEnv,
          secrets: privateValues,
          signal: budget.signal,
          timeoutMs: budget.remainingMs(),
        },
        async ({ budget: appBudget, child }) => {
          await waitForIntegrationHttpReady({
            url: `${appOrigin}/api/auggy-config`,
            budget: appBudget,
            exited: child.exited,
            ready: (response) => response.status === 200,
          });
          const browserSource = readFileSync(
            new URL(
              "./integration-fixtures/application/browser-driver.ts.template",
              import.meta.url,
            ),
          );
          sourceWrite(fixture.directory, "acceptance-browser.mjs", browserSource);
          writeFileSync(
            join(options.evidenceDirectory, "application-browser-driver.ts"),
            browserSource,
            { flag: "wx", mode: 0o600 },
          );
          const outputPath = join(options.evidenceDirectory, "browser-observations.json");
          const browserConfigPath = join(privateDirectory, "browser-config.private.json");
          writeFileSync(
            browserConfigPath,
            JSON.stringify({
              appOrigin,
              agentOrigin,
              controlOrigin: `http://127.0.0.1:${controlServer!.port}`,
              controlToken,
              sessions: cookies,
              expectedMarker: PROVIDER_FIXTURE_FINAL_TEXT,
              outputPath,
              screenshotDirectory: options.evidenceDirectory,
            }),
            { flag: "wx", mode: 0o600 },
          );
          const playwrightRoot = realpathSync(join(fixture.directory, "node_modules/playwright"));
          const playwrightManifest = readIntegrationFile(playwrightRoot, "package.json", 65536);
          writeFileSync(
            join(options.evidenceDirectory, "browser-inputs.json"),
            JSON.stringify({
              driverSHA256: applicationHash(browserSource),
              playwrightVersion: JSON.parse(playwrightManifest.toString("utf8")).version,
              playwrightManifestSHA256: applicationHash(playwrightManifest),
              chromiumExecutableSHA256: options.chromium.sha256,
              driverRuntimeSHA256: driverRuntime.sha256,
            }),
            { flag: "wx", mode: 0o600 },
          );
          const browser = await runIntegrationBrowser({
            repoRoot: options.create.repoRoot,
            appDirectory: fixture.directory,
            driver: { path: "acceptance-browser.mjs", sha256: applicationHash(browserSource) },
            playwright: {
              version: JSON.parse(playwrightManifest.toString("utf8")).version,
              manifestSHA256: applicationHash(playwrightManifest),
            },
            chromium: options.chromium,
            driverRuntime,
            env: { ...baseEnv, AUGGY_FIXTURE_BROWSER_CONFIG: browserConfigPath },
            secrets: privateValues,
            signal: appBudget.signal,
            timeoutMs: appBudget.remainingMs(),
          }).catch((error: unknown) => {
            productError ??= redactIntegrationDiagnostic(
              error instanceof Error ? error.message : "Browser preflight failed",
              privateValues,
            );
            throw error;
          });
          note("actual-chromium-browser", browser);
          if (browser.driver) note("actual-browser-driver", browser.driver);
          check(browser.status === "passed", "Real browser driver did not pass");
          const observation = JSON.parse(
            readIntegrationFile(
              options.evidenceDirectory,
              "browser-observations.json",
              65536,
            ).toString("utf8"),
          );
          assertApplicationBrowserObservation(observation);
          browserObserved = observation;
          check(
            store.journal().length === browserEffectBaseline + 1 &&
              store.journal().at(-1)?.subject === "support-agent",
            "Browser run produced wrong authoritative effect",
          );
          browserChecks.push(
            ...observation.checks,
            "real-next-node-server-and-owned-chromium",
            "authoritative-journal-proves-one-support-effect",
          );
        },
      );
      note("app-fixture-server", appRun);
      check(appRun.status === "passed", "Fixture application flow failed");
    });

    switchEffectPhase("http");
    // Crash after the downstream service commits but before the tool receives its response.
    await model.configure(REFUND);
    const beforeUnknown = store.journal().length;
    holdEffectResponse = true;
    switchEffectPhase("http", true);
    unknownKey = randomUUID();
    unknownBody = runBody(randomUUID(), "Simulate uncertain refund", unknownKey);
    await withAgent(
      "http-uncertain-effect-crash",
      async (budget, child) => {
        const pending = postRun(budget, auth("support-agent"), unknownKey, unknownBody)
          .then(async (response) => {
            await response.body?.cancel();
          })
          .catch(() => {});
        await waitFor(
          budget,
          () => store.journal().length === beforeUnknown + 1 && heldResponseRelease !== undefined,
        );
        child.signal("SIGKILL");
        await child.finish();
        heldResponseRelease?.();
        heldResponseRelease = undefined;
        await pending;
        return "deliberate-crash";
      },
      true,
    );
    holdEffectResponse = false;
    await withAgent("http-uncertain-effect-replacement", async (budget) => {
      const before = toolSnapshot();
      await budget.run(45000, async (signal) => {
        for (;;) {
          signal.throwIfAborted();
          const db = new Database(join(durableDirectory, "data/web-runs.sqlite"), {
            readonly: true,
            create: false,
          });
          let recentlyRunning: number;
          try {
            check(
              (db.query("PRAGMA application_id").get() as { application_id: number })
                .application_id === 0x41554944,
              "Unexpected operation store identity",
            );
            recentlyRunning = (
              db
                .query(
                  "SELECT COUNT(*) AS count FROM web_idempotency WHERE state = 'running' AND heartbeat_at >= ?",
                )
                .get(Date.now() - 30000) as { count: number }
            ).count;
          } finally {
            db.close();
          }
          if (recentlyRunning === 0) break;
          unchanged(before);
          await Bun.sleep(250);
        }
      });
      const response = await postRun(budget, auth("support-agent"), unknownKey, unknownBody);
      check(
        response.status === 409 &&
          (await boundedFixtureBody(response)).includes("idempotency_outcome_unknown"),
        "Uncertain effect was repeated instead of held for reconciliation",
      );
      unchanged(before);
      check(
        store.journal().length === beforeUnknown + 1,
        "Uncertain effect repeated after replacement",
      );
    });
    httpChecks.push(
      "downstream-commit-then-process-crash-is-outcome-unknown",
      "replacement-never-repeats-uncertain-business-effect",
    );
    succeeded = true;
  } catch (error) {
    productError ??= redactIntegrationDiagnostic(
      error instanceof Error ? error.message : "Application integration failed",
      privateValues,
    );
  } finally {
    heldResponseRelease?.();
    const released = await Promise.allSettled([
      controlServer?.stop(true),
      model.stop(),
      domainServer.stop(true),
    ]);
    cleanupComplete &&= released.every((result) => result.status === "fulfilled");
  }
  const effectRows = store.journal();
  effectPhases.push({ ...currentEffectPhase, end: effectRows.length });
  const effectCounts = applicationEffectCounts(effectRows, effectPhases);
  if (
    succeeded &&
    (effectCounts.production.effects !== 0 ||
      effectCounts.http.effects !== 1 ||
      effectCounts.browser.effects !== 1 ||
      Object.values(effectCounts).some(
        (counts) => counts.duplicates !== 0 || counts.unauthorized !== 0,
      ))
  ) {
    succeeded = false;
    productError = "Observed authoritative effects did not match expected scenario counts";
  }
  const journal = {
    effectCounts,
    effectPhases,
    effects: effectRows.map((row) => ({
      subject: row.subject,
      receiptSHA256: applicationHash(JSON.stringify(row.receipt)),
    })),
    domainCalls,
    model: model.snapshot(),
    browser: browserObserved,
    failure: productError,
    diagnostics,
  };
  store.close();
  const journalBytes = `${JSON.stringify(journal, null, 2)}\n`;
  check(
    Buffer.byteLength(journalBytes) <= INTEGRATION_LIMITS.evidenceBytes,
    "Application journal exceeded the evidence byte bound",
  );
  writeFileSync(join(options.evidenceDirectory, "application-journal.json"), journalBytes, {
    flag: "wx",
    mode: 0o600,
  });
  const artifacts: HashedIntegrationFile[] = [
    { path: "application-journal.json", sha256: applicationHash(journalBytes) },
  ];
  if (browserObserved)
    for (const path of [
      "browser-observations.json",
      "application-desktop.png",
      "application-mobile.png",
    ])
      artifacts.push({
        path,
        sha256: applicationHash(
          readIntegrationFile(options.evidenceDirectory, path, 16 * 1024 * 1024),
        ),
      });
  for (const path of ["application-browser-driver.ts", "browser-inputs.json"]) {
    if (existsSync(join(options.evidenceDirectory, path)))
      artifacts.push({
        path,
        sha256: applicationHash(readIntegrationFile(options.evidenceDirectory, path, 65536)),
      });
  }
  const baseEvidence = (
    scenarioId: string,
    buildKind: IntegrationScenarioEvidence["buildKind"],
    checks: string[],
    app?: PreparedCompanyApp,
  ): IntegrationScenarioEvidence => ({
    version: 1,
    scenarioId,
    runId: options.runId,
    stage: "local",
    buildKind,
    source: {
      ...options.source,
      lockfiles: [
        { path: "agent/bun.lock", sha256: generated.lockfile.sha256 },
        ...(app ? [{ path: "app/bun.lock", sha256: app.lockfile.sha256 }] : []),
      ],
      installedFiles: [
        ...generated.installedFiles.map((file) => ({ ...file, path: `agent/${file.path}` })),
        ...(app ? app.installedFiles.map((file) => ({ ...file, path: `app/${file.path}` })) : []),
      ],
    },
    profile: { kind: "http", port: agentPort, healthPath: "/health", consolePath: null },
    baselineFiles: [
      ...generated.baselineFiles.map((file) => ({ ...file, path: `agent/${file.path}` })),
      ...(app ? app.baselineFiles.map((file) => ({ ...file, path: `app/${file.path}` })) : []),
    ],
    changes: [
      ...changes.map((change) => ({ ...change, path: `agent/${change.path}` })),
      ...(app ? app.changes.map((change) => ({ ...change, path: `app/${change.path}` })) : []),
    ],
    execution: {
      commandLabels: diagnostics.map((diagnostic) => diagnostic.label),
      deadlinesMs: {
        scenario: INTEGRATION_LIMITS.scenarioMs,
        build: INTEGRATION_LIMITS.scenarioMs,
      },
      firstChunkBeforeTerminal:
        buildKind === "fixture-auth"
          ? (browserObserved?.firstChunkBeforeTerminal ?? false)
          : buildKind === "standalone-fixture"
            ? httpChecks.includes("actual-content-before-terminal")
            : null,
      effectCount:
        effectCounts[
          buildKind === "production-reference"
            ? "production"
            : buildKind === "fixture-auth"
              ? "browser"
              : "http"
        ].effects,
      duplicateEffectCount:
        effectCounts[
          buildKind === "production-reference"
            ? "production"
            : buildKind === "fixture-auth"
              ? "browser"
              : "http"
        ].duplicates,
      unauthorizedEffectCount:
        effectCounts[
          buildKind === "production-reference"
            ? "production"
            : buildKind === "fixture-auth"
              ? "browser"
              : "http"
        ].unauthorized,
      startup: httpReady ? "ready" : "failed",
      channel: succeeded && buildKind !== "production-reference" ? "verified" : "unverified",
      observations: [
        "Deterministic private HTTP fixtures; no live model or identity provider",
        "Unknown downstream effects require explicit operator reconciliation; no automatic retry",
        "Browser history is ephemeral; only explicit operation and service journals are durable",
      ],
    },
    platform: { exportSHA256: null, imageDigest: null, deploymentId: null, resources: [] },
    outcome:
      succeeded && cleanupComplete
        ? { status: "passed", checks }
        : { status: "failed", reason: `Application integration failed at ${phase}` },
    cleanup: { status: cleanupComplete ? "complete" : "failed", remainingOwnedIds: [] },
    artifacts,
    retainedUntil: null,
    independentReviewer: null,
  });
  const evidence = [
    baseEvidence("standalone-http-policy", "standalone-fixture", httpChecks),
    baseEvidence(
      "application-production-reference",
      "production-reference",
      productionChecks,
      production,
    ),
    baseEvidence("application-browser-integration", "fixture-auth", browserChecks, fixture),
  ];
  for (const record of evidence)
    writeIntegrationEvidence(
      options.evidenceDirectory,
      `${record.scenarioId}.json`,
      JSON.stringify(record),
      privateValues,
    );
  return { evidence, consumer, durableDirectory, diagnostics, failure: productError };
}
