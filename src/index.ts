// === Core types ===
export type {
  // Context
  Augment,
  AugmentCapability,
  AugmentConstraints,
  AgentConfig,
  AgentHandle,
  AgentHealth,
  AuthorizationAction,
  AuthorizationConstraintValue,
  AuthorizationConstraints,
  AuthorizationGrant,
  AuthorizationRequirement,
  AuthorizationResource,
  AuthorizationResourceBinding,
  AuthorizationScope,
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
  ToolExecuteContext,
  ToolDefinition,
  ToolResult,
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
  RouteAgentAuthContext,
  RouteAuthContext,
  RouteExternalAuthClaims,
  RouteAuthPrincipal,
  RouteVisitorAuthContext,
  RouteWebhookContext,
  TransportSpec,
  TransportKernel,
  AugmentHttpRoutePolicy,
  AugmentHttpRouteWebhookProvider,
  AugmentHttpRouteWebhookSignaturePolicy,
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

// === Auth primitives ===
export {
  createExternalAuthAssertion,
  externalAuthClaimsToRouteContext,
  externalAuthClaimsToRoutePrincipal,
  externalSubjectVisitorId,
  verifyExternalAuthAssertion,
} from "./auth/external-auth";
export type {
  CreateExternalAuthAssertionOptions,
  ExternalAuthAssertionFailureReason,
  ExternalAuthAssertionVerification,
  ExternalAuthClaims,
  ExternalAuthPrincipalOptions,
  VerifyExternalAuthAssertionOptions,
} from "./auth/external-auth";
export {
  delegatedAuthorizationForbiddenErrorBody,
  visitorAuthRequiredErrorBody,
} from "./authz/delegated-authorization";
export type {
  DelegatedAuthorizationFailureReason,
  DelegatedAuthorizationForbiddenErrorBody,
  DelegatedAuthorizationHttpErrorBody,
  VisitorAuthRequiredErrorBody,
} from "./authz/delegated-authorization";

// === Helpers ===
export { defineAugment, defineRoute, defineTool, json, webhook } from "./helpers";
export type {
  DefineGetRouteOptions,
  DefinePostRouteOptions,
  RouteContext,
  RouteContextBase,
} from "./helpers";
export { extractText, textPart, dataPart } from "./parts";

// === Tokenizer (for augment authors who need token counting) ===
export { createTokenizer } from "./tokenizer";

// === Built-in augments ===
export { fileMemory } from "./augments/fileMemory";
export type { FileMemoryOptions } from "./augments/fileMemory";
export { supabaseMemory } from "./augments/supabaseMemory";
export type { SupabaseMemoryOptions } from "./augments/supabaseMemory";
export { filesystem } from "./augments/filesystem";
export type { FilesystemOptions, FsMount } from "./augments/filesystem";

// === Built-in augments (knowledge) ===
export { knowledge, knowledgeRoot } from "./augments/knowledge";
export type { KnowledgeRootOptions, ManifestOptions } from "./augments/knowledge";

// === Built-in augments (MCP) ===
export { mcp } from "./augments/mcp";
export type { McpAugmentOptions } from "./augments/mcp";

// === Built-in augments (web) ===
export { webFetch } from "./augments/webFetch";
export type { WebFetchOptions, WebFetchResult } from "./augments/webFetch";

// === Built-in augments (mail) ===
export { agentMail } from "./augments/agentMail";
export type {
  AgentMailAugmentOptions,
  AgentMailOutboundOptions,
  AgentMailRateLimitOptions,
  AgentMailInboundConfig,
  AgentMailInboundMode,
} from "./types";

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
