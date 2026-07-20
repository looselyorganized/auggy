import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TrustLevel } from "../types";
import { parseEnvFile } from "./env-parse";
import { writeFileSafely } from "./safe-write";

export const MCP_CONFIG_FILENAME = ".mcp.json";

export interface McpServerConfig {
  type?: string;
  transport?: string;
  command?: string;
  args?: string[];
  cwd?: string;
  url?: string;
  env?: Record<string, string>;
  headers?: Record<string, string>;
  auggy?: McpServerAuggyPolicy;
  [key: string]: unknown;
}

export interface McpServerAuggyPolicy {
  cloud?: "enabled" | "disabled" | "localOnly" | "local-only";
  allowedTools?: string[];
  blockedTools?: string[];
  allowedTrustLevels?: TrustLevel[];
  toolPolicies?: Record<string, McpToolAuggyPolicy>;
  timeoutMs?: number;
  maxResultBytes?: number;
  maxSchemaBytes?: number;
  maxConcurrentCalls?: number;
  maxTools?: number;
  maxToolPages?: number;
  includeToolDescriptions?: boolean;
}

export interface McpToolAuggyPolicy {
  allowedTrustLevels?: TrustLevel[];
}

export interface McpConfig {
  mcpServers: Record<string, McpServerConfig>;
  auggy?: {
    servers?: Record<string, McpServerAuggyPolicy>;
  };
}

export interface McpServerDiagnostic {
  name: string;
  status: "pass" | "info" | "warn" | "fail";
  message: string;
  fix?: string;
}

export function mcpConfigPath(agentDir: string): string {
  return join(agentDir, MCP_CONFIG_FILENAME);
}

export function emptyMcpConfig(): McpConfig {
  return { mcpServers: {} };
}

export function ensureMcpConfig(agentDir: string): string {
  const path = mcpConfigPath(agentDir);
  if (!existsSync(path)) writeMcpConfig(path, emptyMcpConfig());
  return path;
}

export function readMcpConfig(agentDir: string): { path: string; config: McpConfig } {
  const path = mcpConfigPath(agentDir);
  if (!existsSync(path)) {
    throw new Error(`${MCP_CONFIG_FILENAME} not found`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch (err) {
    throw new Error(`${MCP_CONFIG_FILENAME} is not valid JSON: ${(err as Error).message}`);
  }

  return { path, config: validateMcpConfigShape(parsed) };
}

export function writeMcpConfig(path: string, config: McpConfig): void {
  writeFileSafely(path, `${JSON.stringify(config, null, 2)}\n`);
}

export function setMcpServer(agentDir: string, name: string, server: McpServerConfig): McpConfig {
  validateMcpServerName(name);
  const path = ensureMcpConfig(agentDir);
  const config = readMcpConfig(agentDir).config;
  config.mcpServers[name] = validateServerShape(server, `mcpServers.${name}`);
  writeMcpConfig(path, config);
  return config;
}

export function removeMcpServer(agentDir: string, name: string): boolean {
  const { path, config } = readMcpConfig(agentDir);
  if (!Object.hasOwn(config.mcpServers, name)) return false;
  delete config.mcpServers[name];
  if (config.auggy?.servers) delete config.auggy.servers[name];
  writeMcpConfig(path, config);
  return true;
}

export function parseMcpServerJson(text: string): McpServerConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    throw new Error(`MCP server JSON is invalid: ${(err as Error).message}`);
  }
  return validateServerShape(parsed, "server");
}

