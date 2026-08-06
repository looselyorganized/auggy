import { describe, expect, test } from "bun:test";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { isDeepStrictEqual } from "node:util";
import {
  AgentMailProvisioningApiError,
  AgentMailProvisioningResponseError,
  buildAgentMailClientId,
  buildAgentMailRuntimeKeyPermissions,
  createAgentMailProvisioningClient,
} from "../../src/cli/agentmail-provisioning";

const PARENT_KEY = "am_parent_contract_secret";
const RUNTIME_KEY = "am_runtime_scoped_secret";
const AGENT_ID = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";
const CLIENT_ID = buildAgentMailClientId(AGENT_ID, "agentMail");
const CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,256}$/;

interface StrictServer {
  baseUrl: string;
  close(): Promise<void>;
  state: {
    inboxPosts: number;
    inboxResources: number;
    keyPosts: number;
    violations: string[];
  };
}

describe("AgentMail provisioning strict local provider contract", () => {
  test("uses exact authenticated schemas and preserves inbox idempotency", async () => {
    const provider = await startStrictServer();
    try {
      const client = createAgentMailProvisioningClient({ apiBaseUrl: provider.baseUrl });
      const input = {
        apiKey: PARENT_KEY,
        username: "test-agent",
        displayName: "Test Agent",
        clientId: CLIENT_ID,
        metadata: {
          source: "auggy-cli",
          agent: "test-agent",
          augment: "agentMail",
        },
      };

      const first = await client.createInbox(input);
      const retry = await client.createInbox(input);

      expect(first).toEqual({
        inboxId: "inb_test_agent",
        email: "test-agent@agentmail.to",
        displayName: "Test Agent",
      });
      expect(retry).toEqual(first);
      expect(provider.state.inboxPosts).toBe(2);
      expect(provider.state.inboxResources).toBe(1);

      const permissions = buildAgentMailRuntimeKeyPermissions({ inboundEnabled: false });
      const runtimeKey = await client.createInboxApiKey({
        apiKey: PARENT_KEY,
        inboxId: first.inboxId,
        name: "test-agent agentMail",
        permissions,
      });
      expect(runtimeKey).toEqual({
        apiKeyId: "key_runtime",
        apiKey: RUNTIME_KEY,
        name: "test-agent agentMail",
      });
      expect(permissions).toEqual({ inbox_read: true, message_send: true });
      expect(provider.state.keyPosts).toBe(1);

      await expect(client.getInbox(RUNTIME_KEY, first.inboxId)).resolves.toEqual(first);
      expect(provider.state.violations).toEqual([]);
    } finally {
      await provider.close();
    }
  });

  test("keeps malformed successes and provider failures typed and secret-safe", async () => {
    const provider = await startStrictServer();
    try {
      const client = createAgentMailProvisioningClient({ apiBaseUrl: provider.baseUrl });
      const malformed = await rejection(
        client.createInbox({
          apiKey: PARENT_KEY,
          username: "malformed-response",
          clientId: buildAgentMailClientId(AGENT_ID, "visitorAuth"),
        }),
      );
      expect(malformed).toBeInstanceOf(AgentMailProvisioningResponseError);
      expect(String(malformed)).not.toContain("am_response_secret");
      expect(malformed).not.toHaveProperty("body");

      const rejected = await rejection(
        client.createInbox({
          apiKey: PARENT_KEY,
          username: "rejected",
          clientId: buildAgentMailClientId(AGENT_ID, "visitorAuth"),
        }),
      );
      expect(rejected).toBeInstanceOf(AgentMailProvisioningApiError);
      expect(rejected).toMatchObject({
        status: 400,
        operation: "/inboxes",
        providerCode: "validation_error",
      });
      expect(String(rejected)).not.toContain(PARENT_KEY);
      expect(String(rejected)).not.toContain("\u001b");
      expect(rejected).not.toHaveProperty("body");
      expect(provider.state.violations).toEqual([]);
    } finally {
      await provider.close();
    }
  });
});

