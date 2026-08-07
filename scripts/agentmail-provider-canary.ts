import {
  AgentMailProvisioningApiError,
  AgentMailProvisioningResponseError,
  AgentMailProvisioningTransportError,
  buildAgentMailClientId,
  createAgentMailProvisioningClient,
  type AgentMailProvisioningClient,
} from "../src/cli/agentmail-provisioning";
import { AgentMailClient as SdkAgentMailClient } from "agentmail";

/**
 * Protected real-provider canary for the existing-account AgentMail flow.
 *
 * This identity is intentionally stable. The first approved run creates one
 * persistent canary inbox in the configured AgentMail account; later runs
 * reuse it through client_id idempotency. Each run also creates one disposable
 * inbox-scoped runtime key, validates the same response boundary used by CLI
 * setup, and reconciles all reserved canary keys through the official SDK.
 * The canary never sends mail or retains a runtime key intentionally.
 */
const CANARY_AGENT_ID = "aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab";
const CANARY_TARGET = "agentMail" as const;
const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";
const CANARY_USERNAME = "auggy-release-canary-7d2c91f4";
const CANARY_EMAIL = "auggy-release-canary-7d2c91f4@agentmail.to";
const CANARY_DISPLAY_NAME = "Auggy release provider canary";
const ACCOUNT_KEY_ENV = "AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY";
const RUN_ID_ENV = "GITHUB_RUN_ID";
const CANARY_KEY_PREFIX = "auggy-release-canary-scoped-key-";
const CANARY_KEY_PERMISSIONS = { inbox_read: true, message_send: true } as const;
const CANARY_KEY_LIST_LIMIT = 100;
const CANARY_KEY_LIST_MAX_PAGES = 3;
const CANARY_KEY_MAX_RECONCILE = 8;

interface ListedCanaryKey {
  apiKeyId: string;
  name: string;
}

interface CanaryKeyPage {
  apiKeys: ListedCanaryKey[];
  nextPageToken?: string;
}

export interface AgentMailCanaryKeyAdmin {
  list(inboxId: string, pageToken?: string): Promise<CanaryKeyPage>;
  delete(inboxId: string, apiKeyId: string): Promise<void>;
}

export interface AgentMailCanaryDependencies {
  accountApiKey?: string;
  runId?: string;
  provisioner?: Pick<AgentMailProvisioningClient, "createInbox" | "createInboxApiKey">;
  keyAdmin?: AgentMailCanaryKeyAdmin;
}

class AgentMailCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMailCanaryError";
  }
}

export async function runAgentMailProviderCanary(
  dependencies: AgentMailCanaryDependencies = {},
): Promise<void> {
  const accountApiKey = dependencies.accountApiKey ?? readAccountApiKey();
  const keyName = canaryKeyName(dependencies.runId ?? readRunId());
  const derivedClientId = buildAgentMailClientId(CANARY_AGENT_ID, CANARY_TARGET);
  if (derivedClientId !== CANARY_CLIENT_ID) {
    throw new AgentMailCanaryError(
      "The AgentMail client_id contract changed; refusing to create another persistent canary inbox.",
    );
  }
  const provisioner = dependencies.provisioner ?? createAgentMailProvisioningClient();
  const keyAdmin = dependencies.keyAdmin ?? createOfficialKeyAdmin(accountApiKey);
  const request = {
    apiKey: accountApiKey,
    username: CANARY_USERNAME,
    displayName: CANARY_DISPLAY_NAME,
    clientId: CANARY_CLIENT_ID,
    metadata: {
      source: "auggy-provider-canary",
      agent: "release-canary",
      augment: CANARY_TARGET,
    },
  };

  // Sequential duplicate creates prove retry behavior without creating a
  // race. Do not log either response: inbox identifiers and addresses are not
  // needed in Actions output.
  const first = await provisioner.createInbox(request);
  const second = await provisioner.createInbox(request);

  if (first.inboxId !== second.inboxId) {
    throw new AgentMailCanaryError(
      "AgentMail returned different inboxes for the stable canary client_id.",
    );
  }
  if (first.email !== second.email) {
    throw new AgentMailCanaryError(
      "AgentMail returned different addresses for the stable canary client_id.",
    );
  }
  if (first.email !== CANARY_EMAIL) {
    throw new AgentMailCanaryError(
      "AgentMail returned an unexpected address for the fixed canary username.",
    );
  }

  await reconcileCanaryKeys(keyAdmin, first.inboxId);

  let createError: unknown;
  let createdKeyId: string | undefined;
  try {
    const created = await provisioner.createInboxApiKey({
      apiKey: accountApiKey,
      inboxId: first.inboxId,
      name: keyName,
      permissions: CANARY_KEY_PERMISSIONS,
    });
    createdKeyId = created.apiKeyId;
    if (created.name !== keyName) {
      throw new AgentMailCanaryError(
        "AgentMail returned an unexpected name for the disposable scoped key.",
      );
    }
  } catch (error) {
    createError = error;
  }

  try {
    await reconcileCanaryKeys(keyAdmin, first.inboxId, createdKeyId);
  } catch {
    throw new AgentMailCanaryError(
      createError === undefined
        ? "The scoped-key contract passed, but cleanup could not prove that every reserved canary key was deleted. Inspect the protected canary inbox before retrying."
        : "Scoped-key creation failed and cleanup could not prove that every reserved canary key was deleted. Inspect the protected canary inbox before retrying.",
    );
  }
  if (createError !== undefined) throw createError;

  console.log("AgentMail provider canary passed: stable client_id reused one inbox.");
  console.log("The disposable scoped-key contract passed and reserved canary keys were removed.");
  console.log("No mail was sent and no scoped runtime key was retained.");
}

