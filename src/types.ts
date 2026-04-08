import type { z } from "zod";

// === Context Types (spec §3) ===

export type ContextPlacement = "system" | "preamble" | "assistant-preamble";
export type ContextProvenance = "identity" | "memory" | "retrieval" | "augment";
export type ContextPriority = "required" | "high" | "normal" | "low" | "evictable";
export type EvictionPolicy = "never" | "summarize" | "drop";
export type ContextOrigin = "operator" | "system" | "peer-derived";

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
  search: (query: string) => Promise<MemoryEntry[]>;
  write?: (label: string, content: string) => Promise<void>;
  read?: (label: string) => Promise<MemoryEntry | null>;
  list?: () => Promise<string[]>;
}

export type MemoryProviderSpec = StaticMemoryProvider | NamespaceMemoryProvider;

// === Tool Types (spec §3) ===

export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TInput = any> {
  name: string;
  description: string;
  category: ToolCategory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: z.ZodType<TInput, any, any>;
  inputJsonSchema?: Record<string, unknown>;
  execute: (input: TInput) => Promise<string>;
}

// === Peer Identity (spec §4) ===

export type PeerKind = "human" | "agent" | "system" | "anonymous";
export type TrustLevel = "operator" | "facility" | "authenticated" | "untrusted";

export interface PeerIdentity {
  id: string;
  kind: PeerKind;
  trustLevel: TrustLevel;
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
    cost: { inputCost: number; outputCost: number; total: number };
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
  totalTokens: number;
  evictions: { source: string; priority: ContextPriority; reason: string }[];
}

export interface ModelResponse {
  content: string;
  toolCalls?: { name: string; arguments: Record<string, unknown> }[];
  inputTokens: number;
  outputTokens: number;
  finishReason: "end_turn" | "tool_use" | "max_tokens";
}

export interface ModelClient {
  complete(prompt: AssembledPrompt): Promise<ModelResponse>;
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
  onOutbound(
    callback: (peer: PeerIdentity, message: OutboundMessage) => Promise<void>,
  ): void;
  getAgentCard(): AgentCard;
}

export interface TransportSpec {
  register(kernel: TransportKernel): Promise<void>;
  identify(raw: unknown): PeerIdentity | null;
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
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
}

export interface Augment {
  name: string;
  version?: string;
  required?: boolean;
  capabilities?: AugmentCapability[];
  context?: (
    turn: TurnState,
    priorContext?: ContextBlock[],
  ) => Promise<ContextBlock[] | string>;
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
}

export interface AgentHealth {
  status: "healthy" | "degraded" | "unhealthy";
  agent: string;
  uptime: number;
  augments: Record<
    string,
    { status: "ok" | "degraded" | "failed"; error?: string }
  >;
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
