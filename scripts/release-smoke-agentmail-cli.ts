import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

const SUPPLIED_KEY = "am_packed_supplied_not_real";
const REJECTED_KEY = "am_packed_rejected_not_real";
const AGENT_ID = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
const INBOX_ID = "packed-agentmail@agentmail.to";
const INBOX_EMAIL = INBOX_ID;

const [cliPath, packedRoot, consumerDir, smokeHome, packedTarball, packedEngineTarball] =
  process.argv.slice(2);
if (
  !cliPath ||
  !packedRoot ||
  !consumerDir ||
  !smokeHome ||
  !packedTarball ||
  !packedEngineTarball
) {
  throw new Error(
    "usage: release-smoke-agentmail-cli.ts <cli> <packed-root> <consumer-dir> <home> <auggy-tarball> <engine-tarball>",
  );
}

mkdirSync(consumerDir, { recursive: true });
writeAgentFixture(consumerDir, "packed-agentmail");

const optionalTargetDir = join(consumerDir, ".optional-target-check");
mkdirSync(optionalTargetDir, { recursive: true });
writeAgentFixture(optionalTargetDir, "packed-optional-target");
const optionalAdd = await runCli(
  ["augment", "add", "agentmail", "--skip-install", "--yes"],
  {},
  optionalTargetDir,
);
if (optionalAdd.exitCode !== 0) {
  throw new Error(`packed CLI could not add lowercase agentmail:\n${optionalAdd.output}`);
}
const setupHelp = await runCli(["agentmail", "setup", "--help"], {}, optionalTargetDir);
if (setupHelp.exitCode !== 0 || !setupHelp.output.includes("signup, existing, manual, or env")) {
  throw new Error(`packed AgentMail help omitted the supported setup modes:\n${setupHelp.output}`);
}
for (const requiredFlag of [
  "--username",
  "--display-name",
  "--human-email",
  "--api-key",
  "--inbox-id",
]) {
  if (!setupHelp.output.includes(requiredFlag)) {
    throw new Error(`packed AgentMail help omitted setup option ${requiredFlag}`);
  }
}
if (setupHelp.output.includes("--replace-key")) {
  throw new Error("packed AgentMail help still advertises removed key-replacement behavior");
}
const optionalConfigPath = join(optionalTargetDir, "agent.yaml");
const optionalAugmentPath = join(optionalTargetDir, "augments", "agentMail", "augment.yaml");
const beforeNoninteractiveSignup = snapshotAgentMailFiles(
  optionalTargetDir,
  optionalConfigPath,
  optionalAugmentPath,
);
const noninteractiveSignup = await runCli(
  ["augment", "setup", "agentmail", "--mode", "signup"],
  {},
  optionalTargetDir,
);
if (
  noninteractiveSignup.exitCode === 0 ||
  !noninteractiveSignup.output.includes("requires an interactive terminal for email verification")
) {
  throw new Error(
    `packed AgentMail CLI did not fail closed for non-interactive signup:\n${noninteractiveSignup.output}`,
  );
}
if (
  !isDeepStrictEqual(
    beforeNoninteractiveSignup,
    snapshotAgentMailFiles(optionalTargetDir, optionalConfigPath, optionalAugmentPath),
  )
) {
  throw new Error("packed AgentMail non-interactive signup changed local state");
}
const invalidMode = await runCli(
  ["agentmail", "setup", "--mode", "packed-smoke-invalid"],
  {},
  optionalTargetDir,
);
if (invalidMode.exitCode === 0 || !/Invalid .*AgentMail setup mode/.test(invalidMode.output)) {
  throw new Error(`packed optional AgentMail setup path did not execute:\n${invalidMode.output}`);
}
if (invalidMode.output.includes("missing required argument")) {
  throw new Error("packed AgentMail setup still requires an explicit target");
}

const addPath = join(packedRoot, "src", "cli", "commands", "add.ts");
const setupPath = join(packedRoot, "src", "cli", "commands", "agentmail.ts");
const packedAdd = await import(pathToFileURL(addPath).href);
const packedSetup = await import(pathToFileURL(setupPath).href);

