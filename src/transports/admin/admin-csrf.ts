/**
 * G36 CSRF token scheme. Format:
 *
 *   base64url(HMAC-SHA256(bearer, agentName + "|" + ts + "|" + actionId + "|" + rowKey?)) + "." + ts
 *
 * Binds the token to:
 *   - bearer  → can't reuse tokens after AUGGY_WEB_TOKEN is rotated
 *   - agentName → can't reuse tokens across different agents on the same browser
 *   - actionId → token for `notify-test` can't be replayed against `posture-flip`
 *   - rowKey (when present) → token for `memory-erase` on `vis_abc` can't be
 *     replayed against `vis_xyz` (closes the adversarial-review M1 finding)
 *
 * Timestamp is Unix seconds, base 10. Expiry: 24 hours from issuance.
 */

const CSRF_TTL_SECONDS = 24 * 3600;

export interface CsrfGenerateOpts {
  bearer: string;
  agentName: string;
  actionId: string;
  rowKey?: string;
  /** Internal: override timestamp (used by tests). */
  _timestamp?: number;
}

export interface CsrfValidateOpts {
  token: string;
  bearer: string;
  agentName: string;
  actionId: string;
  rowKey?: string;
}

/**
 * S7 fix — rich result so the caller can distinguish:
 *   - valid: token passes all checks
 *   - expired: HMAC fine, timestamp older than 24h → graceful "session
 *     expired, refreshing..." page (200 + meta-refresh), NOT 403
 *   - tampered: HMAC mismatch OR future-skew timestamp → 403 (real CSRF
 *     attack indicator)
 *   - malformed: structural parse failure → 403
 */
export type CsrfValidateResult =
  | { valid: true }
  | { valid: false; reason: "expired" | "tampered" | "malformed" };

export async function generateCsrfToken(opts: CsrfGenerateOpts): Promise<string> {
  const ts = opts._timestamp ?? Math.floor(Date.now() / 1000);
  const message = `${opts.agentName}|${ts}|${opts.actionId}|${opts.rowKey ?? ""}`;
  const signature = await hmacSha256Base64Url(opts.bearer, message);
  return `${signature}.${ts}`;
}

export async function validateCsrfToken(opts: CsrfValidateOpts): Promise<CsrfValidateResult> {
  const dotIdx = opts.token.lastIndexOf(".");
  if (dotIdx < 0) return { valid: false, reason: "malformed" };
  const signature = opts.token.slice(0, dotIdx);
  const tsStr = opts.token.slice(dotIdx + 1);
  const ts = Number.parseInt(tsStr, 10);
  if (!Number.isFinite(ts) || String(ts) !== tsStr) {
    return { valid: false, reason: "malformed" };
  }

  const now = Math.floor(Date.now() / 1000);
  if (now - ts >= CSRF_TTL_SECONDS) return { valid: false, reason: "expired" };
  // Future-skew tolerance: small window for clock drift; beyond that, treat
  // as tampering (an attacker fabricated a future timestamp to extend TTL).
  if (ts > now + 60) return { valid: false, reason: "tampered" };

  const message = `${opts.agentName}|${ts}|${opts.actionId}|${opts.rowKey ?? ""}`;
  const expected = await hmacSha256Base64Url(opts.bearer, message);

  if (!timingSafeStringEqual(signature, expected)) {
    return { valid: false, reason: "tampered" };
  }
  return { valid: true };
}

const enc = new TextEncoder();

async function hmacSha256Base64Url(key: string, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey(
    "raw",
    enc.encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, enc.encode(message));
  return base64urlEncode(new Uint8Array(sig));
}

function base64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}
