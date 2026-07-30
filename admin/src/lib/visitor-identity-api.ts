import { adminFetch, type AdminFetchDependencies } from "./api";

export type VerifiedVisitorIdentity = {
  status: "verified";
  email: string;
  expiresAt: number;
};

export type InvalidVisitorIdentity = {
  status: "invalid";
  error: string;
};

export type UnconfiguredVisitorIdentity = {
  status: "not-configured";
  error: string;
};

export type VisitorIdentitySummary =
  | VerifiedVisitorIdentity
  | InvalidVisitorIdentity
  | UnconfiguredVisitorIdentity;

export type VisitorIdentityState =
  | { status: "absent" }
  | { status: "checking" }
  | VisitorIdentitySummary
  | { status: "unavailable"; error: string }
  | { status: "session-error"; error: string };

type VisitorIdentityRequestErrorKind =
  | "authorization"
  | "transient"
  | "request";

class VisitorIdentityRequestError extends Error {
  readonly status: number;
  readonly kind: VisitorIdentityRequestErrorKind;

  constructor(message: string, status: number, kind: VisitorIdentityRequestErrorKind) {
    super(message);
    this.name = "VisitorIdentityRequestError";
    this.status = status;
    this.kind = kind;
  }
}

export function isVisitorIdentityAuthorizationError(error: unknown): boolean {
  return error instanceof VisitorIdentityRequestError && error.kind === "authorization";
}

export async function resolveConsoleVisitorIdentity(
  visitorToken: string,
  csrf: string,
  dependencies: AdminFetchDependencies = {},
): Promise<VisitorIdentitySummary> {
  const response = await adminFetch(
    "/console/api/visitor-identity",
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({ csrf, visitorToken }),
    },
    dependencies,
  );
  if (response.status === 401) {
    const rejection = await readCredentialRejection(response);
    if (rejection) return { status: "invalid", error: rejection };
  }
  if (response.status === 501 && (await isNotConfiguredResponse(response))) {
    return {
      status: "not-configured",
      error: "Verified visitor identity is not configured for this agent.",
    };
  }
  if (!response.ok) {
    if (response.status === 401 || response.status === 403 || response.status === 419) {
      throw new VisitorIdentityRequestError(
        "Console authorization could not be verified. Reload and sign in again.",
        response.status,
        "authorization",
      );
    }
    if (response.status >= 500) {
      throw new VisitorIdentityRequestError(
        "Visitor identity is temporarily unavailable.",
        response.status,
        "transient",
      );
    }
    throw new VisitorIdentityRequestError(
      `Visitor identity request failed (${response.status}).`,
      response.status,
      "request",
    );
  }
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    throw new Error("Visitor identity response was not JSON.");
  }

  let value: unknown;
  try {
    value = await response.json();
  } catch {
    throw new Error("Visitor identity response was malformed.");
  }
  if (!isRecord(value) || !hasExactKeys(value, ["identity"]) || !isRecord(value.identity)) {
    throw new Error("Visitor identity response was malformed.");
  }
  const identity = value.identity;
  if (
    identity.status === "verified" &&
    hasExactKeys(identity, ["status", "email", "expiresAt"]) &&
    typeof identity.email === "string" &&
    identity.email.trim() !== "" &&
    typeof identity.expiresAt === "number" &&
    Number.isFinite(identity.expiresAt)
  ) {
    return {
      status: "verified",
      email: identity.email,
      expiresAt: identity.expiresAt,
    };
  }
  if (
    identity.status === "invalid" &&
    hasExactKeys(identity, ["status", "error"]) &&
    typeof identity.error === "string" &&
    identity.error.trim() !== ""
  ) {
    return { status: "invalid", error: identity.error };
  }
  throw new Error("Visitor identity response was malformed.");
}

async function isNotConfiguredResponse(response: Response): Promise<boolean> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return false;
  }
  try {
    const value: unknown = await response.json();
    return (
      isRecord(value) &&
      hasExactKeys(value, ["error", "code"]) &&
      value.code === "visitor_identity_not_configured" &&
      typeof value.error === "string"
    );
  } catch {
    return false;
  }
}

async function readCredentialRejection(response: Response): Promise<string | null> {
  if (!response.headers.get("content-type")?.toLowerCase().includes("application/json")) {
    return null;
  }
  try {
    const value: unknown = await response.json();
    if (
      isRecord(value) &&
      hasExactKeys(value, ["error", "code"]) &&
      value.code === "visitor_credential_rejected" &&
      typeof value.error === "string"
    ) {
      return "Visitor credential was rejected.";
    }
    if (
      isRecord(value) &&
      hasExactKeys(value, ["identity"]) &&
      isRecord(value.identity) &&
      hasExactKeys(value.identity, ["status", "error"]) &&
      value.identity.status === "invalid" &&
      typeof value.identity.error === "string" &&
      value.identity.error.trim() !== ""
    ) {
      return value.identity.error;
    }
  } catch {
    return null;
  }
  return null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  const expectedKeys = [...expected].sort();
  return keys.length === expectedKeys.length && keys.every((key, index) => key === expectedKeys[index]);
}