function createOfficialKeyAdmin(accountApiKey: string): AgentMailCanaryKeyAdmin {
  const client = new SdkAgentMailClient({
    apiKey: accountApiKey,
    timeoutInSeconds: 15,
  });
  return {
    async list(inboxId, pageToken) {
      const response = await client.inboxes.apiKeys.list(inboxId, {
        limit: CANARY_KEY_LIST_LIMIT,
        ...(pageToken === undefined ? {} : { pageToken }),
      });
      if (!Array.isArray(response.apiKeys)) throw canaryKeyReconciliationError();
      const apiKeys = response.apiKeys.map((key) => {
        if (!safeToken(key.apiKeyId, 256) || !safeName(key.name)) {
          throw canaryKeyReconciliationError();
        }
        return { apiKeyId: key.apiKeyId, name: key.name };
      });
      const nextPageToken = response.nextPageToken;
      if (nextPageToken !== undefined && !safeToken(nextPageToken, 4_096)) {
        throw canaryKeyReconciliationError();
      }
      return {
        apiKeys,
        ...(nextPageToken === undefined ? {} : { nextPageToken }),
      };
    },
    async delete(inboxId, apiKeyId) {
      await client.inboxes.apiKeys.delete(inboxId, apiKeyId);
    },
  };
}

async function reconcileCanaryKeys(
  keyAdmin: AgentMailCanaryKeyAdmin,
  inboxId: string,
  knownCreatedKeyId?: string,
): Promise<void> {
  if (knownCreatedKeyId !== undefined) {
    try {
      await keyAdmin.delete(inboxId, knownCreatedKeyId);
    } catch {
      // Listing below is authoritative reconciliation after an ambiguous
      // delete. Do not expose provider response details or key identifiers.
    }
  }

  for (let pass = 0; pass < 2; pass += 1) {
    const reserved = await listReservedCanaryKeys(keyAdmin, inboxId);
    if (reserved.length === 0) return;
    for (const key of reserved) await keyAdmin.delete(inboxId, key.apiKeyId);
  }

  if ((await listReservedCanaryKeys(keyAdmin, inboxId)).length > 0) {
    throw canaryKeyReconciliationError();
  }
}

async function listReservedCanaryKeys(
  keyAdmin: AgentMailCanaryKeyAdmin,
  inboxId: string,
): Promise<ListedCanaryKey[]> {
  const reserved: ListedCanaryKey[] = [];
  const seenTokens = new Set<string>();
  let pageToken: string | undefined;

  for (let page = 0; page < CANARY_KEY_LIST_MAX_PAGES; page += 1) {
    const result = await keyAdmin.list(inboxId, pageToken);
    if (!Array.isArray(result.apiKeys)) throw canaryKeyReconciliationError();
    for (const key of result.apiKeys) {
      if (!safeToken(key.apiKeyId, 256) || !safeName(key.name)) {
        throw canaryKeyReconciliationError();
      }
      if (key.name.startsWith(CANARY_KEY_PREFIX)) {
        reserved.push(key);
        if (reserved.length > CANARY_KEY_MAX_RECONCILE) {
          throw canaryKeyReconciliationError();
        }
      }
    }
    if (result.nextPageToken === undefined) return reserved;
    if (!safeToken(result.nextPageToken, 4_096) || seenTokens.has(result.nextPageToken)) {
      throw canaryKeyReconciliationError();
    }
    seenTokens.add(result.nextPageToken);
    pageToken = result.nextPageToken;
  }
  throw canaryKeyReconciliationError();
}

function canaryKeyName(runId: string): string {
  if (!/^\d{1,32}$/.test(runId)) {
    throw new AgentMailCanaryError(`${RUN_ID_ENV} must be a 1-32 digit workflow run identity.`);
  }
  const name = `${CANARY_KEY_PREFIX}${runId}`;
  if (!safeName(name)) throw new AgentMailCanaryError("The scoped-key canary name is invalid.");
  return name;
}

function readRunId(): string {
  const value = process.env[RUN_ID_ENV]?.trim();
  if (!value) throw new AgentMailCanaryError(`${RUN_ID_ENV} is required for safe key recovery.`);
  return value;
}

function safeName(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 256 &&
    value === value.trim() &&
    !/[\p{Cc}\p{Cf}]/u.test(value)
  );
}

function safeToken(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    /^[\x21-\x7e]+$/.test(value)
  );
}

function canaryKeyReconciliationError(): AgentMailCanaryError {
  return new AgentMailCanaryError(
    "AgentMail scoped-key inventory was invalid or exceeded the bounded cleanup policy; reserved canary key cleanup could not be proven.",
  );
}

function readAccountApiKey(): string {
  const value = process.env[ACCOUNT_KEY_ENV]?.trim();
  if (!value) {
    throw new AgentMailCanaryError(
      `${ACCOUNT_KEY_ENV} is required from the protected GitHub Environment.`,
    );
  }
  if (value.length > 4_096 || /[\p{Cc}\p{Cf}]/u.test(value)) {
    throw new AgentMailCanaryError(`${ACCOUNT_KEY_ENV} is malformed.`);
  }
  return value;
}

function safeCanaryFailure(error: unknown): string {
  if (error instanceof AgentMailProvisioningApiError) {
    return `AgentMail ${error.operation} failed with HTTP ${error.status}.`;
  }
  if (
    error instanceof AgentMailCanaryError ||
    error instanceof AgentMailProvisioningResponseError ||
    error instanceof AgentMailProvisioningTransportError
  ) {
    return error.message;
  }
  return "Unexpected failure; details were suppressed to protect provider credentials and responses.";
}

if (import.meta.main) {
  try {
    await runAgentMailProviderCanary();
  } catch (error) {
    console.error(`AgentMail provider canary failed: ${safeCanaryFailure(error)}`);
    process.exitCode = 1;
  }
}