const setupTargets: string[] = [];
const setupConfirmations: string[] = [];
const addOutput = await captureConsoleOutput(async () => {
  await packedAdd.runAdd(undefined, {
    cwd: consumerDir,
    config: join(consumerDir, "agent.yaml"),
    augment: ["visitorAuth", "agentmail"],
    skipInstall: true,
    interactive: true,
    confirmSetup: async (message: string) => {
      setupConfirmations.push(message);
      return true;
    },
    runAgentMailSetup: async (
      target: "agentMail" | "visitorAuth",
      options: Record<string, unknown>,
    ) => {
      setupTargets.push(`${target}:${String(options.mode ?? "interactive")}`);
      return {
        agentName: "packed-agentmail",
        target,
        mode: target === "agentMail" ? "manual" : "env",
        inboxId: INBOX_ID,
        inboxEmail: INBOX_EMAIL,
        envPath: join(consumerDir, ".env"),
        augmentPath: join(consumerDir, "augments", target, "augment.yaml"),
        envKeys: ["AGENTMAIL_API_KEY", "AGENTMAIL_INBOX_ID", "AGENTMAIL_INBOX_EMAIL"],
      };
    },
  });
});
assertNoCredentialOutput(addOutput);
if (
  setupConfirmations.length !== 1 ||
  setupConfirmations[0] !== "Set up one shared AgentMail inbox for agentMail and visitorAuth now?"
) {
  throw new Error(
    `packed shared add did not ask exactly once: ${JSON.stringify(setupConfirmations)}`,
  );
}
if (setupTargets.join(",") !== "agentMail:interactive,visitorAuth:env") {
  throw new Error(`packed shared setup order was incorrect: ${JSON.stringify(setupTargets)}`);
}

await installPackedAgentDependencies();

const configPath = join(consumerDir, "agent.yaml");
const agentMailPath = join(consumerDir, "augments", "agentMail", "augment.yaml");
const visitorAuthPath = join(consumerDir, "augments", "visitorAuth", "augment.yaml");
enableInboundReview(agentMailPath);
const agentConfigBeforeSetup = readFileSync(configPath, "utf8");