export function diagnoseMcpConfig(
  agentDir: string,
  opts: { cloud?: boolean } = {},
): McpServerDiagnostic[] {
  const out: McpServerDiagnostic[] = [];
  let config: McpConfig;
  try {
    const loaded = readMcpConfig(agentDir);
    config = loaded.config;
    out.push({
      name: "mcp config",
      status: "pass",
      message: loaded.path,
    });
  } catch (err) {
    out.push({
      name: "mcp config",
      status: "fail",
      message: (err as Error).message,
      fix: `Run \`auggy mcp init\` or \`auggy augment add mcp\`.`,
    });
    return out;
  }

  const names = Object.keys(config.mcpServers).sort();
  if (names.length === 0) {
    out.push({
      name: "mcp servers",
      status: "warn",
      message: "no MCP servers configured",
      fix: `Run \`auggy mcp add-json <name> '<json>'\`.`,
    });
    return out;
  }

  const envValues = readAgentEnv(agentDir);
  for (const name of names) {
    const server = config.mcpServers[name]!;
    const transport = classifyMcpTransport(server);
    if (transport === "invalid") {
      out.push({
        name: `mcp ${name}`,
        status: "fail",
        message: "missing command/url or unknown transport",
        fix: "Use stdio with command/args, or remote MCP with type/http url.",
      });
      continue;
    }

    const missing = collectServerEnvReferences(server).filter(
      (key) => !(envValues.get(key)?.trim() || process.env[key]?.trim()),
    );
    let failed = false;
    if (missing.length > 0) {
      out.push({
        name: `mcp ${name} env`,
        status: "fail",
        message: `missing ${missing.join(", ")}`,
        fix: `Set ${missing.join(", ")} in .env.`,
      });
      failed = true;
    }

    const literalSecrets = collectLiteralSecretFields(server);
    if (literalSecrets.length > 0) {
      out.push({
        name: `mcp ${name} secrets`,
        status: opts.cloud ? "fail" : "warn",
        message: `literal secret-like values in ${literalSecrets.join(", ")}`,
        fix: `Move secrets to .env and reference them as \${ENV_NAME}.`,
      });
      if (opts.cloud) failed = true;
    }

    if (opts.cloud && transport === "stdio") {
      const policy = mcpCloudPolicy(config, name, server);
      if (policy === "disabled" || policy === "localOnly" || policy === "local-only") {
        out.push({
          name: `mcp ${name} cloud`,
          status: "info",
          message: "stdio server is marked local-only/disabled for cloud",
        });
      } else {
        out.push({
          name: `mcp ${name} cloud`,
          status: "fail",
          message: "stdio MCP servers do not run safely on Railway by default",
          fix: `Use a remote HTTP MCP server, or set auggy.servers.${name}.cloud="disabled" in .mcp.json.`,
        });
      }
      continue;
    }

    if (opts.cloud && isRemoteTransport(transport)) {
      const url = typeof server.url === "string" ? server.url : "";
      if (!url.startsWith("https://")) {
        out.push({
          name: `mcp ${name} cloud`,
          status: "fail",
          message: "remote MCP servers must use HTTPS for cloud deploys",
          fix: "Use an https:// MCP endpoint.",
        });
        failed = true;
      }
    }

    if (failed) continue;

    out.push({
      name: `mcp ${name}`,
      status: "pass",
      message: `${transport}${transport === "stdio" ? `: ${server.command}` : `: ${server.url}`}`,
    });
  }

  return out;
}

export function classifyMcpTransport(
  server: McpServerConfig,
): "stdio" | "http" | "sse" | "streamable-http" | "invalid" {
  const raw = (server.transport ?? server.type ?? "").trim();
  const normalized = raw === "streamableHttp" ? "streamable-http" : raw;
  if ((!normalized || normalized === "stdio") && typeof server.command === "string") {
    return "stdio";
  }
  if (
    (normalized === "http" || normalized === "sse" || normalized === "streamable-http") &&
    typeof server.url === "string"
  ) {
    return normalized;
  }
  if (!normalized && typeof server.url === "string") return "streamable-http";
  return "invalid";
}

export function validateMcpConfigShape(value: unknown): McpConfig {
  if (!isRecord(value)) throw new Error(`${MCP_CONFIG_FILENAME}: root must be an object`);
  const servers = value.mcpServers;
  if (!isRecord(servers)) throw new Error(`${MCP_CONFIG_FILENAME}: mcpServers must be an object`);

  const out: McpConfig = { mcpServers: {} };
  for (const [name, server] of Object.entries(servers)) {
    validateMcpServerName(name);
    out.mcpServers[name] = validateServerShape(server, `mcpServers.${name}`);
  }

  if (value.auggy !== undefined) {
    if (!isRecord(value.auggy)) throw new Error(`${MCP_CONFIG_FILENAME}: auggy must be an object`);
    const auggy: NonNullable<McpConfig["auggy"]> = {};
    if (value.auggy.servers !== undefined) {
      if (!isRecord(value.auggy.servers)) {
        throw new Error(`${MCP_CONFIG_FILENAME}: auggy.servers must be an object`);
      }
      auggy.servers = {};
      for (const [name, policy] of Object.entries(value.auggy.servers)) {
        validateMcpServerName(name);
        auggy.servers[name] = validatePolicyShape(policy, `auggy.servers.${name}`);
      }
    }
    out.auggy = auggy;
  }
  return out;
}

function validateServerShape(value: unknown, path: string): McpServerConfig {
  if (!isRecord(value)) throw new Error(`${path}: must be an object`);
  const out = { ...value } as McpServerConfig;
  if (out.args !== undefined && !isStringArray(out.args))
    throw new Error(`${path}.args: must be a string array`);
  if (out.env !== undefined && !isStringRecord(out.env))
    throw new Error(`${path}.env: must be an object of strings`);
  if (out.headers !== undefined && !isStringRecord(out.headers)) {
    throw new Error(`${path}.headers: must be an object of strings`);
  }
  if (out.auggy !== undefined) out.auggy = validatePolicyShape(out.auggy, `${path}.auggy`);
  return out;
}

