import { createHttpClient, type HttpClient, HttpTimeoutError } from "../http";
import { isAmbiguousMutationStatus } from "../outcome-unknown";
import { assertSecureCredentialTransport } from "../engines/_shared/credential-transport";

export const AGENTMAIL_DEFAULT_BASE_URL = "https://api.agentmail.to/v0";
const AGENTMAIL_CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const AUGGY_AGENT_ID_RE = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type AgentMailProvisioningTarget = "agentMail" | "visitorAuth";

export interface AgentMailProvisioningFieldIssue {
  path: readonly (string | number)[];
  code?: string;
  message: string;
}

/**
 * A provider-declared HTTP error with only the safe, structured parts of the
 * AgentMail error envelope retained. The raw response and request credentials
 * are deliberately never attached to this error.
 */
export class AgentMailProvisioningApiError extends Error {
  readonly status: number;
  readonly operation: string;
  readonly providerName?: string;
  readonly providerCode?: string;
  readonly providerMessage?: string;
  readonly issues: readonly AgentMailProvisioningFieldIssue[];
  readonly outcomeUnknown?: true;

  constructor(args: {
    status: number;
    operation: string;
    providerName?: string;
    providerCode?: string;
    providerMessage?: string;
    issues?: readonly AgentMailProvisioningFieldIssue[];
    outcomeUnknown?: boolean;
  }) {
    const summary = [
      args.providerCode,
      args.issues?.[0]
        ? `${formatIssuePath(args.issues[0].path)}: ${args.issues[0].message}`
        : args.providerMessage,
    ]
      .filter((part): part is string => Boolean(part))
      .join(" — ");
    const ambiguity = args.outcomeUnknown
      ? "; the provider outcome is unknown and the operation must not be retried automatically"
      : "";
    super(
      `AgentMail ${args.operation} failed (${args.status})${summary ? `: ${summary}` : ""}${ambiguity}`,
    );
    this.name = "AgentMailProvisioningApiError";
    this.status = args.status;
    this.operation = args.operation;
    this.providerName = args.providerName;
    this.providerCode = args.providerCode;
    this.providerMessage = args.providerMessage;
    this.issues = args.issues ?? [];
    if (args.outcomeUnknown) this.outcomeUnknown = true;
  }
}

/** A transport failure, explicitly classified by side-effect ambiguity. */
export class AgentMailProvisioningTransportError extends Error {
  readonly operation: string;
  readonly kind: "timeout" | "network";
  readonly outcomeUnknown?: true;
  readonly retryable: boolean;

  constructor(operation: string, kind: "timeout" | "network", mutation: boolean) {
    super(
      `AgentMail ${operation} ${
        kind === "timeout" ? "timed out" : "failed before a response was received"
      }; ${
        mutation
          ? "the provider outcome is unknown and the operation must not be retried automatically."
          : "the read-only operation may be retried."
      }`,
    );
    this.name = "AgentMailProvisioningTransportError";
    this.operation = operation;
    this.kind = kind;
    this.retryable = !mutation;
    if (mutation) this.outcomeUnknown = true;
  }
}

/** A successful HTTP response that does not satisfy the provider contract. */
export class AgentMailProvisioningResponseError extends Error {
  readonly operation: string;
  readonly outcomeUnknown?: true;

  constructor(operation: string, detail: string, outcomeUnknown = false) {
    super(
      `AgentMail ${operation} returned an invalid response: ${detail}${
        outcomeUnknown
          ? "; the provider outcome is unknown and the operation must not be retried automatically"
          : ""
      }`,
    );
    this.name = "AgentMailProvisioningResponseError";
    this.operation = operation;
    if (outcomeUnknown) this.outcomeUnknown = true;
  }
}

/**
 * Build the stable, resource-scoped idempotency key used for inbox creation.
 * Keep this versioned so future provider resources cannot accidentally share
 * an idempotency namespace with inboxes created by this contract.
 */
