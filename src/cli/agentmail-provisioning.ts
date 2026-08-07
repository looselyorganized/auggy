import { createHttpClient, type HttpClient, HttpTimeoutError } from "../http";
import { isAmbiguousMutationStatus } from "../outcome-unknown";
import { assertSecureCredentialTransport } from "../engines/_shared/credential-transport";

export const AGENTMAIL_DEFAULT_BASE_URL = "https://api.agentmail.to/v0";
const AGENTMAIL_CLIENT_ID_RE = /^[A-Za-z0-9._~-]{1,256}$/;
const AGENTMAIL_USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const AGENTMAIL_CREDENTIAL_RE = /(?:am|whsec)_[A-Za-z0-9._~+/=-]+/gi;
const AGENTMAIL_CREDENTIAL_TEST_RE = /(?:am|whsec)_[A-Za-z0-9._~+/=-]+/i;
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
    sensitiveBodyValues: readonly string[] = [],
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
        [apiKey, ...sensitiveBodyValues].filter((value): value is string => value !== undefined),
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
      assertAgentMailEmail(input.humanEmail, "human_email");
      assertAgentMailUsername(input.username);
      if (input.source !== undefined) assertAgentMailDisplayField(input.source, "source", 2_048);
      if (input.referrer !== undefined) {
        assertAgentMailDisplayField(input.referrer, "referrer", 2_048);
      }
      const raw = await postJson(
        "/agent/sign-up",
        {
          human_email: input.humanEmail,
          username: input.username,
          ...(input.source ? { source: input.source } : {}),
          ...(input.referrer ? { referrer: input.referrer } : {}),
        },
        undefined,
        collectSensitiveValues(input.humanEmail, input.username, input.source, input.referrer),
      );
      if (!isRecord(raw)) {
        throw new AgentMailProvisioningResponseError(
          "/agent/sign-up",
          "the body was not an object",
          true,
        );
      }
      const organizationId = strictToken(raw.organization_id, 256);
      const inboxId = strictToken(raw.inbox_id, 256);
      const apiKey = strictToken(raw.api_key, 4_096);
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
      assertAgentMailCredential(apiKey, "apiKey");
      assertAgentMailCredential(otpCode, "otp_code", 256);
      const raw = await postJson("/agent/verify", { otp_code: otpCode }, apiKey, [otpCode]);
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
      assertAgentMailCredential(input.apiKey, "apiKey");
      if (input.username !== undefined) assertAgentMailUsername(input.username);
      if (input.domain !== undefined) assertAgentMailDomain(input.domain);
      if (input.displayName !== undefined) {
        assertAgentMailDisplayField(input.displayName, "display_name");
      }
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
        collectSensitiveValues(
          input.username,
          input.domain,
          input.displayName,
          input.clientId,
          input.metadata,
        ),
      );
      const expectedEmail =
        input.username === undefined
          ? undefined
          : `${input.username}@${input.domain ?? "agentmail.to"}`.toLowerCase();
      return parseInboxResult(raw, undefined, "/inboxes", true, input.clientId, expectedEmail);
    },

    async getInbox(apiKey, inboxId) {
      assertAgentMailCredential(apiKey, "apiKey");
      assertAgentMailIdentifier(inboxId, "inboxId");
      const path = `/inboxes/${encodeURIComponent(inboxId)}`;
      const raw = await getJson(path, apiKey);
      return parseInboxResult(raw, inboxId, path, false);
    },

    async createInboxApiKey(input) {
      assertAgentMailCredential(input.apiKey, "apiKey");
      assertAgentMailIdentifier(input.inboxId, "inboxId");
      assertAgentMailDisplayField(input.name, "name");
      assertAgentMailPermissions(input.permissions);
      const path = `/inboxes/${encodeURIComponent(input.inboxId)}/api-keys`;
      const raw = await postJson(
        path,
        {
          name: input.name,
          permissions: input.permissions,
        },
        input.apiKey,
        collectSensitiveValues(input.name),
      );
      if (!isRecord(raw)) {
        throw new AgentMailProvisioningResponseError(path, "the body was not an object", true);
      }
      const apiKeyId = strictToken(raw.api_key_id, 256);
      const apiKey = strictToken(raw.api_key, 4_096);
      const name = strictBoundedString(raw.name, 256);
      const inboxId = strictToken(raw.inbox_id, 256);
      const permissions = strictAgentMailPermissions(raw.permissions);
      if (!apiKeyId || !apiKey || !name || !inboxId || !permissions) {
        throw new AgentMailProvisioningResponseError(
          path,
          "api_key_id, api_key, name, inbox_id, or permissions was invalid",
          true,
        );
      }
      const prefix = optionalToken(raw.prefix, 256);
      if (prefix === null) {
        throw new AgentMailProvisioningResponseError(path, "prefix was invalid", true);
      }
      if (name !== input.name || inboxId !== input.inboxId) {
        throw new AgentMailProvisioningResponseError(
          path,
          "name or inbox_id did not match the requested scoped key",
          true,
        );
      }
      if (!returnedPermissionsMatchRequest(permissions, input.permissions)) {
        throw new AgentMailProvisioningResponseError(
          path,
          "permissions did not match the requested least-privilege scope",
          true,
        );
      }
      return {
        apiKeyId,
        apiKey,
        ...(prefix === undefined ? {} : { prefix }),
        name,
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
        const path = safeIssuePath(candidate.path, secrets);
        const message = safeProviderText(candidate.message, secrets);
        if (!path || !message) return [];
        const code = safeProviderIdentifier(candidate.code, secrets);
        return [{ path, ...(code ? { code } : {}), message }];
      })
    : [];

  return new AgentMailProvisioningApiError({
    operation,
    status,
    providerName: safeProviderIdentifier(value.name, secrets),
    providerCode: safeProviderIdentifier(value.code, secrets),
    providerMessage: safeProviderText(value.message, secrets),
    issues,
    outcomeUnknown: mutation && isAmbiguousMutationStatus(status),
  });
}