function validatePolicyShape(value: unknown, path: string): McpServerAuggyPolicy {
  if (!isRecord(value)) throw new Error(`${path}: must be an object`);
  const out = { ...value } as McpServerAuggyPolicy;
  if (
    out.cloud !== undefined &&
    !["enabled", "disabled", "localOnly", "local-only"].includes(out.cloud)
  ) {
    throw new Error(`${path}.cloud: must be enabled, disabled, localOnly, or local-only`);
  }
  if (out.allowedTools !== undefined && !isStringArray(out.allowedTools)) {
    throw new Error(`${path}.allowedTools: must be a string array`);
  }
  if (out.blockedTools !== undefined && !isStringArray(out.blockedTools)) {
    throw new Error(`${path}.blockedTools: must be a string array`);
  }
  if (out.allowedTrustLevels !== undefined) {
    validateTrustLevels(out.allowedTrustLevels, `${path}.allowedTrustLevels`);
  }
  if (out.toolPolicies !== undefined) {
    if (!isRecord(out.toolPolicies)) {
      throw new Error(`${path}.toolPolicies: must be an object`);
    }
    const policies: Record<string, McpToolAuggyPolicy> = {};
    for (const [toolName, policy] of Object.entries(out.toolPolicies)) {
      if (!toolName.trim()) throw new Error(`${path}.toolPolicies: tool name must be non-empty`);
      policies[toolName] = validateToolPolicyShape(policy, `${path}.toolPolicies.${toolName}`);
    }
    out.toolPolicies = policies;
  }
  for (const key of [
    "timeoutMs",
    "maxResultBytes",
    "maxSchemaBytes",
    "maxConcurrentCalls",
    "maxTools",
    "maxToolPages",
  ] as const) {
    if (out[key] !== undefined && !isPositiveInteger(out[key])) {
      throw new Error(`${path}.${key}: must be a positive integer`);
    }
  }
  if (
    out.includeToolDescriptions !== undefined &&
    typeof out.includeToolDescriptions !== "boolean"
  ) {
    throw new Error(`${path}.includeToolDescriptions: must be a boolean`);
  }
  return out;
}

function validateToolPolicyShape(value: unknown, path: string): McpToolAuggyPolicy {
  if (!isRecord(value)) throw new Error(`${path}: must be an object`);
  const out = { ...value } as McpToolAuggyPolicy;
  if (out.allowedTrustLevels !== undefined) {
    validateTrustLevels(out.allowedTrustLevels, `${path}.allowedTrustLevels`);
  }
  return out;
}

function validateTrustLevels(value: unknown, path: string): asserts value is TrustLevel[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${path}: must be a non-empty trust-level array`);
  }
  const allowed = new Set(["creator", "agent", "public"]);
  for (const item of value) {
    if (typeof item !== "string" || !allowed.has(item)) {
      throw new Error(`${path}: must contain only creator, agent, or public`);
    }
  }
}

function validateMcpServerName(name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(name)) {
    throw new Error(`MCP server name "${name}" must be alphanumeric with hyphens/underscores`);
  }
}

function collectServerEnvReferences(server: McpServerConfig): string[] {
  const refs = new Set<string>();
  for (const value of [
    ...Object.values(server.env ?? {}),
    ...Object.values(server.headers ?? {}),
  ]) {
    for (const match of value.matchAll(/\$\{([A-Z_][A-Z0-9_]*)\}/g)) {
      if (match[1]) refs.add(match[1]);
    }
  }
  return [...refs].sort();
}

function collectLiteralSecretFields(server: McpServerConfig): string[] {
  const out: string[] = [];
  for (const [scope, record] of [
    ["env", server.env],
    ["headers", server.headers],
  ] as const) {
    for (const [key, value] of Object.entries(record ?? {})) {
      if (value.includes("${")) continue;
      if (isSecretishKey(key) || isSecretishValue(value)) out.push(`${scope}.${key}`);
    }
  }
  return out.sort();
}

function isSecretishKey(key: string): boolean {
  return /(token|secret|password|authorization|api[_-]?key)/i.test(key);
}

function isSecretishValue(value: string): boolean {
  return /^(bearer\s+)?[A-Za-z0-9_.-]{24,}$/i.test(value.trim());
}

function isRemoteTransport(transport: ReturnType<typeof classifyMcpTransport>): boolean {
  return transport === "http" || transport === "sse" || transport === "streamable-http";
}

function readAgentEnv(agentDir: string): Map<string, string> {
  const values = new Map<string, string>();
  const path = join(agentDir, ".env");
  if (!existsSync(path)) return values;
  for (const line of parseEnvFile(readFileSync(path, "utf-8"))) {
    if (line.kind === "kv") values.set(line.key, line.value);
  }
  return values;
}

function mcpCloudPolicy(
  config: McpConfig,
  name: string,
  server: McpServerConfig,
): McpServerAuggyPolicy["cloud"] | undefined {
  return config.auggy?.servers?.[name]?.cloud ?? server.auggy?.cloud;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringRecord(value: unknown): value is Record<string, string> {
  return isRecord(value) && Object.values(value).every((item) => typeof item === "string");
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}
