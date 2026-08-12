import {
  AgentMailProviderError,
  createAgentMailProvider,
  type AgentMailProvider,
} from "../src/augments/agentMail/provider";

const API_KEY_ENV = "AGENTMAIL_API_KEY";
const INBOX_ID_ENV = "AGENTMAIL_CANARY_INBOX_ID";
const INBOX_EMAIL_ENV = "AGENTMAIL_CANARY_INBOX_EMAIL";
const OPERATION_TIMEOUT_MS = 20_000;
const LIVE_OBSERVATION_MS = 500;

type ReadOnlyCanaryProvider = Pick<
  AgentMailProvider,
  "verifyAccess" | "listMessages" | "listDrafts" | "connect"
>;

export interface AgentMailCanaryDependencies {
  apiKey?: string;
  inboxId?: string;
  inboxEmail?: string;
  createProvider?: (input: { apiKey: string; inboxId: string }) => ReadOnlyCanaryProvider;
  observeLiveMs?: number;
}

class AgentMailCanaryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentMailCanaryError";
  }
}

/**
 * Exercise a pre-provisioned inbox using the exact protected runtime key.
 *
 * This canary is intentionally read-only. It does not sign up, create an
 * inbox, create or rotate a key, create a draft, or send mail. Mutation
 * semantics remain covered by deterministic provider-contract tests.
 */
export async function runAgentMailProviderCanary(
  dependencies: AgentMailCanaryDependencies = {},
): Promise<void> {
  const apiKey = readSecret(dependencies.apiKey, API_KEY_ENV);
  const inboxId = readIdentifier(dependencies.inboxId, INBOX_ID_ENV);
  const expectedEmail = readEmail(dependencies.inboxEmail, INBOX_EMAIL_ENV);
  const provider = (dependencies.createProvider ?? createAgentMailProvider)({ apiKey, inboxId });

  const identity = await withTimeout(
    provider.verifyAccess(),
    OPERATION_TIMEOUT_MS,
    "credential scope and inbox access",
  );
  if (identity.configuredInboxId !== inboxId || identity.emailAddress !== expectedEmail) {
    throw new AgentMailCanaryError(
      "AgentMail returned an inbox identity that does not match the protected canary configuration.",
    );
  }

  await withTimeout(
    provider.listMessages({ limit: 1 }),
    OPERATION_TIMEOUT_MS,
    "bounded message-read probe",
  );
  await withTimeout(
    provider.listDrafts({ limit: 1 }),
    OPERATION_TIMEOUT_MS,
    "bounded draft-read probe",
  );

  let liveError: AgentMailProviderError | undefined;
  let liveClosed = false;
  let subscription: Awaited<ReturnType<ReadOnlyCanaryProvider["connect"]>> | undefined;
  try {
    subscription = await withTimeout(
      provider.connect({
        onEvent() {
          // Passive events may arrive during the bounded observation window.
          // Do not log or retain provider message data.
        },
        onClose() {
          liveClosed = true;
        },
        onError(error) {
          liveError = error;
        },
      }),
      OPERATION_TIMEOUT_MS,
      "WebSocket connection and inbox subscription",
    );
    await Bun.sleep(dependencies.observeLiveMs ?? LIVE_OBSERVATION_MS);
    if (liveError) throw liveError;
    if (liveClosed) {
      throw new AgentMailCanaryError(
        "The AgentMail WebSocket closed during the bounded live-read probe.",
      );
    }
  } finally {
    subscription?.close();
  }

  console.log("AgentMail provider canary passed for the pre-provisioned inbox.");
  console.log(
    "The exact protected runtime key passed scope, inbox, message-read, draft-read, and WebSocket checks.",
  );
  console.log("No AgentMail resource was created, changed, sent, or deleted.");
}

function readSecret(explicit: string | undefined, envName: string): string {
  const value = explicit ?? process.env[envName];
  if (!value || !/^[\x21-\x7e]{1,4096}$/.test(value)) {
    throw new AgentMailCanaryError(
      `${envName} is required from the protected GitHub Environment and must be a non-empty ASCII token.`,
    );
  }
  return value;
}

function readIdentifier(explicit: string | undefined, envName: string): string {
  const value = explicit ?? process.env[envName];
  if (!value || !/^[\x21-\x7e]{1,256}$/.test(value)) {
    throw new AgentMailCanaryError(
      `${envName} is required from the protected GitHub Environment and must be a non-empty identifier.`,
    );
  }
  return value;
}

function readEmail(explicit: string | undefined, envName: string): string {
  const value = readIdentifier(explicit, envName);
  const at = value.lastIndexOf("@");
  if (at <= 0 || at === value.length - 1 || value.includes(" ")) {
    throw new AgentMailCanaryError(`${envName} must be the canonical email for the canary inbox.`);
  }
  return value.toLowerCase();
}

async function withTimeout<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    operation,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new AgentMailCanaryError(`Timed out waiting for ${label}.`)),
        timeoutMs,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

function safeCanaryFailure(error: unknown): string {
  if (error instanceof AgentMailProviderError) {
    const status = error.details.httpStatus ? ` (HTTP ${error.details.httpStatus})` : "";
    return `${error.details.operation} failed: ${error.details.code}${status}. ${error.details.nextAction}`;
  }
  if (error instanceof AgentMailCanaryError) return error.message;
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
