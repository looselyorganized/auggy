import type { z } from "zod";
import type { CostResult } from "./engines/_shared/cost";
export type { CostResult } from "./engines/_shared/cost";

// === Context Types (spec §3) ===

export type ContextPlacement = "system" | "preamble" | "assistant-preamble";
export type ContextProvenance = "identity" | "memory" | "retrieval" | "augment";
export type ContextPriority = "required" | "high" | "normal" | "low" | "evictable";
export type EvictionPolicy = "never" | "summarize" | "drop";
export type ContextOrigin = "operator" | "system" | "agent" | "peer-derived";

export interface ContextBlock {
  source: string;
  content: string;
  placement: ContextPlacement;
  provenance: ContextProvenance;
  priority: ContextPriority;
  eviction: EvictionPolicy;
  origin: ContextOrigin;
  ttl?: "turn" | "session" | "persistent";
  visibility?: "public" | "pipeline-only";
  tokenCount?: number;
}

// === A2A-compatible content types (spec §3, A2A-shaped) ===

export type Part =
  | { kind: "text"; text: string }
  | { kind: "file"; uri: string; mimeType?: string; name?: string }
  | { kind: "data"; data: Record<string, unknown> };

// === Task lifecycle (A2A-shaped, v1 uses "completed" | "failed" | "canceled") ===

export type TaskState =
  | "working"
  | "input-required"
  | "auth-required"
  | "completed"
  | "failed"
  | "canceled"
  | "rejected";

// === Memory Provider Contract ===

export interface MemoryDefaults {
  mutable: boolean;
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  ttl?: "turn" | "session" | "persistent";
}

export interface MemoryEntry {
  label: string;
  content: string;
  metadata?: Record<string, unknown>;
  // Provenance — providers that don't track this omit these fields
  peerId?: string;
  trustLevel?: TrustLevel;
  createdAt?: number;
  supersededBy?: string;
  retentionClass?: "operational" | "lesson";
  isVerbatim?: boolean;
}

export interface MemoryQueryOpts {
  peerId?: string;
}

export interface MemoryWriteOpts {
  peerId?: string;
  trustLevel?: TrustLevel;
}

export interface StaticMemoryProvider {
  owns: { kind: "static"; labels: string[] };
  defaults: MemoryDefaults;
  read: (label: string) => Promise<MemoryEntry | null>;
  write?: (label: string, content: string) => Promise<void>;
}

export interface NamespaceMemoryProvider {
  owns: { kind: "namespace"; prefix: string };
  defaults: MemoryDefaults;
  search: (query: string, opts?: MemoryQueryOpts) => Promise<MemoryEntry[]>;
  write?: (label: string, content: string, opts?: MemoryWriteOpts) => Promise<void>;
  read?: (label: string) => Promise<MemoryEntry | null>;
  list?: () => Promise<string[]>;
  forget?: (peerId: string) => Promise<number>;
}

export type MemoryProviderSpec = StaticMemoryProvider | NamespaceMemoryProvider;

// === Tool Types (spec §3) ===

export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});

