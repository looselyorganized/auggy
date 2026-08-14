import { AgentMailClient, AgentMailEnvironment, AgentMailError } from "agentmail";
import { assertSecureCredentialTransport } from "../engines/_shared/credential-transport";

const REQUEST_TIMEOUT_SECONDS = 30;

export interface AgentMailSetupProviderOptions {
  apiBaseUrl?: string;
  allowInsecureHttpWithCredentials?: boolean;
  /** Test seam for the provider SDK transport. */
  fetch?: typeof fetch;
}

export interface AgentMailSetupProvider {
  signUp(input: {
    humanEmail: string;
    username: string;
    source: string;
    referrer: string;
  }): Promise<{ organizationId: string; inboxId: string; apiKey: string }>;
  verify(apiKey: string, otpCode: string): Promise<{ verified: boolean }>;
  createInbox(input: {
    apiKey: string;
    username: string;
    displayName: string;
    clientId: string;
    metadata: Record<string, string>;
  }): Promise<{ inboxId: string; email: string }>;
}

export class AgentMailSetupProviderError extends Error {
  readonly operation: "signup" | "verify" | "create_inbox";
  readonly status?: number;
  readonly providerCode?: string;
  readonly outcomeUnknown: boolean;

  constructor(input: {
    operation: "signup" | "verify" | "create_inbox";
    status?: number;
    providerCode?: string;
    outcomeUnknown: boolean;
    nextAction: string;
  }) {
    const classification =
      input.providerCode ?? (input.status ? `HTTP ${input.status}` : "network");
    super(`AgentMail ${input.operation} failed (${classification}). ${input.nextAction}`);
    this.name = "AgentMailSetupProviderError";
    this.operation = input.operation;
    this.status = input.status;
    this.providerCode = input.providerCode;
    this.outcomeUnknown = input.outcomeUnknown;
  }
}

export function createAgentMailSetupProvider(
  options: AgentMailSetupProviderOptions = {},
): AgentMailSetupProvider {
  const baseUrl = options.apiBaseUrl ?? AgentMailEnvironment.Prod.http;

  const client = (apiKey?: string): AgentMailClient => {
    // Signup returns a credential in the response, so it receives the same
    // transport protection even though no credential is attached to the request.
    assertSecureCredentialTransport({
      provider: "AgentMail",
      baseURL: baseUrl,
      credential: apiKey ?? "signup-response-credential",
      allowInsecureHttpWithCredentials: options.allowInsecureHttpWithCredentials,
    });
    return new AgentMailClient({
      ...(apiKey ? { apiKey } : {}),
      baseUrl,
      maxRetries: 0,
      timeoutInSeconds: REQUEST_TIMEOUT_SECONDS,
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
  };

  return {
    async signUp(input) {
      const setupClient = client();
      let result: Awaited<ReturnType<typeof setupClient.agent.signUp>>;
      try {
        result = await setupClient.agent.signUp({
          humanEmail: input.humanEmail,
          username: input.username,
          source: input.source,
          referrer: input.referrer,
        });
      } catch (error) {
        throw setupError("signup", error, true);
      }
      return {
        organizationId: boundedToken(result.organizationId, "organization ID", 256),
        inboxId: boundedToken(result.inboxId, "inbox ID", 512),
        apiKey: boundedToken(result.apiKey, "API key", 4_096),
      };
    },

    async verify(apiKey, otpCode) {
      const setupClient = client(apiKey);
      let result: Awaited<ReturnType<typeof setupClient.agent.verify>>;
      try {
        result = await setupClient.agent.verify({ otpCode });
      } catch (error) {
        throw setupError("verify", error, false);
      }
      if (typeof result.verified !== "boolean") {
        throw new Error("AgentMail verification response did not contain verified.");
      }
      return { verified: result.verified };
    },

    async createInbox(input) {
      const setupClient = client(input.apiKey);
      let result: Awaited<ReturnType<typeof setupClient.inboxes.create>>;
      try {
        result = await setupClient.inboxes.create({
          username: input.username,
          displayName: input.displayName,
          clientId: input.clientId,
          metadata: input.metadata,
        });
      } catch (error) {
        throw setupError("create_inbox", error, true);
      }
      return {
        inboxId: boundedToken(result.inboxId, "inbox ID", 512),
        email: boundedEmail(result.email),
      };
    },
  };
}

function setupError(
  operation: AgentMailSetupProviderError["operation"],
  error: unknown,
  mutation: boolean,
): AgentMailSetupProviderError {
  if (error instanceof AgentMailSetupProviderError) return error;
  const status = error instanceof AgentMailError ? error.statusCode : undefined;
  const providerCode = error instanceof AgentMailError ? safeProviderCode(error.body) : undefined;
  const outcomeUnknown =
    mutation && (status === undefined || status === 408 || status === 429 || status >= 500);
  const nextAction = (() => {
    if (outcomeUnknown) {
      return operation === "create_inbox"
        ? "The provider outcome is unknown. Retry with the same username and client ID so AgentMail can reconcile idempotently."
        : "The provider outcome is unknown. Check AgentMail Console before retrying because signup may have created or rotated a key.";
    }
    if (status === 401) return "Use a valid AgentMail API key.";
    if (
      operation === "signup" &&
      (providerCode === "already_exists" || providerCode === "resource_taken")
    ) {
      return "That email already has an AgentMail account. Sign in, then use existing-account or manual setup.";
    }
    if (
      operation === "create_inbox" &&
      (providerCode === "already_exists" || providerCode === "resource_taken")
    ) {
      return "That inbox address is taken. Choose another username or manually connect an inbox you own.";
    }
    if (status === 403 && providerCode === "missing_permission") {
      return "Grant inbox_create to this account key, then retry.";
    }
    if (status === 403) return "Grant inbox_create to this account-scoped key, then retry.";
    if (status === 400 || status === 422)
      return "Review the submitted account or inbox values, then retry.";
    if (status === 429) return "Wait for AgentMail's rate limit to reset, then retry.";
    return "Retry after checking AgentMail service availability and the selected account.";
  })();
  return new AgentMailSetupProviderError({
    operation,
    ...(status === undefined ? {} : { status }),
    ...(providerCode === undefined ? {} : { providerCode }),
    outcomeUnknown,
    nextAction,
  });
}

function safeProviderCode(body: unknown): string | undefined {
  if (!body || typeof body !== "object" || Array.isArray(body)) return undefined;
  const value = (body as Record<string, unknown>).code;
  return typeof value === "string" && /^[A-Za-z][A-Za-z0-9._~-]{0,63}$/.test(value)
    ? value
    : undefined;
}

function boundedToken(value: unknown, label: string, max: number): string {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > max ||
    /[\r\n\0]/.test(value)
  ) {
    throw new Error(`AgentMail ${label} response was invalid.`);
  }
  return value;
}

function boundedEmail(value: unknown): string {
  const email = boundedToken(value, "inbox email", 320);
  if (!email.includes("@")) throw new Error("AgentMail inbox email response was invalid.");
  return email.toLowerCase();
}
