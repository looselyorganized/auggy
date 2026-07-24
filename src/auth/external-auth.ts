import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type {
  AuthorizationConstraints,
  AuthorizationConstraintValue,
  AuthorizationGrant,
  AuthorizationScope,
  RouteAuthPrincipal,
  RouteExternalAuthClaims,
  RouteVisitorAuthContext,
} from "../types";

const ASSERTION_TYPE = "auggy.external-auth.v1";
const DEFAULT_TTL_SECONDS = 5 * 60;
const MAX_AUDIENCE_LENGTH = 256;
const MAX_PROVIDER_LENGTH = 128;
const MAX_SUBJECT_LENGTH = 512;
const MAX_ORG_ID_LENGTH = 256;

export interface ExternalAuthClaims {
  keyId?: string;
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
  scopes?: readonly AuthorizationScope[];
  grants?: readonly AuthorizationGrant[];
  authzVersion?: string;
  jti?: string;
}

export interface CreateExternalAuthAssertionOptions {
  secret: string;
  keyId?: string;
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
  scopes?: readonly AuthorizationScope[];
  grants?: readonly AuthorizationGrant[];
  authzVersion?: string;
  jti?: string;
}

export interface VerifyExternalAuthAssertionOptions {
  secret?: string;
  keyId?: string;
  secrets?: readonly ExternalAuthAssertionSecret[];
  audience: string;
  now?: number;
  allowedProviders?: readonly string[];
  maxTtlSeconds?: number;
}

export interface ExternalAuthAssertionSecret {
  secret: string;
  keyId?: string;
}

export interface ExternalAuthReplayStore {
  /**
   * Atomically record a verified assertion id until its expiry. Return false
   * when the id has already been recorded and has not expired.
   */
  consume(jti: string, expiresAt: number, now: number): boolean | Promise<boolean>;
}

export type ExternalAuthAssertionFailureReason =
  | "malformed"
  | "invalid-payload"
  | "invalid-signature"
  | "key-not-found"
  | "audience-mismatch"
  | "provider-not-allowed"
  | "expired"
  | "not-yet-valid"
  | "ttl-too-long";

export type ExternalAuthAssertionVerification =
  | { ok: true; claims: ExternalAuthClaims }
  | { ok: false; reason: ExternalAuthAssertionFailureReason };

export interface ExternalAuthPrincipalOptions {
  /**
   * Optional app account namespace. The runtime hashes this value together
   * with verified provider, subject, and organization claims; it is not used
   * verbatim as a peer ID.
   */
  visitorId?: string | ((claims: ExternalAuthClaims) => string);
  includeUnverifiedEmail?: boolean;
}

interface ExternalAuthAssertionPayload {
  typ: typeof ASSERTION_TYPE;
  kid?: string;
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
  scopes?: readonly AuthorizationScope[];
  grants?: readonly AuthorizationGrant[];
  authzVersion?: string;
  jti?: string;
}

export function createExternalAuthAssertion(opts: CreateExternalAuthAssertionOptions): string {
  const now = opts.now ?? Date.now();
  const ttlSeconds = opts.ttlSeconds ?? DEFAULT_TTL_SECONDS;
  if (!opts.secret) throw new Error("external auth assertion secret is required");
  if (opts.keyId !== undefined && opts.keyId.trim() === "") {
    throw new Error("external auth assertion keyId must be non-empty when provided");
  }
  if (!Number.isSafeInteger(ttlSeconds) || ttlSeconds <= 0) {
    throw new Error("external auth assertion ttlSeconds must be a positive integer");
  }
  assertIdentityClaim("audience", opts.audience, MAX_AUDIENCE_LENGTH);
  assertIdentityClaim("provider", opts.provider, MAX_PROVIDER_LENGTH);
  assertIdentityClaim("subject", opts.subject, MAX_SUBJECT_LENGTH);
  if (opts.orgId !== undefined) {
    assertIdentityClaim("orgId", opts.orgId, MAX_ORG_ID_LENGTH);
  }

  const payload: ExternalAuthAssertionPayload = {
    typ: ASSERTION_TYPE,
    ...(opts.keyId !== undefined ? { kid: opts.keyId } : {}),
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
    ...(opts.scopes !== undefined ? { scopes: [...opts.scopes] } : {}),
    ...(opts.grants !== undefined ? { grants: cloneAuthorizationGrants(opts.grants) } : {}),
    ...(opts.authzVersion !== undefined ? { authzVersion: opts.authzVersion } : {}),
    ...(opts.jti !== undefined ? { jti: opts.jti } : {}),
  };
  const encodedPayload = encodeJson(payload);
  return `${encodedPayload}.${signPayload(encodedPayload, opts.secret)}`;
}

