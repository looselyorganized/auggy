/**
 * Mirror of the admin server contract. Kept hand-typed (not generated) so the
 * SPA stays decoupled from the server source tree at build time. The shape
 * must match `src/types.ts` (`AdminInfoBlock` and friends) and the JSON
 * envelope produced by `/console/api/dashboard`.
 */

export interface KeyValueRow {
  label: string;
  value: string;
  source?: string;
  resetAction?: { id: string; label: string; augmentName?: string };
}

export type AdminSection =
  | { kind: "keyValue"; rows: KeyValueRow[] }
  | {
      kind: "table";
      columns: string[];
      rows: string[][];
      rowActions?: AdminRowAction[];
      caption?: string;
    }
  | { kind: "status"; level: "ok" | "warn" | "error"; message: string }
  | {
      kind: "eventStream";
      events: Array<{ timestamp: string; type: string; summary: string }>;
      caption?: string;
    };

export interface AdminActionInput {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  required: boolean;
  default?: string;
  helpText?: string;
}

export interface AdminAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  inputs?: AdminActionInput[];
  augmentName?: string;
}

export interface AdminRowAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  rowKeyColumn: number;
  inputs?: AdminActionInput[];
  augmentName?: string;
}

export interface AdminInfoBlock {
  augmentName: string;
  title: string;
  sections: AdminSection[];
  actions?: AdminAction[];
  /** Optional typed feature projection. Unknown projections remain ignorable. */
  projection?: MailAdminProjection | { kind: string; [key: string]: unknown };
}

export interface CsrfToken {
  /** Present for augment-owned actions. Omitted only for built-in console actions. */
  augmentName?: string;
  actionId: string;
  rowKey?: string;
  token: string;
}

export type MailStatusLevel = "ok" | "warn" | "error";
export type MailDraftState =
  | "ready"
  | "scheduled"
  | "stale"
  | "approved"
  | "sending"
  | "retryable"
  | "sent"
  | "ambiguous"
  | "failed"
  | "deleted";

export interface MailDraftProjection {
  draftId: string;
  sourceMessageId?: string;
  threadId?: string;
  state: MailDraftState;
  providerUpdatedAt: string;
  sendAt?: string;
  retryOperationId?: string;
  retryAt?: string;
}

export interface MailInstanceProjection {
  augmentName: string;
  inboxId: string;
  inboxEmail?: string;
  externalConsoleUrl?: string;
  status: {
    level: MailStatusLevel;
    message: string;
  };
  inbound: {
    mode: "none" | "websocket";
    state: "idle" | "connecting" | "catching_up" | "ready" | "degraded" | "stopped";
    senderPolicy: "disabled" | "allowlist" | "any";
    allowedSenderCount: number;
    globalMaxPerHour?: number;
    perSenderMaxPerHour?: number;
    lastCatchUpAt?: string;
    lastEventAt?: string;
    lastErrorCode?: string;
  };
  replies: {
    mode: "disabled" | "review";
    allowReplyAll: boolean;
  };
  drafts: MailDraftProjection[];
}

export interface MailDashboardProjection {
  instances: MailInstanceProjection[];
}

export interface MailAdminProjection extends MailInstanceProjection {
  kind: "mail";
}

export interface AgentCardLite {
  provider: { name: string; displayName?: string; description?: string };
  purpose?: string;
  capabilities?: Record<string, unknown>;
  skills?: Array<{ name: string; description?: string; category?: string }>;
}

/**
 * Operator-facing grouping for augment summaries. Mirrors `AugmentCategory`
 * in `src/types.ts`.
 */
export type AugmentCategory = "transports" | "capabilities" | "memory" | "guardrails";

/** Runtime lifecycle hooks reported by the augment inspector. */
export type AugmentLifecycleHook =
  | "onBoot"
  | "onShutdown"
  | "onTurnStart"
  | "onTurnEnd"
  | "onIdle"
  | "scheduleAfterTurn";

/** Top-level identity fields read from `agent.yaml`. */
export interface AgentMeta {
  id?: string;
  name?: string;
  displayName?: string;
  creator?: {
    displayName?: string;
  };
  purpose?: string;
  engine?: {
    provider?: string;
    model?: string;
  };
  identityPath?: string;
}

/**
 * Summary of one mounted augment. Mirrors `AugmentSummary` in
 * `src/transports/admin/admin-collector.ts`. Used by the dashboard payload to
 * list every mounted augment — settings-bearing or not.
 */
export interface AugmentSummary {
  /** Canonical type name from the create-flow catalog (primary row label). */
  type: string;
  /** Runtime instance name — often equals type, differs for namespaced augments. */
  name: string;
  version?: string;
  required: boolean;
  category: AugmentCategory;
  hasContext: boolean;
  usesSharedMemoryTools: boolean;
  toolCount: number;
  isTransport: boolean;
  isMemoryProvider: boolean;
  httpRouteCount: number;
  hasAdminInfo: boolean;
  lifecycleHooks: AugmentLifecycleHook[];
  handlesInternalTurns: boolean;
  hasTurnGate: boolean;
  /** Safe memory ownership and context policy metadata reported by the runtime. */
  memory?: {
    ownership:
      | { kind: "static"; labels: string[] }
      | { kind: "namespace"; prefix: string };
    mutable: boolean;
    origin: string;
    priority: string;
    placement: string;
    eviction: string;
    ttl: string;
    writeTrustLevels?: string[];
  };
}

