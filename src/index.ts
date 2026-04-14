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
  // Kernel events
  KernelEvent,
  KernelEventHandler,
  // Model
  ModelClient,
  ModelResponse,
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

// === Built-in augments (web) ===
export { webFetch } from "./augments/web-fetch";
export type { WebFetchOptions, WebFetchResult } from "./augments/web-fetch";

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
export { createAnthropicEngine } from "./engines/anthropic";
export type { AnthropicEngineOptions } from "./engines/anthropic";
export { createOpenAIEngine } from "./engines/openai";
export type { OpenAIEngineOptions } from "./engines/openai";
export {
  assembleOpenAISystemMessage,
  buildOpenAIModelResponse,
  convertOpenAIMessages,
  convertOpenAITools,
  safeParseJson as openaiSafeParseJson,
  safeParseToolCall as openaiSafeParseToolCall,
} from "./engines/openai";
export { createOpenRouterEngine } from "./engines/openrouter";
export type {
  OpenRouterEngineOptions,
  OpenRouterProviderRouting,
} from "./engines/openrouter";

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
