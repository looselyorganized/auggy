import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const SUPPLIED_KEY = "am_packed_supplied_not_real";
const REPLACEMENT_KEY = "am_packed_replacement_not_real";
const REJECTED_REPLACEMENT_KEY = "am_packed_rejected_replacement_not_real";
const AGENT_ID = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
const CLIENT_ID = `auggy.v1.inbox.${AGENT_ID}.agentMail`;
const INBOX_ID = "inb_packed_agentmail";
const INBOX_EMAIL = "packed-agentmail@agentmail.to";

const [cliPath, packedRoot, consumerDir, smokeHome] = process.argv.slice(2);
if (!cliPath || !packedRoot || !consumerDir || !smokeHome) {
  throw new Error(
    "usage: release-smoke-agentmail-cli.ts <cli> <packed-root> <consumer-dir> <home>",
  );
}

mkdirSync(consumerDir, { recursive: true });
writeAgentFixture(consumerDir, "packed-agentmail");

// Preserve the packed optional-target command contract in an isolated fixture.
// The main fixture below must remain empty so one combined add exercises the
// actual shared post-add orchestrator from the packed artifact.
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

// A deliberately invalid mode reaches Auggy's setup validation only after the
// optional target has been inferred. It cannot contact AgentMail or write
// credentials.
const setup = await runCli(
  ["agentmail", "setup", "--mode", "packed-smoke-invalid"],
  {},
  optionalTargetDir,
);
if (setup.exitCode === 0 || !setup.output.includes("Invalid AgentMail setup mode")) {
  throw new Error(`packed optional AgentMail setup path did not execute:\n${setup.output}`);
}
if (setup.output.includes("missing required argument")) {
  throw new Error("packed AgentMail setup still requires an explicit target");
}

const provider = await startStrictProvider();
let combinedOutput = "";
const setupTargets: string[] = [];
const setupConfirmations: string[] = [];
const reuseConfirmations: string[] = [];
let callsBeforeVisitorAuth: StrictProvider["state"] | undefined;
try {
  const addPath = join(packedRoot, "src", "cli", "commands", "add.ts");
  const setupPath = join(packedRoot, "src", "cli", "commands", "agentmail.ts");
  const packedAdd = await import(pathToFileURL(addPath).href);
  const packedSetup = await import(pathToFileURL(setupPath).href);
  combinedOutput = await captureConsoleOutput(async () => {
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
        deps: Record<string, unknown>,
      ) => {
        setupTargets.push(`${target}:${String(options.mode ?? "interactive")}`);
        if (target === "visitorAuth") {
          callsBeforeVisitorAuth = {
            ...provider.state,
            violations: [...provider.state.violations],
          };
        }
        const result = await packedSetup.runAgentMailSetup(
          target,
          target === "agentMail"
            ? {
                ...options,
                mode: "existing",
                apiKey: SUPPLIED_KEY,
                username: "packed-agentmail",
                displayName: "Packed AgentMail",
                baseUrl: provider.baseUrl,
              }
            : { ...options, baseUrl: provider.baseUrl },
          {
            ...deps,
            cwd: consumerDir,
            interactive: true,
            promptConfirm: async (prompt: { message: string }) => {
              reuseConfirmations.push(prompt.message);
              return true;
            },
            promptInput: async () => {
              throw new Error("packed shared setup unexpectedly requested text input");
            },
            promptPassword: async () => {
              throw new Error("packed shared setup unexpectedly requested a credential");
            },
            promptSelect: async () => {
              throw new Error("packed shared setup unexpectedly requested a mode");
            },
          },
        );
        if (target === "visitorAuth" && callsBeforeVisitorAuth) {
          assertVisitorAuthReadinessOnly(provider.state, callsBeforeVisitorAuth);
        }
        return result;
      },
    });
  });
} finally {
  await provider.close();
}

