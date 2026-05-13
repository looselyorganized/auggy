// === Core types ===
export type {
  // Context
  Augment,
  AugmentCapability,
  AugmentConstraints,
  AgentConfig,
  AgentHandle,
  AgentHealth,
  ContextBlock,
  ContextPlacement,
  ContextProvenance,
  ContextPriority,
  EvictionPolicy,
  ContextOrigin,
  // A2A-compatible content
  Part,
  TaskState,
  // Memory
  MemoryDefaults,
  MemoryEntry,
  MemoryProviderSpec,
  StaticMemoryProvider,
  NamespaceMemoryProvider,
  // Tools
  Tool,
  ToolCategory,
  ToolDefinition,
  // Peers
  PeerIdentity,
  PeerKind,
  TrustLevel,
  // Turns
  TurnTrigger,
  TurnTriggerType,
  TurnState,
  TurnResult,
  OutboundMessage,
  InboundMessage,
  Message,
  MessageRole,
  ToolCallRecord,
  // ADR-027 — post-turn background work
  Transcript,
  SchedulerContext,
  // Kernel events
  KernelEvent,
  KernelEventHandler,
  // Model
  ModelClient,
  ModelResponse,
  ModelDelta,
  AssembledPrompt,
  // Storage
  Storage,
  // Transport
  TransportSpec,
  TransportKernel,
  // Agent Card
  AgentCard,
  AgentCardProvider,
  AgentCardCapabilities,
  AgentCardSkill,
  // Traces
  TurnTrace,
  // History
  CompactionStrategy,
} from "./types";

// === Agent definition ===
export { defineAgent } from "./agent";

// === Agent Card ===
export { generateAgentCard } from "./agent-card";

// === Helpers ===
export { defineAugment, defineTool } from "./helpers";
export { extractText, textPart, dataPart } from "./parts";

// === Tokenizer (for augment authors who need token counting) ===
export { createTokenizer } from "./tokenizer";

// === Built-in augments ===
export { fileMemory } from "./augments/file-memory";
export type { FileMemoryOptions } from "./augments/file-memory";
export { supabaseMemory } from "./augments/supabase-memory";
export type { SupabaseMemoryOptions } from "./augments/supabase-memory";
export { filesystem } from "./augments/filesystem";
export type { FilesystemOptions, FsMount } from "./augments/filesystem";

// === Built-in augments (org) ===
export { orgContext } from "./augments/org-context";
export type { OrgContextOptions } from "./augments/org-context";

// === Built-in augments (web) ===
export { webFetch } from "./augments/web-fetch";
export type { WebFetchOptions, WebFetchResult } from "./augments/web-fetch";

export { bash } from "./augments/bash";
export type {
  BashAugmentOptions,
  BashRiskLevel,
  BashScript,
} from "./augments/bash";

// === HTTP client (for augment authors who need HTTP) ===
export { createHttpClient } from "./http";
export type {
  HttpClient,
  HttpClientOptions,
  HttpRequestInit,
  HttpResponse,
} from "./http";

// === Built-in transports ===
export { webTransport } from "./transports/web-transport";
export type { WebTransportOptions } from "./transports/web-transport";

// === Engines (model client adapters) ===
// Engine factories live in per-provider packages so `auggy` core ships zero
// provider SDKs. Consumers must import directly:
//   import { createAnthropicEngine }  from "@auggy/anthropic";
//   import { createOpenAIEngine }     from "@auggy/openai";
//   import { createOpenRouterEngine } from "@auggy/openrouter";
// The `ModelClient` interface (exported above as a core type) is the
// cross-package contract every adapter implements.

// === AG-UI event protocol (for custom transports or advanced consumers) ===
export {
  runStarted,
  runFinished,
  runError,
  textMessageStart,
  textMessageContent,
  textMessageEnd,
  toolCallStart,
  toolCallArgs,
  toolCallEnd,
  toolCallResult,
  translateKernelEvent,
  serializeSSE,
} from "./transports/ag-ui-events";
export type {
  AGUIEvent,
  AGUIBaseEvent,
  AGUIRunStarted,
  AGUIRunFinished,
  AGUIRunError,
  AGUITextMessageStart,
  AGUITextMessageContent,
  AGUITextMessageEnd,
  AGUIToolCallStart,
  AGUIToolCallArgs,
  AGUIToolCallEnd,
  AGUIToolCallResult,
} from "./transports/ag-ui-events";