const provider = await startReadOnlyProvider();
try {
  let keyPrompts = 0;
  let inboxPrompts = 0;
  let setupResult: Awaited<ReturnType<typeof packedSetup.runAgentMailSetup>>;
  try {
    setupResult = await packedSetup.runAgentMailSetup(
      "agentMail",
      {
        config: configPath,
        mode: "manual",
        baseUrl: provider.baseUrl,
        allowInsecureHttpWithCredentials: true,
      },
      {
        cwd: consumerDir,
        interactive: true,
        promptPassword: async (prompt: { message?: string; mask?: string }) => {
          keyPrompts += 1;
          if (!prompt.mask || !prompt.message?.includes("runtime")) {
            throw new Error("packed connect did not use the masked runtime-key prompt");
          }
          return SUPPLIED_KEY;
        },
        promptInput: async (prompt: { message?: string }) => {
          inboxPrompts += 1;
          if (!prompt.message?.includes("Existing AgentMail inbox ID")) {
            throw new Error("packed connect did not ask for an existing inbox ID");
          }
          return INBOX_ID;
        },
      },
    );
  } catch (error) {
    throw new Error(
      `packed AgentMail manual connection failed: ${(error as Error).message}; provider state ${JSON.stringify(provider.state)}`,
    );
  }
  if (keyPrompts !== 1 || inboxPrompts !== 1) {
    throw new Error("packed manual setup did not collect exactly one key and one inbox ID");
  }
  assertPermissionEvidence(setupResult);
  assertNoCredentialOutput(packedSetup.formatAgentMailSetupResult(setupResult));

  if (readFileSync(configPath, "utf8") !== agentConfigBeforeSetup) {
    throw new Error("packed AgentMail connect changed immutable agent.yaml identity/topology");
  }
  assertConfiguredEnv(readFileSync(join(consumerDir, ".env"), "utf8"));
  assertAgentMailYaml(readFileSync(agentMailPath, "utf8"));

  const visitorResult = await packedSetup.runAgentMailSetup(
    "visitorAuth",
    {
      config: configPath,
      mode: "env",
      baseUrl: provider.baseUrl,
      allowInsecureHttpWithCredentials: true,
    },
    { cwd: consumerDir, interactive: false },
  );
  assertNoCredentialOutput(packedSetup.formatAgentMailSetupResult(visitorResult));
  assertVisitorAuthYaml(readFileSync(visitorAuthPath, "utf8"));

  const beforeRerun = snapshotConfiguredFiles(
    consumerDir,
    configPath,
    agentMailPath,
    visitorAuthPath,
  );
  const rerun = await packedSetup.runAgentMailSetup(
    "agentMail",
    {
      config: configPath,
      mode: "env",
      baseUrl: provider.baseUrl,
      allowInsecureHttpWithCredentials: true,
    },
    { cwd: consumerDir, interactive: false },
  );
  assertPermissionEvidence(rerun);
  const afterRerun = snapshotConfiguredFiles(
    consumerDir,
    configPath,
    agentMailPath,
    visitorAuthPath,
  );
  if (!isDeepStrictEqual(beforeRerun, afterRerun)) {
    throw new Error("packed AgentMail env rerun was not byte-idempotent");
  }

  const beforeDoctor = snapshotConfiguredFiles(
    consumerDir,
    configPath,
    agentMailPath,
    visitorAuthPath,
  );
  configureReadOnlyDoctorFixture(configPath, agentMailPath, provider.baseUrl);
  let doctorChangedEnv = false;
  try {
    const doctor = await runCli(["doctor", "--config", configPath], {}, consumerDir);
    if (doctor.exitCode !== 0) {
      throw new Error(`packed AgentMail doctor failed after connect/env setup:\n${doctor.output}`);
    }
    if (
      !doctor.output.includes("AgentMail policy agentMail") ||
      !doctor.output.includes("receive/triage disabled; reviewed reply drafts disabled") ||
      !doctor.output.includes("read and search messages, threads, and drafts") ||
      !doctor.output.includes("send, reply, and forward directly") ||
      !doctor.output.includes("inbox_read") ||
      !doctor.output.includes("message_read") ||
      !doctor.output.includes("draft_read") ||
      !doctor.output.includes("message_send") ||
      !doctor.output.includes("draft_create") ||
      !doctor.output.includes("draft_update") ||
      !doctor.output.includes("draft_send")
    ) {
      throw new Error(`packed AgentMail doctor omitted the connected policy:\n${doctor.output}`);
    }
  } finally {
    doctorChangedEnv = readFileSync(join(consumerDir, ".env"), "utf8") !== beforeDoctor.env;
    writeFileSync(configPath, beforeDoctor.agent);
    writeFileSync(agentMailPath, beforeDoctor.agentMail);
    writeFileSync(visitorAuthPath, beforeDoctor.visitorAuth);
  }
  if (doctorChangedEnv) {
    throw new Error("packed AgentMail doctor changed the connected credential file");
  }

  const rejectedDir = join(consumerDir, ".rejected-connect-check");
  mkdirSync(rejectedDir, { recursive: true });
  writeAgentFixture(rejectedDir, "packed-rejected");
  const rejectedAdd = await runCli(
    ["augment", "add", "agentmail", "--skip-install", "--yes"],
    {},
    rejectedDir,
  );
  if (rejectedAdd.exitCode !== 0) throw new Error("could not prepare rejected-connect fixture");
  const rejectedConfig = join(rejectedDir, "agent.yaml");
  const rejectedAugment = join(rejectedDir, "augments", "agentMail", "augment.yaml");
  const rejectedBefore = snapshotAgentMailFiles(rejectedDir, rejectedConfig, rejectedAugment);
  let rejectedError: unknown;
  try {
    await packedSetup.runAgentMailSetup(
      "agentMail",
      {
        config: rejectedConfig,
        mode: "manual",
        apiKey: REJECTED_KEY,
        inboxId: INBOX_ID,
        baseUrl: provider.baseUrl,
        allowInsecureHttpWithCredentials: true,
      },
      { cwd: rejectedDir, interactive: false },
    );
  } catch (error) {
    rejectedError = error;
  }
  if (
    !(rejectedError instanceof Error) ||
    !/credential|permission|403/i.test(rejectedError.message)
  ) {
    throw new Error("packed manual setup did not fail clearly for a rejected supplied key");
  }
  assertNoCredentialOutput(rejectedError.message);
  if (
    !isDeepStrictEqual(
      rejectedBefore,
      snapshotAgentMailFiles(rejectedDir, rejectedConfig, rejectedAugment),
    )
  ) {
    throw new Error("failed packed manual setup changed local credentials or configuration");
  }

  assertReadOnlyProviderState(provider.state);
  console.log("packed AgentMail CLI setup contract passed");
} finally {
  await provider.close();
}