if (combinedOutput.includes(SUPPLIED_KEY)) {
  throw new Error("packed shared add printed the supplied AgentMail credential");
}
for (const staleClaim of ["scoped runtime key", "child API key", "new runtime key"]) {
  if (combinedOutput.toLowerCase().includes(staleClaim.toLowerCase())) {
    throw new Error(`packed shared add emitted a stale key-lifecycle claim: ${staleClaim}`);
  }
}
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
if (
  reuseConfirmations.length !== 1 ||
  !reuseConfirmations[0]?.includes("already belongs to this Auggy agent")
) {
  throw new Error("packed resource_taken recovery did not require explicit owned-inbox reuse");
}
if ((combinedOutput.match(/Apply changes:/g) ?? []).length !== 1) {
  throw new Error(
    `packed shared add did not emit exactly one final apply block:\n${combinedOutput}`,
  );
}

const agentYaml = readFileSync(join(consumerDir, "agent.yaml"), "utf8");
const augmentYaml = join(consumerDir, "augments", "agentMail", "augment.yaml");
if (!agentYaml.includes("  - agentMail") || agentYaml.includes("  - agentmail")) {
  throw new Error("packed CLI did not canonicalize lowercase agentmail in agent.yaml");
}
if (!existsSync(augmentYaml) || !readFileSync(augmentYaml, "utf8").startsWith("type: agentMail")) {
  throw new Error("packed CLI did not create canonical agentMail augment metadata");
}

const sharedAgentYaml = readFileSync(join(consumerDir, "agent.yaml"), "utf8");
const visitorAuthYaml = join(consumerDir, "augments", "visitorAuth", "augment.yaml");
if (
  !sharedAgentYaml.includes("  - agentMail") ||
  !sharedAgentYaml.includes("  - visitorAuth") ||
  !existsSync(visitorAuthYaml) ||
  !readFileSync(visitorAuthYaml, "utf8").startsWith("type: visitorAuth")
) {
  throw new Error("packed CLI did not install both canonical shared AgentMail consumers");
}

if (
  provider.state.inboxPosts !== 1 ||
  provider.state.inboxLists !== 1 ||
  provider.state.inboxResources !== 2 ||
  provider.state.replacementInboxReads !== 0 ||
  provider.state.rejectedReplacementReads !== 0 ||
  provider.state.apiKeyRequests !== 0 ||
  provider.state.violations.length > 0
) {
  throw new Error(
    `packed AgentMail setup violated the strict provider contract: ${JSON.stringify(provider.state)}`,
  );
}

const configuredEnv = readFileSync(join(consumerDir, ".env"), "utf8");
for (const expected of [
  `AGENTMAIL_API_KEY=${SUPPLIED_KEY}`,
  `AGENTMAIL_INBOX_ID=${INBOX_ID}`,
  `AGENTMAIL_INBOX_EMAIL=${INBOX_EMAIL}`,
]) {
  if (!configuredEnv.split("\n").includes(expected)) {
    throw new Error(`packed AgentMail setup did not persist ${expected.split("=")[0]}`);
  }
}
if (
  configuredEnv.split("\n").filter((line) => line.startsWith("AGENTMAIL_API_KEY=")).length !== 1 ||
  configuredEnv.includes("AGENTMAIL_ACCOUNT_API_KEY") ||
  configuredEnv.includes("AGENTMAIL_PARENT_API_KEY")
) {
  throw new Error("packed AgentMail setup did not persist one canonical supplied-key binding");
}

const configuredVisitorAuth = readFileSync(visitorAuthYaml, "utf8");
for (const expected of [
  "type: visitorAuth",
  "transport: agentmail",
  "apiKey: ${AGENTMAIL_API_KEY}",
  "inboxId: ${AGENTMAIL_INBOX_ID}",
  "perHour: 1",
  "perDay: 3",
]) {
  if (!configuredVisitorAuth.includes(expected)) {
    throw new Error(`packed visitorAuth setup did not reuse shared credentials: ${expected}`);
  }
}

const configuredAugment = readFileSync(augmentYaml, "utf8");
for (const expected of [
  "type: agentMail",
  "apiKey: ${AGENTMAIL_API_KEY}",
  "inboxId: ${AGENTMAIL_INBOX_ID}",
  "emailAddress: ${AGENTMAIL_INBOX_EMAIL}",
  "addressVisibility: creator",
]) {
  if (!configuredAugment.includes(expected)) {
    throw new Error(`packed AgentMail setup did not commit canonical augment config: ${expected}`);
  }
}

