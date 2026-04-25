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
  const derived = await crypto.subtle.sign(
    "HMAC",
    keyMaterial,
    encoder.encode(PURPOSE),
  );
  return crypto.subtle.importKey(
    "raw",
    derived,
    { name: "HMAC", hash: "SHA-256" },
    true,
    ["sign", "verify"],
  );
}

export async function createVisitorToken(
  key: CryptoKey,
  agentId: string,
  ttlSeconds: number,
): Promise<string> {
  const payload: VisitorTokenPayload = {
    visitorId: `vis_${crypto.randomUUID()}`,
    agentId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + ttlSeconds * 1000,
  };
  const payloadB64 = btoa(JSON.stringify(payload));
  const signature = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(payloadB64),
  );
  const sigB64 = btoa(String.fromCharCode(...new Uint8Array(signature)));
  return `${payloadB64}.${sigB64}`;
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

  const valid = await crypto.subtle.verify(
    "HMAC",
    key,
    sigBytes.buffer as ArrayBuffer,
    encoder.encode(payloadB64),
  );
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