interface ReadOnlyProvider {
  baseUrl: string;
  close(): Promise<void>;
  state: {
    authReads: number;
    inboxReads: number;
    messageReads: number;
    draftReads: number;
    rejectedReads: number;
    mutations: number;
    violations: string[];
  };
}

async function startReadOnlyProvider(): Promise<ReadOnlyProvider> {
  const state: ReadOnlyProvider["state"] = {
    authReads: 0,
    inboxReads: 0,
    messageReads: 0,
    draftReads: 0,
    rejectedReads: 0,
    mutations: 0,
    violations: [],
  };
  let server: Server | undefined;
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = createServer((request, response) => {
      handleReadOnlyRequest(request, response, state);
    });
    try {
      await listenOnLoopback(candidate, attempt === 0 ? 0 : fallbackStart + attempt - 1);
      server = candidate;
      break;
    } catch (error) {
      lastError = error;
      candidate.close();
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  if (!server) throw lastError;
  const address = server.address();
  if (!address || typeof address === "string") {
    await closeServer(server);
    throw new Error("packed AgentMail provider did not acquire a TCP port");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    state,
    close: () => closeServer(server),
  };
}

function handleReadOnlyRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: ReadOnlyProvider["state"],
): void {
  const url = new URL(request.url ?? "/", "http://strict.local");
  if (request.method !== "GET") {
    state.mutations += 1;
    failContract(response, state, `provider mutation attempted: ${request.method ?? "UNKNOWN"}`);
    return;
  }

  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${REJECTED_KEY}`) {
    state.rejectedReads += 1;
    sendJson(response, 403, {
      name: "ForbiddenError",
      code: "missing_permission",
      message: "Forbidden",
    });
    return;
  }
  if (authorization !== `Bearer ${SUPPLIED_KEY}`) {
    failContract(response, state, "incorrect or missing bearer authorization");
    return;
  }

  if (url.pathname === "/v0/auth/me") {
    state.authReads += 1;
    sendJson(response, 200, {
      scope_type: "inbox",
      scope_id: INBOX_ID,
      organization_id: "org_packed",
      inbox_id: INBOX_ID,
      api_key_id: "key_packed",
    });
    return;
  }
  if (url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}`) {
    state.inboxReads += 1;
    sendJson(response, 200, {
      inbox_id: INBOX_ID,
      email: INBOX_EMAIL,
      display_name: "Packed AgentMail",
    });
    return;
  }
  if (url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages`) {
    state.messageReads += 1;
    if (url.searchParams.get("limit") !== "1") {
      failContract(response, state, "message permission probe must be bounded to one item");
      return;
    }
    sendJson(response, 200, { count: 0, messages: [] });
    return;
  }
  if (url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/drafts`) {
    state.draftReads += 1;
    if (url.searchParams.get("limit") !== "1") {
      failContract(response, state, "draft permission probe must be bounded to one item");
      return;
    }
    sendJson(response, 200, { count: 0, drafts: [] });
    return;
  }
  failContract(response, state, `unexpected GET ${url.pathname}`);
}

