import type { McpServerConfig } from "../../cli/mcp-config";
import type { TrustLevel } from "../../types";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export interface McpRuntimePolicy {
  allowInsecureHttpWithCredentials?: boolean;
  allowedTools?: string[];
  blockedTools?: string[];
  allowedTrustLevels?: TrustLevel[];
  toolPolicies?: Record<string, McpRuntimeToolPolicy>;
  timeoutMs?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  maxArgumentBytes?: number;
  maxDepth?: number;
  maxNodes?: number;
  maxTransportMessageBytes?: number;
  maxConcurrentCalls?: number;
  maxTools?: number;
  maxToolPages?: number;
  includeToolDescriptions?: boolean;
}

export interface McpRuntimeToolPolicy {
  allowedTrustLevels?: TrustLevel[];
}

export interface McpRuntimeServer {
  name: string;
  transport: McpTransportKind;
  config: McpServerConfig;
  policy: McpRuntimePolicy;
}

export interface McpRemoteTool {
  name: string;
  description?: string;
  inputSchema?: Record<string, unknown>;
  annotations?: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  };
}

export interface McpToolCallResult {
  content?: unknown[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
  _meta?: Record<string, unknown>;
}

export interface McpConnection {
  listTools(cursor?: string): Promise<{ tools: McpRemoteTool[]; nextCursor?: string }>;
  callTool(
    name: string,
    args: Record<string, unknown>,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<McpToolCallResult>;
  close(signal?: AbortSignal): Promise<void>;
}

export interface McpClientAdapter {
  connect(server: McpRuntimeServer, signal?: AbortSignal): Promise<McpConnection>;
}

export interface McpServerStatus {
  name: string;
  transport: string;
  state: "configured" | "connected" | "disabled" | "failed";
  tools: number;
  restrictedTools?: number;
  error?: string;
}
