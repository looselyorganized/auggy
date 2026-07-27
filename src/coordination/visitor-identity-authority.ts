import { migratePostgresCoordinator, type PostgresMigrationExecutor } from "./migrations";
import { createSecurePostgresCoordinationClient } from "./postgres-url";

type Row = Record<string, unknown>;

interface SqlTransaction extends PostgresMigrationExecutor {
  begin<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

const MAX_CAPACITY = 1_000_000;
const MAX_RETENTION_MS = 31_536_000_000;
const MAX_RATE_INTERVAL_MS = 86_400_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;
const DIGEST = /^[0-9a-f]{64}$/;
const VISITOR_ID = /^vis_[A-Za-z0-9._:-]{1,200}$/;
const REASON_CODE = /^[a-z0-9][a-z0-9._:-]{0,63}$/;

export interface VisitorIdentityAuthorityPolicy {
  maxVerificationRequests: number;
  maxVisitors: number;
  maxExternalAssertions: number;
  verificationTokenTtlMs: number;
  verificationRequestRetentionMs: number;
  reverifyAfterMs: number;
  maxExternalAssertionTtlMs: number;
  rateLimit: {
    perHour: number;
    perDay: number;
    minIntervalMs: number;
  };
}

export interface PostgresVisitorIdentityAuthorityOptions {
  url?: string;
  sql?: SqlTransaction;
  namespace: string;
  audience: string;
  policy: VisitorIdentityAuthorityPolicy;
}

export interface IssueVerificationRequest {
  requestId: string;
  bindingHash: string;
  token: string;
  email: string;
  peerId: string;
  threadId: string;
}

export type IssueVerificationRequestResult =
  | { status: "issued" | "replayed"; issuedAt: number; expiresAt: number }
  | { status: "conflict" | "capacity" | "unavailable" }
  | { status: "rate-limited"; retryAfterMs: number };

export interface VerifyVisitorRequest {
  token: string;
}

export type VerifyVisitorResult =
  | {
      status: "verified";
      visitorId: string;
      identityVersion: number;
      email: string;
      verifiedAt: number;
      reverifyDueAt: number;
      authoritativeNow: number;
      priorPeerId: string;
      priorThreadId: string;
    }
  | { status: "unknown" | "consumed" | "expired" | "revoked" | "capacity" | "unavailable" };

export type ResolveSharedVisitorResult =
  | {
      status: "active";
      visitorId: string;
      identityVersion: number;
      email: string;
      verifiedAt: number;
      reverifyDueAt: number;
    }
  | { status: "unknown" | "expired" | "revoked" | "unavailable" };

export interface SharedVisitorPromotionRequest {
  visitorId: string;
  identityVersion: number;
  peerId: string;
  threadId: string;
}

export interface ExternalAssertionClaimRequest {
  provider: string;
  keyId: string | null;
  jti: string;
  requestId: string;
  bindingHash: string;
  expiresAt: number;
}

export type ExternalAssertionClaimResult = {
  status: "claimed" | "replayed" | "conflict" | "invalid" | "expired" | "capacity" | "unavailable";
};

export interface VisitorIdentityAuthority {
  register(): Promise<{ status: "registered" | "conflict" | "unavailable" }>;
  issueVerificationRequest(
    request: IssueVerificationRequest,
  ): Promise<IssueVerificationRequestResult>;
  verify(request: VerifyVisitorRequest): Promise<VerifyVisitorResult>;
  resolveVisitor(
    visitorId: string,
    identityVersion: number,
    credentialExpiresAt?: number,
  ): Promise<ResolveSharedVisitorResult>;
  canPromote(
    request: SharedVisitorPromotionRequest,
  ): Promise<{ status: "allowed" | "denied" | "unavailable" }>;
  revokeByEmail(
    email: string,
    reason: string,
  ): Promise<
    | { status: "revoked"; visitorId: string; identityVersion: number; wasRevoked: boolean }
    | { status: "missing" | "unavailable" }
  >;
  claimExternalAssertion(
    request: ExternalAssertionClaimRequest,
  ): Promise<ExternalAssertionClaimResult>;
  close(): Promise<void>;
}

function digest(domain: string, ...values: string[]): string {
  const hasher = new Bun.CryptoHasher("sha256").update(domain).update("\0");
  for (const value of values) hasher.update(value).update("\0");
  return hasher.digest("hex");
}

function canonicalEmail(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (
    normalized.length < 3 ||
    normalized.length > 320 ||
    !normalized.includes("@") ||
    hasControlCharacter(normalized)
  ) {
    throw new Error("visitor authority email is invalid");
  }
  return normalized;
}

function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function assertBoundedText(name: string, value: string, maximum: number): void {
  if (
    typeof value !== "string" ||
    value.length < 1 ||
    value.length > maximum ||
    hasControlCharacter(value)
  ) {
    throw new Error(`${name} is invalid`);
  }
}

function assertPositiveInteger(name: string, value: number, maximum = MAX_CAPACITY): void {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new Error(`${name} is invalid`);
  }
}

