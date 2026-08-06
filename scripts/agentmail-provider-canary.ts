import {
  AgentMailProvisioningApiError,
  AgentMailProvisioningResponseError,
  AgentMailProvisioningTransportError,
  buildAgentMailClientId,
  createAgentMailProvisioningClient,
} from "../src/cli/agentmail-provisioning";

/**
 * Protected real-provider canary for the existing-account AgentMail flow.
 *
 * This identity is intentionally stable. The first approved run creates one
 * persistent canary inbox in the configured AgentMail account; later runs
 * reuse it through client_id idempotency. The canary never sends mail and
 * never creates a scoped runtime key because the provisioning client has no
 * verified key-deletion contract.
 */
const CANARY_AGENT_ID = "aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab";
const CANARY_TARGET = "agentMail" as const;
const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";
const CANARY_USERNAME = "auggy-release-canary-7d2c91f4";
const CANARY_DISPLAY_NAME = "Auggy release provider canary";
const ACCOUNT_KEY_ENV = "AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY";

class AgentMailCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMailCanaryError";
  }
}

export async function runAgentMailProviderCanary(): Promise<void> {
  const accountApiKey = readAccountApiKey();
  const derivedClientId = buildAgentMailClientId(CANARY_AGENT_ID, CANARY_TARGET);
  if (derivedClientId !== CANARY_CLIENT_ID) {
    throw new AgentMailCanaryError(
      "The AgentMail client_id contract changed; refusing to create another persistent canary inbox.",
    );
  }
  const provisioner = createAgentMailProvisioningClient();
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

  console.log("AgentMail provider canary passed: stable client_id reused one inbox.");
  console.log("No mail was sent and no scoped runtime key was created.");
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