export function buildAgentMailClientId(
  agentId: string,
  target: AgentMailProvisioningTarget,
): string {
  if (!AUGGY_AGENT_ID_RE.test(agentId)) {
    throw new Error(
      "AgentMail inbox provisioning requires a valid immutable aug1_ UUID from agent.yaml.",
    );
  }
  const clientId = `auggy.v1.inbox.${agentId}.${target}`;
  assertAgentMailClientId(clientId);
  return clientId;
}

export interface AgentMailProvisioningClientOptions {
  apiBaseUrl?: string;
  /** Development-only escape hatch for credentialed non-loopback HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
  timeoutMs?: number;
  http?: Pick<HttpClient, "post" | "get">;
}

export interface AgentMailSignUpInput {
  humanEmail: string;
  username: string;
  source?: string;
  referrer?: string;
}

export interface AgentMailSignUpResult {
  organizationId: string;
  inboxId: string;
  apiKey: string;
}

export interface AgentMailCreateInboxInput {
  apiKey: string;
  username?: string;
  domain?: string;
  displayName?: string;
  clientId?: string;
  metadata?: Record<string, string | number | boolean>;
}

export interface AgentMailInboxResult {
  inboxId: string;
  email: string;
  displayName?: string;
}

export type AgentMailApiKeyPermissions = Record<string, boolean>;

export type AgentMailRuntimeKeyPermissions = AgentMailApiKeyPermissions & {
  inbox_read: true;
  message_send: true;
  message_read?: true;
  label_spam_read?: true;
  label_blocked_read?: true;
};

export interface AgentMailRuntimePermissionRequirements {
  /** Whether the agentMail augment will admit inbound messages. */
  inboundEnabled: boolean;
  /** Whether spam-classified messages are intentionally processed. */
  processSpam?: boolean;
  /** Whether blocked-classified messages are intentionally processed. */
  processBlocked?: boolean;
}

export interface AgentMailCreateInboxApiKeyInput {
  apiKey: string;
  inboxId: string;
  name: string;
  permissions: AgentMailApiKeyPermissions;
}

export interface AgentMailApiKeyResult {
  apiKeyId: string;
  apiKey: string;
  prefix?: string;
  name?: string;
}

export interface AgentMailProvisioningClient {
  signUp(input: AgentMailSignUpInput): Promise<AgentMailSignUpResult>;
  verify(apiKey: string, otpCode: string): Promise<{ verified: boolean }>;
  createInbox(input: AgentMailCreateInboxInput): Promise<AgentMailInboxResult>;
  getInbox(apiKey: string, inboxId: string): Promise<AgentMailInboxResult>;
  createInboxApiKey(input: AgentMailCreateInboxApiKeyInput): Promise<AgentMailApiKeyResult>;
}

export function buildAgentMailRuntimeKeyPermissions(
  requirements: AgentMailRuntimePermissionRequirements,
): AgentMailRuntimeKeyPermissions {
  if (!requirements.inboundEnabled && (requirements.processSpam || requirements.processBlocked)) {
    throw new Error("AgentMail label-read permissions require inbound delivery to be enabled.");
  }
  return {
    inbox_read: true,
    message_send: true,
    ...(requirements.inboundEnabled ? { message_read: true as const } : {}),
    ...(requirements.processSpam ? { label_spam_read: true as const } : {}),
    ...(requirements.processBlocked ? { label_blocked_read: true as const } : {}),
  };
}

/** Backward-compatible outbound-only permission set. */
export const AGENTMAIL_RUNTIME_KEY_PERMISSIONS = buildAgentMailRuntimeKeyPermissions({
  inboundEnabled: false,
});

