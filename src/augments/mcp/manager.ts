import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import { classifyMcpTransport, readMcpConfig, type McpConfig } from "../../cli/mcp-config";
import { parseEnvFile } from "../../cli/env-parse";
import type { Tool } from "../../types";
import { formatMcpToolResult } from "./result";
import { SdkMcpClientAdapter } from "./sdk-adapter";
import type {
  McpClientAdapter,
  McpConnection,
  McpRemoteTool,
  McpRuntimePolicy,
  McpRuntimeServer,
  McpServerStatus,
  McpTransportKind,
} from "./types";

export interface McpManagerOptions {
  agentDir?: string;
  config?: string;
  client?: McpClientAdapter;
  timeoutMs?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  maxConcurrentCalls?: number;
}

export interface McpManager {
  tools: Tool[];
  boot(): Promise<void>;
  shutdown(): Promise<void>;
  statuses(): McpServerStatus[];
}

interface ServerRuntime {
  server: McpRuntimeServer;
  connection: McpConnection | null;
  status: McpServerStatus;
  activeCalls: number;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESULT_BYTES = 128 * 1024;
const DEFAULT_MAX_SCHEMA_BYTES = 16 * 1024;
const DEFAULT_MAX_CONCURRENT_CALLS = 4;

const toolInputSchema = z.record(z.string(), z.unknown());

export function createMcpManager(opts: McpManagerOptions = {}): McpManager {
  const agentDir = opts.agentDir ?? process.cwd();
  const client = opts.client ?? new SdkMcpClientAdapter();
  const tools: Tool[] = [];
  const runtimes: ServerRuntime[] = [];

  return {
    tools,
    async boot() {
      tools.splice(0, tools.length);
      runtimes.splice(0, runtimes.length);
      const { path, config } = loadConfig(agentDir, opts.config);
      const env = loadAgentEnv(dirname(path));
      const servers = resolveServers(config, dirname(path), env, opts);

      for (const server of servers) {
        const runtime: ServerRuntime = {
          server,
          connection: null,
          activeCalls: 0,
          status: {
            name: server.name,
            transport: server.transport,
            state: "configured",
            tools: 0,
          },
        };
        runtimes.push(runtime);

        const cloudPolicy =
          server.config.auggy?.cloud ?? config.auggy?.servers?.[server.name]?.cloud;
        if (
          cloudPolicy === "disabled" ||
          cloudPolicy === "localOnly" ||
          cloudPolicy === "local-only"
        ) {
          runtime.status.state = "disabled";
          continue;
        }

        try {
          runtime.connection = await client.connect(server);
          const remoteTools = await listAllTools(runtime.connection);
          const exposed = remoteTools.filter((tool) => shouldExposeTool(tool.name, server.policy));
          for (const remoteTool of exposed) {
            const tool = toAuggyTool(server, remoteTool, runtime);
            if (tools.some((existing) => existing.name === tool.name)) {
              throw new Error(`duplicate exposed MCP tool name "${tool.name}"`);
            }
            tools.push(tool);
          }
          runtime.status.state = "connected";
          runtime.status.tools = exposed.length;
        } catch (err) {
          runtime.status.state = "failed";
          runtime.status.error = cleanError(err);
          await runtime.connection?.close().catch(() => {});
          runtime.connection = null;
        }
      }
    },
    async shutdown() {
      for (const runtime of runtimes) {
        await runtime.connection?.close().catch(() => {});
        runtime.connection = null;
      }
      tools.splice(0, tools.length);
    },
    statuses() {
      return runtimes.map((runtime) => ({ ...runtime.status }));
    },
  };
}

function loadConfig(
  agentDir: string,
  configPath: string | undefined,
): { path: string; config: McpConfig } {
  if (!configPath) return readMcpConfig(agentDir);
  const path = isAbsolute(configPath) ? configPath : resolve(agentDir, configPath);
  if (!existsSync(path)) throw new Error(`mcp: ${configPath} not found`);
  const parsed = JSON.parse(readFileSync(path, "utf-8")) as McpConfig;
  return { path, config: parsed };
}

function resolveServers(
  config: McpConfig,
  agentDir: string,
  env: Map<string, string>,
  opts: McpManagerOptions,
): McpRuntimeServer[] {
  return Object.entries(config.mcpServers).map(([name, raw]) => {
    const classified = classifyMcpTransport(raw);
    if (classified === "invalid") {
      throw new Error(`mcp: server "${name}" has unsupported transport "invalid"`);
    }
    const transport: McpTransportKind = classified === "http" ? "streamable-http" : classified;
    const policy = {
      timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      maxResultBytes: opts.maxResultBytes ?? DEFAULT_MAX_RESULT_BYTES,
      maxSchemaBytes: opts.maxSchemaBytes ?? DEFAULT_MAX_SCHEMA_BYTES,
      maxConcurrentCalls: opts.maxConcurrentCalls ?? DEFAULT_MAX_CONCURRENT_CALLS,
      ...config.auggy?.servers?.[name],
      ...raw.auggy,
    } satisfies McpRuntimePolicy;
    return {
      name,
      transport,
      config: {
        ...raw,
        cwd: typeof raw.cwd === "string" ? resolvePath(raw.cwd, agentDir) : raw.cwd,
        env: interpolateRecord(raw.env ?? {}, env),
        headers: interpolateRecord(raw.headers ?? {}, env),
      },
      policy,
    };
  });
}

async function listAllTools(connection: McpConnection): Promise<McpRemoteTool[]> {
  const out: McpRemoteTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await connection.listTools(cursor);
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

function toAuggyTool(
  server: McpRuntimeServer,
  remoteTool: McpRemoteTool,
  runtime: ServerRuntime,
): Tool {
  const schema = sanitizeInputSchema(remoteTool.inputSchema, server.policy.maxSchemaBytes!);
  const toolName = `mcp_${safeName(server.name)}_${safeName(remoteTool.name)}`;
  return {
    name: toolName,
    description: buildToolDescription(server.name, remoteTool),
    category: "mcp",
    input: toolInputSchema,
    inputJsonSchema: schema,
    execute: async (input) => {
      if (!runtime.connection || runtime.status.state !== "connected") {
        return { content: `MCP server "${server.name}" is not connected.` };
      }
      if (runtime.activeCalls >= server.policy.maxConcurrentCalls!) {
        return { content: `MCP server "${server.name}" is busy. Try again later.` };
      }
      runtime.activeCalls++;
      try {
        const result = await runtime.connection.callTool(
          remoteTool.name,
          input,
          server.policy.timeoutMs!,
        );
        return {
          content: formatMcpToolResult(result, server.policy.maxResultBytes!),
        };
      } catch (err) {
        return {
          content: `MCP tool "${remoteTool.name}" on server "${server.name}" failed: ${cleanError(err)}`,
        };
      } finally {
        runtime.activeCalls--;
      }
    },
  };
}

function sanitizeInputSchema(
  schema: Record<string, unknown> | undefined,
  maxBytes: number,
): Record<string, unknown> {
  if (schema?.type !== "object") return { type: "object", additionalProperties: true };
  const serialized = JSON.stringify(schema);
  if (new TextEncoder().encode(serialized).length > maxBytes) {
    return { type: "object", additionalProperties: true };
  }
  return schema;
}

function shouldExposeTool(name: string, policy: McpRuntimePolicy): boolean {
  if (policy.allowedTools && !policy.allowedTools.includes(name)) return false;
  if (policy.blockedTools?.includes(name)) return false;
  return true;
}

function buildToolDescription(serverName: string, tool: McpRemoteTool): string {
  const title = tool.annotations?.title ?? tool.name;
  const hints = [
    tool.annotations?.readOnlyHint ? "read-only" : null,
    tool.annotations?.destructiveHint ? "may be destructive" : null,
    tool.annotations?.openWorldHint ? "uses external services" : null,
  ].filter(Boolean);
  const suffix = hints.length > 0 ? ` (${hints.join(", ")})` : "";
  const description = tool.description?.trim() || "External MCP tool.";
  return `MCP ${serverName}.${title}${suffix}: ${description}`;
}

function safeName(value: string): string {
  return value
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/^([^A-Za-z_])/, "_$1")
    .slice(0, 48);
}

function loadAgentEnv(agentDir: string): Map<string, string> {
  const values = new Map<string, string>();
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return values;
  for (const line of parseEnvFile(readFileSync(path, "utf-8"))) {
    if (line.kind === "kv") values.set(line.key, line.value);
  }
  return values;
}

function interpolateRecord(
  record: Record<string, string>,
  env: Map<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(record)) {
    out[key] = value.replaceAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, name: string) => {
      return env.get(name) ?? process.env[name] ?? "";
    });
  }
  return out;
}

function resolvePath(path: string, base: string): string {
  return isAbsolute(path) ? path : resolve(base, path);
}

function cleanError(err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return message
    .replaceAll(/(Bearer|token|key|secret|password)[^\s"']+/gi, "$1 [redacted]")
    .replaceAll(/[A-Za-z0-9_.-]{24,}/g, "[redacted]");
}
