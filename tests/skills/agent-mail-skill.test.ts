import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, relative } from "node:path";
import { copyBundledSkill } from "../../src/cli/scaffold-skills";
import { createMcpManager } from "../../src/augments/mcp/manager";
import type {
  McpClientAdapter,
  McpConnection,
  McpRemoteTool,
  McpRuntimeServer,
} from "../../src/augments/mcp/types";

const ROOT = join(import.meta.dir, "..", "..");
const CANONICAL = join(ROOT, "src", "augments", "agentMail", "skill");
const PROVENANCE_PATH = join(CANONICAL, "references", "upstream-provenance.json");
const MCP_EXAMPLE_PATH = join(CANONICAL, "references", "mcp-read-only.example.json");
const TMP = join(import.meta.dir, ".tmp-agent-mail-skill");
const MUTATION_TOOLS = [
  "create_inbox",
  "update_inbox",
  "delete_inbox",
  "update_thread",
  "delete_thread",
  "send_message",
  "reply_to_message",
  "forward_message",
  "update_message",
  "create_draft",
  "update_draft",
  "send_draft",
  "delete_draft",
] as const;

function listFiles(root: string, current = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(current).sort()) {
    const path = join(current, entry);
    if (statSync(path).isDirectory()) files.push(...listFiles(root, path));
    else files.push(relative(root, path));
  }
  return files;
}

class ManifestConnection implements McpConnection {
  constructor(private readonly tools: McpRemoteTool[]) {}

  async listTools() {
    return { tools: this.tools };
  }

  async callTool() {
    return { content: [{ type: "text", text: "ok" }] };
  }

  async close() {}
}

class ManifestAdapter implements McpClientAdapter {
  servers: McpRuntimeServer[] = [];

  constructor(private readonly tools: McpRemoteTool[]) {}

  async connect(server: McpRuntimeServer) {
    this.servers.push(server);
    return new ManifestConnection(this.tools);
  }
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  process.env.AGENTMAIL_API_KEY = "am_test_agentmail_skill_boundary";
});

afterEach(() => {
  delete process.env.AGENTMAIL_API_KEY;
  rmSync(TMP, { recursive: true, force: true });
});

describe("AgentMail bundled skill contract", () => {
  test("installs every bundled skill file byte-for-byte", () => {
    expect(copyBundledSkill("agentMail", TMP)).toBe(true);
    const installed = join(TMP, "skills", "agentMail");
    const canonicalFiles = listFiles(CANONICAL);

    expect(existsSync(installed)).toBe(true);
    expect(listFiles(installed)).toEqual(canonicalFiles);
    for (const file of canonicalFiles) {
      expect(readFileSync(join(installed, file))).toEqual(readFileSync(join(CANONICAL, file)));
    }
  });

  test("pins the audited upstream skills, MCP manifest, and SDK", () => {
    const provenance = JSON.parse(readFileSync(PROVENANCE_PATH, "utf-8")) as {
      agentmailSkills: { commit: string; auditedPaths: string[] };
      agentmailMcp: {
        repository: string;
        commit: string;
        hostedUrl: string;
        manifestPath: string;
      };
      sdkVersion: string;
    };
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    };

    expect(provenance.agentmailSkills.commit).toBe("e0db938ca1dfd9f7525e08c0264c019707e034e2");
    expect(provenance.agentmailSkills.auditedPaths).toEqual(
      expect.arrayContaining([
        "agentmail/SKILL.md",
        "agentmail-send-email/SKILL.md",
        "agentmail-check-email/SKILL.md",
        "agentmail-mcp/SKILL.md",
      ]),
    );
    expect(provenance.agentmailMcp).toEqual({
      repository: "https://github.com/agentmail-to/agentmail-mcp",
      commit: "9cf619c973c59efad1fed34ea0967ef2f016cf5a",
      manifestPath: "mcp-manifest.json",
      hostedUrl: "https://mcp.agentmail.to/mcp",
    });
    expect(packageJson.dependencies.agentmail).toBe(provenance.sdkVersion);
  });

  test("keeps hosted MCP mutations absent and optional reads creator-only", async () => {
    const config = JSON.parse(readFileSync(MCP_EXAMPLE_PATH, "utf-8")) as {
      mcpServers: Record<string, unknown>;
    };
    writeFileSync(join(TMP, ".mcp.json"), `${JSON.stringify(config, null, 2)}\n`);

    const readTools = [
      "list_threads",
      "search_threads",
      "get_thread",
      "list_messages",
      "search_messages",
      "list_drafts",
      "get_draft",
    ];
    const adapter = new ManifestAdapter(
      [...readTools, ...MUTATION_TOOLS].map((name) => ({
        name,
        inputSchema: { type: "object" },
      })),
    );
    const manager = createMcpManager({ agentDir: TMP, client: adapter });
    await manager.boot();

    const exposed = manager.tools.map((tool) => tool.name);
    expect(exposed).toEqual(readTools.map((name) => `mcp_agentmail_readonly_${name}`));
    for (const mutation of MUTATION_TOOLS) {
      expect(exposed).not.toContain(`mcp_agentmail_readonly_${mutation}`);
    }
    expect(manager.constraints.perTrustLevel?.creator).toBeUndefined();
    expect(manager.constraints.perTrustLevel?.agent?.neverExpose).toEqual(exposed);
    expect(manager.constraints.perTrustLevel?.public?.neverExpose).toEqual(exposed);
    expect(adapter.servers[0]?.config.headers?.["x-api-key"]).toBe(
      "am_test_agentmail_skill_boundary",
    );

    await manager.shutdown();
  });

  test("teaches exact identities, provider drafts, untrusted input, and safe ambiguity", () => {
    const skill = readFileSync(join(CANONICAL, "SKILL.md"), "utf-8");
    for (const required of [
      "exact source `messageId`",
      "provider-native draft",
      "never authorizes delivery",
      "providerRevision",
      "untrusted data",
      "outcome_unknown",
      "never retry automatically",
      "send_message",
      "reply_to_mail_message",
      "forward_mail_message",
      "retry_mail_delivery",
      "reconcile_mail_delivery",
      "Do not use hosted AgentMail MCP mutation tools",
    ]) {
      expect(skill, required).toContain(required);
    }
  });
});
