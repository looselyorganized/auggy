import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { mcpCommand, formatMcpServerList } from "../../../src/cli/commands/mcp";

function setupAgent(): { dir: string; cleanup: () => void } {
  const root = mkdtempSync(join(tmpdir(), "mcp-command-test-"));
  const dir = join(root, "agent");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.yaml"),
    [
      "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      "name: agent",
      "engine:",
      "  provider: anthropic",
      "  model: claude-sonnet-4-6",
      "augments:",
      "  - name: mcp",
      "    type: mcp",
      "",
    ].join("\n"),
  );
  return { dir, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

describe("auggy mcp command", () => {
  test("init creates .mcp.json for project-local agent", async () => {
    const { dir, cleanup } = setupAgent();
    try {
      const exit = mock((_code: number) => {});
      const cmd = mcpCommand({ cwd: dir, exit });
      await cmd.parseAsync(["init"], { from: "user" });
      expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"))).toEqual({
        mcpServers: {},
      });
    } finally {
      cleanup();
    }
  });

  test("add-json and remove mutate .mcp.json", async () => {
    const { dir, cleanup } = setupAgent();
    try {
      const exit = mock((_code: number) => {});
      const cmd = mcpCommand({ cwd: dir, exit });
      await cmd.parseAsync(
        [
          "add-json",
          "github",
          '{"type":"stdio","command":"npx","args":["-y","@modelcontextprotocol/server-github"]}',
        ],
        { from: "user" },
      );
      let config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.github.command).toBe("npx");

      await cmd.parseAsync(["remove", "github"], { from: "user" });
      config = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"));
      expect(config.mcpServers.github).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("formatMcpServerList renders server rows", () => {
    const text = formatMcpServerList({
      mcpServers: {
        github: { type: "stdio", command: "npx", args: ["server"] },
        remote: { type: "http", url: "https://example.com/mcp" },
      },
    });
    expect(text).toContain("SERVER");
    expect(text).toContain("github");
    expect(text).toContain("stdio");
    expect(text).toContain("remote");
    expect(text).toContain("https://example.com/mcp");
  });
});
