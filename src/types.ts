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

// === Tool Types (spec §3) ===

export type ToolCategory = "memory" | "search" | "communication" | "meta" | (string & {});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export interface Tool<TInput = any> {
  name: string;
  description: string;
  category: ToolCategory;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  input: z.ZodType<TInput, any, any>;
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
  text: string;
  sourceAugment: string;
  peer: PeerIdentity | null;
  timestamp: number;
  metadata?: Record<string, unknown>;
}

export interface TurnTrigger {
  type: TurnTriggerType;
  turnId: string;
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
  text: string;
  targetAugment?: string;
  targetPeer?: string;
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
}

export interface TurnResult {
  turnId: string;
  success: boolean;
  response?: OutboundMessage;
  errorResponse?: string;
  toolCalls: ToolCallRecord[];
  trace: TurnTrace;
  error?: { message: string; source: string };
}

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

// === Transport (spec §3) ===

export interface TransportKernel {
  handleInbound(trigger: TurnTrigger): Promise<TurnResult>;
  onOutbound(
    callback: (peer: PeerIdentity, message: OutboundMessage) => Promise<void>,
  ): void;
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
  constraints?: AugmentConstraints;
  onBoot?: () => Promise<void>;
  onShutdown?: () => Promise<void>;
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
  inject(trigger: TurnTrigger): Promise<TurnResult>;
}
