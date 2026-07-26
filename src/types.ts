import type { z } from "zod";
import type { CostResult } from "./engines/_shared/cost";
export type { CostResult } from "./engines/_shared/cost";

// === Context Types (spec §3) ===

export type ContextPlacement = "system" | "preamble" | "assistant-preamble";
export type ContextProvenance = "identity" | "memory" | "retrieval" | "augment";
export type ContextPriority = "required" | "high" | "normal" | "low" | "evictable";
export type EvictionPolicy = "never" | "summarize" | "drop";
export type ContextOrigin = "operator" | "system" | "agent" | "agent-derived" | "peer-derived";

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

/**
 * Provenance origin of a memory entry. Canonical here; storage types alias
 * via MemoryOrigin so the runtime contract and the storage column type
 * stay in lockstep.
 *
 * - "operator" — written by the operator (config-mounted entries, identity)
 * - "peer-derived" — explicit `memory_write` calls from the model on behalf
 *   of a peer's request ("save this for me")
 * - "agent-derived" — written by background extraction (auto-save, ADR-018
 *   Phase 2; populated by PR β). Paraphrases, not verbatim.
 * - "agent" — direct agent-side writes (rare; reserved for system-internal
 *   writes that shouldn't carry "peer-derived" trust)
 */
export type MemoryOrigin = "operator" | "peer-derived" | "agent-derived" | "agent";

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
  origin?: MemoryOrigin;
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
  /** Optional peer trust allowlist for writes. Omit to use the origin-based policy. */
  writeTrustLevels?: readonly TrustLevel[];
  read: (label: string) => Promise<MemoryEntry | null>;
  write?: (label: string, content: string) => Promise<void>;
}

export interface NamespaceMemoryProvider {
  owns: { kind: "namespace"; prefix: string };
  defaults: MemoryDefaults;
  /** Optional peer trust allowlist for writes. Omit to use the origin-based policy. */
  writeTrustLevels?: readonly TrustLevel[];
  search: (query: string, opts?: MemoryQueryOpts) => Promise<MemoryEntry[]>;
  write?: (label: string, content: string, opts?: MemoryWriteOpts) => Promise<void>;
  read?: (label: string) => Promise<MemoryEntry | null>;
  list?: () => Promise<string[]>;
  forget?: (peerId: string) => Promise<number>;
  /**
   * Read-only listing for `/admin`'s Memory tab. Returns most-recent entries
   * (peer-scoped if `peerId` given). Implementing it is optional — providers
   * that don't surface the admin browser get a "no entries listing available"
   * placeholder in the SPA.
   *
   * Distinct from `search` (query-driven, ranked) and `list` (labels only,
   * no payload). Returns full `MemoryEntry` rows so the tab can render
   * peer/trust/timestamp without a second round-trip.
   */
  listEntries?: (opts?: { peerId?: string; limit?: number }) => Promise<MemoryEntry[]>;
}

export type MemoryProviderSpec = StaticMemoryProvider | NamespaceMemoryProvider;

// === Tool Types (spec §3) ===

export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});

/**
 * Versioned, trusted metadata for one embedded execution. It is accepted only
 * through AgentHandle.inject(); public transports never control these fields.
 * Idempotency material is represented solely by one-way hashes.
 */
export interface ExecutionContextV1 {
  version: 1;
  executionId: string;
  attempt: number;
  deadlineAt?: number;
  correlationId?: string;
  idempotencyKeyHash?: string;
  bindingHash?: string;
}

/** Safe projection permitted in traces and kernel events. */
export interface ExecutionTraceContextV1 {
  version: 1;
  executionId: string;
  attempt: number;
  deadlineAt?: number;
  correlationId?: string;
}

export interface ToolExecuteContext {
  turnId: string;
  peer: PeerIdentity | null;
  threadId: string;
  auth?: RouteAuthContext;
  /** Combined request/deadline cancellation for this exact tool attempt. */
  signal?: AbortSignal;
  /** Safe execution metadata projection; binding and idempotency hashes stay trusted to the kernel. */
  executionContext?: ExecutionTraceContextV1;
  /** Opaque downstream idempotency identity derived from the execution and tool position. */
  operationId?: string;
}

// biome-ignore lint/suspicious/noExplicitAny: Tool is covariant over arbitrary model-facing schemas.
export interface Tool<TInput = any> {
  name: string;
  description: string;
  category: ToolCategory;
  // biome-ignore lint/suspicious/noExplicitAny: ZodType internals vary by schema and should not constrain Tool callers.
  input: z.ZodType<TInput, any, any>;
  inputJsonSchema?: Record<string, unknown>;
  requires?: AuthorizationRequirement | readonly AuthorizationRequirement[];
  execute: (input: TInput, context?: ToolExecuteContext) => Promise<string | ToolResult>;
}

/**
 * Structured tool return shape. Augments may return either a plain string
 * (back-compat with all existing tools) OR a ToolResult that lets the tool
 * influence turn lifecycle.
 *
 * The narrowed `terminate.status` union is a type-level guarantee that
 * augments cannot spoof kernel-controlled states (failed/canceled/rejected/
 * auth-required). Those remain owned by the kernel.
 */
export interface ToolResult {
  /** What the model sees as the tool's output. Replaces the plain-string return. */
  content: string;
  /** Marks an expected tool-level failure without requiring the tool to throw. */
  isError?: boolean;
  /**
   * The tool may have crossed a side-effect boundary without learning the
   * result. The kernel terminates the turn and never asks the model to retry.
   */
  outcomeUnknown?: boolean;
  /** Optional turn-termination directive. */
  terminate?: {
    status: Extract<TaskState, "input-required" | "completed">;
    message?: string;
  };
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
   * Authenticated origin carried across a delegated transport hop.
   *
   * The active transport mints the local `id` and records the original
   * subject separately so peer-derived storage never trusts a caller-chosen
   * cross-transport identifier. Only transports that authenticate and verify
   * the delegation envelope may populate this field.
   */
  delegatedOrigin?: {
    subject: string;
    sourceAugment: string;
    viaPeerId: string;
    hopCount: number;
  };
  /**
   * Substate within the `public` trust level. Set by the transport at
   * identity resolution. Differentiates first-contact anonymous visitors
   * from those holding a valid agent-issued visitor token.
   *
   * - "anonymous": no verified visitor token. The web transport uses a
   *   server-minted anonymous-session subject; it is never derived from the
   *   caller-controlled thread ID.
   * - "recognized": HMAC-verified visitor token, durable peer.id (vis_*).
   *   Memory writes attach to durable identity.
   *
   * Present iff trustLevel === "public". Other trust levels MUST omit it.
   */
  publicSubstate?: "anonymous" | "recognized";
  /**
   * Authenticated one-way identity transition asserted by the transport.
   * A public/recognized peer may use it to prove ownership of the prior
   * anonymous subject during thread and memory promotion.
   *
   * This is authorization evidence, not caller metadata. Transports MUST omit
   * it unless they cryptographically verified the prior subject.
   */
  authenticatedPriorPeerId?: string;
  sourceAugment: string;
  displayName?: string;
  orgId?: string;
}

