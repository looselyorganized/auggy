/**
 * Internal types for the agentMail augment.
 * Public types (AgentMailAugmentOptions etc.) live in src/types.ts.
 */

import type { AgentMailClient } from "../../agentmail-client";
import type { AgentMailAugmentOptions } from "../../types";
import type { AgentMailInboundLedger } from "./inbound-ledger";
import type { AgentMailSdkAdapters } from "./sdk-provider";
import type { AgentMailReviewQueue } from "./review-queue";

/**
 * Internal test seams. Production callers do not pass these.
 */
export interface AgentMailAugmentInternalOptions extends AgentMailAugmentOptions {
  /**
   * Stable mounted augment identity supplied by the resolver. Defaults to the
   * legacy single-instance name `agent-mail` for direct callers.
   */
  instanceId?: string;
  /**
   * Resolver-owned migration signal. True only when exactly one AgentMail
   * instance is mounted, allowing that named instance to inherit legacy
   * singleton policy before its next v2 write.
   */
  legacySingletonCompatibility?: boolean;
  /**
   * Resolver-owned signal to prevent cross-instance tool-name collisions.
   * Namespaced instances are limited to 46 characters because
   * `reply_to_message__${instanceId}` must remain within the provider's
   * 64-character tool-name limit.
   */
  namespaceTools?: boolean;
  /** Deployment-owned directory for durable AgentMail state. Defaults to agentDir locally. */
  stateDir?: string;
  /** Canonical shared directory for admin-overrides.json. Defaults to agentDir locally. */
  overrideDir?: string;
  /** Test-only override; production constructs from apiKey via createAgentMailClient. */
  _client?: AgentMailClient;
  /** Test-only clock injection (ms epoch). Defaults to Date.now. */
  _now?: () => number;
  /** Test-only inbound storage override. */
  _inboundLedger?: AgentMailInboundLedger;
  /** Test-only SDK boundary override. */
  _sdkAdapters?: AgentMailSdkAdapters;
  /** Test-only shutdown deadline override. Production uses four seconds. */
  _shutdownTimeoutMs?: number;
  /** Test-only durable outbound-review queue override. */
  _reviewQueue?: AgentMailReviewQueue;
}

/**
 * Single row in the admin "recent dispatches" ring buffer. Recipients are
 * stored redacted (first 2 chars of local-part + domain) so admin views
 * never leak full address lists.
 */
export interface DispatchRecord {
  /** Short HH:MM:SS for compact display. Operators rarely care about the date. */
  timestamp: string;
  /** Tool that produced this dispatch. */
  tool: "send_message" | "reply_to_message" | "forward_message" | "admin-test";
  /** Outcome surfaced back to the model / operator. */
  status: "sent" | "pending_review" | "rate_limited" | "blocked" | "failed";
  /** Redacted recipient summary (e.g. `"al***@example.com (+2)"`). */
  recipients: string;
  /** First 80 chars of subject. */
  subject: string;
  /** HTTP status when status === "failed" and the failure came from AgentMail. */
  httpStatus?: number;
  /** Set to true when sensitive-token regex matched and body was logged with redaction. */
  flaggedSensitive?: boolean;
  /** Human-readable detail for failures / rate-limits. */
  detail?: string;
}