function safeProviderIdentifier(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._~-]{0,63}$/.test(value)) {
    return undefined;
  }
  if (containsSensitiveValue(value, secrets)) return undefined;
  return value;
}

function safeIssuePath(
  value: readonly unknown[],
  secrets: readonly string[],
): readonly (string | number)[] | null {
  if (value.length === 0 || value.length > 8) return null;
  const path: (string | number)[] = [];
  for (const part of value) {
    if (typeof part === "number" && Number.isSafeInteger(part) && part >= 0) {
      path.push(part);
      continue;
    }
    if (
      typeof part === "string" &&
      /^[A-Za-z0-9_.~-]{1,64}$/.test(part) &&
      !containsSensitiveValue(part, secrets)
    ) {
      path.push(part);
      continue;
    }
    return null;
  }
  return path;
}

function containsSensitiveValue(value: string, secrets: readonly string[]): boolean {
  if (AGENTMAIL_CREDENTIAL_TEST_RE.test(value)) return true;
  return secrets.some((secret) => sensitiveValueAppears(value, secret));
}

function safeProviderText(value: unknown, secrets: readonly string[]): string | undefined {
  if (typeof value !== "string") return undefined;
  let text = value;
  for (const secret of secrets) {
    text = redactSensitiveValue(text, secret);
  }
  text = text.replace(AGENTMAIL_CREDENTIAL_RE, "[redacted]");
  text = text
    .replace(/[\p{Cc}\p{Cf}]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return undefined;
  text = text.replace(/\bBearer\s+\S+/gi, "Bearer [redacted]");
  return text.slice(0, 240);
}

function redactSensitiveValue(text: string, secret: string): string {
  if (!secret) return text;
  if (secret.length > 3) return text.replaceAll(secret, "[redacted]");
  return text.replace(shortSensitiveValuePattern(secret, "g"), "[redacted]");
}

function sensitiveValueAppears(text: string, secret: string): boolean {
  if (!secret) return false;
  if (secret.length > 3) return text.includes(secret);
  return shortSensitiveValuePattern(secret).test(text);
}

function shortSensitiveValuePattern(secret: string, flags?: string): RegExp {
  const escaped = secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, flags);
}

function collectSensitiveValues(...candidates: unknown[]): string[] {
  const values: string[] = [];
  const visit = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.length > 0) values.push(value);
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
  for (const candidate of candidates) visit(candidate);
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

function assertAgentMailUsername(username: string): void {
  if (!AGENTMAIL_USERNAME_RE.test(username)) {
    throw new Error(
      "AgentMail username must be 1-64 characters using letters, numbers, hyphens, or underscores, and must start with a letter or number.",
    );
  }
}

function assertAgentMailDomain(domain: string): void {
  if (!strictDomain(domain)) {
    throw new Error("AgentMail domain must be a valid DNS name of at most 253 characters.");
  }
}

function assertAgentMailEmail(email: string, field: string): void {
  if (!strictEmail(email)) {
    throw new Error(`AgentMail ${field} must be a valid email address.`);
  }
}

