/**
 * Outbound guards for the agentMail augment.
 *
 * Pure helpers — no IO, no client calls, no state. The augment factory in
 * `./index.ts` calls these in sequence before invoking the AgentMail client.
 *
 * Layer order, applied in `validateOutbound`:
 *   1. Recipient list well-formed (non-empty, every entry passes `isWellFormedEmail`)
 *   2. Recipient count ≤ maxRecipients (AgentMail hard ceiling = 50)
 *   3. Recipient allowlist (exact + `*@domain` glob, lowercased compare)
 *   4. Subject non-empty + sanitization (control char stripping)
 *   5. Body size cap (default 100KB)
 *   6. Body sanitization (CRLF-dot-CRLF rejected — SMTP-envelope smuggling defense)
 *   7. HTML allowed?  (respects `outbound.allowHtml`)
 *
 * Sensitive-content scan (`scanForSensitive`) is informational only — it
 * does NOT block the send. The augment logs flagged dispatches to admin
 * info so operators can audit; the skill teaches the model what to omit.
 */

import { isWellFormedEmail } from "../visitorAuth/email-validation";
import type { AgentMailOutboundOptions } from "../../types";

export interface ValidatedOutbound {
  recipients: string[];
  subject: string;
  text: string;
  html?: string;
}

export type OutboundValidationResult =
  | { ok: true; value: ValidatedOutbound }
  | { ok: false; reason: string };

const DEFAULT_MAX_RECIPIENTS = 10;
const ABSOLUTE_MAX_RECIPIENTS = 50; // AgentMail's combined to/cc/bcc cap
const DEFAULT_BODY_MAX_BYTES = 102_400; // 100KB
const DEFAULT_SUBJECT_PREFIX = "[Auggy] ";

/** Apply subject prefix + sanitization. Throws no errors — only returns. */
export function normalizeSubject(rawSubject: string, opts: AgentMailOutboundOptions): string {
  // Strip every C0/C1 control character including CR (\r), LF (\n), and tab.
  // Subjects MUST stay on one line — any embedded LF can be normalized to a
  // header separator by downstream mail stacks, which is the classic
  // header-injection vector. Body sanitization is separate (it keeps \n).
  const stripped = stripSubjectControlChars(rawSubject);
  const trimmed = stripped.trim();
  const prefix = opts.subjectPrefix ?? DEFAULT_SUBJECT_PREFIX;
  // Idempotence: if the model already prepended the prefix, don't double it.
  if (prefix && trimmed.startsWith(prefix.trimEnd())) return trimmed;
  return `${prefix}${trimmed}`;
}

function stripSubjectControlChars(input: string): string {
  // ALL C0 + DEL + C1 control characters. No exceptions — subjects are
  // single-line by definition. Codex #2: previously this kept \n which
  // allows `Hello\nBcc: evil@x.com` to smuggle a header on downstream
  // stacks that fold lone LFs into header separators.
  // biome-ignore lint/suspicious/noControlCharactersInRegex: deliberate header-injection guard
  return input.replace(/[\x00-\x1F\x7F]/g, "");
}

/**
 * Returns true if `body` contains the SMTP "end-of-data" sequence in a
 * position that could break envelopes if AgentMail forwards raw. Defense
 * in depth — AgentMail almost certainly escapes these, but we don't want
 * to bet the farm on it.
 */
export function containsSmtpDotSequence(body: string): boolean {
  // The bare-LF variant doesn't end SMTP DATA but is still suspect.
  return /\r\n\.\r\n|\n\.\n/.test(body);
}

export function recipientMatchesAllowlist(recipient: string, allowlist: string[]): boolean {
  const r = recipient.toLowerCase();
  for (const entry of allowlist) {
    const e = entry.toLowerCase();
    if (e.startsWith("*@")) {
      // domain glob
      const domain = e.slice(2);
      if (r.endsWith(`@${domain}`)) return true;
    } else if (e === r) {
      return true;
    }
  }
  return false;
}

export interface ValidateInput {
  recipients: string[];
  subject: string;
  text: string;
  html?: string;
  /** When set, marks this as a reply/forward — subject prefix logic is skipped. */
  skipSubjectPrefix?: boolean;
}

