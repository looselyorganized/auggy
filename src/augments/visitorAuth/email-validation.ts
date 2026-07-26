/**
 * Email-format validation + "did the visitor actually say this address?"
 * substring search. Pure functions; no IO, no SQL.
 *
 * Defense layer for spec fix #4 (confused-deputy): visitorAuth refuses to
 * mint a token for an email the visitor never typed.
 */

import type { RecentVisitorMessage } from "./types";

// Conservative email pattern: local @ domain with a TLD ≥ 2 chars.
// Deliberately stricter than RFC 5322 — we'd rather false-reject some
// exotic-but-valid addresses than risk header injection or smuggled
// whitespace. Operators with weird-domain visitors can layer their own
// validation pre-call.
const EMAIL_PATTERN = /^[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}$/;
const MAX_EMAIL_LEN = 254; // RFC 5321 §4.5.3.1

/** Canonical storage/lookup form used at every email identity boundary. */
export function canonicalizeEmail(value: string): string {
  return value.trim().toLowerCase();
}

export function isWellFormedEmail(value: string): boolean {
  if (typeof value !== "string") return false;
  if (value.length === 0 || value.length > MAX_EMAIL_LEN) return false;
  // Reject control characters explicitly — header injection guard.
  if (/[\r\n\t]/.test(value)) return false;
  // Reject double-dot in domain.
  if (/\.\./.test(value)) return false;
  return EMAIL_PATTERN.test(value);
}

export type RecentMessageMatch =
  | { matched: true; messageId: string }
  | { matched: false; hint?: "malformed" | "near-match" };

/**
 * Case-insensitive, word-boundary-aware search for `email` across the
 * visitor's recent messages. Returns the messageId of the first hit, or
 * a structured non-match with a debug-only `hint`.
 *
 * Word-boundary matching is necessary so `ice@example.com` does NOT match
 * a transcript containing `alice@example.com`.
 */
export function emailAppearsInRecentMessages(
  email: string,
  messages: readonly RecentVisitorMessage[],
): RecentMessageMatch {
  if (!isWellFormedEmail(email)) return { matched: false, hint: "malformed" };
  const target = email.toLowerCase();
  // Email regex with negative lookbehind/lookahead approximation —
  // require the char before/after to NOT be part of an email-local-name char.
  const escaped = target.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const boundary = new RegExp(`(^|[^A-Za-z0-9._%+-])${escaped}(?![A-Za-z0-9._%+-])`, "i");

  for (const msg of messages) {
    if (!msg.text) continue;
    if (boundary.test(msg.text)) {
      return { matched: true, messageId: msg.messageId ?? "" };
    }
  }
  // Did the email's local-part appear in some message but with different
  // surrounding context? Useful debug hint, never surfaced to the model.
  for (const msg of messages) {
    if (msg.text?.toLowerCase().includes(target)) {
      return { matched: false, hint: "near-match" };
    }
  }
  return { matched: false };
}