export interface CreatorConfig {
  /**
   * Human-facing name for the runtime-verified creator. Cosmetic only; never
   * used to prove trust.
   */
  displayName?: string;
}

// === Turn Types (spec §4) ===

export type TurnTriggerType = "message" | "scheduled" | "event" | "continuation" | "internal";

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
  auth?: RouteAuthContext;
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
  /** Caller cancellation for turn-scoped context and lifecycle work. */
  signal?: AbortSignal;
  /** Trusted embedding metadata; never read from a public trigger. */
  executionContext?: ExecutionContextV1;
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
  /** Safe execution metadata projection; excludes binding and idempotency hashes. */
  executionContext?: ExecutionTraceContextV1;
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
    /** Terminal outcome of this exact inference attempt. Legacy traces omit it and imply completed. */
    outcome?: "completed" | "failed" | "canceled" | "outcome-unknown";
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
  /** Trusted execution metadata returned to the embedding caller. */
  executionContext?: ExecutionContextV1;
  /**
   * True when work crossed a side-effect boundary without a trustworthy
   * terminal result. The agent scheduler quarantines the resolved thread
   * against blind retries until a trusted operator explicitly recovers it.
   */
  outcomeUnknown?: boolean;
  /** Structured admission rejection metadata for transport-specific mapping. */
  rejection?: TurnRejection;
  /**
   * When status is "rejected", this names the class of rejection so
   * the transport can map to the right HTTP status:
   *   - "cap-denied"             → HTTP 429 (over budget cap)
   *   - "admission-state-failed" → HTTP 5xx (confirm-phase failure)
   *   - "engine-error"           → HTTP 5xx (engine call threw)
   *
   * Optional because success results and non-classed rejections leave it
   * unset; the transport's default 5xx fallback handles absence.
   */
  errorClass?: TurnRejectionClass;
}

export type TurnRejectionClass = "cap-denied" | "admission-state-failed" | "engine-error";

export type TurnRejectionReason =
  | "peer-rate-limit"
  | "thread-capacity"
  | "source-capacity"
  | "agent-capacity"
  | "runtime-stopping"
  | "thread-quarantined"
  | "causal-depth"
  | "causal-concurrency"
  | "causal-context-expired"
  | "causal-thread-mismatch";

export interface TurnRejection {
  reason: TurnRejectionReason;
  retryAfterMs?: number;
}

// === Transcript + Scheduler (ADR-027) ===

/**
 * Snapshot of a completed turn, captured by the kernel and exposed via
 * SchedulerContext.getCompletedTranscript() for background-work augments.
 *
 * Returned by history-manager's kernel-internal getTranscript(turnId).
 * Returns null when the turn was already compacted before retrieval.
 */
export interface Transcript {
  turnId: string;
  threadId: string;
  peer: PeerIdentity | null;
  parts: Part[];
  toolCalls: ToolCallRecord[];
  startedAt: number;
  endedAt: number;
}

/**
 * Context handed to `Augment.scheduleAfterTurn` (ADR-027). Exposes the
 * narrow surface needed for post-turn background work:
 *
 *   - inject(trigger): admit a follow-up turn through the normal turn
 *     loop. The follow-up gets its own turnId, runs admission/budgets,
 *     fires lifecycle hooks, and surfaces in cost accounting like any
 *     other turn.
 *   - getCompletedTranscript(): retrieve the just-completed turn's
 *     transcript snapshot. Closure-bound to the just-completed turnId;
 *     no turnId argument by design (per ADR-027 Decision 3 — arbitrary
 *     turnId reads stay kernel-internal at v1.0). Returns null when the
 *     turn was already compacted before the hook ran.
 */
export interface SchedulerContext {
  /**
   * Admit a causal follow-up for the same resolved thread. Cross-thread
   * injection from a terminal hook fails closed; use a separate trusted
   * producer for unrelated work.
   */
  inject(trigger: TurnTrigger): Promise<TurnResult>;
  getCompletedTranscript(): Promise<Transcript | null>;
  /** Caller cancellation; background hooks must not begin new work after abort. */
  signal?: AbortSignal;
}

/** Cancellation context shared by terminal turn hooks. */
export interface TurnLifecycleContext {
  signal?: AbortSignal;
}

/**
 * Context handed to `Augment.handleInternalTurn` (ADR-027 Decision 5).
 * Exposes the kernel-resolved threadId + peer for the internal turn so
 * the handler can propagate them when writing to memory or recording
 * side-effects.
 */
export interface InternalTurnContext {
  threadId: string;
  peer: PeerIdentity | null;
  signal?: AbortSignal;
}

// === Kernel Events (internal — emitted by turn loop, consumed by transports) ===

export type KernelEvent =
  | {
      kind: "run_started";
      turnId: string;
      threadId: string;
      contextId?: string;
      taskId?: string;
      /** Safe projection; binding and idempotency hashes are never emitted. */
      execution?: ExecutionTraceContextV1;
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
      /**
       * Optional human-visible message that explains the terminal status.
       * Today this is populated only when a tool's `ToolResult.terminate`
       * carries a `message` (e.g. the prompt from `request_input`). The
       * AG-UI translator forwards it as `RUN_FINISHED.result.message`.
       */
      message?: string;
    }
  | {
      kind: "run_error";
      turnId: string;
      message: string;
      source: string;
    }
  | DelegatedAuthorizationDeniedAuditEvent;

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

export interface ModelResponseLimits {
  /** Maximum UTF-8 bytes in assistant text across one inference. Default 1 MiB. */
  maxTextBytes: number;
  /** Maximum tool calls returned by one inference. Default 32. */
  maxToolCalls: number;
  /** Maximum UTF-8 bytes in one tool name. Default 256. */
  maxToolNameBytes: number;
  /** Maximum serialized UTF-8 bytes in one tool-call argument object. Default 64 KiB. */
  maxToolArgumentBytes: number;
  /** Maximum aggregate serialized argument bytes across one response. Default 256 KiB. */
  maxTotalToolArgumentBytes: number;
  /** Maximum JSON nesting depth in tool arguments. Default 32. */
  maxArgumentDepth: number;
  /** Maximum JSON nodes in each tool argument object. Default 10,000. */
  maxArgumentNodes: number;
  /** Maximum aggregate UTF-8 bytes retained from one model response. Default 2 MiB. */
  maxResponseBytes: number;
  /** Maximum streamed text delta events per inference. Default 10,000. */
  maxStreamEvents: number;
}

export type ModelDelta = { kind: "text_delta"; text: string };