/** Skill installed under `<agentDir>/skills/<folder>/SKILL.md`. */
export interface InstalledSkillInfo {
  folder: string;
  name: string | null;
  description: string | null;
  provenance: "auggy-provided" | "customized-auggy-skill" | "user-created";
  fromAugmentType?: string;
  frontmatterValid: boolean;
  contentBytes: number;
}

/** Skill shipped by an augment but not yet installed. */
export interface AvailableSkillInfo {
  folder: string;
  name: string | null;
  description: string | null;
  provenance: "auggy-provided";
  fromAugmentType?: string;
}

export interface SkillsInfo {
  installed: InstalledSkillInfo[];
  available: AvailableSkillInfo[];
  skillsDir: string | null;
}

export type RouteAuthMode =
  | "bearer"
  | "creator"
  | "none"
  | "visitor.optional"
  | "visitor.required"
  | "agent.required";

export interface RouteManifestEntry {
  method: "GET" | "POST";
  path: string;
  augmentName: string;
  auth: RouteAuthMode;
  params: string[];
  public: boolean;
  security: "public" | "private";
  timeoutMs?: number;
  maxBodyBytes?: number;
  rateLimit?: { maxPerMinute: number };
  policy?: { kind: string; provider?: string; secretEnv?: string };
  requires?: unknown;
  requestJsonSchema?: {
    params?: Record<string, unknown>;
    query?: Record<string, unknown>;
    body?: Record<string, unknown>;
  };
  responseJsonSchema?: Record<string, unknown>;
  requestMediaTypes?: string[];
  responseMediaTypes?: string[];
}

export interface RouteManifestSummary {
  totalRoutes: number;
  publicRoutes: number;
  privateRoutes: number;
  publicRoutePaths: string[];
}

export interface RoutesInfo {
  summary: RouteManifestSummary;
  entries: RouteManifestEntry[];
}

export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});
export type TrustLevel = "creator" | "agent" | "public";

export interface ToolSummary {
  name: string;
  description: string;
  category: ToolCategory;
  augmentName: string;
  augmentType: string;
  hasInputSchema: boolean;
  requires?: unknown;
  constraints: {
    maxToolCallsPerTurn?: number;
    toolTimeoutMs?: number;
    neverExpose: boolean;
    requiresHumanApproval: boolean;
    hiddenFromTrustLevels: TrustLevel[];
    approvalRequiredForTrustLevels: TrustLevel[];
  };
}

export interface ToolInventoryInfo {
  totalTools: number;
  entries: ToolSummary[];
}

export interface WebDashboardState {
  allowAnonymous: { value: boolean | null; source?: string };
  publicIntegration: { value: boolean | null; source?: string };
  publicFrontendUrl?: string;
  port?: string;
  trustedProxies: string[];
  corsOrigins: string[];
  visitorTokensEnabled: boolean | null;
  /** Whether this runtime can resolve a browser token to a Console-safe identity summary. */
  visitorIdentityEnabled?: boolean;
  externalAuthEnabled: boolean | null;
  externalAuthHeader?: string;
  externalAuthAudience?: string;
  agentAccessEntries?: string;
}

/**
 * Process-lifetime, aggregate runtime state. It intentionally has no dynamic
 * labels, customer identifiers, content, destinations, or exception text.
 */
export interface RuntimeOperationalState {
  schemaVersion: 1;
  scope: "process";
  startedAt: number;
  collectedAt: number;
  readiness: {
    accepting: boolean;
    state: "not-started" | "accepting" | "draining" | "stopped";
  };
  scheduler: {
    state: "accepting" | "draining" | "stopped";
    activeTurns: number;
    queuedTurns: number;
    activeThreads: number;
    queuedThreads: number;
    quarantinedThreads: number;
    oldestQueueWaitMs: number;
    queueWait: { count: number; totalMs: number; maxMs: number };
    admitted: number;
    settled: number;
    rejected: number;
    canceled: number;
    quarantined: number;
    rejectedByReason: Record<string, number>;
  };
  turns: Record<string, number>;
  inference: Record<string, number>;
  tools: Record<string, number>;
  responseDelivery: Record<string, number>;
  hooks: Record<string, number>;
  threadRecovery: Record<string, number>;
  shutdown: Record<string, number | boolean>;
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
}

export interface DashboardData {
  card: AgentCardLite;
  /** Auggy package/runtime version from package.json. */
  auggyVersion: string;
  /** Top-level identity read from agent.yaml; null when unavailable. */
  agentMeta: AgentMeta | null;
  augments: AugmentSummary[];
  tools: ToolInventoryInfo;
  routes: RoutesInfo;
  web: WebDashboardState;
  /** Present for current runtimes; optional so an older runtime remains readable during rollback. */
  runtime?: RuntimeOperationalState | null;
  blocks: AdminInfoBlock[];
  csrfTokens: CsrfToken[];
  /** Skills snapshot — installed + available Auggy-provided skills. */
  skills: SkillsInfo;
}
