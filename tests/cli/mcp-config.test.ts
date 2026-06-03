import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  diagnoseMcpConfig,
  ensureMcpConfig,
  parseMcpServerJson,
  readMcpConfig,
  removeMcpServer,
  setMcpServer,
} from "../../src/cli/mcp-config";

function tempAgent(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("mcp config helpers", () => {
  test("ensureMcpConfig creates a portable empty .mcp.json", () => {
    const { dir, cleanup } = tempAgent();
    try {
      ensureMcpConfig(dir);
      expect(readMcpConfig(dir).config).toEqual({ mcpServers: {} });
    } finally {
      cleanup();
    }
  });

  test("set and remove server definitions", () => {
    const { dir, cleanup } = tempAgent();
    try {
      setMcpServer(dir, "github", {
        type: "stdio",
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
      });
      expect(readMcpConfig(dir).config.mcpServers.github?.command).toBe("npx");
      expect(removeMcpServer(dir, "github")).toBe(true);
      expect(readMcpConfig(dir).config.mcpServers.github).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  test("diagnose catches missing env references", () => {
    const { dir, cleanup } = tempAgent();
    try {
      setMcpServer(dir, "remote", {
        type: "http",
        url: "https://example.com/mcp",
        headers: { Authorization: "Bearer ${MCP_TOKEN}" },
      });
      const checks = diagnoseMcpConfig(dir);
      expect(
        checks.some((check) => check.name === "mcp remote env" && check.status === "fail"),
      ).toBe(true);
    } finally {
      cleanup();
    }
  });

  test("cloud diagnostics fail stdio unless disabled", () => {
    const { dir, cleanup } = tempAgent();
    try {
      setMcpServer(dir, "local", { type: "stdio", command: "npx", args: ["-y", "server"] });
      expect(
        diagnoseMcpConfig(dir, { cloud: true }).find((check) => check.name === "mcp local cloud")
          ?.status,
      ).toBe("fail");

      writeFileSync(
        join(dir, ".mcp.json"),
        JSON.stringify(
          {
            mcpServers: { local: { type: "stdio", command: "npx", args: ["-y", "server"] } },
            auggy: { servers: { local: { cloud: "disabled" } } },
          },
          null,
          2,
        ),
      );
      expect(
        diagnoseMcpConfig(dir, { cloud: true }).find((check) => check.name === "mcp local cloud")
          ?.status,
      ).toBe("warn");
    } finally {
      cleanup();
    }
  });

  test("cloud diagnostics fail remote MCP without HTTPS", () => {
    const { dir, cleanup } = tempAgent();
    try {
      setMcpServer(dir, "remote", {
        type: "streamable-http",
        url: "http://mcp.example.com/mcp",
      });
      expect(
        diagnoseMcpConfig(dir, { cloud: true }).find((check) => check.name === "mcp remote cloud")
          ?.status,
      ).toBe("fail");
    } finally {
      cleanup();
    }
  });

  test("cloud diagnostics fail literal secret-like headers", () => {
    const { dir, cleanup } = tempAgent();
    try {
      setMcpServer(dir, "remote", {
        type: "streamable-http",
        url: "https://mcp.example.com/mcp",
        headers: { Authorization: "Bearer abcdefghijklmnopqrstuvwxyz123456" },
      });
      expect(
        diagnoseMcpConfig(dir, { cloud: true }).find((check) => check.name === "mcp remote secrets")
          ?.status,
      ).toBe("fail");
      expect(
        diagnoseMcpConfig(dir).find((check) => check.name === "mcp remote secrets")?.status,
      ).toBe("warn");
    } finally {
      cleanup();
    }
  });

  test("parseMcpServerJson validates object shape", () => {
    expect(parseMcpServerJson('{"type":"http","url":"https://example.com/mcp"}').url).toBe(
      "https://example.com/mcp",
    );
    expect(() => parseMcpServerJson("[]")).toThrow("must be an object");
  });
});
