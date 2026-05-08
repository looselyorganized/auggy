export interface VisitorTokenPayload {
  visitorId: string;
  agentId: string;
  issuedAt: number;
  expiresAt: number;
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
): Promise<{ token: string; payload: VisitorTokenPayload }> {
  const payload: VisitorTokenPayload = {
    visitorId: existingVisitorId ?? `vis_${crypto.randomUUID()}`,
    agentId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
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
    payload = JSON.parse(atob(payloadB64)) as VisitorTokenPayload;
  } catch {
    return null;
  }

  if (payload.expiresAt < Date.now()) return null;
  return payload;
}