export function validateOutbound(
  input: ValidateInput,
  opts: AgentMailOutboundOptions,
): OutboundValidationResult {
  // 1. Recipient list well-formed
  if (!Array.isArray(input.recipients) || input.recipients.length === 0) {
    return { ok: false, reason: "recipients: at least one recipient required" };
  }
  for (const r of input.recipients) {
    if (!isWellFormedEmail(r)) {
      return { ok: false, reason: `recipients: "${r}" is not a well-formed email address` };
    }
  }

  // 2. Recipient count cap
  const maxRecipients = Math.min(
    opts.maxRecipients ?? DEFAULT_MAX_RECIPIENTS,
    ABSOLUTE_MAX_RECIPIENTS,
  );
  if (input.recipients.length > maxRecipients) {
    return {
      ok: false,
      reason: `recipients: ${input.recipients.length} addresses exceeds the configured cap of ${maxRecipients}`,
    };
  }

  // 3. Allowlist
  if (opts.allowedRecipients && opts.allowedRecipients.length > 0) {
    for (const r of input.recipients) {
      if (!recipientMatchesAllowlist(r, opts.allowedRecipients)) {
        return {
          ok: false,
          reason: `recipients: "${r}" is not on the operator's recipient allowlist`,
        };
      }
    }
  }

  // 4. Subject
  if (input.skipSubjectPrefix) {
    // Reply / forward — subject is determined server-side by AgentMail.
    // We just verify the field, when present, is non-empty.
  } else {
    if (typeof input.subject !== "string" || input.subject.trim().length === 0) {
      return { ok: false, reason: "subject: required and must be non-empty" };
    }
  }

  // 5. Body cap (text + html combined — Codex #4: HTML must count toward the cap too)
  const bodyMaxBytes = opts.bodyMaxBytes ?? DEFAULT_BODY_MAX_BYTES;
  const textBytes = Buffer.byteLength(input.text ?? "", "utf8");
  const htmlBytes = input.html !== undefined ? Buffer.byteLength(input.html, "utf8") : 0;
  const totalBytes = textBytes + htmlBytes;
  if (totalBytes > bodyMaxBytes) {
    return {
      ok: false,
      reason: `body: ${totalBytes} bytes (text + html) exceeds the cap of ${bodyMaxBytes} bytes`,
    };
  }

  // 6. Body sanitization
  if (containsSmtpDotSequence(input.text ?? "")) {
    return {
      ok: false,
      reason:
        "body: contains SMTP envelope-end sequence (CRLF.CRLF) — rejected as defense in depth",
    };
  }

  // 7. HTML
  if (input.html !== undefined && !opts.allowHtml) {
    return {
      ok: false,
      reason: "html: HTML bodies are disabled by default; set outbound.allowHtml=true to enable",
    };
  }

  const normalizedSubject = input.skipSubjectPrefix
    ? input.subject
    : normalizeSubject(input.subject, opts);

  return {
    ok: true,
    value: {
      recipients: input.recipients.map((r) => r),
      subject: normalizedSubject,
      text: input.text,
      html: input.html,
    },
  };
}

// ---------------------------------------------------------------------------
// Sensitive content scan (informational; does NOT block)
// ---------------------------------------------------------------------------

/**
 * Lightweight regex pass for shapes commonly belonging to secrets. Matches
 * are logged to admin info with `flaggedSensitive: true`; the send still
 * proceeds. The model is taught (via SKILL.md) to omit these — this is the
 * post-hoc audit layer, not a blocker.
 *
 * False positives are acceptable here; under-detection is the actual risk.
 */
const SENSITIVE_PATTERNS: ReadonlyArray<{ name: string; pattern: RegExp }> = [
  { name: "agentmail-key", pattern: /\bam_[A-Za-z0-9]{20,}\b/ },
  { name: "openai-key", pattern: /\bsk-[A-Za-z0-9]{20,}\b/ },
  { name: "slack-bot-token", pattern: /\bxox[bp]-[A-Za-z0-9-]{10,}\b/ },
  // JWTs: header.payload.signature with base64url segments
  { name: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  // GitHub PAT shapes
  { name: "github-pat", pattern: /\bgh[pousr]_[A-Za-z0-9]{30,}\b/ },
  // AWS access keys
  { name: "aws-access-key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
];

export interface SensitiveScanResult {
  flagged: boolean;
  /** Names of patterns that matched (no values — never log the secrets themselves). */
  hits: string[];
}

export function scanForSensitive(body: string): SensitiveScanResult {
  const hits: string[] = [];
  for (const { name, pattern } of SENSITIVE_PATTERNS) {
    if (pattern.test(body)) hits.push(name);
  }
  return { flagged: hits.length > 0, hits };
}

// ---------------------------------------------------------------------------
// Recipient redaction (for admin info ring buffer)
// ---------------------------------------------------------------------------

/**
 * Render a recipient list for the admin view without leaking full addresses.
 * `alice@example.com` → `al***@example.com`. Multi-recipient lists collapse
 * to `first (+N)` to keep ring-buffer rows compact.
 */
export function redactRecipients(recipients: string[]): string {
  if (recipients.length === 0) return "(none)";
  const head = redactSingle(recipients[0]!);
  if (recipients.length === 1) return head;
  return `${head} (+${recipients.length - 1})`;
}

function redactSingle(email: string): string {
  const atIdx = email.indexOf("@");
  if (atIdx < 0) return "***";
  const local = email.slice(0, atIdx);
  const domain = email.slice(atIdx);
  const visible = local.slice(0, Math.min(2, local.length));
  return `${visible}***${domain}`;
}
