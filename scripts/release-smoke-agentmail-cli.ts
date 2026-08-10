import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";

const ACCOUNT_KEY = "am_packed_parent_not_real";
const RUNTIME_KEY = "am_packed_runtime_not_real";
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
writeFileSync(
  join(consumerDir, "agent.yaml"),
  [
    `id: ${AGENT_ID}`,
    "name: packed-agentmail",
    "engine:",
    "  provider: anthropic",
    "  model: claude-sonnet-4-6",
    "augments: []",
    "",
  ].join("\n"),
);
writeFileSync(
  join(consumerDir, "package.json"),
  `${JSON.stringify({ name: "packed-agentmail-consumer", private: true, type: "module" }, null, 2)}\n`,
);
writeFileSync(join(consumerDir, ".env"), "ANTHROPIC_API_KEY=smoke-not-real\n");

const add = await runCli(["augment", "add", "agentmail", "--skip-install", "--yes"]);
if (add.exitCode !== 0) {
  throw new Error(`packed CLI could not add lowercase agentmail:\n${add.output}`);
}
const agentYaml = readFileSync(join(consumerDir, "agent.yaml"), "utf8");
const augmentYaml = join(consumerDir, "augments", "agentMail", "augment.yaml");
if (!agentYaml.includes("  - agentMail") || agentYaml.includes("  - agentmail")) {
  throw new Error("packed CLI did not canonicalize lowercase agentmail in agent.yaml");
}
if (!existsSync(augmentYaml) || !readFileSync(augmentYaml, "utf8").startsWith("type: agentMail")) {
  throw new Error("packed CLI did not create canonical agentMail augment metadata");
}

// A deliberately invalid mode reaches Auggy's setup validation only after the
// optional target has been parsed and inferred from the canonical install. It
// cannot contact AgentMail or write credentials.
const setup = await runCli(["agentmail", "setup", "--mode", "packed-smoke-invalid"]);
if (setup.exitCode === 0 || !setup.output.includes("Invalid AgentMail setup mode")) {
  throw new Error(`packed optional AgentMail setup path did not execute:\n${setup.output}`);
}
if (setup.output.includes("missing required argument")) {
  throw new Error("packed AgentMail setup still requires an explicit target");
}

const addVisitorAuth = await runCli(["augment", "add", "visitorAuth", "--skip-install", "--yes"]);
if (addVisitorAuth.exitCode !== 0) {
  throw new Error(`packed CLI could not add visitorAuth:\n${addVisitorAuth.output}`);
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

const provider = await startStrictProvider();
try {
  const configured = await runCli(
    [
      "agentmail",
      "setup",
      "agentMail",
      "--mode",
      "existing",
      "--username",
      "packed-agentmail",
      "--display-name",
      "Packed AgentMail",
      "--base-url",
      provider.baseUrl,
    ],
    { AGENTMAIL_ACCOUNT_API_KEY: ACCOUNT_KEY },
  );
  if (configured.exitCode !== 0) {
    throw new Error(`packed successful AgentMail setup failed:\n${configured.output}`);
  }
  if (configured.output.includes(ACCOUNT_KEY) || configured.output.includes(RUNTIME_KEY)) {
    throw new Error("packed AgentMail setup printed a provisioning credential");
  }

  const callsAfterProvisioning = {
    inboxPosts: provider.state.inboxPosts,
    inboxResources: provider.state.inboxResources,
    keyPosts: provider.state.keyPosts,
  };
  const configuredVisitorAuth = await runCli([
    "agentmail",
    "setup",
    "visitorAuth",
    "--mode",
    "env",
  ]);
  if (configuredVisitorAuth.exitCode !== 0) {
    throw new Error(
      `packed shared visitorAuth credential reuse failed:\n${configuredVisitorAuth.output}`,
    );
  }
  if (
    configuredVisitorAuth.output.includes(ACCOUNT_KEY) ||
    configuredVisitorAuth.output.includes(RUNTIME_KEY)
  ) {
    throw new Error("packed shared visitorAuth setup printed a provisioning credential");
  }
  if (
    provider.state.inboxPosts !== callsAfterProvisioning.inboxPosts ||
    provider.state.inboxResources !== callsAfterProvisioning.inboxResources ||
    provider.state.keyPosts !== callsAfterProvisioning.keyPosts
  ) {
    throw new Error("packed visitorAuth env setup made an unexpected provider mutation");
  }
} finally {
  await provider.close();
}

if (
  provider.state.inboxPosts !== 1 ||
  provider.state.inboxResources !== 1 ||
  provider.state.keyPosts !== 1 ||
  provider.state.violations.length > 0
) {
  throw new Error(
    `packed AgentMail setup violated the strict provider contract: ${JSON.stringify(provider.state)}`,
  );
}

const configuredEnv = readFileSync(join(consumerDir, ".env"), "utf8");
for (const expected of [
  `AGENTMAIL_API_KEY=${RUNTIME_KEY}`,
  `AGENTMAIL_INBOX_ID=${INBOX_ID}`,
  `AGENTMAIL_INBOX_EMAIL=${INBOX_EMAIL}`,
]) {
  if (!configuredEnv.split("\n").includes(expected)) {
    throw new Error(`packed AgentMail setup did not persist ${expected.split("=")[0]}`);
  }
}
if (configuredEnv.includes(ACCOUNT_KEY) || configuredEnv.includes("AGENTMAIL_ACCOUNT_API_KEY")) {
  throw new Error("packed AgentMail setup persisted the account-level provisioning credential");
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
  "addressVisibility: public",
]) {
  if (!configuredAugment.includes(expected)) {
    throw new Error(`packed AgentMail setup did not commit canonical augment config: ${expected}`);
  }
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
    inboxResources: number;
    keyPosts: number;
    violations: string[];
  };
}