export function createAgentMailProvisioningClient(
  opts: AgentMailProvisioningClientOptions = {},
): AgentMailProvisioningClient {
  const baseUrl = opts.apiBaseUrl ?? AGENTMAIL_DEFAULT_BASE_URL;
  assertSecureCredentialTransport({
    provider: "AgentMail provisioning",
    baseURL: baseUrl,
    // Provisioning returns and subsequently sends API keys on this channel.
    credential: "provisioning-credential",
    allowInsecureHttpWithCredentials: opts.allowInsecureHttpWithCredentials,
  });
  const http =
    opts.http ??
    createHttpClient({
      timeoutMs: opts.timeoutMs ?? 20_000,
      userAgent: "auggy-agentmail-setup/0.1",
      urlPolicy: "operator-configured",
    });

  async function postJson(
    path: string,
    body: Record<string, unknown>,
    apiKey?: string,
  ): Promise<unknown> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    let res: Awaited<ReturnType<HttpClient["post"]>>;
    try {
      res = await http.post(`${baseUrl}${path}`, {
        headers,
        body: JSON.stringify(body),
      });
    } catch (error) {
      throw provisioningTransportError(path, error, true);
    }
    if (res.status < 200 || res.status >= 300) {
      throw parseAgentMailApiError(
        path,
        res.status,
        res.body,
        [apiKey, ...requestStringValues(body)].filter(
          (value): value is string => value !== undefined,
        ),
        true,
      );
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new AgentMailProvisioningResponseError(path, "the body was not valid JSON", true);
    }
  }

  async function getJson(path: string, apiKey: string): Promise<unknown> {
    let res: Awaited<ReturnType<HttpClient["get"]>>;
    try {
      res = await http.get(`${baseUrl}${path}`, {
        headers: { authorization: `Bearer ${apiKey}` },
      });
    } catch (error) {
      throw provisioningTransportError(path, error, false);
    }
    if (res.status < 200 || res.status >= 300) {
      throw parseAgentMailApiError(path, res.status, res.body, [apiKey], false);
    }
    try {
      return JSON.parse(res.body) as unknown;
    } catch {
      throw new AgentMailProvisioningResponseError(path, "the body was not valid JSON");
    }
  }

  return {
    async signUp(input) {
      const raw = await postJson("/agent/sign-up", {
        human_email: input.humanEmail,
        username: input.username,
        ...(input.source ? { source: input.source } : {}),
        ...(input.referrer ? { referrer: input.referrer } : {}),
      });
      if (!isRecord(raw)) {
        throw new AgentMailProvisioningResponseError(
          "/agent/sign-up",
          "the body was not an object",
          true,
        );
      }
      const organizationId = strictBoundedString(raw.organization_id, 256);
      const inboxId = strictBoundedString(raw.inbox_id, 256);
      const apiKey = strictBoundedString(raw.api_key, 4_096);
      if (!organizationId || !inboxId || !apiKey) {
        throw new AgentMailProvisioningResponseError(
          "/agent/sign-up",
          "organization_id, inbox_id, or api_key was missing",
          true,
        );
      }
      return { organizationId, inboxId, apiKey };
    },

    async verify(apiKey, otpCode) {
      const raw = await postJson("/agent/verify", { otp_code: otpCode }, apiKey);
      if (!isRecord(raw) || typeof raw.verified !== "boolean") {
        throw new AgentMailProvisioningResponseError(
          "/agent/verify",
          "verified was missing or was not a boolean",
          true,
        );
      }
      return { verified: raw.verified };
    },

    async createInbox(input) {
      if (input.clientId !== undefined) {
        assertAgentMailClientId(input.clientId);
      }
      if (input.metadata !== undefined) {
        assertAgentMailMetadata(input.metadata);
      }
      const raw = await postJson(
        "/inboxes",
        {
          ...(input.username ? { username: input.username } : {}),
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
          ...(input.clientId !== undefined ? { client_id: input.clientId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        input.apiKey,
      );
      return parseInboxResult(raw, undefined, "/inboxes", true, input.clientId);
    },

    async getInbox(apiKey, inboxId) {
      const path = `/inboxes/${encodeURIComponent(inboxId)}`;
      const raw = await getJson(path, apiKey);
      return parseInboxResult(raw, inboxId, path, false);
    },

    async createInboxApiKey(input) {
      const path = `/inboxes/${encodeURIComponent(input.inboxId)}/api-keys`;
      const raw = await postJson(
        path,
        {
          name: input.name,
          permissions: input.permissions,
        },
        input.apiKey,
      );
      if (!isRecord(raw)) {
        throw new AgentMailProvisioningResponseError(path, "the body was not an object", true);
      }
      const apiKeyId = strictBoundedString(raw.api_key_id, 256);
      const apiKey = strictBoundedString(raw.api_key, 4_096);
      if (!apiKeyId || !apiKey) {
        throw new AgentMailProvisioningResponseError(
          path,
          "api_key_id or api_key was missing",
          true,
        );
      }
      const prefix = optionalBoundedString(raw.prefix, 256);
      const name = optionalBoundedString(raw.name, 256);
      if (prefix === null || name === null) {
        throw new AgentMailProvisioningResponseError(path, "prefix or name was invalid", true);
      }
      return {
        apiKeyId,
        apiKey,
        ...(prefix === undefined ? {} : { prefix }),
        ...(name === undefined ? {} : { name }),
      };
    },
  };
}

function provisioningTransportError(
  operation: string,
  error: unknown,
  mutation: boolean,
): AgentMailProvisioningTransportError {
  return new AgentMailProvisioningTransportError(
    operation,
    error instanceof HttpTimeoutError ||
      (error instanceof Error && error.name === "HttpTimeoutError")
      ? "timeout"
      : "network",
    mutation,
  );
}

function parseAgentMailApiError(
  operation: string,
  status: number,
  body: string,
  secrets: readonly string[],
  mutation: boolean,
): AgentMailProvisioningApiError {
  let value: unknown;
  try {
    value = JSON.parse(body);
  } catch {
    return new AgentMailProvisioningApiError({
      operation,
      status,
      outcomeUnknown: mutation && isAmbiguousMutationStatus(status),
    });
  }
  if (!isRecord(value)) {
    return new AgentMailProvisioningApiError({
      operation,
      status,
      outcomeUnknown: mutation && isAmbiguousMutationStatus(status),
    });
  }

  const issues = Array.isArray(value.errors)
    ? value.errors.flatMap((candidate): AgentMailProvisioningFieldIssue[] => {
        if (!isRecord(candidate) || !Array.isArray(candidate.path)) return [];
        const path = safeIssuePath(candidate.path);
        const message = safeProviderText(candidate.message, secrets);
        if (!path || !message) return [];
        const code = safeProviderIdentifier(candidate.code);
        return [{ path, ...(code ? { code } : {}), message }];
      })
    : [];

  return new AgentMailProvisioningApiError({
    operation,
    status,
    providerName: safeProviderIdentifier(value.name),
    providerCode: safeProviderIdentifier(value.code),
    providerMessage: safeProviderText(value.message, secrets),
    issues,
    outcomeUnknown: mutation && isAmbiguousMutationStatus(status),
  });
}

function safeProviderIdentifier(value: unknown): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._~-]{0,63}$/.test(value)) {
    return undefined;
  }
  return value;
}

