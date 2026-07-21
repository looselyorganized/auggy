/**
 * Type definitions for the visitorAuth augment.
 *
 * Exposed to the auggy resolver (consumes VisitorAuthOptions) and to the
 * augment's internal modules. All shapes here are stable contracts; storage
 * record shapes live in storage/types.ts (a deliberate split — operator-facing
 * config is separate from on-disk representation).
 */

/**
 * AgentMail delivery configuration. visitorAuth uses src/agentmail-client.ts
 * directly (see Plan §"Spec deviation"). Operator wires apiKey + inboxId via
 * env-var interpolation in agent.yaml.
 *
 * Discriminated union over `transport`:
 *   - `"agentmail"` (default when transport is unset) — uses AgentMail HTTP API.
 *     Requires `apiKey` + `inboxId`.
 *   - `"console"` — prints verify links to stdout instead of sending email
 *     (OSS-friendly local-testing path, G34). No third-party credentials needed.
 *     Rejected at boot in production unless `allowConsoleInProduction: true` is
 *     set on `VisitorAuthOptions` — see the factory in `./index.ts`.
 */
export type AgentMailConfig = AgentMailAgentMailConfig | AgentMailConsoleConfig;

export interface AgentMailAgentMailConfig {
  /**
   * Selects the delivery transport. Omit or set to `"agentmail"` to use the
   * AgentMail HTTP API (existing behavior — back-compatible).
   */
  transport?: "agentmail";
  /** Bearer token (`am_*` prefix). Resolve via `${AGENTMAIL_API_KEY}` in augment.yaml. */
  apiKey: string;
  /** AgentMail inbox the verify email is sent FROM. */
  inboxId: string;
  /** Optional subject prefix prepended to the templated subject. Default: `[Verify] `. */
  subjectPrefix?: string;
  /** Optional override for the AgentMail API base URL (testing/sandbox). */
  apiBaseUrl?: string;
}

export interface AgentMailConsoleConfig {
  /**
   * Selects the console adapter — prints verify links to stdout instead of
   * sending email. Useful for local OSS testing without AgentMail credentials.
   */
  transport: "console";
  /** Optional subject prefix prepended to the templated subject. Default: `[Verify] `. */
  subjectPrefix?: string;
}

/**
 * Per-anonymous-peer rate-limit caps for `request_auth` calls. Defaults:
 * 1 send per hour, 3 sends per 24 hours. State is in-memory (resets on
 * restart — documented behavior; the verified_visitors UNIQUE-on-email
 * constraint catches accidental double-verification).
 */
export interface VisitorAuthRateLimit {
  perHour: number;
  perDay: number;
}

/**
 * Operator notification fired the FIRST time an email verifies on this agent.
 * Optional; when set, visitorAuth uses agentmail-client to send a one-line
 * note from inboxId TO the operator address. Independent from `notify`.
 */
export interface NotifyOnFirstVerifyConfig {
  to: string;
  /** Optional subject prefix (default `[New verified visitor] `). */
  subjectPrefix?: string;
}