async function startStrictServer(): Promise<StrictServer> {
  const state = {
    inboxPosts: 0,
    inboxResources: 0,
    keyPosts: 0,
    violations: [] as string[],
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
      await new Promise<void>((resolve, reject) => {
        candidate.once("error", reject);
        candidate.listen(attempt === 0 ? 0 : fallbackStart + attempt - 1, "127.0.0.1", resolve);
      });
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
    await new Promise<void>((resolve) => server.close(() => resolve()));
    throw new Error("Strict AgentMail test server did not acquire a TCP port.");
  }
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v0`,
    state,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

async function handleStrictRequest(
  request: IncomingMessage,
  response: ServerResponse,
  state: StrictServer["state"],
  inboxesByClientId: Map<string, Record<string, unknown>>,
): Promise<void> {
  const path = new URL(request.url ?? "/", "http://strict.local").pathname;

  if (request.method === "POST" && path === "/v0/inboxes") {
    state.inboxPosts += 1;
    if (!requireBearer(request, response, PARENT_KEY, state)) return;
    if (!requireJsonContentType(request, response, state)) return;
    const body = await readJsonObject(request, response, state);
    if (!body) return;
    const username = body.username;
    const clientId = body.client_id;
    if (typeof clientId !== "string" || !CLIENT_ID_RE.test(clientId)) {
      failContract(response, state, "createInbox requires a provider-valid client_id");
      return;
    }

    if (username === "malformed-response") {
      if (!requireExactBody(body, { username, client_id: clientId }, response, state)) return;
      sendJson(response, 200, {
        inbox_id: "inb_malformed",
        api_key: "am_response_secret",
      });
      return;
    }
    if (username === "rejected") {
      if (!requireExactBody(body, { username, client_id: clientId }, response, state)) return;
      sendJson(response, 400, {
        name: "ValidationError",
        code: "validation_error",
        message: `Rejected ${PARENT_KEY}\u001b[31m`,
        errors: [
          {
            code: "invalid_format",
            path: ["username"],
            message: `Invalid username for Bearer ${PARENT_KEY}\u001b[0m`,
          },
        ],
      });
      return;
    }

    const expected = {
      username: "test-agent",
      display_name: "Test Agent",
      client_id: CLIENT_ID,
      metadata: {
        source: "auggy-cli",
        agent: "test-agent",
        augment: "agentMail",
      },
    };
    if (!requireExactBody(body, expected, response, state)) return;

    const existing = inboxesByClientId.get(clientId);
    if (existing) {
      sendJson(response, 200, existing);
      return;
    }
    const inbox = {
      inbox_id: "inb_test_agent",
      email: "test-agent@agentmail.to",
      display_name: "Test Agent",
    };
    inboxesByClientId.set(clientId, inbox);
    state.inboxResources += 1;
    sendJson(response, 200, inbox);
    return;
  }

  if (request.method === "POST" && path === "/v0/inboxes/inb_test_agent/api-keys") {
    state.keyPosts += 1;
    if (!requireBearer(request, response, PARENT_KEY, state)) return;
    if (!requireJsonContentType(request, response, state)) return;
    const body = await readJsonObject(request, response, state);
    if (!body) return;
    if (
      !requireExactBody(
        body,
        {
          name: "test-agent agentMail",
          permissions: { inbox_read: true, message_send: true },
        },
        response,
        state,
      )
    ) {
      return;
    }
    sendJson(response, 200, {
      api_key_id: "key_runtime",
      api_key: RUNTIME_KEY,
      name: "test-agent agentMail",
    });
    return;
  }

  if (request.method === "GET" && path === "/v0/inboxes/inb_test_agent") {
    if (!requireBearer(request, response, RUNTIME_KEY, state)) return;
    sendJson(response, 200, {
      inbox_id: "inb_test_agent",
      email: "test-agent@agentmail.to",
      display_name: "Test Agent",
    });
    return;
  }

  failContract(response, state, `unexpected ${request.method ?? "UNKNOWN"} ${path}`);
}

function requireBearer(
  request: IncomingMessage,
  response: ServerResponse,
  expected: string,
  state: StrictServer["state"],
): boolean {
  if (request.headers.authorization === `Bearer ${expected}`) return true;
  failContract(response, state, "incorrect or missing bearer authorization");
  return false;
}

function requireJsonContentType(
  request: IncomingMessage,
  response: ServerResponse,
  state: StrictServer["state"],
): boolean {
  if (request.headers["content-type"] === "application/json") return true;
  failContract(response, state, "content-type must be exactly application/json");
  return false;
}

async function readJsonObject(
  request: IncomingMessage,
  response: ServerResponse,
  state: StrictServer["state"],
): Promise<Record<string, unknown> | null> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    failContract(response, state, "request body must be valid JSON");
    return null;
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    failContract(response, state, "request body must be a JSON object");
    return null;
  }
  return value as Record<string, unknown>;
}

function requireExactBody(
  actual: Record<string, unknown>,
  expected: Record<string, unknown>,
  response: ServerResponse,
  state: StrictServer["state"],
): boolean {
  if (isDeepStrictEqual(actual, expected)) return true;
  failContract(response, state, "request body did not match the exact provider schema");
  return false;
}

function failContract(
  response: ServerResponse,
  state: StrictServer["state"],
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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject.");
}