function assertReadOnlyProviderState(state: ReadOnlyProvider["state"]): void {
  if (
    state.authReads !== 3 ||
    state.inboxReads !== 3 ||
    state.messageReads !== 2 ||
    state.draftReads !== 2 ||
    // verifyAccess probes auth identity and the configured inbox concurrently.
    // Depending on request cancellation timing, the strict mock observes one
    // or both rejected reads; either outcome must still fail before mutation.
    state.rejectedReads < 1 ||
    state.rejectedReads > 2 ||
    state.mutations !== 0 ||
    state.violations.length > 0
  ) {
    throw new Error(
      `packed AgentMail setup violated the read-only provider contract: ${JSON.stringify(state)}`,
    );
  }
}

function enableInboundReview(path: string): void {
  const value = parseYaml(readFileSync(path, "utf8")) as Record<string, unknown>;
  const config = value.config as Record<string, unknown>;
  config.inbound = {
    mode: "websocket",
    allowAnySender: true,
    rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
  };
  config.replies = { mode: "review", allowReplyAll: false };
  writeFileSync(path, stringifyYaml(value));
}

function configureReadOnlyDoctorFixture(
  configPath: string,
  agentMailPath: string,
  providerBaseUrl: string,
): void {
  const agent = parseYaml(readFileSync(configPath, "utf8")) as Record<string, unknown>;
  agent.augments = (agent.augments as unknown[]).filter((augment) => augment !== "visitorAuth");
  writeFileSync(configPath, stringifyYaml(agent));

  const augment = parseYaml(readFileSync(agentMailPath, "utf8")) as Record<string, unknown>;
  const config = augment.config as Record<string, unknown>;
  delete config.inbound;
  delete config.replies;
  config.apiBaseUrl = providerBaseUrl;
  config.allowInsecureHttpWithCredentials = true;
  writeFileSync(agentMailPath, stringifyYaml(augment));
}

function assertPermissionEvidence(result: {
  requiredPermissions?: string[];
  verifiedPermissions?: string[];
}): void {
  for (const permission of ["inbox_read", "message_read", "draft_read"]) {
    if (!result.verifiedPermissions?.includes(permission)) {
      throw new Error(`packed setup did not verify ${permission}`);
    }
  }
  for (const permission of [
    "inbox_read",
    "message_send",
    "message_read",
    "draft_read",
    "draft_create",
    "draft_update",
    "draft_send",
  ]) {
    if (!result.requiredPermissions?.includes(permission)) {
      throw new Error(`packed setup did not report required permission ${permission}`);
    }
  }
}

function assertConfiguredEnv(source: string): void {
  for (const expected of [
    `AGENTMAIL_API_KEY=${SUPPLIED_KEY}`,
    `AGENTMAIL_INBOX_ID=${INBOX_ID}`,
    `AGENTMAIL_INBOX_EMAIL=${INBOX_EMAIL}`,
  ]) {
    if (!source.split("\n").includes(expected)) {
      throw new Error(`packed AgentMail setup did not persist ${expected.split("=")[0]}`);
    }
  }
  if (
    source.split("\n").filter((line) => line.startsWith("AGENTMAIL_API_KEY=")).length !== 1 ||
    source.includes("AGENTMAIL_ACCOUNT_API_KEY") ||
    source.includes("AGENTMAIL_PARENT_API_KEY")
  ) {
    throw new Error("packed AgentMail setup did not persist one canonical supplied-key binding");
  }
}

function assertAgentMailYaml(source: string): void {
  for (const expected of [
    "type: agentMail",
    "apiKey: ${AGENTMAIL_API_KEY}",
    "inboxId: ${AGENTMAIL_INBOX_ID}",
    "emailAddress: ${AGENTMAIL_INBOX_EMAIL}",
    "mode: websocket",
    "allowAnySender: true",
    "mode: review",
    'subjectPrefix: "[Auggy] "',
  ]) {
    if (!source.includes(expected)) {
      throw new Error(`packed AgentMail setup did not preserve canonical policy: ${expected}`);
    }
  }
}

