import type { AugmentHttpRoute, RouteWebhookContext } from "../types";

const DEFAULT_STRIPE_TIMESTAMP_TOLERANCE_SECONDS = 300;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

export type RouteWebhookPolicyVerification =
  | { ok: true; context?: RouteWebhookContext }
  | { ok: false; status: 400 | 401 | 500; error: string };

type EnvLookup = Record<string, string | undefined>;

export function validateRouteWebhookPolicyConfig(
  route: Pick<AugmentHttpRoute, "method" | "path" | "policy">,
  env: EnvLookup = process.env,
): string | undefined {
  const policy = route.policy;
  if (!policy) return undefined;
  if (policy.kind !== "webhook.signature") return undefined;
  if (policy.provider !== "stripe") {
    return `Webhook signature provider "${policy.provider}" is not supported.`;
  }

  if (!policy.secretEnv) return "Stripe webhook policy requires secretEnv.";
  const secret = env[policy.secretEnv];
  if (!secret || secret.trim().length === 0) {
    return `Stripe webhook secret env ${policy.secretEnv} is not set.`;
  }

  return undefined;
}

export async function verifyRouteWebhookPolicy(
  route: Pick<AugmentHttpRoute, "policy">,
  req: Request,
  rawBody: Uint8Array,
  env: EnvLookup = process.env,
  nowMs = Date.now(),
): Promise<RouteWebhookPolicyVerification> {
  const policy = route.policy;
  if (!policy) return { ok: true };
  if (policy.kind !== "webhook.signature") return { ok: true };

  // Unsupported providers are a server configuration error. Boot-time
  // validation normally prevents this path, but request verification remains
  // fail-closed as defense in depth.
  if (policy.provider !== "stripe") {
    return { ok: false, status: 500, error: "webhook-policy-unsupported" };
  }

  if (!policy.secretEnv) {
    return { ok: false, status: 500, error: "webhook-policy-misconfigured" };
  }
  const secret = env[policy.secretEnv];
  if (!secret || secret.trim().length === 0) {
    return { ok: false, status: 500, error: "webhook-policy-misconfigured" };
  }

  const header = req.headers.get("stripe-signature");
  if (!header) return { ok: false, status: 401, error: "webhook-signature-required" };

  const parsed = parseStripeSignatureHeader(header);
  if (!parsed) return { ok: false, status: 401, error: "webhook-signature-invalid" };

  const tolerance = policy.timestampToleranceSeconds ?? DEFAULT_STRIPE_TIMESTAMP_TOLERANCE_SECONDS;
  if (Math.abs(nowMs / 1000 - parsed.timestamp) > tolerance) {
    return { ok: false, status: 401, error: "webhook-signature-invalid" };
  }

  const expected = await stripeSignatureHex(secret, parsed.timestamp, rawBody);
  if (!parsed.signatures.some((candidate) => timingSafeEqual(candidate, expected))) {
    return { ok: false, status: 401, error: "webhook-signature-invalid" };
  }

  let event: unknown;
  try {
    event = JSON.parse(decoder.decode(rawBody)) as unknown;
  } catch {
    return { ok: false, status: 400, error: "webhook-payload-invalid" };
  }

  return {
    ok: true,
    context: {
      kind: "webhook.signature",
      provider: "stripe",
      event,
      timestamp: parsed.timestamp,
      receivedAt: nowMs,
    },
  };
}

function parseStripeSignatureHeader(
  header: string,
): { timestamp: number; signatures: readonly string[] } | null {
  let timestamp: number | undefined;
  const signatures: string[] = [];

  for (const part of header.split(",")) {
    const trimmed = part.trim();
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;
    const key = trimmed.slice(0, separator);
    const value = trimmed.slice(separator + 1);
    if (key === "t") {
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed) || parsed <= 0) return null;
      timestamp = parsed;
    } else if (key === "v1" && value.length > 0) {
      signatures.push(value);
    }
  }

  if (timestamp === undefined || signatures.length === 0) return null;
  return { timestamp, signatures };
}

async function stripeSignatureHex(
  secret: string,
  timestamp: number,
  rawBody: Uint8Array,
): Promise<string> {
  const prefix = encoder.encode(`${timestamp}.`);
  const signedPayload = new Uint8Array(prefix.byteLength + rawBody.byteLength);
  signedPayload.set(prefix, 0);
  signedPayload.set(rawBody, prefix.byteLength);

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const signature = await crypto.subtle.sign("HMAC", key, signedPayload);
  return bytesToHex(new Uint8Array(signature));
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a: string, b: string): boolean {
  const ab = encoder.encode(a);
  const bb = encoder.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