function date(row: Row, key: string): number {
  const value = row[key];
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`invalid visitor authority row: ${key}`);
  return parsed;
}

function nullableDate(row: Row, key: string): number | null {
  return row[key] === null ? null : date(row, key);
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid visitor authority row: ${key}`);
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value))
  ) {
    throw new Error(`invalid visitor authority row: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid visitor authority row: ${key}`);
  return parsed;
}

function policyFingerprint(policy: VisitorIdentityAuthorityPolicy): string {
  return digest("auggy-visitor-authority-policy-v1", JSON.stringify(policy));
}

function validateOptions(options: PostgresVisitorIdentityAuthorityOptions): void {
  if (!options.sql && !options.url) throw new Error("visitor authority requires url or sql");
  assertBoundedText("visitor authority namespace", options.namespace, 160);
  assertBoundedText("visitor authority audience", options.audience, 256);
  const policy = options.policy;
  assertPositiveInteger("maxVerificationRequests", policy.maxVerificationRequests);
  assertPositiveInteger("maxVisitors", policy.maxVisitors);
  assertPositiveInteger("maxExternalAssertions", policy.maxExternalAssertions);
  assertPositiveInteger("verificationTokenTtlMs", policy.verificationTokenTtlMs, MAX_RETENTION_MS);
  assertPositiveInteger(
    "verificationRequestRetentionMs",
    policy.verificationRequestRetentionMs,
    MAX_RETENTION_MS,
  );
  if (policy.verificationRequestRetentionMs < 60_000) {
    throw new Error("verificationRequestRetentionMs is invalid");
  }
  assertPositiveInteger("reverifyAfterMs", policy.reverifyAfterMs, MAX_RETENTION_MS);
  assertPositiveInteger(
    "maxExternalAssertionTtlMs",
    policy.maxExternalAssertionTtlMs,
    MAX_RETENTION_MS,
  );
  assertPositiveInteger("rateLimit.perHour", policy.rateLimit.perHour);
  assertPositiveInteger("rateLimit.perDay", policy.rateLimit.perDay);
  if (policy.rateLimit.perDay < policy.rateLimit.perHour) {
    throw new Error("rateLimit.perDay must be at least rateLimit.perHour");
  }
  if (
    !Number.isSafeInteger(policy.rateLimit.minIntervalMs) ||
    policy.rateLimit.minIntervalMs < 0 ||
    policy.rateLimit.minIntervalMs > MAX_RATE_INTERVAL_MS
  ) {
    throw new Error("rateLimit.minIntervalMs is invalid");
  }
}

/**
 * Namespace-scoped shared identity authority for the distributed preview.
 * Every authority decision uses PostgreSQL time while holding the immutable
 * audience policy row. Direct verification delivery is deliberately outside
 * this class and remains disabled until the durable outbox checkpoints.
 */
export class PostgresVisitorIdentityAuthority implements VisitorIdentityAuthority {
  readonly #namespace: string;
  readonly #audience: string;
  readonly #policy: VisitorIdentityAuthorityPolicy;
  readonly #policyFingerprint: string;
  readonly #sql: SqlTransaction;
  readonly #ownsSql: boolean;

  constructor(options: PostgresVisitorIdentityAuthorityOptions) {
    validateOptions(options);
    this.#namespace = options.namespace;
    this.#audience = options.audience;
    this.#policy = {
      ...options.policy,
      rateLimit: { ...options.policy.rateLimit },
    };
    this.#policyFingerprint = policyFingerprint(this.#policy);
    this.#ownsSql = !options.sql;
    this.#sql = (options.sql ??
      createSecurePostgresCoordinationClient(options.url!)) as unknown as SqlTransaction;
  }

  async migrate(): Promise<void> {
    await migratePostgresCoordinator(this.#sql);
  }

  async register(): Promise<{ status: "registered" | "conflict" | "unavailable" }> {
    try {
      return await this.#sql.begin(async (tx) => {
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_visitor_authorities (namespace, audience, policy_fingerprint, max_verification_requests, max_visitors, max_external_assertions, verification_token_ttl_ms, verification_request_retention_ms, reverify_after_ms, max_external_assertion_ttl_ms, rate_per_hour, rate_per_day, rate_min_interval_ms) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (namespace, audience) DO NOTHING",
          [
            this.#namespace,
            this.#audience,
            this.#policyFingerprint,
            this.#policy.maxVerificationRequests,
            this.#policy.maxVisitors,
            this.#policy.maxExternalAssertions,
            this.#policy.verificationTokenTtlMs,
            this.#policy.verificationRequestRetentionMs,
            this.#policy.reverifyAfterMs,
            this.#policy.maxExternalAssertionTtlMs,
            this.#policy.rateLimit.perHour,
            this.#policy.rateLimit.perDay,
            this.#policy.rateLimit.minIntervalMs,
          ],
        );
        const row = await this.#lockAuthority(tx);
        return row ? { status: "registered" as const } : { status: "conflict" as const };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async issueVerificationRequest(
    request: IssueVerificationRequest,
  ): Promise<IssueVerificationRequestResult> {
    try {
      this.#validateVerificationRequest(request);
      const email = canonicalEmail(request.email);
      const tokenHash = digest("auggy-visitor-verification-token-v1", request.token);
      const emailHash = digest("auggy-visitor-email-v1", email);
      const peerHash = digest("auggy-visitor-peer-v1", request.peerId);
      const threadHash = digest("auggy-visitor-thread-v1", request.threadId);
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "conflict" as const };
        const existing = await tx.unsafe<Row>(
          "SELECT binding_hash, token_hash, email_hash, peer_hash, thread_hash, issued_at, expires_at FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND request_id = $3 FOR UPDATE",
          [this.#namespace, this.#audience, request.requestId],
        );
        if (existing[0]) {
          const row = existing[0];
          if (
            text(row, "binding_hash") !== request.bindingHash ||
            text(row, "token_hash") !== tokenHash ||
            text(row, "email_hash") !== emailHash ||
            text(row, "peer_hash") !== peerHash ||
            text(row, "thread_hash") !== threadHash
          ) {
            return { status: "conflict" as const };
          }
          return {
            status: "replayed" as const,
            issuedAt: date(row, "issued_at"),
            expiresAt: date(row, "expires_at"),
          };
        }
        const tokenOwner = await tx.unsafe<Row>(
          "SELECT request_id FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND token_hash = $3 FOR UPDATE",
          [this.#namespace, this.#audience, tokenHash],
        );
        if (tokenOwner.length > 0) return { status: "conflict" as const };

        await tx.unsafe(
          "DELETE FROM public.auggy_coordination_visitor_requests WHERE ctid IN (SELECT ctid FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND ((status <> 'open' AND terminal_at < clock_timestamp() - $3 * INTERVAL '1 millisecond') OR (status = 'open' AND expires_at < clock_timestamp() - $3 * INTERVAL '1 millisecond')) ORDER BY COALESCE(terminal_at, expires_at), request_id LIMIT 1000)",
          [this.#namespace, this.#audience, this.#policy.verificationRequestRetentionMs],
        );
        const countRows = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS count FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2",
          [this.#namespace, this.#audience],
        );
        if (number(countRows[0]!, "count") >= this.#policy.maxVerificationRequests) {
          return { status: "capacity" as const };
        }

        const rateRows = await tx.unsafe<Row>(
          "SELECT count(*) FILTER (WHERE issued_at > clock_timestamp() - INTERVAL '1 hour')::integer AS hour_count, count(*) FILTER (WHERE issued_at > clock_timestamp() - INTERVAL '1 day')::integer AS day_count, max(issued_at) AS latest FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND email_hash = $3",
          [this.#namespace, this.#audience, emailHash],
        );
        const rate = rateRows[0]!;
        const latest = nullableDate(rate, "latest");
        const nowRows = await tx.unsafe<Row>("SELECT clock_timestamp() AS now");
        const now = date(nowRows[0]!, "now");
        let retryAfterMs = 0;
        if (number(rate, "hour_count") >= this.#policy.rateLimit.perHour) {
          const oldest = await tx.unsafe<Row>(
            "SELECT issued_at FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND email_hash = $3 AND issued_at > clock_timestamp() - INTERVAL '1 hour' ORDER BY issued_at, request_id LIMIT 1",
            [this.#namespace, this.#audience, emailHash],
          );
          retryAfterMs = Math.max(retryAfterMs, date(oldest[0]!, "issued_at") + 3_600_000 - now);
        }
        if (number(rate, "day_count") >= this.#policy.rateLimit.perDay) {
          const oldest = await tx.unsafe<Row>(
            "SELECT issued_at FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND email_hash = $3 AND issued_at > clock_timestamp() - INTERVAL '1 day' ORDER BY issued_at, request_id LIMIT 1",
            [this.#namespace, this.#audience, emailHash],
          );
          retryAfterMs = Math.max(retryAfterMs, date(oldest[0]!, "issued_at") + 86_400_000 - now);
        }
        if (latest !== null) {
          retryAfterMs = Math.max(
            retryAfterMs,
            latest + this.#policy.rateLimit.minIntervalMs - now,
          );
        }
        if (retryAfterMs > 0) {
          return { status: "rate-limited" as const, retryAfterMs: Math.ceil(retryAfterMs) };
        }

        const inserted = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_visitor_requests (namespace, audience, request_id, binding_hash, token_hash, email, email_hash, peer_id, peer_hash, thread_id, thread_hash, expires_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, clock_timestamp() + $12 * INTERVAL '1 millisecond') RETURNING issued_at, expires_at",
          [
            this.#namespace,
            this.#audience,
            request.requestId,
            request.bindingHash,
            tokenHash,
            email,
            emailHash,
            request.peerId,
            peerHash,
            request.threadId,
            threadHash,
            this.#policy.verificationTokenTtlMs,
          ],
        );
        return {
          status: "issued" as const,
          issuedAt: date(inserted[0]!, "issued_at"),
          expiresAt: date(inserted[0]!, "expires_at"),
        };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async verify(request: VerifyVisitorRequest): Promise<VerifyVisitorResult> {
    try {
      assertBoundedText("verification token", request.token, 512);
      const tokenHash = digest("auggy-visitor-verification-token-v1", request.token);
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "unavailable" as const };
        const requestRows = await tx.unsafe<Row>(
          "SELECT email, email_hash, peer_id, thread_id, issued_at, expires_at, status FROM public.auggy_coordination_visitor_requests WHERE namespace = $1 AND audience = $2 AND token_hash = $3 FOR UPDATE",
          [this.#namespace, this.#audience, tokenHash],
        );
        const evidence = requestRows[0];
        if (!evidence) return { status: "unknown" as const };
        const status = text(evidence, "status");
        if (status === "verified") return { status: "consumed" as const };
        if (status === "revoked") return { status: "revoked" as const };
        const nowRows = await tx.unsafe<Row>("SELECT clock_timestamp() AS now");
        const now = date(nowRows[0]!, "now");
        if (date(evidence, "expires_at") <= now) return { status: "expired" as const };

        const emailHash = text(evidence, "email_hash");
        const visitorRows = await tx.unsafe<Row>(
          "SELECT visitor_id, identity_version, email, verified_at, reverify_due_at, revoked_at FROM public.auggy_coordination_visitors WHERE namespace = $1 AND audience = $2 AND email_hash = $3 ORDER BY identity_version DESC LIMIT 1 FOR UPDATE",
          [this.#namespace, this.#audience, emailHash],
        );
        const current = visitorRows[0];
        const issuedAt = date(evidence, "issued_at");
        const revokedAt = current ? nullableDate(current, "revoked_at") : null;
        if (revokedAt !== null && issuedAt <= revokedAt) {
          await tx.unsafe(
            "UPDATE public.auggy_coordination_visitor_requests SET status = 'revoked', terminal_at = clock_timestamp() WHERE namespace = $1 AND audience = $2 AND token_hash = $3 AND status = 'open'",
            [this.#namespace, this.#audience, tokenHash],
          );
          return { status: "revoked" as const };
        }

        let visitorId: string;
        let identityVersion: number;
        let verifiedAt: number;
        let reverifyDueAt: number;
        if (current && revokedAt === null) {
          visitorId = text(current, "visitor_id");
          identityVersion = number(current, "identity_version");
          const renewed = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_visitors SET verified_at = clock_timestamp(), last_seen_at = clock_timestamp(), reverify_due_at = clock_timestamp() + $4 * INTERVAL '1 millisecond' WHERE namespace = $1 AND audience = $2 AND visitor_id = $3 AND revoked_at IS NULL RETURNING verified_at, reverify_due_at",
            [this.#namespace, this.#audience, visitorId, this.#policy.reverifyAfterMs],
          );
          verifiedAt = date(renewed[0]!, "verified_at");
          reverifyDueAt = date(renewed[0]!, "reverify_due_at");
        } else {
          const counts = await tx.unsafe<Row>(
            "SELECT count(*)::integer AS count FROM public.auggy_coordination_visitors WHERE namespace = $1 AND audience = $2",
            [this.#namespace, this.#audience],
          );
          if (number(counts[0]!, "count") >= this.#policy.maxVisitors) {
            return { status: "capacity" as const };
          }
          visitorId = `vis_${crypto.randomUUID()}`;
          identityVersion = current ? number(current, "identity_version") + 1 : 1;
          const inserted = await tx.unsafe<Row>(
            "INSERT INTO public.auggy_coordination_visitors (namespace, audience, visitor_id, email, email_hash, identity_version, verified_at, last_seen_at, reverify_due_at) VALUES ($1, $2, $3, $4, $5, $6, clock_timestamp(), clock_timestamp(), clock_timestamp() + $7 * INTERVAL '1 millisecond') RETURNING verified_at, reverify_due_at",
            [
              this.#namespace,
              this.#audience,
              visitorId,
              text(evidence, "email"),
              emailHash,
              identityVersion,
              this.#policy.reverifyAfterMs,
            ],
          );
          verifiedAt = date(inserted[0]!, "verified_at");
          reverifyDueAt = date(inserted[0]!, "reverify_due_at");
        }
        await tx.unsafe(
          "UPDATE public.auggy_coordination_visitor_requests SET status = 'verified', terminal_at = clock_timestamp(), visitor_id = $4, identity_version = $5 WHERE namespace = $1 AND audience = $2 AND token_hash = $3 AND status = 'open'",
          [this.#namespace, this.#audience, tokenHash, visitorId, identityVersion],
        );
        return {
          status: "verified" as const,
          visitorId,
          identityVersion,
          email: text(evidence, "email"),
          verifiedAt,
          reverifyDueAt,
          authoritativeNow: now,
          priorPeerId: text(evidence, "peer_id"),
          priorThreadId: text(evidence, "thread_id"),
        };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async resolveVisitor(
    visitorId: string,
    identityVersion: number,
    credentialExpiresAt?: number,
  ): Promise<ResolveSharedVisitorResult> {
    try {
      if (
        !VISITOR_ID.test(visitorId) ||
        !Number.isSafeInteger(identityVersion) ||
        identityVersion < 1 ||
        (credentialExpiresAt !== undefined &&
          (!Number.isSafeInteger(credentialExpiresAt) || credentialExpiresAt < 0))
      ) {
        return { status: "unknown" };
      }
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "unavailable" as const };
        const rows = await tx.unsafe<Row>(
          "SELECT visitor_id, identity_version, email, verified_at, reverify_due_at, revoked_at, clock_timestamp() AS authority_now FROM public.auggy_coordination_visitors WHERE namespace = $1 AND audience = $2 AND visitor_id = $3 AND identity_version = $4",
          [this.#namespace, this.#audience, visitorId, identityVersion],
        );
        const row = rows[0];
        if (!row) return { status: "unknown" as const };
        const authorityNow = date(row, "authority_now");
        const reverifyDueAt = date(row, "reverify_due_at");
        if (
          reverifyDueAt <= authorityNow ||
          (credentialExpiresAt !== undefined && credentialExpiresAt <= authorityNow)
        ) {
          return { status: "expired" as const };
        }
        if (nullableDate(row, "revoked_at") !== null) return { status: "revoked" as const };
        return {
          status: "active" as const,
          visitorId: text(row, "visitor_id"),
          identityVersion: number(row, "identity_version"),
          email: text(row, "email"),
          verifiedAt: date(row, "verified_at"),
          reverifyDueAt,
        };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async canPromote(
    request: SharedVisitorPromotionRequest,
  ): Promise<{ status: "allowed" | "denied" | "unavailable" }> {
    try {
      if (
        !VISITOR_ID.test(request.visitorId) ||
        !Number.isSafeInteger(request.identityVersion) ||
        request.identityVersion < 1
      ) {
        return { status: "denied" };
      }
      assertBoundedText("promotion peer", request.peerId, 256);
      assertBoundedText("promotion thread", request.threadId, 256);
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "unavailable" as const };
        const rows = await tx.unsafe<Row>(
          "SELECT 1 AS allowed FROM public.auggy_coordination_visitor_requests evidence JOIN public.auggy_coordination_visitors visitor ON visitor.namespace = evidence.namespace AND visitor.audience = evidence.audience AND visitor.visitor_id = evidence.visitor_id AND visitor.identity_version = evidence.identity_version WHERE evidence.namespace = $1 AND evidence.audience = $2 AND evidence.visitor_id = $3 AND evidence.identity_version = $4 AND evidence.status = 'verified' AND evidence.peer_hash = $5 AND evidence.thread_hash = $6 AND visitor.revoked_at IS NULL AND visitor.reverify_due_at > clock_timestamp() LIMIT 1",
          [
            this.#namespace,
            this.#audience,
            request.visitorId,
            request.identityVersion,
            digest("auggy-visitor-peer-v1", request.peerId),
            digest("auggy-visitor-thread-v1", request.threadId),
          ],
        );
        return { status: rows.length > 0 ? ("allowed" as const) : ("denied" as const) };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async revokeByEmail(
    rawEmail: string,
    reason: string,
  ): Promise<
    | { status: "revoked"; visitorId: string; identityVersion: number; wasRevoked: boolean }
    | { status: "missing" | "unavailable" }
  > {
    try {
      const email = canonicalEmail(rawEmail);
      if (!REASON_CODE.test(reason)) throw new Error("revocation reason is invalid");
      const emailHash = digest("auggy-visitor-email-v1", email);
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "unavailable" as const };
        const rows = await tx.unsafe<Row>(
          "SELECT visitor_id, identity_version, revoked_at FROM public.auggy_coordination_visitors WHERE namespace = $1 AND audience = $2 AND email_hash = $3 ORDER BY identity_version DESC LIMIT 1 FOR UPDATE",
          [this.#namespace, this.#audience, emailHash],
        );
        const row = rows[0];
        if (!row) return { status: "missing" as const };
        const wasRevoked = nullableDate(row, "revoked_at") !== null;
        if (!wasRevoked) {
          await tx.unsafe(
            "UPDATE public.auggy_coordination_visitors SET revoked_at = clock_timestamp(), revoked_reason = $4 WHERE namespace = $1 AND audience = $2 AND visitor_id = $3 AND revoked_at IS NULL",
            [this.#namespace, this.#audience, text(row, "visitor_id"), reason],
          );
          await tx.unsafe(
            "UPDATE public.auggy_coordination_visitor_requests SET status = 'revoked', terminal_at = clock_timestamp() WHERE namespace = $1 AND audience = $2 AND email_hash = $3 AND status = 'open' AND issued_at <= clock_timestamp()",
            [this.#namespace, this.#audience, emailHash],
          );
        }
        return {
          status: "revoked" as const,
          visitorId: text(row, "visitor_id"),
          identityVersion: number(row, "identity_version"),
          wasRevoked,
        };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async claimExternalAssertion(
    request: ExternalAssertionClaimRequest,
  ): Promise<ExternalAssertionClaimResult> {
    try {
      assertBoundedText("external assertion provider", request.provider, 128);
      if (request.keyId !== null) assertBoundedText("external assertion keyId", request.keyId, 128);
      assertBoundedText("external assertion jti", request.jti, 512);
      if (!IDENTIFIER.test(request.requestId) || !DIGEST.test(request.bindingHash)) {
        return { status: "conflict" };
      }
      if (!Number.isSafeInteger(request.expiresAt) || request.expiresAt < 0) {
        return { status: "expired" };
      }
      const claimHash = digest(
        "auggy-external-assertion-claim-v1",
        this.#namespace,
        this.#audience,
        request.provider,
        request.keyId ?? "",
        request.jti,
      );
      return await this.#sql.begin(async (tx) => {
        if (!(await this.#lockAuthority(tx))) return { status: "unavailable" as const };
        const nowRows = await tx.unsafe<Row>("SELECT clock_timestamp() AS now");
        const now = date(nowRows[0]!, "now");
        if (request.expiresAt <= now) return { status: "expired" as const };
        if (request.expiresAt - now > this.#policy.maxExternalAssertionTtlMs) {
          return { status: "invalid" as const };
        }
        const existing = await tx.unsafe<Row>(
          "SELECT request_id, binding_hash, expires_at FROM public.auggy_coordination_external_assertions WHERE namespace = $1 AND audience = $2 AND claim_hash = $3 FOR UPDATE",
          [this.#namespace, this.#audience, claimHash],
        );
        if (existing[0] && date(existing[0], "expires_at") > now) {
          return text(existing[0], "request_id") === request.requestId &&
            text(existing[0], "binding_hash") === request.bindingHash
            ? { status: "replayed" as const }
            : { status: "conflict" as const };
        }
        if (existing[0]) {
          await tx.unsafe(
            "DELETE FROM public.auggy_coordination_external_assertions WHERE namespace = $1 AND audience = $2 AND claim_hash = $3",
            [this.#namespace, this.#audience, claimHash],
          );
        }
        await tx.unsafe(
          "DELETE FROM public.auggy_coordination_external_assertions WHERE ctid IN (SELECT ctid FROM public.auggy_coordination_external_assertions WHERE namespace = $1 AND audience = $2 AND expires_at <= clock_timestamp() ORDER BY expires_at, claim_hash LIMIT 1000)",
          [this.#namespace, this.#audience],
        );
        const counts = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS count FROM public.auggy_coordination_external_assertions WHERE namespace = $1 AND audience = $2",
          [this.#namespace, this.#audience],
        );
        if (number(counts[0]!, "count") >= this.#policy.maxExternalAssertions) {
          return { status: "capacity" as const };
        }
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_external_assertions (namespace, audience, claim_hash, request_id, binding_hash, expires_at) VALUES ($1, $2, $3, $4, $5, to_timestamp($6 / 1000.0))",
          [
            this.#namespace,
            this.#audience,
            claimHash,
            request.requestId,
            request.bindingHash,
            request.expiresAt,
          ],
        );
        return { status: "claimed" as const };
      });
    } catch {
      return { status: "unavailable" };
    }
  }

  async close(): Promise<void> {
    if (this.#ownsSql) await (this.#sql as unknown as { close(): Promise<void> }).close();
  }

  async #lockAuthority(tx: SqlTransaction): Promise<Row | null> {
    const rows = await tx.unsafe<Row>(
      "SELECT policy_fingerprint, max_verification_requests, max_visitors, max_external_assertions, verification_token_ttl_ms, verification_request_retention_ms, reverify_after_ms, max_external_assertion_ttl_ms, rate_per_hour, rate_per_day, rate_min_interval_ms FROM public.auggy_coordination_visitor_authorities WHERE namespace = $1 AND audience = $2 FOR UPDATE",
      [this.#namespace, this.#audience],
    );
    const row = rows[0];
    if (!row) return null;
    return text(row, "policy_fingerprint") === this.#policyFingerprint &&
      number(row, "max_verification_requests") === this.#policy.maxVerificationRequests &&
      number(row, "max_visitors") === this.#policy.maxVisitors &&
      number(row, "max_external_assertions") === this.#policy.maxExternalAssertions &&
      number(row, "verification_token_ttl_ms") === this.#policy.verificationTokenTtlMs &&
      number(row, "verification_request_retention_ms") ===
        this.#policy.verificationRequestRetentionMs &&
      number(row, "reverify_after_ms") === this.#policy.reverifyAfterMs &&
      number(row, "max_external_assertion_ttl_ms") === this.#policy.maxExternalAssertionTtlMs &&
      number(row, "rate_per_hour") === this.#policy.rateLimit.perHour &&
      number(row, "rate_per_day") === this.#policy.rateLimit.perDay &&
      number(row, "rate_min_interval_ms") === this.#policy.rateLimit.minIntervalMs
      ? row
      : null;
  }

  #validateVerificationRequest(request: IssueVerificationRequest): void {
    if (!IDENTIFIER.test(request.requestId) || !DIGEST.test(request.bindingHash)) {
      throw new Error("verification request identity is invalid");
    }
    assertBoundedText("verification token", request.token, 512);
    assertBoundedText("verification peer", request.peerId, 256);
    assertBoundedText("verification thread", request.threadId, 256);
  }
}
