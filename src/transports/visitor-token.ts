export interface VisitorTokenPayload {
  visitorId: string;
  agentId: string;
  issuedAt: number;
  expiresAt: number;
  priorPeerId?: string;
  priorThreadScopeId?: string;
}

const PURPOSE = "auggy-visitor-signing";
const encoder = new TextEncoder();

export async function deriveSigningKey(bearerToken: string): Promise<CryptoKey> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    encoder.encode(bearerToken),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const derived = await crypto.subtle.sign("HMAC", keyMaterial, encoder.encode(PURPOSE));
  return crypto.subtle.importKey("raw", derived, { name: "HMAC", hash: "SHA-256" }, true, [
    "sign",
    "verify",
  ]);
}

export async function createVisitorToken(
  key: CryptoKey,
  agentId: string,
  ttlSeconds: number,
  /**
   * Optional pre-existing visitorId. When omitted (the common case for first
   * verification or anonymous-recognized issuance), a fresh `vis_<uuid>` is
   * minted. When provided (re-verification of an already-known email), the
   * existing identifier is preserved so peer-scoped state in layered-memory
   * remains continuous across re-verifications.
   */
  existingVisitorId?: string,
  /**
   * Optional signed one-way promotion link to the anonymous subject that
   * initiated verification. It never authenticates without this visitor
   * token and cannot be used to downgrade a recognized thread.
   */
  priorPeerId?: string,
  priorThreadScopeId?: string,
): Promise<{ token: string; payload: VisitorTokenPayload }> {
  const payload: VisitorTokenPayload = {
    visitorId: existingVisitorId ?? `vis_${crypto.randomUUID()}`,
    agentId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
    ...(priorPeerId ? { priorPeerId } : {}),
    ...(priorThreadScopeId ? { priorThreadScopeId } : {}),
  };
  const payloadB64 = btoa(JSON.stringify(payload));
  const signature = await crypto.subtle.sign("HMAC", key, encoder.encode(payloadB64));
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return { token: `${payloadB64}.${sigB64}`, payload };
}

export async function verifyVisitorToken(
  key: CryptoKey,
  token: string,
): Promise<VisitorTokenPayload | null> {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sigB64] = parts as [string, string];

  let sigBytes: Uint8Array;
  try {
    if (btoa(atob(sigB64)) !== sigB64) return null;
    sigBytes = Uint8Array.from(atob(sigB64), (c) => c.charCodeAt(0));
  } catch {
    return null;
  }

  const sigBuffer = sigBytes.buffer.slice(
    sigBytes.byteOffset,
    sigBytes.byteOffset + sigBytes.byteLength,
  ) as ArrayBuffer;
  const valid = await crypto.subtle.verify("HMAC", key, sigBuffer, encoder.encode(payloadB64));
  if (!valid) return null;

  let payload: VisitorTokenPayload;
  try {
    if (btoa(atob(payloadB64)) !== payloadB64) return null;
    payload = JSON.parse(atob(payloadB64)) as VisitorTokenPayload;
  } catch {
    return null;
  }

  if (!isVisitorTokenPayload(payload)) return null;
  if (payload.expiresAt <= Date.now()) return null;
  return payload;
}

function isVisitorTokenPayload(value: unknown): value is VisitorTokenPayload {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const payload = value as Record<string, unknown>;
  const keys = Object.keys(payload);
  if (
    keys.length !==
      4 +
        (payload.priorPeerId === undefined ? 0 : 1) +
        (payload.priorThreadScopeId === undefined ? 0 : 1) ||
    !keys.every((key) =>
      [
        "visitorId",
        "agentId",
        "issuedAt",
        "expiresAt",
        "priorPeerId",
        "priorThreadScopeId",
      ].includes(key),
    )
  ) {
    return false;
  }
  return (
    typeof payload.visitorId === "string" &&
    /^vis_[A-Za-z0-9._:-]{1,200}$/.test(payload.visitorId) &&
    typeof payload.agentId === "string" &&
    payload.agentId.length > 0 &&
    payload.agentId.length <= 256 &&
    typeof payload.issuedAt === "number" &&
    Number.isSafeInteger(payload.issuedAt) &&
    typeof payload.expiresAt === "number" &&
    Number.isSafeInteger(payload.expiresAt) &&
    payload.expiresAt > payload.issuedAt &&
    (payload.priorPeerId === undefined ||
      (typeof payload.priorPeerId === "string" &&
        payload.priorPeerId.length > 0 &&
        payload.priorPeerId.length <= 256)) &&
    (payload.priorThreadScopeId === undefined ||
      (typeof payload.priorThreadScopeId === "string" &&
        payload.priorThreadScopeId.length > 0 &&
        payload.priorThreadScopeId.length <= 256))
  );
}