const replacementProvider = await startStrictProvider();
const configPath = join(consumerDir, "agent.yaml");
const beforeReplacement = snapshotConfiguredFiles(
  consumerDir,
  configPath,
  augmentYaml,
  visitorAuthYaml,
);
try {
  const replacement = await runCli(
    [
      "agentmail",
      "setup",
      "agentMail",
      "--config",
      configPath,
      "--mode",
      "manual",
      "--replace-key",
      "--yes",
      "--base-url",
      replacementProvider.baseUrl,
    ],
    { AGENTMAIL_API_KEY: REPLACEMENT_KEY },
  );
  if (replacement.exitCode !== 0) {
    throw new Error(`packed direct AgentMail key replacement failed:\n${replacement.output}`);
  }
  assertNoCredentialOutput(replacement.output);

  const afterReplacement = snapshotConfiguredFiles(
    consumerDir,
    configPath,
    augmentYaml,
    visitorAuthYaml,
  );
  const expectedEnv = replaceExactEnvValue(
    beforeReplacement.env,
    "AGENTMAIL_API_KEY",
    REPLACEMENT_KEY,
  );
  if (afterReplacement.env !== expectedEnv) {
    throw new Error("packed direct replacement changed more than the stored AgentMail API key");
  }
  assertIdentityFilesUnchanged(beforeReplacement, afterReplacement, "successful replacement");
  assertReplacementProviderState(replacementProvider.state, {
    inboxResources: 1,
    replacementInboxReads: 1,
    rejectedReplacementReads: 0,
    operation: "successful replacement",
  });

  const rejected = await runCli(
    [
      "agentmail",
      "setup",
      "agentMail",
      "--config",
      configPath,
      "--mode",
      "manual",
      "--replace-key",
      "--yes",
      "--base-url",
      replacementProvider.baseUrl,
    ],
    { AGENTMAIL_API_KEY: REJECTED_REPLACEMENT_KEY },
  );
  if (rejected.exitCode === 0 || !rejected.output.includes("403 missing_permission")) {
    throw new Error(
      `packed direct replacement did not fail closed on forbidden inbox access:\n${rejected.output}`,
    );
  }
  assertNoCredentialOutput(rejected.output);

  const afterRejectedReplacement = snapshotConfiguredFiles(
    consumerDir,
    configPath,
    augmentYaml,
    visitorAuthYaml,
  );
  if (afterRejectedReplacement.env !== afterReplacement.env) {
    throw new Error("failed packed direct replacement changed the stored AgentMail API key");
  }
  assertIdentityFilesUnchanged(afterReplacement, afterRejectedReplacement, "failed replacement");
  assertReplacementProviderState(replacementProvider.state, {
    inboxResources: 2,
    replacementInboxReads: 1,
    rejectedReplacementReads: 1,
    operation: "failed replacement",
  });
} finally {
  await replacementProvider.close();
}

const provisioningPath = join(packedRoot, "src", "cli", "agentmail-provisioning.ts");
const provisioning = await import(pathToFileURL(provisioningPath).href);
const canonicalClientId = provisioning.buildAgentMailClientId(AGENT_ID, "agentMail");
if (canonicalClientId !== CLIENT_ID) {
  throw new Error(`packed CLI emitted an unexpected AgentMail client_id: ${canonicalClientId}`);
}

let providerCalls = 0;
const provisioningClient = provisioning.createAgentMailProvisioningClient({
  apiBaseUrl: "https://api.agentmail.to/v0",
  http: {
    post: async () => {
      providerCalls += 1;
      throw new Error("invalid client_id reached the provider transport");
    },
    get: async () => {
      providerCalls += 1;
      throw new Error("unexpected provider read");
    },
  },
});
let invalidClientIdRejected = false;
try {
  await provisioningClient.createInbox({
    apiKey: "packed-smoke-not-a-secret",
    username: "packed-agentmail",
    clientId: "auggy:invalid:client-id",
  });
} catch (error) {
  invalidClientIdRejected =
    error instanceof Error && error.message.includes("AgentMail client_id must be");
}
if (!invalidClientIdRejected || providerCalls !== 0) {
  throw new Error("packed CLI did not reject an invalid AgentMail client_id before transport");
}