function assertVisitorAuthYaml(source: string): void {
  for (const expected of [
    "type: visitorAuth",
    "transport: agentmail",
    "apiKey: ${AGENTMAIL_API_KEY}",
    "inboxId: ${AGENTMAIL_INBOX_ID}",
  ]) {
    if (!source.includes(expected)) {
      throw new Error(`packed visitorAuth setup did not reuse shared credentials: ${expected}`);
    }
  }
}

function snapshotConfiguredFiles(
  root: string,
  configPath: string,
  agentMailPath: string,
  visitorAuthPath: string,
): { env: string; agent: string; agentMail: string; visitorAuth: string } {
  return {
    env: readFileSync(join(root, ".env"), "utf8"),
    agent: readFileSync(configPath, "utf8"),
    agentMail: readFileSync(agentMailPath, "utf8"),
    visitorAuth: readFileSync(visitorAuthPath, "utf8"),
  };
}

function snapshotAgentMailFiles(
  root: string,
  configPath: string,
  agentMailPath: string,
): { env: string; agent: string; agentMail: string } {
  return {
    env: readFileSync(join(root, ".env"), "utf8"),
    agent: readFileSync(configPath, "utf8"),
    agentMail: readFileSync(agentMailPath, "utf8"),
  };
}

function writeAgentFixture(dir: string, name: string): void {
  writeFileSync(
    join(dir, "agent.yaml"),
    [
      `id: ${AGENT_ID}`,
      `name: ${name}`,
      "engine:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "augments: []",
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "package.json"),
    `${JSON.stringify({ name: `${name}-consumer`, private: true, type: "module" }, null, 2)}\n`,
  );
  writeFileSync(join(dir, ".env"), "ANTHROPIC_API_KEY=smoke-not-real\n");
}

async function installPackedAgentDependencies(): Promise<void> {
  const child = Bun.spawn(
    ["bun", "add", "--offline", "--no-summary", packedTarball, packedEngineTarball],
    {
      cwd: consumerDir,
      env: { ...process.env, HOME: smokeHome },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`could not install packed AgentMail fixture dependencies:\n${stdout}${stderr}`);
  }
}

async function captureConsoleOutput(action: () => Promise<void>): Promise<string> {
  const lines: string[] = [];
  const originalLog = console.log;
  const originalError = console.error;
  console.log = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  console.error = (...args: unknown[]) => lines.push(args.map(String).join(" "));
  try {
    await action();
  } finally {
    console.log = originalLog;
    console.error = originalError;
  }
  return lines.join("\n");
}

function assertNoCredentialOutput(output: string): void {
  for (const credential of [SUPPLIED_KEY, REJECTED_KEY]) {
    if (output.includes(credential)) {
      throw new Error("packed AgentMail setup printed an AgentMail credential");
    }
  }
}

function failContract(
  response: ServerResponse,
  state: ReadOnlyProvider["state"],
  message: string,
): void {
  state.violations.push(message);
  sendJson(response, 422, { code: "strict_contract_violation" });
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  if (response.headersSent) return;
  response.statusCode = status;
  response.setHeader("content-type", "application/json");
  response.end(JSON.stringify(value));
}

function listenOnLoopback(server: Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(port, "127.0.0.1");
  });
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
  cwd = consumerDir,
): Promise<{ exitCode: number; output: string }> {
  const env = { ...process.env, HOME: smokeHome, ...envOverrides };
  delete env.AGENTMAIL_ACCOUNT_API_KEY;
  delete env.AGENTMAIL_API_KEY;
  delete env.AGENTMAIL_INBOX_ID;
  delete env.AGENTMAIL_INBOX_EMAIL;
  Object.assign(env, envOverrides);
  const child = Bun.spawn([cliPath, ...args], {
    cwd,
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  return { exitCode, output: `${stdout}${stderr}` };
}