export interface ModelClient {
  complete(
    prompt: AssembledPrompt,
    opts?: { onDelta?: (delta: ModelDelta) => void; signal?: AbortSignal },
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

/**
 * Durable, versioned representation of the model-visible history for one
 * thread. Implementations must treat the payload as opaque; the kernel
 * validates every loaded snapshot before installing it.
 */
export interface ThreadHistorySnapshot {
  version: 1;
  messages: Message[];
}

/**
 * Optional transport-owned persistence for model-visible thread history.
 *
 * The transport passes this only after it has resolved the request's real
 * peer identity. Implementations own the authorization boundary: `load` must
 * atomically claim a new thread or verify its exact owner, while
 * `assertAccess` and `commit` must reject any owner mismatch.
 */
export interface ThreadHistoryPersistence {
  load(threadId: string, peer: PeerIdentity): Promise<unknown | null>;
  assertAccess(threadId: string, peer: PeerIdentity): Promise<void>;
  commit(threadId: string, peer: PeerIdentity, snapshot: ThreadHistorySnapshot): Promise<void>;
}

// === Legacy Auggy runtime metadata (not a current A2A Agent Card) ===

export interface AgentCardProvider {
  name: string;
  displayName?: string;
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
    options?: {
      onEvent?: KernelEventHandler;
      signal?: AbortSignal;
      historyPersistence?: ThreadHistoryPersistence;
      /** Runtime-owned proof that scheduler admission reached task execution. */
      onExecutionStart?: () => void;
    },
  ): Promise<TurnResult>;
  /** Evict an in-memory thread so a later request restores durable state. */
  forgetThreadHistory?(threadId: string): void;
  onOutbound(
    callback: (
      peer: PeerIdentity,
      message: OutboundMessage,
      context?: { signal?: AbortSignal },
    ) => Promise<void>,
  ): void;
  getAgentCard(): AgentCard;
  /** Process-local, aggregate operational state for authenticated operator surfaces. */
  getOperationalSnapshot?(): RuntimeOperationalSnapshot;
  /** Trusted transport-only restoration of a durable thread quarantine. */
  quarantineThread(threadId: string): boolean;
  /**
   * Trusted console-only handoff after a durable incident was reconciled.
   * The runtime releases the lane only when every registered durable
   * quarantine authority reports that the thread is clear.
   */
  recoverThread(threadId: string): boolean;
  /**
   * Cross-augment HTTP routes collected at `agent.start()` after
   * `lifecycle.boot()`. Returns a frozen array — transports MUST NOT mutate.
   * Transports that don't speak HTTP simply ignore this method.
   */
  getAugmentRoutes(): readonly AugmentHttpRoute[];
  /**
   * G36 — returns the live augment list for /console's adminInfo collection
   * + boot-time action-handler validation. Returns a frozen snapshot so
   * downstream iteration is safe even if an augment's adminInfo() happened
   * to mutate the array.
   */
  getAugments(): readonly Augment[];
}

export interface TransportSpec {
  /**
   * Called once at agent boot. The kernel handle is captured for handleInbound
   * dispatch; the augmentName is the operator-chosen runtime name (e.g. "telegram"),
   * which the transport SHOULD use as trigger.source so kernel-emitted outbound
   * messages route back through the agent's outboundHandlers map (keyed by aug.name).
   */
  register(kernel: TransportKernel, augmentName: string): Promise<void>;
  /**
   * Called after every mounted transport has successfully registered. This is
   * the first lifecycle phase in which a transport may bind a listener, start
   * polling, or otherwise admit inbound traffic.
   *
   * `register()` must remain preparation-only so no transport can deliver a
   * turn before all transports have a kernel handle. Resources started here
   * must be released idempotently by the owning augment's `onShutdown()`.
   * Calls should be idempotent once readiness has been reached.
   */
  ready?(): Promise<void>;
  identify(raw: unknown): PeerIdentity | null;
  /** Source-specific active cap inside the agent-wide scheduler. */
  concurrency?: number;
  /** Source-specific waiting cap inside the agent-wide scheduler. */
  maxQueueDepth?: number;
  /** Source-specific peer admission policy enforced by the scheduler. */
  rateLimitPerPeer?: { maxPerMinute: number };
}

// === Augment HTTP routes (PR γ.1) ===

/**
 * HTTP methods supported by augment-registered routes.
 *
 * v1 limits to GET + POST. PUT/DELETE/PATCH deferred — no current consumer
 * needs them, and a smaller surface reduces audit cost. Add on demand.
 */
export type HttpMethod = "GET" | "POST";

/**
 * Authentication mode for an augment-registered HTTP route.
 *
 * - `"bearer"` — the route inherits webTransport's bearer-token check (same
 *   token that gates `/agent/run`). Recommended default for any route that
 *   represents creator-driven action.
 * - `"creator"` — semantic alias for creator-only routes. Uses the same web
 *   bearer check as `"bearer"`, but exposes `auth.mode === "creator"` to route
 *   handlers so app code can distinguish intentional creator authority from
 *   legacy bearer naming.
 * - `"none"` — the route accepts any caller. Opt-in only; required for
 *   public callbacks like email magic-link clicks (PR γ.2 visitorAuth) where
 *   the visitor can't supply a bearer token. Boot logs a warning per
 *   `auth: "none"` route so operators can't miss them.
 * - `"visitor.optional"` — the route accepts anonymous callers but receives
 *   recognized visitor context when `x-visitor-token` is valid. Public posture.
 * - `"visitor.required"` — the route requires a valid `x-visitor-token` or
 *   configured external auth assertion and receives recognized visitor context.
 *   Missing, invalid, expired, wrong-agent, or revoked visitor tokens fail before
 *   the handler runs unless a valid external assertion is present. `email`
 *   metadata is present only when the transport is wired with visitorAuth /
 *   identityLookup or verified external auth claims.
 * - `"agent.required"` — the route requires admitted machine/agent credentials.
 *   `webTransport` currently verifies `x-agent-id` and `x-agent-secret` against
 *   `access.agents` and exposes agent route context.
 */
export type AugmentHttpRouteAuth =
  | "bearer"
  | "creator"
  | "none"
  | "visitor.optional"
  | "visitor.required"
  | "agent.required";

export type AugmentHttpRouteWebhookProvider = "stripe" | "github" | "svix" | (string & {});

export interface AugmentHttpRouteWebhookSignaturePolicy {
  kind: "webhook.signature";
  provider: AugmentHttpRouteWebhookProvider;
  /**
   * Environment variable that stores the provider signing secret. The route
   * manifest exposes the variable name only, never the secret value.
   */
  secretEnv?: string;
  /**
   * Max accepted age for provider timestamps. Stripe and Svix verification
   * default to 300 seconds when omitted.
   */
  timestampToleranceSeconds?: number;
}

export type AugmentHttpRoutePolicy = AugmentHttpRouteWebhookSignaturePolicy;

export interface RouteWebhookContext {
  kind: "webhook.signature";
  provider: AugmentHttpRouteWebhookProvider;
  /** Parsed provider event payload after signature verification. */
  event: unknown;
  /** Provider delivery identifier. Stable across retries when supplied. */
  deliveryId?: string;
  /** Unix timestamp in seconds from the provider signature envelope. */
  timestamp?: number;
  /** Local wall-clock time when the transport accepted the webhook. */
  receivedAt: number;
}

export interface RouteVisitorIdentity {
  visitorId: string;
  agentId: string;
  issuedAt: number;
  expiresAt: number;
  orgId?: string;
  email?: string;
  verifiedAt?: number;
  reverifyDueAt?: number;
  externalAuth?: RouteExternalAuthClaims;
}

export type AuthorizationScope = string & {};
export type AuthorizationAction = string & {};
export type AuthorizationResource = string & {};

export type AuthorizationConstraintValue =
  | string
  | number
  | boolean
  | null
  | readonly AuthorizationConstraintValue[]
  | { readonly [key: string]: AuthorizationConstraintValue };

export type AuthorizationConstraints = Readonly<Record<string, AuthorizationConstraintValue>>;

/**
 * App-signed delegated permission. The application remains the source of
 * authorization truth; Auggy only verifies and enforces the compact grants it
 * receives for the current request.
 */
export interface AuthorizationGrant {
  action: AuthorizationAction;
  resource?: AuthorizationResource;
  constraints?: AuthorizationConstraints;
}

export type AuthorizationResourceBinding =
  | AuthorizationResource
  | {
      /** Bind the required resource to a path parameter such as `/orders/:id`. */
      param: string;
    }
  | {
      /** Bind the required resource to a validated tool input field. */
      input: string;
    };

export type AuthorizationRequirement =
  | {
      scope: AuthorizationScope;
    }
  | {
      action: AuthorizationAction;
      resource?: AuthorizationResourceBinding;
      constraints?: AuthorizationConstraints;
    };

export type DelegatedAuthorizationFailureReason =
  | "authorization-claims-required"
  | "authorization-scope-missing"
  | "authorization-grant-missing"
  | "authorization-resource-unresolved";

export interface RouteExternalAuthClaims {
  keyId?: string;
  provider: string;
  subject: string;
  orgId?: string;
  roles?: readonly string[];
  scopes?: readonly AuthorizationScope[];
  grants?: readonly AuthorizationGrant[];
  authzVersion?: string;
  jti?: string;
}

export type DelegatedAuthorizationDeniedAuditTarget =
  | {
      type: "route";
      route: string;
      method: HttpMethod;
      path: string;
      auth: AugmentHttpRouteAuth;
    }
  | {
      type: "tool";
      toolName: string;
      augmentName: string;
      turnId: string;
      threadId: string;
    };

export interface DelegatedAuthorizationDeniedAuditEvent {
  kind: "delegated_authorization_denied";
  reason: DelegatedAuthorizationFailureReason;
  requirement: AuthorizationRequirement;
  target: DelegatedAuthorizationDeniedAuditTarget;
  keyId?: string;
  provider?: string;
  subject?: string;
  orgId?: string;
}

export type RouteAuthPrincipal =
  | {
      kind: "anonymous";
      trustLevel: "public";
      publicSubstate: "anonymous";
    }
  | {
      kind: "visitor";
      trustLevel: "public";
      publicSubstate: "recognized";
      visitorId: string;
      agentId: string;
      orgId?: string;
      email?: string;
      verifiedAt?: number;
      reverifyDueAt?: number;
      externalAuth?: RouteExternalAuthClaims;
    }
  | {
      kind: "creator";
      trustLevel: "creator";
      peerId: "creator";
    }
  | {
      kind: "agent";
      trustLevel: "agent";
      agentId: string;
      peerId: `agent:${string}`;
      displayName?: string;
      orgId?: string;
    };

export type RouteAuthContext =
  | {
      mode: "none";
      principal: Extract<RouteAuthPrincipal, { kind: "anonymous" }>;
    }
  | {
      mode: "bearer";
      principal: Extract<RouteAuthPrincipal, { kind: "creator" }>;
    }
  | {
      mode: "creator";
      principal: Extract<RouteAuthPrincipal, { kind: "creator" }>;
    }
  | {
      mode: "visitor";
      state: "anonymous";
      principal: Extract<RouteAuthPrincipal, { kind: "anonymous" }>;
    }
  | ({
      mode: "visitor";
      state: "recognized";
      principal: Extract<RouteAuthPrincipal, { kind: "visitor" }>;
    } & RouteVisitorIdentity)
  | {
      mode: "agent";
      principal: Extract<RouteAuthPrincipal, { kind: "agent" }>;
      agentId: string;
      peerId: `agent:${string}`;
      displayName?: string;
      orgId?: string;
    };

export type RouteVisitorAuthContext = Extract<RouteAuthContext, { mode: "visitor" }>;
export type RouteAgentAuthContext = Extract<RouteAuthContext, { mode: "agent" }>;

export interface AugmentHttpRouteRequestJsonSchema {
  /** JSON Schema for `:param` path params, usually generated from `defineRoute`'s Zod schema. */
  params?: Record<string, unknown>;
  /** JSON Schema for parsed query params, usually generated from `defineRoute`'s Zod schema. */
  query?: Record<string, unknown>;
  /** JSON Schema for parsed JSON request body, usually generated from `defineRoute`'s Zod schema. */
  body?: Record<string, unknown>;
}

export type AugmentHttpRouteResponseJsonSchema = Record<string, unknown>;

/**
 * One HTTP route registered by an augment. Routes are collected at
 * `agent.start()` AFTER `lifecycle.boot()` succeeds (so `onBoot`-populated
 * route lists are visible) and BEFORE any transport binds a port. Path
 * collisions (vs built-in paths or across augments) throw at `agent.start()`,
 * never silently override.
 */
export interface AugmentHttpRoute {
  method: HttpMethod;
  /**
   * Route path. Static paths are exact-match. Parameterized paths support
   * full-segment `:param` placeholders such as `/orders/:id`.
   * Must start with `/`. Reserved paths (cannot be registered):
   *   - "/"
   *   - "/agent/run"
   *   - "/health"
   *   - "/.well-known/agent-card.json"
   * Convention: scope under `/<augment-name>/...` to make collisions unlikely.
   */
  path: string;
  /** Auth mode is required — no implicit default; forces deliberate choice. */
  auth: AugmentHttpRouteAuth;
  /**
   * Optional per-route handler timeout in milliseconds. Default 30_000.
   * Times out → 504. Independent from Bun.serve's connection idleTimeout.
   */
  timeoutMs?: number;
  /**
   * Optional max body bytes the dispatcher will accept. Default 1_048_576 (1 MB).
   * Over cap → 413 before the handler runs. Enforced by counting actual bytes
   * read from req.body (not trusting content-length, which is bypassable via
   * chunked encoding or omission).
   */
  maxBodyBytes?: number;
  /**
   * Optional sliding-window rate limit per route (NOT per peer — auth-none
   * routes have no peer). Returns 429 with `Retry-After` when triggered.
   */
  rateLimit?: {
    maxPerMinute: number;
  };
  /**
   * Optional route policy metadata for tooling, manifests, and generated
   * clients. v1.x treats policies as descriptive metadata unless a transport
   * explicitly implements the verifier; do not rely on this field alone as an
   * authorization boundary.
   */
  policy?: AugmentHttpRoutePolicy;
  /**
   * Optional request schemas for operator tooling and OpenAPI-ish export.
   * The dispatcher still validates via the route handler/helper; this metadata
   * is descriptive and must not be treated as an authorization boundary.
   */
  requestJsonSchema?: AugmentHttpRouteRequestJsonSchema;
  /**
   * Ordered, concrete media types accepted by the request body. The first entry
   * is the preferred representation for generated artifacts. Wildcard ranges
   * and GET request bodies are rejected. When omitted, a JSON body schema
   * implies `application/json` without materializing this field.
   */
  requestMediaTypes?: readonly string[];
  /**
   * Optional JSON Schema for the route's successful JSON response.
   * v1.x models only the default success payload; non-2xx error contracts remain
   * intentionally generic until Auggy has a stable route error protocol.
   */
  responseJsonSchema?: AugmentHttpRouteResponseJsonSchema;
  /**
   * Ordered, concrete media types returned by a successful response. The first
   * entry is the preferred representation for generated artifacts. Wildcard
   * ranges are rejected. When omitted, a JSON response schema implies
   * `application/json` without materializing this field.
   */
  responseMediaTypes?: readonly string[];
  /**
   * Delegated app authorization requirements. These are satisfied only by
   * verified external auth claims (`scopes` / `grants`) on recognized visitor
   * context; Auggy does not infer app permissions from roles.
   */
  requires?: AuthorizationRequirement | readonly AuthorizationRequirement[];
  /**
   * The handler. Receives the raw Request and an options bag carrying an
   * AbortSignal that fires on timeout. Handlers SHOULD listen for the
   * signal and short-circuit side-effecting work to avoid duplicate effects
   * after a 504. Errors thrown are caught by the dispatcher and surfaced
   * as 500 with an opaque body; the actual error is logged with the route
   * path for triage.
   */
  handler: (
    req: Request,
    opts: {
      signal: AbortSignal;
      /**
       * Auth mode enforced by the dispatcher for this route. v1.x exposes the
       * current mode only; visitor/agent identity resolution is intentionally
       * deferred until route context has a stable trust model.
       */
      auth?: RouteAuthContext;
      /** Path parameters resolved by the HTTP dispatcher for `:param` routes. */
      params?: Record<string, string>;
      /** Verified webhook policy context when a transport verifier accepted the route. */
      webhook?: RouteWebhookContext;
      /**
       * Effective path after helper transforms such as `defineRoute.group()`.
       * Raw handlers can ignore this; helper-generated handlers use it for
       * accurate route context.
       */
      routePath?: string;
    },
  ) => Promise<Response>;
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
   * Optional. The kernel treats an error here as outcome-unknown after
   * inference and does not return a successful terminal result.
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

// ===========================================================================
// Admin information contract used by webTransport's console dashboard.
// See docs/21-console.md for the current operator-surface contract.
// ===========================================================================

/** A typed render block for an augment's section on /admin. */
export interface AdminInfoBlock {
  /** Stable identifier; used in audit logs + action dispatch. */
  augmentName: string;
  /** Human-readable heading. */
  title: string;
  /** Ordered sections rendered in the block. */
  sections: AdminSection[];
  /** Optional augment-level actions (rendered as forms at the bottom). */
  actions?: AdminAction[];
}

/** Section variants. The four primitives v1.0 supports. */
export type AdminSection =
  | {
      kind: "keyValue";
      rows: Array<{
        label: string;
        value: string;
        /** Optional annotation, e.g. "source: yaml". */
        source?: string;
        /** Optional reset-to-yaml affordance for rows with /admin-override source. */
        resetAction?: { id: string; label: string };
      }>;
    }
  | {
      kind: "table";
      columns: string[];
      rows: string[][];
      /** Optional per-row buttons. */
      rowActions?: AdminRowAction[];
      /** Optional caption (e.g., "Showing 50 of 234"). */
      caption?: string;
    }
  | {
      kind: "status";
      level: "ok" | "warn" | "error";
      message: string;
    }
  | {
      kind: "eventStream";
      events: Array<{ timestamp: string; type: string; summary: string }>;
      caption?: string;
    };

/** Augment-level action (rendered as a form). */
export interface AdminAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  inputs?: AdminActionInput[];
}

/** Form input declaration on an AdminAction. */
export interface AdminActionInput {
  name: string;
  label: string;
  type: "text" | "number" | "boolean";
  required: boolean;
  default?: string;
  helpText?: string;
}

/** Per-row action button (rendered next to each row in a table section). */
export interface AdminRowAction {
  id: string;
  label: string;
  confirmRequired: boolean;
  /** Which column's value to pass as `rowKey` to the action handler. */
  rowKeyColumn: number;
}

/** Result returned by an AdminActionHandler. */
export interface AdminActionResult {
  ok: boolean;
  /** Human-readable message displayed as flash on the redirected admin page. */
  message: string;
  /** @internal Release only this scheduler lane after the handler durably resolves its incident. */
  recoverThreadId?: string;
}

/**
 * Handler signature for adminActions[id]. The dispatcher coerces form inputs
 * to declared types (string/number/boolean) before calling the handler, so
 * params arrive typed-string but the handler can assume coercion succeeded.
 * For row actions, the rowKey is delivered in params under the key "rowKey".
 */
export type AdminActionHandler = (params: Record<string, string>) => Promise<AdminActionResult>;

/**
 * Operator-facing category for the Augments tab grouping. Every augment
 * declares the role it plays for the agent so the SPA can group cards by
 * what they DO, not by which file they live in. Adding a new category is
 * a deliberate decision — keep the set short.
 *
 *   - `transports`  — how the agent talks to the outside world (in + out).
 *   - `capabilities`— what the agent can DO (tools, scripts, side effects).
 *   - `memory`      — what the agent remembers / knows.
 *   - `guardrails`  — limits, identity, safety, trust.
 */
export type AugmentCategory = "transports" | "capabilities" | "memory" | "guardrails";

/**
 * First-party, runtime-trusted durable thread quarantine authority.
 *
 * These methods must be synchronous so checking every authority and changing
 * scheduler state is one event-loop critical section. They are lifecycle and
 * operator-recovery plumbing, never model-visible tools or HTTP actions.
 */
export interface DurableThreadQuarantine {
  listThreadIds(): readonly string[];
  hasThread(threadId: string): boolean;
}

export interface Augment {
  name: string;
  /**
   * Canonical type identifier as the operator declares it in `agent.yaml`'s
   * `type:` field (and as the create-flow catalog enumerates it). Stable
   * across instances of the same factory — e.g. `layeredMemory` even if the
   * runtime `name` is `layered-memory-${namespace}`. Used as the primary
   * label in the `/admin` Augments tab so the operator sees the names they
   * typed into config, not derived runtime slugs.
   */
  type?: string;
  version?: string;
  required?: boolean;
  /** Operator-facing category. Used by `/admin`'s Augments tab to group. */
  category?: AugmentCategory;
  /**
   * True for augments the kernel injects automatically (not user-declared in
   * `agent.yaml`). The Augments tab hides these — the operator didn't add them
   * and can't unmount them; they're plumbing. Example: `memory-bus`, which
   * registers the memory tools whenever any memory provider is mounted.
   */
  synthetic?: boolean;
  context?: (turn: TurnState, priorContext?: ContextBlock[]) => Promise<ContextBlock[] | string>;
  receivesPriorContext?: boolean;
  tools?: Tool[];
  transport?: TransportSpec;
  /**
   * HTTP routes the augment serves on any HTTP-capable transport (today: webTransport).
   * Collected at `agent.start()` after `onBoot` runs; immutable thereafter.
   * See `AugmentHttpRoute` for the contract.
   */
  httpRoutes?: AugmentHttpRoute[];
  /**
   * G36 — optional dashboard block for the built-in /admin route.
   * Augments that implement this opt into being dashboarded; the admin
   * collector iterates kernel.getAugments() and calls this on each.
   * Returns null/undefined → augment doesn't appear on /admin.
   */
  adminInfo?: () => Promise<AdminInfoBlock>;
  /**
   * G36 — action handlers for the actions declared in adminInfo().actions
   * (and AdminRowAction in table sections). Boot-time validation verifies
   * every declared action id has a matching key here.
   */
  adminActions?: Record<string, AdminActionHandler>;
  /** First-party durable incidents that fence whole runtime thread lanes. */
  durableThreadQuarantine?: DurableThreadQuarantine;
  memory?: MemoryProviderSpec;
  constraints?: AugmentConstraints;
  onBoot?: () => Promise<void>;
  onShutdown?: (signal?: AbortSignal) => Promise<void>;
  onTurnStart?: (turn: TurnState) => Promise<void>;
  onTurnEnd?: (turn: TurnResult, context?: TurnLifecycleContext) => Promise<void>;
  onIdle?: () => Promise<void>;
  /**
   * ADR-027: post-turn background-work hook. Fires after `onTurnEnd` for
   * the just-completed user-facing turn. Receives a `SchedulerContext`
   * with `inject` (admit a follow-up turn through the normal turn loop)
   * and `getCompletedTranscript` (retrieve the just-completed turn's
   * transcript snapshot).
   *
   * Errors thrown from this hook are caught and logged and do not replace the
   * already-produced response content. The hook is awaited, however, and its
   * owned causal injections and descendants extend turn completion and keyed
   * lane occupancy.
   *
   * Multiple augments registering the hook execute sequentially in declaration
   * order (ADR-027 Decision 2). Each hook's SchedulerContext is revoked before
   * the next hook begins.
   */
  scheduleAfterTurn?: (result: TurnResult, ctx: SchedulerContext) => Promise<void>;
  /**
   * ADR-027 Decision 5: internal-trigger handler dispatch. When the
   * kernel admits a turn whose `trigger.type === "internal"`, the
   * turn-loop walks the augment list in declaration order and calls
   * each augment's `handleInternalTurn` (if present) with the trigger.
   * Augments that do not recognize the trigger MUST return null —
   * dispatch then continues to the next augment. The first augment to
   * return a non-null TurnResult owns the turn; the standard
   * model-engine + tool-execution path is bypassed and the returned
   * result is the turn's outcome.
   *
   * Augments use trigger.source as the authoritative routing key
   * (e.g. `"layered-memory.autoSave"`). Augments emitting and consuming
   * triggers SHOULD use a dotted prefix matching their augment name to
   * avoid cross-augment collisions.
   *
   * The handler runs WITHIN the admitted turn — turn-gate prepare /
   * confirm, onTurnStart, onTurnEnd, scheduleAfterTurn, and history
   * recording all fire as for any standard turn. The handler is
   * responsible for any LLM call its work needs; cost flows through
   * `runCostCommit` via the standard trace pipeline (push priced
   * inference steps onto `TurnResult.trace.inferenceSteps[]`).
   *
   * Augment authors MUST guard against re-entry — a handler should
   * never synthesize a trigger that re-routes back to itself during
   * the same execution.
   *
   * **Throw contract — load-bearing for budget accuracy.** Handlers
   * MUST NOT throw with side effects. Failure modes (engine error,
   * malformed response, transient network failure) MUST be caught
   * inside the handler and returned as a failed TurnResult that still
   * carries any priced inference steps in `trace.inferenceSteps[]`.
   *
   * If a handler throws after incurring LLM spend, the kernel's
   * catch-block will commit a turn with no recorded cost — budgets
   * sees zero spend for a turn that actually burned money. The kernel
   * logs a structured warning (`[kernel] handleInternalTurn for
   * augment "X" threw; cost may be undercounted ...`) so a misbehaving
   * handler is operator-visible, but the cap-accuracy invariant
   * depends on handlers honoring this contract.
   */
  handleInternalTurn?: (
    trigger: TurnTrigger,
    ctx: InternalTurnContext,
  ) => Promise<TurnResult | null>;
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
  displayName?: string;
  creator?: CreatorConfig;
  purpose?: string;
  model: string;
  augments: Augment[];
  contextBudget?: {
    historyPercent?: number;
    toolSchemaPercent?: number;
  };
  compactionStrategy?: CompactionStrategy;
  /** Max inference loop iterations per turn. Default 10. */
  maxInferenceLoops?: number;
  /** Mandatory model-output bounds. Omitted fields use finite secure defaults. */
  responseLimits?: Partial<ModelResponseLimits>;
  /**
   * Total deadline for one model inference attempt, including connection,
   * stream setup, streaming, and response materialization. Default 120s;
   * maximum 10 minutes. Model POSTs are attempted exactly once.
   */
  providerRequestTimeoutMs?: number;
  /** Tool-choice policy sent to the model. "auto" (default) lets the model
   *  decide; "any" forces a tool call; { name } forces a specific tool. */
  toolChoice?: "auto" | "any" | { name: string };
  /** Bounded process-local admission and per-thread scheduling policy. */
  turnScheduling?: Partial<TurnSchedulingConfig>;
  /**
   * Declares an intended PostgreSQL coordination topology. The current
   * runtime deliberately refuses to treat this declaration as replica
   * enablement until its shared-store and fencing preflight is complete.
   */
  coordination?: DistributedCoordinationConfig;
}

/** Public, secret-free distributed coordinator configuration. */
export interface DistributedCoordinationConfig {
  mode: "postgres";
  namespace: string;
  urlEnv: string;
  leaseDurationMs: number;
  heartbeatIntervalMs: number;
  claimPollMs: number;
  maxWaitMs: number;
}

export interface TurnSchedulingConfig {
  /** Maximum active complete-turn pipelines across this agent. Default 4. */
  maxConcurrent: number;
  /** Maximum waiting turns across this agent. Default 100. */
  maxQueued: number;
  /** Maximum waiting turns for one resolved thread. Default 20. */
  maxQueuedPerThread: number;
  /** Maximum nested same-thread SchedulerContext.inject depth. Default 8. */
  maxCausalDepth: number;
}

export interface TurnSchedulerSnapshot {
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
  rejectedByReason: Record<TurnRejectionReason, number>;
}

export interface RuntimeSignalsSnapshot {
  schemaVersion: 1;
  scope: "process";
  startedAt: number;
  collectedAt: number;
  turns: {
    total: number;
    completed: number;
    failed: number;
    canceled: number;
    rejected: number;
    outcomeUnknown: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  inference: {
    attempts: number;
    completed: number;
    failed: number;
    canceled: number;
    outcomeUnknown: number;
    inputTokens: number;
    outputTokens: number;
    pricedCostUsd: number;
    unpriced: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  tools: {
    attempts: number;
    completed: number;
    failed: number;
    denied: number;
    outcomeUnknown: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  responseDelivery: {
    attempts: number;
    completed: number;
    failed: number;
    outcomeUnknown: number;
    inFlight: number;
    totalDurationMs: number;
    maxDurationMs: number;
  };
  hooks: { failed: number; outcomeUnknown: number };
  threadRecovery: { attempted: number; completed: number; rejected: number };
  shutdown: {
    attempts: number;
    completed: number;
    inProgress: boolean;
    startedAt: number;
    elapsedMs: number;
    hookFailures: number;
    lastDurationMs: number;
    maxDurationMs: number;
  };
  memory: {
    rssBytes: number;
    heapTotalBytes: number;
    heapUsedBytes: number;
    externalBytes: number;
    arrayBuffersBytes: number;
  };
}

export interface RuntimeOperationalSnapshot extends RuntimeSignalsSnapshot {
  readiness: {
    accepting: boolean;
    state: "not-started" | "accepting" | "draining" | "stopped";
  };
  scheduler: TurnSchedulerSnapshot;
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  agent: string;
  uptime: number;
  augments: Record<string, { status: "ok" | "degraded" | "failed"; error?: string }>;
  model: { reachable: boolean };
  scheduler: TurnSchedulerSnapshot;
}

export interface AgentHandle {
  start(): Promise<void>;
  stop(): Promise<void>;
  ready(): Promise<void>;
  health(): AgentHealth;
  /** Aggregate, process-lifetime operational signals with no customer content or identifiers. */
  operationalSnapshot(): RuntimeOperationalSnapshot;
  card(): AgentCard;
  inject(trigger: TurnTrigger, options?: AgentInjectOptions): Promise<TurnResult>;
  /**
   * Clear a fail-closed thread quarantine after a trusted operator has
   * reconciled the outcome-unknown side effect.
   */
  recoverThread(threadId: string): boolean;
}

/** Options for the trusted embedding API. Public transports do not receive this surface. */
export interface AgentInjectOptions {
  signal?: AbortSignal;
  executionContext?: ExecutionContextV1;
  onEvent?: KernelEventHandler;
  /**
   * Trusted pre-execution hook. It runs after scheduler admission and before
   * model or tool execution. A rejected hook prevents the turn from starting.
   * Public transports do not receive this embedding surface.
   */
  onExecutionStart?: () => void | Promise<void>;
}

// === Notify augment ===

export type NotifyAdapterKind = "webhook" | "telegram" | "agentmail" | "log-to-file";

export type NotifyPublicPolicy = "allowed" | "escalation-only";

export interface NotifyDestinationAuthority {
  /**
   * Trust levels allowed to use this destination. Defaults to creator and agent;
   * public destinations must opt in explicitly.
   */
  allowedTrustLevels?: TrustLevel[];
  /**
   * Optional stricter policy for public-originated sends. `escalation-only`
   * requires the tool call to include a non-empty `reason`.
   */
  publicPolicy?: NotifyPublicPolicy;
}

export interface LogToFileNotifyDestination extends NotifyDestinationAuthority {
  name: string;
  transport: "log-to-file";
  /** Path to the JSONL log file. Relative paths resolve against the agent
   *  dir; absolute paths used as-is. Default destination for scaffolded
   *  agents: `./notifications.jsonl`. The file is created on first write
   *  and appended to (one JSON object per line). */
  path: string;
  /** Optional per-destination rate limit. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export interface WebhookNotifyDestination extends NotifyDestinationAuthority {
  name: string;
  transport: "webhook";
  url: string;
  headers?: Record<string, string>;
  /** Development-only escape hatch for non-loopback plaintext HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export interface TelegramNotifyDestination extends NotifyDestinationAuthority {
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

export interface AgentMailNotifyDestination extends NotifyDestinationAuthority {
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
  /** Development-only escape hatch for credentialed non-loopback HTTP. */
  allowInsecureHttpWithCredentials?: boolean;
  /** Optional per-destination rate limit. Falls back to the augment-level global cap when absent. */
  rateLimit?: {
    maxPerHour?: number;
    cooldownMs?: number;
  };
}

export type NotifyDestination =
  | WebhookNotifyDestination
  | TelegramNotifyDestination
  | AgentMailNotifyDestination
  | LogToFileNotifyDestination;

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
  /**
   * Durable quota, attempt, and outcome-unknown ledger. The CLI resolves an
   * omitted value under the runtime data root. Direct factory callers must
   * provide this or agentDir; Notify never silently falls back to memory.
   */
  dbPath?: string;
  /**
   * G36 — agent project directory. When set,
   * `admin-overrides.json` is read at boot to apply runtime overrides
   * (currently: globalMaxPerHour). Admin actions persist back via this
   * path.
   */
  agentDir?: string;
}

export interface NotifyPayload {
  summary: string;
  reason?: string;
  visitor?: string;
}

export interface NotifyDeliveryResult {
  status: "sent" | "failed";
  detail?: string;
  /** Delivery may have occurred; callers must not retry automatically. */
  outcomeUnknown?: boolean;
}

export interface NotifyAdapter {
  deliver(
    destination: NotifyDestination,
    payload: NotifyPayload,
    options?: { signal?: AbortSignal },
  ): Promise<NotifyDeliveryResult>;
}

// ---------------------------------------------------------------------------
// agentMail augment (outbound + durable inbound)
// ---------------------------------------------------------------------------

/**
 * Inbound delivery modes for the agentMail augment. WebSocket is recommended
 * when a public webhook URL is unavailable; every mode performs REST catch-up.
 */
export type AgentMailInboundMode = "none" | "websocket" | "polling" | "webhook";

export interface AgentMailRateLimitOptions {
  /** Master toggle; default true. Creator/null peer always bypass when enabled. */
  enabled?: boolean;
  /** Maximum outbound sends across all recipients per hour. Default 10. */
  globalMaxPerHour?: number;
  /** Cooldown between sends to the same recipient (ms). Default 300000 (5min). */
  perRecipientCooldownMs?: number;
  /** Subject-hash dedup window (ms). Default 300000 (5min). 0 disables dedup. */
  dedupWindowMs?: number;
}

export interface AgentMailOutboundOptions {
  /**
   * Trust levels permitted to call `send_message` / `reply_to_message` /
   * `forward_message`. Default `["creator"]`. Email is a high-blast-radius
   * channel — defaults are strict on purpose.
   */
  allowedTrustLevels?: TrustLevel[];
  /**
   * Recipient allowlist. When set, only these addresses may receive mail.
   * Match modes:
   *   - exact: `"alice@example.com"` matches just that address (lowercased).
   *   - domain glob: `"*@example.com"` matches any address at example.com.
   * When unset, recipients only need to pass `isWellFormedEmail()`.
   */
  allowedRecipients?: string[];
  /** Max recipients per send (combined to/cc/bcc). Default 10. Hard ceiling 50 per AgentMail. */
  maxRecipients?: number;
  /** Hard cap on text body size in bytes. Default 102400 (100KB). */
  bodyMaxBytes?: number;
  /** Permit HTML body in send/reply/forward. Default false. */
  allowHtml?: boolean;
  /**
   * Subject prefix prepended to every outbound subject. Default `"[Auggy] "`.
   * Cannot be empty — recipients must be able to identify agent-sent mail.
   */
  subjectPrefix?: string;
  /** Rate-limit configuration. */
  rateLimit?: AgentMailRateLimitOptions;
  /**
   * Durable operator review for outbound actions. By default, actions
   * originating from public peers are queued instead of sent immediately.
   * Set `requiredForTrustLevels: []` only when autonomous public sending is
   * explicitly intended.
   */
  humanReview?: {
    /** Trust levels whose valid outbound actions enter the review queue. Default `["public"]`. */
    requiredForTrustLevels?: TrustLevel[];
    /** Time an action remains approvable. Default 86400000 (24 hours), maximum 30 days. */
    expiresAfterMs?: number;
  };
}

export interface AgentMailInboundConfig {
  /** Inbound delivery channel. */
  mode: AgentMailInboundMode;
  /** Exact sender addresses or `*@domain` patterns. Required when inbound is enabled. */
  allowedSenders?: string[];
  /** Classification gates. Only ordinary received mail is processed by default. */
  classifications?: {
    received?: "process" | "discard";
    spam?: "process" | "discard";
    blocked?: "process" | "discard";
    unauthenticated?: "process" | "discard";
  };
  /** Poll/catch-up cadence. Default 60 seconds. */
  pollIntervalMs?: number;
  /** Max bytes rendered into the untrusted email prompt. Default 100 KiB. */
  maxPromptBytes?: number;
  /** Attempts before durable discard. Default 5. */
  maxAttempts?: number;
  /** WebSocket origin override for sandbox providers. */
  websocketBaseUrl?: string;
  /** Svix route configuration when mode is `"webhook"`. */
  webhook?: {
    path?: string;
    secretEnv?: string;
    timestampToleranceSeconds?: number;
  };
}

export interface AgentMailAugmentOptions {
  /** AgentMail API key (`am_*`). Resolve via `${AGENTMAIL_API_KEY}` in agent.yaml. */
  apiKey: string;
  /** AgentMail inbox ID this augment sends from / receives at. */
  inboxId: string;
  /** Override AgentMail API base URL (testing/sandbox). */
  apiBaseUrl?: string;
  /** Development-only escape hatch for credentialed non-loopback HTTP/WS. */
  allowInsecureHttpWithCredentials?: boolean;
  /** SQLite store path for inbound dedup. Default `"./agent-mail.db"`. */
  dbPath?: string;
  /** Outbound policy + tools configuration. */
  outbound?: AgentMailOutboundOptions;
  /** Inbound configuration. Omit or use `{ mode: "none" }` to disable receiving. */
  inbound?: AgentMailInboundConfig;
  /**
   * Agent project directory. When set,
   * `admin-overrides.json` is read at boot to apply runtime overrides
   * (currently: outbound.rateLimit.globalMaxPerHour). Admin actions persist
   * back via this path.
   */
  agentDir?: string;
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
  /** Maximum encoded webhook request bytes. Default 256 KiB. */
  maxBodyBytes?: number;
}

export interface TelegramAdmittedAgent {
  id: string;
  telegramUserId: number;
}

export type TelegramAnonymousIdentityMode = "ephemeral" | "durable";

export type TelegramReplayClaim =
  | "claimed"
  | "duplicate"
  | "conflict"
  | "quarantined"
  | "discarded";

/** Privacy-safe active replay conflict metadata. Payload hashes remain store-private. */
export interface TelegramReplayConflict {
  /** Opaque, server-minted identifier used for compare-and-set recovery. */
  id: string;
  updateId: number;
  detectedAt: number;
}

export interface TelegramAuthOptions {
  creatorUserIds?: number[];
  /** Env var containing comma-separated Telegram user IDs that resolve as creator. */
  creatorUserIdsEnv?: string;
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

export interface TelegramReplayStore {
  /**
   * Atomically claim an update. A hash mismatch must also atomically
   * quarantine the namespace before returning "conflict".
   */
  claim(namespace: string, updateId: number, payloadHash: string): TelegramReplayClaim;
  /** Return the active namespace conflict without payload hashes or content. */
  getConflict(namespace: string): TelegramReplayConflict | null;
  /**
   * Atomically retain the canonical claim, discard the exact conflicting
   * payload, and clear only the matching active conflict.
   */
  resolveConflict(namespace: string, conflictId: string): boolean;
  close?(): void;
}

export interface TelegramReplayClaimOptions {
  /**
   * Aborted when the transport shuts down or the configured claim deadline
   * expires. Distributed stores should stop pending work promptly.
   */
  signal: AbortSignal;
}

export interface TelegramAsyncReplayStore {
  claimAsync(
    namespace: string,
    updateId: number,
    payloadHash: string,
    options: TelegramReplayClaimOptions,
  ): Promise<TelegramReplayClaim>;
  getConflictAsync(
    namespace: string,
    options: TelegramReplayClaimOptions,
  ): Promise<TelegramReplayConflict | null>;
  resolveConflictAsync(
    namespace: string,
    conflictId: string,
    options: TelegramReplayClaimOptions,
  ): Promise<boolean>;
  close?(): void | Promise<void>;
}

export interface TelegramReplayOptions {
  /**
   * Shared transactional store. Async stores support distributed databases.
   * When omitted, a hardened SQLite store is used.
   */
  store?: TelegramReplayStore | TelegramAsyncReplayStore;
  /** SQLite path used when store is omitted. Default ./data/telegram-replay.db. */
  dbPath?: string;
  /** Stable non-secret namespace. Defaults to `telegram:bot-<numeric bot id>`. */
  namespace?: string;
  /** Claim retention. Default 30 days. */
  retentionMs?: number;
  /** Maximum retained update claims. Default 1,000,000. */
  maxEntries?: number;
  /** Maximum time to await an async shared-store claim. Default 5,000 ms. */
  claimTimeoutMs?: number;
}

export interface TelegramTransportOptions {
  botToken: string;
  inbound: {
    mode: TelegramInboundMode;
    polling?: TelegramPollingOptions;
    webhook?: TelegramWebhookOptions;
  };
  auth: TelegramAuthOptions;
  creator?: CreatorConfig;
  replay?: TelegramReplayOptions;
}