function safeIssuePath(value: readonly unknown[]): readonly (string | number)[] | null {
  if (value.length === 0 || value.length > 8) return null;
  const path: (string | number)[] = [];
  for (const part of value) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      path.push(part);
      continue;
    }
    if (typeof part === "string" && /^[A-Za-z0-9_.~-]{1,64}$/.test(part)) {
      path.push(part);
      continue;
    }
    return null;
  }
  return path;
}

function safeProviderText(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  for (const secret of secrets) {
    if (secret) text = text.replaceAll(secret, "[redacted]");
  }
  text = text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  return text.slice(0, 240);
}

function requestStringValues(body: Record<string, unknown>): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      // Redacting tiny ordinary words makes provider diagnostics unreadable;
      // credentials and user-supplied identifiers are never this short.
      if (value.length >= 4) values.push(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const entry of value) visit(entry);
      return;
    }
    if (isRecord(value)) {
      for (const entry of Object.values(value)) visit(entry);
    }
  };
  visit(body);
  return values;
}

function formatIssuePath(path: readonly (string | number)[]): string {
  return path
    .map((part, index) =>
      typeof part === "number" ? `[${part}]` : index === 0 ? part : `.${part}`,
    )
    .join("");
}

function assertAgentMailClientId(clientId: string): void {
  if (!AGENTMAIL_CLIENT_ID_RE.test(clientId)) {
    throw new Error(
      "AgentMail client_id must be 1-256 characters using only letters, numbers, periods, hyphens, underscores, or tildes.",
    );
  }
}

