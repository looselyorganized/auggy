import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Command } from "commander";
import { parse as parseYaml } from "yaml";
import { resolveConfigPath } from "../resolve-config";
import { displayPath } from "../display-path";
import {
  classifyMcpTransport,
  diagnoseMcpConfig,
  ensureMcpConfig,
  parseMcpServerJson,
  readMcpConfig,
  removeMcpServer,
  setMcpServer,
  type McpConfig,
} from "../mcp-config";
import { formatDoctorChecks, hasDoctorFailures } from "./doctor";

export interface McpCommandDeps {
  auggyDir?: string;
  cwd?: string;
  exit?: (code: number) => void;
}

export function mcpCommand(deps: McpCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const cmd = new Command("mcp").description("Manage this agent's .mcp.json MCP servers");

  cmd
    .command("init")
    .description("Create .mcp.json in the agent root if it does not exist")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .action((opts: { agent?: string; config?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const path = ensureMcpConfig(agentDir);
        console.log(`MCP config: ${displayPath(path, deps.cwd)}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  cmd
    .command("list")
    .description("List configured MCP servers")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .action((opts: { agent?: string; config?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const { config } = readMcpConfig(agentDir);
        console.log(formatMcpServerList(config));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  cmd
    .command("show <name>")
    .description("Show one MCP server definition")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .action((name: string, opts: { agent?: string; config?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const { config } = readMcpConfig(agentDir);
        const server = config.mcpServers[name];
        if (!server) throw new Error(`MCP server "${name}" not found.`);
        console.log(JSON.stringify(server, null, 2));
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  cmd
    .command("add-json <name> <json>")
    .description("Add or replace an MCP server from a JSON object")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .action((name: string, json: string, opts: { agent?: string; config?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const server = parseMcpServerJson(json);
        setMcpServer(agentDir, name, server);
        console.log(
          `Added MCP server ${name} to ${displayPath(join(agentDir, ".mcp.json"), deps.cwd)}.`,
        );
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  cmd
    .command("remove <name>")
    .alias("rm")
    .description("Remove an MCP server from .mcp.json")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .action((name: string, opts: { agent?: string; config?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const removed = removeMcpServer(agentDir, name);
        if (!removed) throw new Error(`MCP server "${name}" not found.`);
        console.log(`Removed MCP server ${name}.`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  cmd
    .command("doctor")
    .description("Check .mcp.json syntax, env refs, and cloud compatibility")
    .option("--agent <name>", "agent name")
    .option("--config <path>", "path to agent.yaml")
    .option("--cloud", "check Railway/cloud compatibility")
    .action((opts: { agent?: string; config?: string; cloud?: boolean }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, opts.config, deps);
        const checks = diagnoseMcpConfig(agentDir, { cloud: opts.cloud });
        console.log(
          formatDoctorChecks(checks, { relativeTo: agentDir, color: process.stdout.isTTY }),
        );
        exit(hasDoctorFailures(checks) ? 1 : 0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return cmd;
}

export function formatMcpServerList(config: McpConfig): string {
  const entries = Object.entries(config.mcpServers).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) return "No MCP servers configured.";

  const rows = entries.map(([name, server]) => ({
    name,
    transport: classifyMcpTransport(server),
    target: server.command ?? server.url ?? "",
  }));
  const nameWidth = Math.max("SERVER".length, ...rows.map((row) => row.name.length));
  const transportWidth = Math.max("TRANSPORT".length, ...rows.map((row) => row.transport.length));
  return [
    `${"SERVER".padEnd(nameWidth)}  ${"TRANSPORT".padEnd(transportWidth)}  TARGET`,
    ...rows.map(
      (row) =>
        `${row.name.padEnd(nameWidth)}  ${row.transport.padEnd(transportWidth)}  ${row.target}`,
    ),
  ].join("\n");
}

function resolveAgentDir(
  agentName: string | undefined,
  config: string | undefined,
  deps: McpCommandDeps,
): string {
  const cwd = deps.cwd ?? process.cwd();
  const localConfig = join(cwd, "agent.yaml");
  const configPath = resolveConfigPath(agentName, config, {
    auggyDir: deps.auggyDir,
    cwd,
  });
  if (!agentName && !config && !existsSync(localConfig)) {
    throw new Error("Run from an agent project, pass --agent <name>, or pass --config <path>.");
  }
  if (!hasMcpAugment(configPath)) {
    throw new Error("MCP is not installed for this agent.\n\nRun:\n  auggy augment add mcp");
  }
  return dirname(configPath);
}

function hasMcpAugment(configPath: string): boolean {
  const agentDir = dirname(configPath);
  const raw = parseYaml(readFileSync(configPath, "utf-8")) as Record<string, unknown> | null;
  const augments = raw?.augments;
  if (!Array.isArray(augments)) return false;

  return augments.some((entry) => {
    if (typeof entry === "string") {
      if (entry === "mcp") return true;
      return readStringAugmentType(agentDir, entry) === "mcp";
    }
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return false;
    return (entry as Record<string, unknown>).type === "mcp";
  });
}

function readStringAugmentType(agentDir: string, id: string): string | null {
  const metadataPath = join(agentDir, "augments", id, "augment.yaml");
  if (!existsSync(metadataPath)) return null;
  const parsed = parseYaml(readFileSync(metadataPath, "utf-8")) as Record<string, unknown> | null;
  return typeof parsed?.type === "string" ? parsed.type : null;
}