interface StrictProvider {
  baseUrl: string;
  close(): Promise<void>;
  state: {
    inboxPosts: number;
    inboxLists: number;
    inboxResources: number;
    replacementInboxReads: number;
    rejectedReplacementReads: number;
    apiKeyRequests: number;
    violations: string[];
  };
}

async function startStrictProvider(): Promise<StrictProvider> {
  const state: StrictProvider["state"] = {
    inboxPosts: 0,
    inboxLists: 0,
    inboxResources: 0,
    replacementInboxReads: 0,
    rejectedReplacementReads: 0,
    apiKeyRequests: 0,
    violations: [],
  };
  let server: Server | undefined;
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = createServer((request, response) => {
      void handleStrictRequest(request, response, state).catch((error) => {
        state.violations.push(`handler failure: ${(error as Error).message}`);
        sendJson(response, 500, { code: "strict_server_failure" });
      });
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
    baseUrl: `http://127.0.0.1:${address.port}/v0`,
    state,
    close: () => closeServer(server),
  };
}

async function handleStrictRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: StrictProvider["state"],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://strict.local");
  const path = url.pathname;
  if (request.method === "POST" && path === "/v0/inboxes") {
    state.inboxPosts += 1;
    if (!requireBearer(request, response, SUPPLIED_KEY, state)) return;
    const body = await readJsonObject(request, response, state);
    if (!body) return;
    if (
      !requireExactBody(
        body,
        {
          username: "packed-agentmail",
          display_name: "Packed AgentMail",
          client_id: CLIENT_ID,
          metadata: {
            source: "auggy-cli",
            agent: "packed-agentmail",
            augment: "agentMail",
          },
        },
        response,
        state,
      )
    ) {
      return;
    }
    sendJson(response, 403, {
      name: "ResourceTakenError",
      code: "resource_taken",
      message: "Inbox is taken",
    });
    return;
  }

  if (request.method === "GET" && path === "/v0/inboxes") {
    state.inboxLists += 1;
    if (!requireBearer(request, response, SUPPLIED_KEY, state)) return;
    if (url.search !== "?limit=100") {
      failContract(response, state, "inbox ownership lookup must use the bounded first page");
      return;
    }
    sendJson(response, 200, {
      inboxes: [
        {
          inbox_id: INBOX_ID,
          email: INBOX_EMAIL,
          display_name: "Packed AgentMail",
          client_id: CLIENT_ID,
        },
      ],
    });
    return;
  }

  if (request.method === "GET" && path === `/v0/inboxes/${INBOX_ID}`) {
    state.inboxResources += 1;
    const authorization = request.headers.authorization;
    if (authorization === `Bearer ${REPLACEMENT_KEY}`) {
      state.replacementInboxReads += 1;
    } else if (authorization === `Bearer ${REJECTED_REPLACEMENT_KEY}`) {
      state.rejectedReplacementReads += 1;
      sendJson(response, 403, {
        name: "ForbiddenError",
        code: "missing_permission",
        message: "Forbidden",
      });
      return;
    } else if (authorization !== `Bearer ${SUPPLIED_KEY}`) {
      failContract(response, state, "incorrect or missing bearer authorization");
      return;
    }
    sendJson(response, 200, {
      inbox_id: INBOX_ID,
      email: INBOX_EMAIL,
      display_name: "Packed AgentMail",
      client_id: CLIENT_ID,
    });
    return;
  }

  if (path.includes("/api-keys")) {
    state.apiKeyRequests += 1;
    failContract(response, state, "Auggy must not create, narrow, or rotate AgentMail API keys");
    return;
  }

  failContract(response, state, `unexpected ${request.method ?? "UNKNOWN"} request`);
}

function requireBearer(
  request: IncomingMessage,
  response: ServerResponse,
  expected: string,
  state: StrictProvider["state"],
): boolean {
  if (request.headers.authorization === `Bearer ${expected}`) return true;
  failContract(response, state, "incorrect or missing bearer authorization");
  return false;
}