function assertAgentMailMetadata(metadata: Record<string, string | number | boolean>): void {
  if (!isRecord(metadata)) {
    throw new Error("AgentMail metadata must be an object.");
  }
  const entries = Object.entries(metadata);
  if (entries.length > 256) {
    throw new Error("AgentMail metadata must contain at most 256 keys.");
  }
  for (const [key, value] of entries) {
    if (key.length > 256) {
      throw new Error("AgentMail metadata keys must be at most 256 characters.");
    }
    if (typeof value === "string" && value.length > 256) {
      throw new Error("AgentMail metadata string values must be at most 256 characters.");
    }
    if (
      typeof value !== "string" &&
      typeof value !== "boolean" &&
      !(typeof value === "number" && Number.isFinite(value))
    ) {
      throw new Error("AgentMail metadata values must be strings, finite numbers, or booleans.");
    }
  }
}

function parseInboxResult(
  value: unknown,
  expectedInboxId: string | undefined,
  operation: string,
  outcomeUnknown: boolean,
  expectedClientId?: string,
): AgentMailInboxResult {
  if (!isRecord(value)) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "the body was not an object",
      outcomeUnknown,
    );
  }
  const inboxId = strictBoundedString(value.inbox_id, 256);
  const email = strictEmail(value.email);
  const displayName = optionalDisplayName(value.display_name);
  const clientId = optionalBoundedString(value.client_id, 256);
  if (!inboxId || !email || displayName === null || clientId === null) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "inbox_id, email, or display_name was invalid",
      outcomeUnknown,
    );
  }
  if (expectedInboxId !== undefined && inboxId !== expectedInboxId) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "inbox_id did not match the requested inbox",
      outcomeUnknown,
    );
  }
  if (expectedClientId !== undefined && clientId !== undefined && clientId !== expectedClientId) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "client_id did not match the requested idempotency identity",
      outcomeUnknown,
    );
  }
  return {
    inboxId,
    email,
    ...(displayName === undefined ? {} : { displayName }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function strictString(value: unknown): string | null {
  if (typeof value !== "string" || !value || value !== value.trim()) return null;
  if (/[\p{Cc}\p{Cf}]/u.test(value)) return null;
  return value;
}

function strictBoundedString(value: unknown, maxLength: number): string | null {
  const string = strictString(value);
  return string && string.length <= maxLength ? string : null;
}

function optionalBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return strictBoundedString(value, maxLength);
}

function strictEmail(value: unknown): string | null {
  const email = strictString(value);
  if (!email || email.length > 254 || /\s/u.test(email)) return null;

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || domain.length > 253) return null;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;

  const labels = domain.split(".");
  if (labels.length < 2) return null;
  if (
    labels.some(
      (label) =>
        label.length === 0 ||
        label.length > 63 ||
        !/^[A-Za-z0-9-]+$/.test(label) ||
        label.startsWith("-") ||
        label.endsWith("-"),
    )
  ) {
    return null;
  }
  return email;
}

function optionalDisplayName(value: unknown): string | null | undefined {
  return optionalBoundedString(value, 256);
}
