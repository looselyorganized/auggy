import { createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

export interface AnonymousSessionPayload {
  version: 1;
  peerId: string;
  threadScopeId: string;
  audience: string;
  issuedAt: number;
  expiresAt: number;
}

export interface AnonymousSessionManager {
  issue(options?: { threadScopeId?: string }): { token: string; payload: AnonymousSessionPayload };
  verify(token: string): AnonymousSessionPayload | null;
}

const TOKEN_PURPOSE = "auggy-anonymous-session-v1";
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000;
const MAX_TOKEN_LENGTH = 2048;
const PEER_ID = /^anon_session_[0-9a-f-]{36}$/;
const THREAD_SCOPE_ID = /^(?:anon_session|vis)_[0-9a-f-]{36}$/;

function decodeCanonicalBase64url(value: string): Buffer | null {
  if (value.length === 0) return null;
  try {
    const decoded = Buffer.from(value, "base64url");
    return decoded.toString("base64url") === value ? decoded : null;
  } catch {
    return null;
  }
}

export function createAnonymousSessionManager(opts: {
  audience: string;
  ttlMs?: number;
  secret?: Uint8Array;
  now?: () => number;
}): AnonymousSessionManager {
  const ttlMs = opts.ttlMs ?? DEFAULT_TTL_MS;
  if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
    throw new Error("anonymous session ttlMs must be a positive integer");
  }
  const secret = opts.secret ? Buffer.from(opts.secret) : randomBytes(32);
  if (secret.byteLength < 32) {
    throw new Error("anonymous session secret must contain at least 32 bytes");
  }
  const now = opts.now ?? Date.now;

  function signature(payload: string): Buffer {
    return createHmac("sha256", secret).update(TOKEN_PURPOSE).update("\0").update(payload).digest();
  }

  return {
    issue(options) {
      const issuedAt = now();
      const peerId = `anon_session_${randomUUID()}`;
      const threadScopeId = options?.threadScopeId ?? peerId;
      if (!THREAD_SCOPE_ID.test(threadScopeId)) {
        throw new Error("anonymous session threadScopeId is invalid");
      }
      const payload: AnonymousSessionPayload = {
        version: 1,
        peerId,
        threadScopeId,
        audience: opts.audience,
        issuedAt,
        expiresAt: issuedAt + ttlMs,
      };
      const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
      return {
        token: `${encoded}.${signature(encoded).toString("base64url")}`,
        payload,
      };
    },

    verify(token) {
      if (token.length === 0 || token.length > MAX_TOKEN_LENGTH) return null;
      const parts = token.split(".");
      if (parts.length !== 2) return null;
      const [encoded, signatureText] = parts as [string, string];

      const suppliedSignature = decodeCanonicalBase64url(signatureText);
      if (!suppliedSignature) return null;
      const expectedSignature = signature(encoded);
      if (
        suppliedSignature.byteLength !== expectedSignature.byteLength ||
        !timingSafeEqual(suppliedSignature, expectedSignature)
      ) {
        return null;
      }

      let payload: unknown;
      try {
        const decodedPayload = decodeCanonicalBase64url(encoded);
        if (!decodedPayload) return null;
        payload = JSON.parse(decodedPayload.toString("utf8"));
      } catch {
        return null;
      }
      if (!isAnonymousSessionPayload(payload)) return null;
      if (payload.audience !== opts.audience) return null;
      if (payload.expiresAt <= now()) return null;
      if (payload.issuedAt > now() + 60_000) return null;
      return payload;
    },
  };
}

function isAnonymousSessionPayload(value: unknown): value is AnonymousSessionPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    Object.keys(candidate).length === 6 &&
    candidate.version === 1 &&
    typeof candidate.peerId === "string" &&
    PEER_ID.test(candidate.peerId) &&
    typeof candidate.threadScopeId === "string" &&
    THREAD_SCOPE_ID.test(candidate.threadScopeId) &&
    typeof candidate.audience === "string" &&
    candidate.audience.length > 0 &&
    typeof candidate.issuedAt === "number" &&
    Number.isSafeInteger(candidate.issuedAt) &&
    typeof candidate.expiresAt === "number" &&
    Number.isSafeInteger(candidate.expiresAt) &&
    candidate.expiresAt > candidate.issuedAt
  );
}