export function verifyExternalAuthAssertion(
  assertion: string,
  opts: VerifyExternalAuthAssertionOptions,
): ExternalAuthAssertionVerification {
  if (
    opts.allowedProviders !== undefined &&
    (!Array.isArray(opts.allowedProviders) ||
      opts.allowedProviders.length === 0 ||
      opts.allowedProviders.some(
        (provider) => typeof provider !== "string" || provider.trim() === "",
      ))
  ) {
    return { ok: false, reason: "provider-not-allowed" };
  }
  if (
    opts.maxTtlSeconds !== undefined &&
    (!Number.isSafeInteger(opts.maxTtlSeconds) || opts.maxTtlSeconds <= 0)
  ) {
    return { ok: false, reason: "ttl-too-long" };
  }
  const secrets = normalizeAssertionSecrets(opts);
  if (secrets.length === 0) return { ok: false, reason: "invalid-signature" };

  const [encodedPayload, signature, extra] = assertion.split(".");
  if (!encodedPayload || !signature || extra !== undefined) {
    return { ok: false, reason: "malformed" };
  }

  const payload = decodePayload(encodedPayload);
  if (!payload) return { ok: false, reason: "invalid-payload" };
  const candidateSecrets = secretsForPayload(secrets, payload);
  if (candidateSecrets.length === 0) return { ok: false, reason: "key-not-found" };
  if (!candidateSecrets.some((entry) => verifySignature(encodedPayload, signature, entry.secret))) {
    return { ok: false, reason: "invalid-signature" };
  }

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
      ...(payload.kid !== undefined ? { keyId: payload.kid } : {}),
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
      ...(payload.scopes !== undefined ? { scopes: [...payload.scopes] } : {}),
      ...(payload.grants !== undefined ? { grants: cloneAuthorizationGrants(payload.grants) } : {}),
      ...(payload.authzVersion !== undefined ? { authzVersion: payload.authzVersion } : {}),
      ...(payload.jti !== undefined ? { jti: payload.jti } : {}),
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
    ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
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
    ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
    ...(principal.email !== undefined ? { email: principal.email } : {}),
    ...(principal.verifiedAt !== undefined ? { verifiedAt: principal.verifiedAt } : {}),
    externalAuth: principal.externalAuth,
    principal,
  };
}

export function externalSubjectVisitorId(
  claims: Pick<ExternalAuthClaims, "provider" | "subject" | "orgId">,
): string {
  assertIdentityClaim("provider", claims.provider, MAX_PROVIDER_LENGTH);
  assertIdentityClaim("subject", claims.subject, MAX_SUBJECT_LENGTH);
  if (claims.orgId !== undefined) {
    assertIdentityClaim("orgId", claims.orgId, MAX_ORG_ID_LENGTH);
  }
  const digest = createHash("sha256");
  if (claims.orgId === undefined) {
    // Preserve the original no-organization identifier byte-for-byte so
    // existing visitor memory and thread ownership remain reachable.
    digest.update(claims.provider).update("\0").update(claims.subject);
  } else {
    // A versioned JSON tuple is unambiguous even when future claim syntax
    // admits delimiter-like text.
    digest
      .update("auggy-external-subject-v2\0")
      .update(JSON.stringify([claims.provider, claims.subject, claims.orgId]));
  }
  const hash = digest.digest("base64url").slice(0, 32);
  return `vis_ext_${hash}`;
}

/**
 * Bind an operator-provided account label to the authenticated subject that
 * supplied it. A mapper is useful for choosing a stable namespace, but its
 * output is not itself authentication evidence: a constant or buggy mapper
 * must not collapse unrelated external subjects into one runtime peer.
 */