async function startStrictProvider(): Promise<StrictProvider> {
  const state: StrictProvider["state"] = {
    inboxPosts: 0,
    inboxResources: 0,
    keyPosts: 0,
    violations: [],
  };
  const inboxesByClientId = new Map<string, Record<string, unknown>>();
  let server: Server | undefined;
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const candidate = createServer((request, response) => {
      void handleStrictRequest(request, response, state, inboxesByClientId).catch((error) => {
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
  inboxesByClientId: Map<string, Record<string, unknown>>,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://strict.local").pathname;
  if (request.method === "POST" && path === "/v0/inboxes") {
    state.inboxPosts += 1;
    if (!requireBearer(request, response, ACCOUNT_KEY, state)) return;
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
    const existing = inboxesByClientId.get(CLIENT_ID);
    if (existing) {
      sendJson(response, 200, existing);
      return;
    }
    const inbox = {
      inbox_id: INBOX_ID,
      email: INBOX_EMAIL,
      display_name: "Packed AgentMail",
      client_id: CLIENT_ID,
    };
    inboxesByClientId.set(CLIENT_ID, inbox);
    state.inboxResources += 1;
    sendJson(response, 200, inbox);
    return;
  }

  if (request.method === "POST" && path === `/v0/inboxes/${INBOX_ID}/api-keys`) {
    state.keyPosts += 1;
    if (!requireBearer(request, response, ACCOUNT_KEY, state)) return;
    const body = await readJsonObject(request, response, state);
    if (
      !body ||
      !requireExactBody(
        body,
        {
          name: "packed-agentmail agentMail",
          permissions: { inbox_read: true, message_send: true },
        },
        response,
        state,
      )
    ) {
      return;
    }
    sendJson(response, 200, {
      api_key_id: "key_packed_runtime",
      api_key: RUNTIME_KEY,
      name: "packed-agentmail agentMail",
      inbox_id: INBOX_ID,
      permissions: { inbox_read: true, message_send: true },
    });
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

async function runCli(
  args: string[],
  envOverrides: Record<string, string> = {},
): Promise<{ exitCode: number; output: string }> {
  const env = { ...process.env, HOME: smokeHome, ...envOverrides };
  delete env.AGENTMAIL_ACCOUNT_API_KEY;
  delete env.AGENTMAIL_API_KEY;
  delete env.AGENTMAIL_INBOX_ID;
  delete env.AGENTMAIL_INBOX_EMAIL;
  Object.assign(env, envOverrides);
  const child = Bun.spawn([cliPath, ...args], {
    cwd: consumerDir,
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