export interface ToolExecuteContext {
  turnId: string;
  peer: PeerIdentity | null;
  threadId: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TInput = any> {
  name: string;
  description: string;
  category: ToolCategory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: z.ZodType<TInput, any, any>;
  inputJsonSchema?: Record<string, unknown>;
  execute: (input: TInput, context?: ToolExecuteContext) => Promise<string>;
}

// === Peer Identity (spec §4) ===

export type PeerKind = "human" | "agent" | "system" | "anonymous";

/**
 * Trust level for an inbound peer. Determines what they CAN do
 * (capability gating).
 *
 *   creator — the deployer of this specific agent. Bypasses budgets.
 *   agent   — a machine the creator has admitted (shared-secret).
 *   public  — everyone else (anonymous or recognized via visitor token).
 *
 * v0 ships these three. "person" (verified human, post-OAuth/SSO) is
 * the post-v0 fourth level — reserved in design, not enabled in code.
 */
export type TrustLevel = "creator" | "agent" | "public";

export interface PeerIdentity {
  id: string;
  kind: PeerKind;
  trustLevel: TrustLevel;
  /**
   * Substate within the `public` trust level. Set by the transport at
   * identity resolution. Differentiates first-contact anonymous visitors
   * from those holding a valid agent-issued visitor token.
   *
   * - "anonymous": no token, ephemeral peer.id (anon-<threadId>).
   *   Memory writes attach to ephemeral identity.
   * - "recognized": HMAC-verified visitor token, durable peer.id (vis_*).
   *   Memory writes attach to durable identity.
   *
   * Present iff trustLevel === "public". Other trust levels MUST omit it.
   */
  publicSubstate?: "anonymous" | "recognized";
  sourceAugment: string;
  displayName?: string;
  orgId?: string;
}

// === Turn Types (spec §4) ===

export type TurnTriggerType = "message" | "scheduled" | "event" | "continuation";

export interface InboundMessage {
  parts: Part[];
  sourceAugment: string;
  peer: PeerIdentity | null;
  timestamp: number;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface TurnTrigger {
  type: TurnTriggerType;
  turnId: string;
  threadId?: string;
  contextId?: string;
  taskId?: string;
  timestamp: number;
  source?: string;
  peer?: PeerIdentity | null;
  payload: InboundMessage | Record<string, unknown>;
}

export interface TurnState {
  turnId: string;
  threadId: string;
  trigger: TurnTrigger;
  peer: PeerIdentity | null;
  toolCallsSoFar: number;
  turnStartedAt: number;
  metadata: Record<string, unknown>;
}

export interface OutboundMessage {
  parts: Part[];
  targetAugment?: string;
  targetPeer?: string;
  contextId?: string;
  taskId?: string;
  metadata?: Record<string, unknown>;
}

export interface ToolCallRecord {
  name: string;
  input: unknown;
  output: string;
  durationMs: number;
}

export interface TurnTrace {
  turnId: string;
  threadId: string;
  timestamp: number;
  duration: number;
  trigger: {
    type: string;
    sourceAugment?: string;
    peerKind?: string;
    trustLevel?: string;
  };
  contextAssembly: {
    augmentBlocks: {
      source: string;
      tokens: number;
      included: boolean;
      evicted: boolean;
    }[];
    preambleTokens: number;
    toolSchemaTokens: number;
    historyTokens: number;
    totalTokens: number;
    budgetUsed: number;
  };
  toolSelection: {
    totalTools: number;
    phase1Used: boolean;
    selectedCategories?: string[];
    mountedTools: string[];
    withheldTools: string[];
  };
  inferenceSteps: {
    model: string;
    inputTokens: number;
    outputTokens: number;
    durationMs: number;
    toolCalls: {
      name: string;
      augment: string;
      durationMs: number;
      approved: boolean;
    }[];
    cost: CostResult;
  }[];
  capabilityChecks: {
    tool: string;
    result: "allowed" | "needs-approval" | "denied";
  }[];
  approvals?: {
    tool: string;
    outcome: "approved" | "denied" | "timeout";
    waitMs: number;
  }[];
  outputValidation?: {
    flagged: boolean;
    reasons: string[];
  };
}

export interface TurnResult {
  turnId: string;
  success: boolean;
  status: TaskState;
  response?: OutboundMessage;
  responses?: OutboundMessage[];
  errorResponse?: string;
  toolCalls: ToolCallRecord[];
  trace: TurnTrace;
  error?: { message: string; source: string };
  /**
   * When status is "rejected", this names the class of rejection so
   * the transport can map to the right HTTP status:
   *   - "cap-denied"            → HTTP 429 (over budget cap)
   *   - "admission-state-failed" → HTTP 5xx (confirm-phase failure)
   *   - "engine-error"          → HTTP 5xx (engine call threw)
   *   - other strings           → HTTP 5xx fallback
   *
   * Optional for backward compatibility — older callers and existing
   * rejection sites may not yet set this.
   */
  errorClass?: string;
}

// === Kernel Events (internal — emitted by turn loop, consumed by transports) ===

export type KernelEvent =
  | {
      kind: "run_started";
      turnId: string;
      threadId: string;
      contextId?: string;
      taskId?: string;
    }
  | {
      kind: "tool_call_started";
      turnId: string;
      toolCallId: string;
      toolName: string;
      augmentName: string;
    }
  | {
      kind: "tool_call_args";
      turnId: string;
      toolCallId: string;
      args: Record<string, unknown>;
    }
  | {
      kind: "tool_call_result";
      turnId: string;
      toolCallId: string;
      output: string;
      isError: boolean;
    }
  | {
      kind: "text_message";
      turnId: string;
      messageId: string;
      role: "assistant";
      text: string;
    }
  | {
      kind: "text_message_start";
      turnId: string;
      messageId: string;
      role: "assistant";
    }
  | {
      kind: "text_message_delta";
      turnId: string;
      messageId: string;
      delta: string;
    }
  | {
      kind: "text_message_end";
      turnId: string;
      messageId: string;
    }
  | {
      kind: "run_finished";
      turnId: string;
      status: TaskState;
    }
  | {
      kind: "run_error";
      turnId: string;
      message: string;
      source: string;
    };

export type KernelEventHandler = (event: KernelEvent) => void;

// === Message / History (spec §4) ===

export type MessageRole = "user" | "assistant" | "tool_use" | "tool_result";

export interface Message {
  id: string;
  role: MessageRole;
  peerId?: string;
  toolCallId?: string;
  content: string;
  timestamp: number;
  tokenCount: number;
}

// === Model Interface (spec §12) ===

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface AssembledPrompt {
  systemBlocks: string[];
  contextBlocks: string[];
  assistantPreamble?: string[];
  messages: Message[];
  tools: ToolDefinition[];
  toolChoice?: "auto" | "any" | { name: string };
  totalTokens: number;
  evictions: { source: string; priority: ContextPriority; reason: string }[];
}

export interface ModelResponse {
  content: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens?: number; // Anthropic-specific: tokens written to prompt cache
  cacheReadTokens?: number; // Anthropic-specific: tokens read from prompt cache
  finishReason: "end_turn" | "tool_use" | "max_tokens";
  costUsd?: number; // populated by adapter when pricing is known; undefined otherwise
  unpricedReason?: string; // set when costUsd is absent, describes why pricing was unavailable
}

export type ModelDelta = { kind: "text_delta"; text: string };

export interface ModelClient {
  complete(
    prompt: AssembledPrompt,
    opts?: { onDelta?: (delta: ModelDelta) => void },
  ): Promise<ModelResponse>;
  countTokens(text: string): number;
  maxContextTokens: number;
}

// === Storage (spec §5.5) ===

export interface Storage {
  get(key: string): Promise<string | null>;
  put(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

// === Agent Card (A2A-shaped, used for discovery) ===

export interface AgentCardProvider {
  name: string;
  version?: string;
  contact?: string;
}

export interface AgentCardCapabilities {
  streaming: boolean;
  pushNotifications: boolean;
  memory: boolean;
  transport: boolean;
}

export interface AgentCardSkill {
  name: string;
  description: string;
  category: string;
}

export interface AgentCard {
  provider: AgentCardProvider;
  purpose?: string;
  capabilities: AgentCardCapabilities;
  skills: AgentCardSkill[];
  interfaces: string[];
  extensions: Record<string, unknown>;
}

// === Transport (spec §3) ===

export interface TransportKernel {
  handleInbound(
    trigger: TurnTrigger,
    options?: { onEvent?: KernelEventHandler },
  ): Promise<TurnResult>;
  onOutbound(callback: (peer: PeerIdentity, message: OutboundMessage) => Promise<void>): void;
  getAgentCard(): AgentCard;
}

export interface TransportSpec {
  /**
   * Called once at agent boot. The kernel handle is captured for handleInbound
   * dispatch; the augmentName is the operator-chosen runtime name (e.g. "telegram"),
   * which the transport SHOULD use as trigger.source so kernel-emitted outbound
   * messages route back through the agent's outboundHandlers map (keyed by aug.name).
   */
  register(kernel: TransportKernel, augmentName: string): Promise<void>;
  identify(raw: unknown): PeerIdentity | null;
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
}

// === Turn Gate (2PC admission) ===

/**
 * Pre-dispatch admission gate. Augments declaring `turnGate` participate
 * in two-phase commit (2PC) admission: the augment opens a transaction,
 * stages writes inside it, returns a ticket the kernel uses to confirm
 * (commit) or rollback (discard).
 *
 * The kernel pairs every prepare with exactly one of confirm or rollback.
 * Storage transactions enforce atomicity; the augment cannot leak partial
 * state because the writes only escape into the live state when the
 * kernel signals confirm.
 *
 * v0 NOTE: This contract is FIRST-PARTY ONLY. The kernel cannot
 * mechanically prevent third-party augments from violating the
 * prepare-then-confirm contract (e.g. by writing outside the transaction).
 * v0 ships with the budgets augment as the sole turn-gate; third-party
 * turn-gate augments are out of scope until the contract has more
 * real-world miles.
 */
export interface TurnGateProvider {
  /**
   * Stage admission writes inside an open transaction. Returns a ticket
   * the kernel uses to confirm or rollback. The augment evaluates caps
   * using whatever reads it needs, stages reservation rows / rate-limit
   * ticks / etc inside the transaction, and returns either:
   *   - { decision: { allow: false, reason }, confirm, rollback }
   *     where confirm is a no-op and rollback closes the read transaction.
   *   - { decision: { allow: true }, confirm, rollback }
   *     where confirm commits the staged writes and rollback discards them.
   *
   * The kernel pairs every prepare with exactly one of confirm/rollback.
   */
  prepare(args: {
    turnId: string;
    peer: PeerIdentity | null;
    threadId: string;
    trigger: TurnTrigger;
  }): Promise<TurnGateTicket>;

  /**
   * Post-response cost commit. Receives the cost result; the augment
   * uses this to debit USD totals or mark reservations completed.
   * The CostResult discriminated union forces unpriced-aware handling.
   *
   * Optional. Errors here are logged but do not fail the turn — the
   * response already exists.
   */
  commit?(args: {
    turnId: string;
    peer: PeerIdentity | null;
    threadId: string;
    cost: CostResult;
  }): Promise<void>;
}

export interface TurnGateTicket {
  decision: { allow: true } | { allow: false; reason: string };
  /** Commit the staged writes. Idempotent — calling twice is a no-op. */
  confirm(): Promise<void>;
  /** Discard the staged writes. Idempotent — calling twice is a no-op. */
  rollback(): Promise<void>;
}

// === Augment (spec §3) ===

export type AugmentCapability = "transport" | "context" | "tools" | "lifecycle";

export interface AugmentConstraints {
  maxToolCallsPerTurn?: number;
  requiresHumanApproval?: string[];
  approvalPolicy?: "block-and-queue" | "skip" | "fail";
  neverExpose?: string[];
  contextTimeoutMs?: number;
  toolTimeoutMs?: number;
  /**
   * Per-trust-level structural constraints. Applied additively on top of the
   * top-level `neverExpose` / `requiresHumanApproval` fields. Top-level rules
   * apply to every peer; per-level rules apply only to the specific level.
   *
   * Example: hide `fs_remove` from public peers but keep it visible to
   * agent and creator:
   *   perTrustLevel: { public: { neverExpose: ["fs_remove"] } }
   *
   * Null peer (internal/scheduled triggers) is treated as "creator" trust.
   */
  perTrustLevel?: Partial<
    Record<
      TrustLevel,
      {
        neverExpose?: string[];
        requiresHumanApproval?: string[];
      }
    >
  >;
}

export interface Augment {
  name: string;
  version?: string;
  required?: boolean;
  capabilities?: AugmentCapability[];
  context?: (turn: TurnState, priorContext?: ContextBlock[]) => Promise<ContextBlock[] | string>;
  receivesPriorContext?: boolean;
  tools?: Tool[];
  transport?: TransportSpec;
  memory?: MemoryProviderSpec;
  constraints?: AugmentConstraints;
  onBoot?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
  onTurnStart?: (turn: TurnState) => Promise<void>;
  onTurnEnd?: (turn: TurnResult) => Promise<void>;
  onIdle?: () => Promise<void>;
  /**
   * Pre-dispatch admission gate. Kernel calls prepare/confirm/rollback
   * before executing the turn. See TurnGateProvider for the 2PC contract.
   *
   * v0 NOTE: First-party only. The budgets augment is the sole shipped
   * implementation. Third-party turn-gate augments are out of scope
   * until the contract has more real-world miles.
   */
  turnGate?: TurnGateProvider;
}

// === Agent Config (spec §8) ===

export type CompactionStrategy = "summarize" | "truncate" | "sliding-window";

export interface AgentConfig {
  name: string;
  purpose?: string;
  model: string;
  augments: Augment[];
  operators?: string[];
  contextBudget?: {
    historyPercent?: number;
    toolSchemaPercent?: number;
  };
  compactionStrategy?: CompactionStrategy;
  /** Max inference loop iterations per turn. Default 10. */
  maxInferenceLoops?: number;
  /** Tool-choice policy sent to the model. "auto" (default) lets the model
   *  decide; "any" forces a tool call; { name } forces a specific tool. */
  toolChoice?: "auto" | "any" | { name: string };
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  agent: string;
  uptime: number;
  augments: Record<string, { status: "ok" | "degraded" | "failed"; error?: string }>;
  model: { reachable: boolean };
}

export interface AgentHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<void>;
  health(): AgentHealth;
  card(): AgentCard;
  inject(trigger: TurnTrigger): Promise<TurnResult>;
}

// === Notify augment ===

export type NotifyAdapterKind = "webhook" | "telegram" | "agentmail";

export interface WebhookNotifyDestination {
  name: string;
  transport: "webhook";
  url: string;
  headers?: Record<string, string>;
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export interface TelegramNotifyDestination {
  name: string;
  transport: "telegram";
  botToken: string;
  chatId: number | string;
  parseMode?: "Markdown" | "HTML" | "MarkdownV2";
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export interface AgentMailNotifyDestination {
  name: string;
  transport: "agentmail";
  /** AgentMail API key (Bearer token, prefix `am_`). Resolve via env interpolation in agent.yaml. */
  apiKey: string;
  /** AgentMail inbox ID this notification is sent FROM. */
  inboxId: string;
  /** Recipient email address(es). String or array; adapter normalizes to array. */
  to: string | string[];
  /** Optional subject prefix prepended to the notify summary. e.g. "[Auggy] ". */
  subjectPrefix?: string;
  /** Optional labels applied to the sent message in AgentMail. */
  labels?: string[];
  /** Override the AgentMail API base URL (testing/sandbox). Default: https://api.agentmail.to/v0 */
  apiBaseUrl?: string;
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export type NotifyDestination =
  | WebhookNotifyDestination
  | TelegramNotifyDestination
  | AgentMailNotifyDestination;

export interface NotifyRateLimitOptions {
  enabled?: boolean;
  cooldownMs?: number;
  globalMaxPerHour?: number;
  dedupWindowMs?: number;
  dedupThreshold?: number;
  perPeerCooldownMs?: number;
}

export interface NotifyAugmentOptions {
  destinations: NotifyDestination[];
  rateLimit?: NotifyRateLimitOptions;
}

export interface NotifyPayload {
  summary: string;
  reason?: string;
  visitor?: string;
}

export interface NotifyDeliveryResult {
  status: "sent" | "failed";
  detail?: string;
}

export interface NotifyAdapter {
  deliver(destination: NotifyDestination, payload: NotifyPayload): Promise<NotifyDeliveryResult>;
}

// ---------------------------------------------------------------------------
// Telegram transport
// ---------------------------------------------------------------------------

export type TelegramInboundMode = "polling" | "webhook";

export interface TelegramPollingOptions {
  timeoutSec?: number;
}

export interface TelegramWebhookOptions {
  publicUrl: string;
  port?: number;
  secretToken: string;
  allowedUpdates?: string[];
}

export interface TelegramAdmittedAgent {
  id: string;
  telegramUserId: number;
}

export type TelegramAnonymousIdentityMode = "ephemeral" | "durable";

export interface TelegramAuthOptions {
  creatorUserIds?: number[];
  admittedAgents?: TelegramAdmittedAgent[];
  recognizedUserIds?: number[];
  /**
   * peer.id durability for anonymous Telegram peers. Default "ephemeral"
   * matches web's anonymous-ephemeral semantics — peer.id is `tg_anon_<threadId>`,
   * memory dies with thread. "durable" uses `tg_user_<userId>` for cross-session
   * recall; operators opt into this consciously.
   */
  anonymousIdentityMode?: TelegramAnonymousIdentityMode;
}

export interface TelegramTransportOptions {
  botToken: string;
  inbound: {
    mode: TelegramInboundMode;
    polling?: TelegramPollingOptions;
    webhook?: TelegramWebhookOptions;
  };
  auth: TelegramAuthOptions;
}