export interface VisitorAuthOptions {
  /**
   * Public-facing base URL for the magic link, e.g. `https://zip.lorf.dev`.
   * Must be a valid URL with `http://` or `https://` scheme. Required because
   * the magic-link URL embedded in the email is `<publicUrl>/visitor-auth/verify?token=<uuid>`.
   */
  publicUrl: string;
  /** Path to the visitor-auth SQLite database. Default: `./visitor-auth.db` (relative to agent dir). */
  dbPath: string;
  /** AgentMail delivery config. Required. */
  agentMail: AgentMailConfig;
  /**
   * HMAC signing key for minting `vis_<uuid>` visitor tokens after a successful
   * verify. MUST match webTransport's `visitorTokens.signingKey`. Resolve via
   * `${VISITOR_SIGNING_KEY}` in agent.yaml (same env var both augments read).
   */
  signingKey: string;
  /**
   * Stable identifier this agent uses for visitor tokens (fix C2). MUST match
   * webTransport's `visitorTokens.agentBinding`. Default: `"auggy"`.
   *
   * When two agents share the same signing key, setting distinct `agentBinding`
   * values on each prevents cross-agent replay: a token minted for agent A
   * will be rejected by agent B because the embedded agentId will not match
   * agent B's expected binding.
   */
  agentBinding?: string;
  /** Optional rate-limit caps. Defaults: { perHour: 1, perDay: 3 }. */
  rateLimit?: VisitorAuthRateLimit;
  /** Days before reverification is required. Default: 90. */
  reverifyAfterDays?: number;
  /** Token TTL in minutes. Default: 15. */
  tokenTtlMinutes?: number;
  /** Optional operator-notification on first verify per email. */
  notifyOnFirstVerify?: NotifyOnFirstVerifyConfig;
  /**
   * Path to the layeredMemory SQLite database for the anonymous→recognized
   * peer-id migration on successful verify. Default: `./memory.db` (relative
   * to agent dir). Set to `null` to disable migration (anonymous history will
   * be orphaned but still queryable by threadId).
   */
  layeredMemoryDbPath?: string | null;
  /**
   * Permit `agentMail.transport: "console"` when `NODE_ENV === "production"`.
   * Default `false`. Console mode prints magic links to stdout, which on cloud
   * platforms (Railway/Fly/etc.) end up in runtime logs — anyone with log
   * access could harvest verification links. Production deploys MUST set this
   * to `true` explicitly to acknowledge the risk. visitorAuth's factory
   * throws at boot with a clear error message pointing here if the operator
   * forgot.
   *
   * Has no effect when `transport` is `"agentmail"` (or unset / default).
   */
  allowConsoleInProduction?: boolean;
}

/**
 * Extra surface exposed by the visitorAuth augment beyond the base Augment
 * interface. Consumed by the augment resolver to wire the revocation check
 * into webTransport without requiring a new kernel surface (fix C1).
 */
export interface VisitorAuthAugmentExtras {
  /**
   * Returns `true` iff the visitor with the given `vis_<uuid>` id has been
   * revoked. Reads directly from the store — no caching, always current.
   * Intended to be wired as `webTransport.visitorTokens.revocationCheck`.
   */
  isVisitorRevoked(visitorId: string): boolean;
  /**
   * Resolve a verified visitor by `vis_<uuid>` id. Returns null for unknown or
   * revoked visitors. Used by app-route auth to attach email / verification
   * metadata to route handlers without embedding PII in the visitor token.
   */
  resolveVisitorIdentity(visitorId: string): {
    visitorId: string;
    email: string;
    verifiedAt: number;
    reverifyDueAt: number;
  } | null;
  /** Authorize promotion only for the anonymous thread that issued the consumed link. */
  canPromoteAnonymousThread(visitorId: string, threadId: string): boolean;
}

/** Return shape of `request_auth({...})`. JSON-stringified by the tool. */
export interface RequestAuthResult {
  status: "sent" | "rejected" | "failed";
  code?:
    | "not_booted"
    | "missing_peer"
    | "unsupported_method"
    | "malformed_email"
    | "email_not_recent"
    | "rate_limited"
    | "send_failed";
  message: string;
  /**
   * Present iff status === "sent". The channel that received the magic link.
   * `console` means the link was printed locally and no email was sent.
   */
  delivery?: "email" | "console";
  /** Present iff status === "sent". TTL of the issued token. */
  expiresInSec?: number;
}

/**
 * Snapshot of the most-recent visitor message text the augment uses for
 * the email-in-recent-message validation. The transcript itself lives
 * in the kernel; visitorAuth only needs the visitor's recent text.
 */
export interface RecentVisitorMessage {
  text: string;
  /** Optional message id; recorded with the token for audit. */
  messageId?: string;
}
