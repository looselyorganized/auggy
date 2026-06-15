import type { McpServerConfig } from "../../cli/mcp-config";

export type McpTransportKind = "stdio" | "streamable-http" | "sse";

export interface McpRuntimePolicy {
  allowedTools?: string[];
  blockedTools?: string[];
  timeoutMs?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  maxConcurrentCalls?: number;
  maxTools?: number;
  maxToolPages?: number;
  includeToolDescriptions?: boolean;
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
  ): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export interface McpClientAdapter {
  connect(server: McpRuntimeServer): Promise<McpConnection>;
}

export interface McpServerStatus {
  name: string;
  transport: string;
  state: "configured" | "connected" | "disabled" | "failed";
  tools: number;
  error?: string;
}