async function readJsonObject(
  request: IncomingMessage,
  response: ServerResponse,
  state: StrictProvider["state"],
): Promise<Record<string, unknown> | null> {
  if (request.headers["content-type"] !== "application/json") {
    failContract(response, state, "content-type must be exactly application/json");
    return null;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 64 * 1024) {
      failContract(response, state, "request body exceeded 64 KiB");
      return null;
    }
    chunks.push(buffer);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as Record<string, unknown>;
  } catch {
    failContract(response, state, "request body must be a JSON object");
    return null;
  }
}

function requireExactBody(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  response: ServerResponse,
  state: StrictProvider["state"],
): boolean {
  if (isDeepStrictEqual(actual, expected)) return true;
  failContract(response, state, "request body did not match exact provider schema");
  return false;
}

function failContract(
  response: ServerResponse,
  state: StrictProvider["state"],
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

function assertVisitorAuthReadinessOnly(
  current: StrictProvider["state"],
  expected: StrictProvider["state"],
): void {
  if (
    current.inboxResources !== expected.inboxResources + 1 ||
    current.inboxPosts !== expected.inboxPosts ||
    current.inboxLists !== expected.inboxLists ||
    current.replacementInboxReads !== expected.replacementInboxReads ||
    current.rejectedReplacementReads !== expected.rejectedReplacementReads ||
    current.apiKeyRequests !== expected.apiKeyRequests ||
    !isDeepStrictEqual(current.violations, expected.violations)
  ) {
    throw new Error(
      `packed visitorAuth env setup did more than verify the shared inbox: ${JSON.stringify(current)}`,
    );
  }
}

function snapshotConfiguredFiles(
  consumerRoot: string,
  configPath: string,
  agentMailPath: string,
  visitorAuthPath: string,
): { env: string; agent: string; agentMail: string; visitorAuth: string } {
  return {
    env: readFileSync(join(consumerRoot, ".env"), "utf8"),
    agent: readFileSync(configPath, "utf8"),
    agentMail: readFileSync(agentMailPath, "utf8"),
    visitorAuth: readFileSync(visitorAuthPath, "utf8"),
  };
}

function replaceExactEnvValue(source: string, key: string, value: string): string {
  const pattern = new RegExp(`^${key}=.*$`, "gm");
  const matches = source.match(pattern) ?? [];
  if (matches.length !== 1) {
    throw new Error(`packed replacement expected exactly one ${key} binding`);
  }
  return source.replace(pattern, `${key}=${value}`);
}

function assertIdentityFilesUnchanged(
  before: { agent: string; agentMail: string; visitorAuth: string },
  after: { agent: string; agentMail: string; visitorAuth: string },
  operation: string,
): void {
  if (
    before.agent !== after.agent ||
    before.agentMail !== after.agentMail ||
    before.visitorAuth !== after.visitorAuth
  ) {
    throw new Error(`packed direct ${operation} changed AgentMail inbox identity or augment YAML`);
  }
}

function assertReplacementProviderState(
  state: StrictProvider["state"],
  expected: {
    inboxResources: number;
    replacementInboxReads: number;
    rejectedReplacementReads: number;
    operation: string;
  },
): void {
  if (
    state.inboxPosts !== 0 ||
    state.inboxLists !== 0 ||
    state.inboxResources !== expected.inboxResources ||
    state.replacementInboxReads !== expected.replacementInboxReads ||
    state.rejectedReplacementReads !== expected.rejectedReplacementReads ||
    state.apiKeyRequests !== 0 ||
    state.violations.length > 0
  ) {
    throw new Error(
      `packed direct ${expected.operation} violated the strict provider contract: ${JSON.stringify(state)}`,
    );
  }
}

function assertNoCredentialOutput(output: string): void {
  for (const credential of [SUPPLIED_KEY, REPLACEMENT_KEY, REJECTED_REPLACEMENT_KEY]) {
    if (output.includes(credential)) {
      throw new Error("packed direct replacement printed an AgentMail credential");
    }
  }
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
