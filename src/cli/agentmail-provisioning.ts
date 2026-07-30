import { createHttpClient, type HttpClient } from "../http";
import { assertSecureCredentialTransport } from "../engines/_shared/credential-transport";

export const AGENTMAIL_DEFAULT_BASE_URL = "https://api.agentmail.to/v0";

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

export const AGENTMAIL_RUNTIME_KEY_PERMISSIONS: AgentMailApiKeyPermissions = {
  inbox_read: true,
  message_send: true,
};

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

  async function postJson<T>(
    path: string,
    body: Record<string, unknown>,
    apiKey?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    const res = await http.post(`${baseUrl}${path}`, {
      headers,
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`AgentMail ${path} failed (${res.status}): ${res.body.slice(0, 240)}`);
    }
    try {
      return JSON.parse(res.body) as T;
    } catch (err) {
      throw new Error(`AgentMail ${path} returned invalid JSON: ${(err as Error).message}`);
    }
  }

  async function getJson<T>(path: string, apiKey: string): Promise<T> {
    const res = await http.get(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${apiKey}` },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`AgentMail ${path} failed (${res.status}): ${res.body.slice(0, 240)}`);
    }
    try {
      return JSON.parse(res.body) as T;
    } catch (err) {
      throw new Error(`AgentMail ${path} returned invalid JSON: ${(err as Error).message}`);
    }
  }

  return {
    async signUp(input) {
      const raw = await postJson<Record<string, unknown>>("/agent/sign-up", {
        human_email: input.humanEmail,
        username: input.username,
        ...(input.source ? { source: input.source } : {}),
        ...(input.referrer ? { referrer: input.referrer } : {}),
      });
      const organizationId = stringField(raw.organization_id);
      const inboxId = stringField(raw.inbox_id);
      const apiKey = stringField(raw.api_key);
      if (!organizationId || !inboxId || !apiKey) {
        throw new Error(
          "AgentMail sign-up response was missing organization_id, inbox_id, or api_key.",
        );
      }
      return { organizationId, inboxId, apiKey };
    },

    async verify(apiKey, otpCode) {
      const raw = await postJson<Record<string, unknown>>(
        "/agent/verify",
        { otp_code: otpCode },
        apiKey,
      );
      return { verified: raw.verified === true };
    },

    async createInbox(input) {
      const raw = await postJson<Record<string, unknown>>(
        "/inboxes",
        {
          ...(input.username ? { username: input.username } : {}),
          ...(input.domain ? { domain: input.domain } : {}),
          ...(input.displayName ? { display_name: input.displayName } : {}),
          ...(input.clientId ? { client_id: input.clientId } : {}),
          ...(input.metadata ? { metadata: input.metadata } : {}),
        },
        input.apiKey,
      );
      const inboxId = stringField(raw.inbox_id);
      const email = stringField(raw.email);
      if (!inboxId || !email) {
        throw new Error("AgentMail create inbox response was missing inbox_id or email.");
      }
      return {
        inboxId,
        email,
        displayName: stringField(raw.display_name) ?? undefined,
      };
    },

    async getInbox(apiKey, inboxId) {
      const path = `/inboxes/${encodeURIComponent(inboxId)}`;
      const raw = await getJson<unknown>(path, apiKey);
      return parseInboxResult(raw, inboxId, "get inbox");
    },

    async createInboxApiKey(input) {
      const raw = await postJson<Record<string, unknown>>(
        `/inboxes/${encodeURIComponent(input.inboxId)}/api-keys`,
        {
          name: input.name,
          permissions: input.permissions,
        },
        input.apiKey,
      );
      const apiKeyId = stringField(raw.api_key_id);
      const apiKey = stringField(raw.api_key);
      if (!apiKeyId || !apiKey) {
        throw new Error("AgentMail API key response was missing api_key_id or api_key.");
      }
      return {
        apiKeyId,
        apiKey,
        prefix: stringField(raw.prefix) ?? undefined,
        name: stringField(raw.name) ?? undefined,
      };
    },
  };
}

function stringField(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function parseInboxResult(
  value: unknown,
  expectedInboxId: string,
  operation: string,
): AgentMailInboxResult {
  if (!isRecord(value)) {
    throw new Error(`AgentMail ${operation} response was not an object.`);
  }
  const inboxId = strictString(value.inbox_id);
  const email = strictEmail(value.email);
  const displayName = optionalDisplayName(value.display_name);
  if (!inboxId || !email || displayName === null) {
    throw new Error(
      `AgentMail ${operation} response had an invalid inbox_id, email, or display_name.`,
    );
  }
  if (inboxId !== expectedInboxId) {
    throw new Error(`AgentMail ${operation} response did not match the requested inbox.`);
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
  if (/\p{Cc}/u.test(value)) return null;
  return value;
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
  if (value === undefined || value === null) return undefined;
  const displayName = strictString(value);
  if (!displayName || displayName.length > 256) return null;
  return displayName;
}
