/**
 * Storage record shapes + the abstract VisitorAuthStore interface.
 * Splitting the storage contract from the SQLite impl lets us swap to
 * a Postgres-backed store later without touching the augment.
 */

export type TokenStatus = "open" | "consumed" | "expired" | "unknown";

export interface IssueTokenArgs {
  token: string;
  email: string;
  peerId: string;
  threadId: string;
  expiresAt: number;          // epoch ms
  sourceMessageId: string | null;
}

export interface ConsumeTokenResult {
  /** True iff exactly one row transitioned from consumed=0 to consumed=1. */
  consumed: boolean;
  /** Set when consumed=true. */
  email?: string;
  /** Set when consumed=true. */
  peerId?: string;
  /** Set when consumed=true. */
  threadId?: string;
}

export interface VerifiedVisitorRow {
  visitorId: string;          // vis_<uuid>
  email: string;
  verifiedAt: number;         // epoch ms
  lastSeenAt: number | null;
  reverifyDueAt: number;      // epoch ms
  revoked: boolean;
  revokedAt: number | null;
  revokedReason: string | null;
}

export interface OpenTokenForPeer {
  token: string;
  email: string;
  expiresAt: number;          // epoch ms
  issuedAt: number;           // epoch ms
}

export interface VisitorAuthStore {
  /**
   * Idempotent schema apply. Safe to call repeatedly; safe on a fresh DB.
   * Called from onBoot before any other operation.
   */
  initialize(): void;
  /**
   * Insert a new token row. Throws on PK collision (caller should generate
   * a fresh UUID — collisions are statistically impossible in normal use).
   */
  issueToken(args: IssueTokenArgs): void;
  /**
   * Atomic consume. Single SQL UPDATE, returns whether exactly one row
   * transitioned. When consumed=true the row's email/peerId/threadId are
   * returned for the caller to mint the visitor token.
   *
   * Per spec fix #8 — the entire decision lives in `changes()`, no race.
   */
  consumeToken(token: string, now: number): ConsumeTokenResult;
  /**
   * Read-only status query. Used by the verify route to disambiguate
   * 410 (consumed/expired) from 404 (unknown) after a failed consumeToken.
   */
  tokenStatus(token: string, now: number): TokenStatus;
  /**
   * The most-recent OPEN (unconsumed, unexpired) token for this peer, if any.
   * Used by `request_auth` to invalidate prior open tokens before issuing a new one.
   */
  findOpenTokenForPeer(peerId: string, now: number): OpenTokenForPeer | null;
  /**
   * The most-recent token for this peer regardless of consumed/expired status.
   * Used by context() to surface "verification expired" state. Returns null
   * if the peer has never had a token issued.
   */
  findMostRecentTokenForPeer(peerId: string, now: number): {
    email: string;
    expiresAt: number;
    issuedAt: number;
    consumed: boolean;
  } | null;
  /**
   * Mark every open token for this peer as consumed (without minting a
   * visitor token). Used when a peer requests a new email; the prior code
   * goes dead.
   */
  invalidateOpenTokensForPeer(peerId: string, now: number): number;
  /**
   * Insert a verified-visitor row. Caller has already minted the visitor token.
   * If a row with the same email exists and is not revoked, throws — caller
   * should treat this as "already verified, prefer existing identity"
   * (handled in the verify route).
   */
  recordVerifiedVisitor(row: VerifiedVisitorRow): void;
  /** Returns the row for an email, or null. */
  findVerifiedByEmail(email: string): VerifiedVisitorRow | null;
  /** Update lastSeenAt; no-op if email is unknown or revoked. */
  touchVerifiedVisitor(email: string, now: number): void;
  /** All verified-visitor rows, ordered by verifiedAt DESC. Used by `auggy visitors`. */
  listVerifiedVisitors(): VerifiedVisitorRow[];
  /**
   * Hard-revoke. Sets revoked=1 + reason. Returns the visitorId or null
   * if the email was unknown. Used by `auggy visitors --revoke`.
   */
  revokeByEmail(email: string, reason: string, now: number): string | null;
  /** True iff the augment has emitted notifyOnFirstVerify for this email yet. */
  hasNotifiedFirstVerifyFor(email: string): boolean;
  /** Mark notifyOnFirstVerify as fired for this email. Idempotent. */
  markNotifiedFirstVerifyFor(email: string, now: number): void;
  close(): void;
}
