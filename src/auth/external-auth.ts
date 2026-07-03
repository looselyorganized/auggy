import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  RouteAuthPrincipal,
  RouteExternalAuthClaims,
  RouteVisitorAuthContext,
} from "../types";

const ASSERTION_TYPE = "auggy.external-auth.v1";
const DEFAULT_TTL_SECONDS = 5 * 60;

export interface ExternalAuthClaims {
  provider: string;
  subject: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
  email?: string;
  emailVerified?: boolean;
  verifiedAt?: number;
  orgId?: string;
  roles?: readonly string[];
}

export interface CreateExternalAuthAssertionOptions {
  secret: string;
  audience: string;
  provider: string;
  subject: string;
  ttlSeconds?: number;
  now?: number;
  email?: string;
  emailVerified?: boolean;
  verifiedAt?: number;
  orgId?: string;
  roles?: readonly string[];
}

export interface VerifyExternalAuthAssertionOptions {
  secret: string;
  audience: string;
  now?: number;
  allowedProviders?: readonly string[];
  maxTtlSeconds?: number;
}

export type ExternalAuthAssertionFailureReason =
  | "malformed"
  | "invalid-payload"
  | "invalid-signature"
  | "audience-mismatch"
  | "provider-not-allowed"
  | "expired"
  | "not-yet-valid"
  | "ttl-too-long";

export type ExternalAuthAssertionVerification =
  | { ok: true; claims: ExternalAuthClaims }
  | { ok: false; reason: ExternalAuthAssertionFailureReason };

export interface ExternalAuthPrincipalOptions {
  visitorId?: string | ((claims: ExternalAuthClaims) => string);
  includeUnverifiedEmail?: boolean;
}

interface ExternalAuthAssertionPayload {
  typ: typeof ASSERTION_TYPE;
  aud: string;
  provider: string;
  sub: string;
  iat: number;
  exp: number;
  email?: string;
  emailVerified?: boolean;
  verifiedAt?: number;
  orgId?: string;
  roles?: readonly string[];
}

export function createExternalAuthAssertion(opts: CreateExternalAuthAssertionOptions): string {
  const now = opts.now ?? Date.now();
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!opts.secret) throw new Error("external auth assertion secret is required");
  if (ttlSeconds <= 0) throw new Error("external auth assertion ttlSeconds must be positive");

  const payload: ExternalAuthAssertionPayload = {
    typ: ASSERTION_TYPE,
    aud: opts.audience,
    provider: opts.provider,
    sub: opts.subject,
    iat: now,
    exp: now + ttlSeconds * 1000,
    ...(opts.email !== undefined ? { email: opts.email } : {}),
    ...(opts.emailVerified !== undefined ? { emailVerified: opts.emailVerified } : {}),
    ...(opts.verifiedAt !== undefined ? { verifiedAt: opts.verifiedAt } : {}),
    ...(opts.orgId !== undefined ? { orgId: opts.orgId } : {}),
    ...(opts.roles !== undefined ? { roles: [...opts.roles] } : {}),
  };
  const encodedPayload = encodeJson(payload);
  return `${encodedPayload}.${signPayload(encodedPayload, opts.secret)}`;
}

export function verifyExternalAuthAssertion(
  assertion: string,
  opts: VerifyExternalAuthAssertionOptions,
): ExternalAuthAssertionVerification {
  if (!opts.secret) return { ok: false, reason: "invalid-signature" };

  const [encodedPayload, signature, extra] = assertion.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    return { ok: false, reason: "malformed" };
  }
  if (!verifySignature(encodedPayload, signature, opts.secret)) {
    return { ok: false, reason: "invalid-signature" };
  }

  const payload = decodePayload(encodedPayload);
  if (!payload) return { ok: false, reason: "invalid-payload" };

  if (payload.aud !== opts.audience) return { ok: false, reason: "audience-mismatch" };
  if (opts.allowedProviders && !opts.allowedProviders.includes(payload.provider)) {
    return { ok: false, reason: "provider-not-allowed" };
  }

  const now = opts.now ?? Date.now();
  if (payload.exp <= now) return { ok: false, reason: "expired" };
  if (payload.iat > now + 30_000) return { ok: false, reason: "not-yet-valid" };
  if (opts.maxTtlSeconds !== undefined && payload.exp - payload.iat > opts.maxTtlSeconds * 1000) {
    return { ok: false, reason: "ttl-too-long" };
  }

  return {
    ok: true,
    claims: {
      provider: payload.provider,
      subject: payload.sub,
      audience: payload.aud,
      issuedAt: payload.iat,
      expiresAt: payload.exp,
      ...(payload.email !== undefined ? { email: payload.email } : {}),
      ...(payload.emailVerified !== undefined ? { emailVerified: payload.emailVerified } : {}),
      ...(payload.verifiedAt !== undefined ? { verifiedAt: payload.verifiedAt } : {}),
      ...(payload.orgId !== undefined ? { orgId: payload.orgId } : {}),
      ...(payload.roles !== undefined ? { roles: [...payload.roles] } : {}),
    },
  };
}