export function externalMappedVisitorId(
  claims: Pick<ExternalAuthClaims, "provider" | "subject" | "orgId">,
  mappedVisitorId: string,
): string {
  assertIdentityClaim("provider", claims.provider, MAX_PROVIDER_LENGTH);
  assertIdentityClaim("subject", claims.subject, MAX_SUBJECT_LENGTH);
  if (claims.orgId !== undefined) {
    assertIdentityClaim("orgId", claims.orgId, MAX_ORG_ID_LENGTH);
  }
  assertIdentityClaim("visitorId", mappedVisitorId, 256);
  const hash = createHash("sha256")
    .update("auggy-external-mapped-visitor-v1\0")
    .update(
      JSON.stringify([mappedVisitorId, claims.provider, claims.subject, claims.orgId ?? null]),
    )
    .digest("base64url")
    .slice(0, 32);
  return `vis_extmap_${hash}`;
}

export function createInMemoryExternalAuthReplayStore(): ExternalAuthReplayStore {
  const seen = new Map<string, number>();
  let touches = 0;

  function prune(now: number): void {
    for (const [jti, expiresAt] of seen) {
      if (expiresAt <= now) seen.delete(jti);
    }
  }

  return {
    consume(jti, expiresAt, now) {
      if (++touches >= 128) {
        touches = 0;
        prune(now);
      }
      const previousExpiresAt = seen.get(jti);
      if (previousExpiresAt !== undefined && previousExpiresAt > now) return false;
      if (expiresAt <= now) return false;
      seen.set(jti, expiresAt);
      return true;
    },
  };
}

function resolveVisitorId(
  claims: ExternalAuthClaims,
  visitorId: ExternalAuthPrincipalOptions["visitorId"],
): string {
  if (typeof visitorId === "function") {
    return externalMappedVisitorId(claims, visitorId(claims));
  }
  if (typeof visitorId === "string") {
    return externalMappedVisitorId(claims, visitorId);
  }
  return externalSubjectVisitorId(claims);
}

function assertIdentityClaim(label: string, value: string, maxLength: number): void {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maxLength ||
    hasControlCharacter(value)
  ) {
    throw new Error(
      `external auth assertion ${label} must be 1-${maxLength} characters without control characters`,
    );
  }
}

function routeExternalAuthClaims(claims: ExternalAuthClaims): RouteExternalAuthClaims {
  return {
    ...(claims.keyId !== undefined ? { keyId: claims.keyId } : {}),
    provider: claims.provider,
    subject: claims.subject,
    ...(claims.orgId !== undefined ? { orgId: claims.orgId } : {}),
    ...(claims.roles !== undefined ? { roles: [...claims.roles] } : {}),
    ...(claims.scopes !== undefined ? { scopes: [...claims.scopes] } : {}),
    ...(claims.grants !== undefined ? { grants: cloneAuthorizationGrants(claims.grants) } : {}),
    ...(claims.authzVersion !== undefined ? { authzVersion: claims.authzVersion } : {}),
    ...(claims.jti !== undefined ? { jti: claims.jti } : {}),
  };
}

