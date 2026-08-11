import {
  AgentMailProvisioningApiError,
  AgentMailProvisioningResponseError,
  AgentMailProvisioningTransportError,
  buildAgentMailClientId,
  createAgentMailProvisioningClient,
  type AgentMailProvisioningClient,
} from "../src/cli/agentmail-provisioning";
import {
  AgentMailProviderRequestError,
  createAgentMailSdkAdapters,
  type AgentMailSdkAdapters,
  type AgentMailSdkProviderOptions,
} from "../src/augments/agentMail/sdk-provider";

/**
 * Protected real-provider canary for the existing-account AgentMail flow.
 *
 * This identity is intentionally stable. The first approved run creates one
 * persistent canary inbox in the configured AgentMail account; later runs
 * reuse it through client_id idempotency. Each run uses the protected supplied
 * key unchanged for the same inbox-create and account-inventory reads used by
 * CLI setup, then exercises the shipped runtime REST and WebSocket adapters.
 * The canary never sends mail or creates, lists, deletes, or replaces API keys.
 */
const CANARY_AGENT_ID = "aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab";
const CANARY_TARGET = "agentMail" as const;
const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";
const CANARY_USERNAME = "auggy-release-canary-7d2c91f4";
const CANARY_EMAIL = "auggy-release-canary-7d2c91f4@agentmail.to";
const CANARY_DISPLAY_NAME = "Auggy release provider canary";
const API_KEY_ENV = "AGENTMAIL_API_KEY";
const RUNTIME_EVENT_TYPES = ["message.received"] as const;
const SDK_TIMEOUT_MS = 15_000;
const RUNTIME_TIMEOUT_MS = 20_000;
const CLOSE_TIMEOUT_MS = 5_000;

export interface AgentMailCanaryDependencies {
  apiKey?: string;
  provisioner?: Pick<AgentMailProvisioningClient, "createInbox" | "listInboxes">;
  createSdkAdapters?: (options: AgentMailSdkProviderOptions) => AgentMailSdkAdapters;
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
  const apiKey = dependencies.apiKey ?? readApiKey();
  const derivedClientId = buildAgentMailClientId(CANARY_AGENT_ID, CANARY_TARGET);
  if (derivedClientId !== CANARY_CLIENT_ID) {
    throw new AgentMailCanaryError(
      "The AgentMail client_id contract changed; refusing to create another persistent canary inbox.",
    );
  }
  const provisioner = dependencies.provisioner ?? createAgentMailProvisioningClient();
  const request = {
    apiKey,
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
  if (!provisioner.listInboxes) {
    throw new AgentMailCanaryError(
      "The AgentMail inbox ownership-list contract is unavailable; refusing to continue.",
    );
  }
  const listedInboxes = await provisioner.listInboxes(apiKey);
  const ownedMatches = listedInboxes.filter(
    (inbox) =>
      inbox.inboxId === first.inboxId &&
      inbox.email === CANARY_EMAIL &&
      inbox.clientId === CANARY_CLIENT_ID,
  );
  if (ownedMatches.length !== 1) {
    throw new AgentMailCanaryError(
      "The AgentMail account inventory did not contain exactly one matching fixed canary inbox/client_id.",
    );
  }

  const createAdapters = dependencies.createSdkAdapters ?? createAgentMailSdkAdapters;
  const adapters = createAdapters({
    apiKey,
    timeoutMs: SDK_TIMEOUT_MS,
    handshakeTimeoutMs: SDK_TIMEOUT_MS,
    connectionTimeoutMs: SDK_TIMEOUT_MS,
  });

  // Exercise the shipped runtime REST normalizer without fetching message
  // bodies or performing a provider mutation.
  await adapters.catchUp.listMessages({
    inboxId: first.inboxId,
    limit: 1,
    processedEventTypes: [...RUNTIME_EVENT_TYPES],
  });

  let subscription: Awaited<ReturnType<AgentMailSdkAdapters["live"]["subscribe"]>> | undefined;
  let subscriptionAcknowledged = false;
  let liveErrorObserved = false;
  let closeStarted = false;
  let failure: unknown;
  try {
    subscription = await withTimeout(
      adapters.live.subscribe({
        inboxId: first.inboxId,
        eventTypes: [...RUNTIME_EVENT_TYPES],
        async onSubscribed({ reconnected }) {
          if (!reconnected) subscriptionAcknowledged = true;
        },
        async onEvent() {
          // Never log message data if a passive event arrives during the handshake check.
        },
        onError() {
          liveErrorObserved = true;
        },
      }),
      RUNTIME_TIMEOUT_MS,
      "runtime WebSocket subscription",
    );
    closeStarted = true;
    await withTimeout(subscription.close(), CLOSE_TIMEOUT_MS, "runtime WebSocket close");
    await withTimeout(subscription.closed, CLOSE_TIMEOUT_MS, "runtime WebSocket closed signal");
    subscription = undefined;
  } catch (error) {
    failure = error;
  } finally {
    if (subscription && !closeStarted) {
      try {
        closeStarted = true;
        await withTimeout(subscription.close(), CLOSE_TIMEOUT_MS, "runtime WebSocket cleanup");
        await withTimeout(
          subscription.closed,
          CLOSE_TIMEOUT_MS,
          "runtime WebSocket cleanup signal",
        );
      } catch (cleanupError) {
        failure ??= cleanupError;
      }
    }
  }
  if (failure) throw failure;
  if (!subscriptionAcknowledged) {
    throw new AgentMailCanaryError(
      "The AgentMail runtime WebSocket did not acknowledge the canary subscription.",
    );
  }
  if (liveErrorObserved) {
    throw new AgentMailCanaryError(
      "The AgentMail runtime WebSocket reported an error during the canary subscription.",
    );
  }

  console.log("AgentMail provider canary passed: stable client_id reused one inbox.");
  console.log("The exact protected AGENTMAIL_API_KEY passed runtime REST and WebSocket checks.");
  console.log(
    "No mail was sent and no AgentMail API key was created, listed, deleted, or replaced.",
  );
}

function readApiKey(): string {
  const value = process.env[API_KEY_ENV];
  if (!value) {
    throw new AgentMailCanaryError(
      `${API_KEY_ENV} is required from the protected GitHub Environment.`,
    );
  }
  if (!/^[\x21-\x7e]{1,4096}$/.test(value)) {
    throw new AgentMailCanaryError(`${API_KEY_ENV} is malformed.`);
  }
  return value;
}

async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  operation: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AgentMailCanaryError(`Timed out waiting for ${operation}.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeCanaryFailure(error: unknown): string {
  if (error instanceof AgentMailProvisioningApiError) {
    return `AgentMail ${error.operation} failed with HTTP ${error.status}.`;
  }
  if (error instanceof AgentMailProviderRequestError) return error.message;
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