export function externalAuthClaimsToRoutePrincipal(
  claims: ExternalAuthClaims,
  opts: ExternalAuthPrincipalOptions = {},
): Extract<RouteAuthPrincipal, { kind: "visitor" }> {
  const visitorId = resolveVisitorId(claims, opts.visitorId);
  const includeEmail =
    claims.email !== undefined &&
    (claims.emailVerified === true || opts.includeUnverifiedEmail === true);
  return {
    kind: "visitor",
    trustLevel: "public",
    publicSubstate: "recognized",
    visitorId,
    agentId: claims.audience,
    ...(includeEmail ? { email: claims.email } : {}),
    ...(claims.verifiedAt !== undefined ? { verifiedAt: claims.verifiedAt } : {}),
    externalAuth: routeExternalAuthClaims(claims),
  };
}

export function externalAuthClaimsToRouteContext(
  claims: ExternalAuthClaims,
  opts: ExternalAuthPrincipalOptions = {},
): RouteVisitorAuthContext {
  const principal = externalAuthClaimsToRoutePrincipal(claims, opts);
  return {
    mode: "visitor",
    state: "recognized",
    visitorId: principal.visitorId,
    agentId: claims.audience,
    issuedAt: claims.issuedAt,
    expiresAt: claims.expiresAt,
    ...(principal.email !== undefined ? { email: principal.email } : {}),
    ...(principal.verifiedAt !== undefined ? { verifiedAt: principal.verifiedAt } : {}),
    externalAuth: principal.externalAuth,
    principal,
  };
}

export function externalSubjectVisitorId(
  claims: Pick<ExternalAuthClaims, "provider" | "subject">,
): string {
  const hash = createHash("sha256")
    .update(claims.provider)
    .update("\0")
    .update(claims.subject)
    .digest("base64url")
    .slice(0, 32);
  return `vis_ext_${hash}`;
}

function resolveVisitorId(
  claims: ExternalAuthClaims,
  visitorId: ExternalAuthPrincipalOptions["visitorId"],
): string {
  if (typeof visitorId === "function") return visitorId(claims);
  if (typeof visitorId === "string") return visitorId;
  return externalSubjectVisitorId(claims);
}

function routeExternalAuthClaims(claims: ExternalAuthClaims): RouteExternalAuthClaims {
  return {
    provider: claims.provider,
    subject: claims.subject,
    ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
    ...(claims.roles !== undefined ? { roles: [...claims.roles] } : {}),
  };
}

function encodeJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

function signPayload(encodedPayload: string, secret: string): string {
  return createHmac("sha256", `auggy-external-auth:${secret}`)
    .update(encodedPayload)
    .digest("base64url");
}

function verifySignature(encodedPayload: string, signature: string, secret: string): boolean {
  const expected = signPayload(encodedPayload, secret);
  const left = Buffer.from(signature);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function decodePayload(encodedPayload: string): ExternalAuthAssertionPayload | null {
  let raw: unknown;
  try {
    raw = JSON.parse(Buffer.from(encodedPayload, "base64url").toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(raw)) return null;
  if (raw.typ !== ASSERTION_TYPE) return null;
  if (typeof raw.aud !== "string" || raw.aud.length === 0) return null;
  if (typeof raw.provider !== "string" || raw.provider.length === 0) return null;
  if (typeof raw.sub !== "string" || raw.sub.length === 0) return null;
  if (typeof raw.iat !== "number" || !Number.isFinite(raw.iat)) return null;
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) return null;
  if (raw.email !== undefined && typeof raw.email !== "string") return null;
  if (raw.emailVerified !== undefined && typeof raw.emailVerified !== "boolean") return null;
  if (raw.verifiedAt !== undefined && typeof raw.verifiedAt !== "number") return null;
  if (raw.orgId !== undefined && typeof raw.orgId !== "string") return null;
  if (
    raw.roles !== undefined &&
    (!Array.isArray(raw.roles) || raw.roles.some((role) => typeof role !== "string"))
  ) {
    return null;
  }
  return {
    typ: ASSERTION_TYPE,
    aud: raw.aud,
    provider: raw.provider,
    sub: raw.sub,
    iat: raw.iat,
    exp: raw.exp,
    ...(raw.email !== undefined ? { email: raw.email } : {}),
    ...(raw.emailVerified !== undefined ? { emailVerified: raw.emailVerified } : {}),
    ...(raw.verifiedAt !== undefined ? { verifiedAt: raw.verifiedAt } : {}),
    ...(raw.orgId !== undefined ? { orgId: raw.orgId } : {}),
    ...(raw.roles !== undefined ? { roles: raw.roles } : {}),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