function normalizeAssertionSecrets(
  opts: VerifyExternalAuthAssertionOptions,
): readonly Required<ExternalAuthAssertionSecret>[] {
  const entries = [
    ...(opts.secret !== undefined ? [{ secret: opts.secret, keyId: opts.keyId }] : []),
    ...(opts.secrets ?? []),
  ];
  const normalized: Required<ExternalAuthAssertionSecret>[] = [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.secret) continue;
    if (entry.keyId !== undefined && entry.keyId.trim() === "") continue;
    const keyId = entry.keyId ?? "";
    const dedupeKey = `${keyId}\0${entry.secret}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    normalized.push({ secret: entry.secret, keyId });
  }
  return normalized;
}

function secretsForPayload(
  secrets: readonly Required<ExternalAuthAssertionSecret>[],
  payload: ExternalAuthAssertionPayload,
): readonly Required<ExternalAuthAssertionSecret>[] {
  if (payload.kid === undefined) return secrets;
  return secrets.filter((entry) => entry.keyId === payload.kid);
}

function cloneAuthorizationGrants(grants: readonly AuthorizationGrant[]): AuthorizationGrant[] {
  return grants.map((grant) => ({
    action: grant.action,
    ...(grant.resource !== undefined ? { resource: grant.resource } : {}),
    ...(grant.constraints !== undefined
      ? { constraints: cloneConstraintValue(grant.constraints) as AuthorizationConstraints }
      : {}),
  }));
}

function cloneConstraintValue(value: AuthorizationConstraintValue): AuthorizationConstraintValue {
  if (Array.isArray(value)) return value.map(cloneConstraintValue);
  if (isRecord(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, cloneConstraintValue(item)]),
    );
  }
  return value;
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
  if (raw.kid !== undefined && (typeof raw.kid !== "string" || raw.kid.trim() === "")) {
    return null;
  }
  if (!isIdentityClaim(raw.aud, MAX_AUDIENCE_LENGTH)) return null;
  if (!isIdentityClaim(raw.provider, MAX_PROVIDER_LENGTH)) return null;
  if (!isIdentityClaim(raw.sub, MAX_SUBJECT_LENGTH)) return null;
  if (typeof raw.iat !== "number" || !Number.isFinite(raw.iat)) return null;
  if (typeof raw.exp !== "number" || !Number.isFinite(raw.exp)) return null;
  if (raw.email !== undefined && typeof raw.email !== "string") return null;
  if (raw.emailVerified !== undefined && typeof raw.emailVerified !== "boolean") return null;
  if (raw.verifiedAt !== undefined && typeof raw.verifiedAt !== "number") return null;
  if (raw.orgId !== undefined && !isIdentityClaim(raw.orgId, MAX_ORG_ID_LENGTH)) return null;
  if (
    raw.roles !== undefined &&
    (!Array.isArray(raw.roles) || raw.roles.some((role) => typeof role !== "string"))
  ) {
    return null;
  }
  if (
    raw.scopes !== undefined &&
    (!Array.isArray(raw.scopes) ||
      raw.scopes.some((scope) => typeof scope !== "string" || scope.length === 0))
  ) {
    return null;
  }
  if (
    raw.grants !== undefined &&
    (!Array.isArray(raw.grants) || raw.grants.some((grant) => !isAuthorizationGrantPayload(grant)))
  ) {
    return null;
  }
  if (
    raw.authzVersion !== undefined &&
    (typeof raw.authzVersion !== "string" || raw.authzVersion.length === 0)
  ) {
    return null;
  }
  if (raw.jti !== undefined && (typeof raw.jti !== "string" || raw.jti.length === 0)) {
    return null;
  }
  return {
    typ: ASSERTION_TYPE,
    ...(raw.kid !== undefined ? { kid: raw.kid } : {}),
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
    ...(raw.scopes !== undefined ? { scopes: raw.scopes } : {}),
    ...(raw.grants !== undefined ? { grants: cloneAuthorizationGrants(raw.grants) } : {}),
    ...(raw.authzVersion !== undefined ? { authzVersion: raw.authzVersion } : {}),
    ...(raw.jti !== undefined ? { jti: raw.jti } : {}),
  };
}

function isIdentityClaim(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacter(value)
  );
}

function hasControlCharacter(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function isAuthorizationGrantPayload(value: unknown): value is AuthorizationGrant {
  if (!isRecord(value)) return false;
  if (typeof value.action !== "string" || value.action.length === 0) return false;
  if (
    value.resource !== undefined &&
    (typeof value.resource !== "string" || value.resource.length === 0)
  ) {
    return false;
  }
  if (value.constraints !== undefined && !isAuthorizationConstraints(value.constraints)) {
    return false;
  }
  return true;
}

function isAuthorizationConstraints(value: unknown): value is AuthorizationConstraints {
  if (!isRecord(value)) return false;
  return Object.values(value).every(isAuthorizationConstraintValue);
}

function isAuthorizationConstraintValue(value: unknown): value is AuthorizationConstraintValue {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "boolean":
      return true;
    case "number":
      return Number.isFinite(value);
    case "object":
      if (Array.isArray(value)) return value.every(isAuthorizationConstraintValue);
      if (!isRecord(value)) return false;
      return Object.values(value).every(isAuthorizationConstraintValue);
    default:
      return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