function assertAgentMailDisplayField(value: string, field: string, maxLength = 256): void {
  if (!strictBoundedString(value, maxLength)) {
    throw new Error(
      `AgentMail ${field} must be 1-${maxLength} characters without leading/trailing whitespace or controls.`,
    );
  }
}

function assertAgentMailCredential(value: string, field: string, maxLength = 4_096): void {
  if (!strictToken(value, maxLength)) {
    throw new Error(
      `AgentMail ${field} must be a non-empty ASCII token of at most ${maxLength} characters.`,
    );
  }
}

function assertAgentMailIdentifier(value: string, field: string): void {
  if (!strictToken(value, 256)) {
    throw new Error(
      `AgentMail ${field} must be a non-empty ASCII token of at most 256 characters.`,
    );
  }
}

function assertAgentMailPermissions(permissions: AgentMailApiKeyPermissions): void {
  const parsed = strictAgentMailPermissions(permissions);
  if (!parsed || Object.keys(parsed).length === 0) {
    throw new Error("AgentMail permissions must contain 1-64 entries.");
  }
}

function strictAgentMailPermissions(value: unknown): AgentMailApiKeyPermissions | null {
  if (!isRecord(value)) return null;
  const entries = Object.entries(value);
  if (entries.length > 64) return null;
  if (
    entries.some(
      ([name, enabled]) =>
        !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) || typeof enabled !== "boolean",
    )
  ) {
    return null;
  }
  return Object.fromEntries(entries) as AgentMailApiKeyPermissions;
}

function returnedPermissionsMatchRequest(
  returned: AgentMailApiKeyPermissions,
  requested: AgentMailApiKeyPermissions,
): boolean {
  for (const [name, enabled] of Object.entries(requested)) {
    if (enabled && returned[name] !== true) return false;
  }
  for (const [name, enabled] of Object.entries(returned)) {
    if (enabled && requested[name] !== true) return false;
  }
  return true;
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
    if (!strictBoundedString(key, 256)) {
      throw new Error(
        "AgentMail metadata keys must be non-empty, at most 256 characters, and contain no controls.",
      );
    }
    if (typeof value === "string" && !strictBoundedString(value, 256)) {
      throw new Error(
        "AgentMail metadata string values must be non-empty, at most 256 characters, and contain no controls.",
      );
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
  expectedEmail?: string,
): AgentMailInboxResult {
  if (!isRecord(value)) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "the body was not an object",
      outcomeUnknown,
    );
  }
  const inboxId = strictToken(value.inbox_id, 256);
  const email = strictEmail(value.email);
  const displayName = optionalDisplayName(value.display_name);
  const clientId = optionalClientId(value.client_id);
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
  if (expectedClientId !== undefined && clientId !== expectedClientId) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "client_id did not match the requested idempotency identity",
      outcomeUnknown,
    );
  }
  if (expectedEmail !== undefined && email.toLowerCase() !== expectedEmail) {
    throw new AgentMailProvisioningResponseError(
      operation,
      "email did not match the requested inbox identity",
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

function strictToken(value: unknown, maxLength: number): string | null {
  const string = strictString(value);
  return string && string.length <= maxLength && /^[\x21-\x7e]+$/.test(string) ? string : null;
}

function optionalBoundedString(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return strictBoundedString(value, maxLength);
}

function optionalToken(value: unknown, maxLength: number): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return strictToken(value, maxLength);
}

function optionalClientId(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === "string" && AGENTMAIL_CLIENT_ID_RE.test(value) ? value : null;
}

function strictEmail(value: unknown): string | null {
  const email = strictString(value);
  if (!email || email.length > 254 || /\s/u.test(email)) return null;

  const at = email.lastIndexOf("@");
  if (at <= 0 || at !== email.indexOf("@") || at === email.length - 1) return null;
  const local = email.slice(0, at);
  const domain = email.slice(at + 1);
  if (local.length > 64 || !strictDomain(domain)) return null;
  if (!/^[A-Za-z0-9!#$%&'*+/=?^_`{|}~.-]+$/.test(local)) return null;
  if (local.startsWith(".") || local.endsWith(".") || local.includes("..")) return null;
  return email;
}

function strictDomain(value: unknown): string | null {
  const domain = strictString(value);
  if (!domain || domain.length > 253) return null;
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
  return domain;
}

function optionalDisplayName(value: unknown): string | null | undefined {
  return optionalBoundedString(value, 256);
}
