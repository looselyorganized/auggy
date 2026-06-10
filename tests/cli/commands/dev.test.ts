import { describe, expect, test } from "bun:test";
import { formatDevReadyMessage, formatRunDisplayPath } from "../../../src/cli/commands/dev";

describe("formatDevReadyMessage", () => {
  test("prints the local run success banner with extension and Railway deploy guidance", () => {
    const out = formatDevReadyMessage({
      agentName: "my-agent",
      port: 8080,
      configPath: "/tmp/my-agent/agent.yaml",
      deployCommand: "auggy deploy",
    });

    expect(out).toContain('Agent "my-agent" is live.');
    expect(out).toContain("  Chat:     http://localhost:8080/console/chat");
    expect(out).toContain("  Console:  http://localhost:8080/console");
    expect(out).toContain("  Health:   http://localhost:8080/health");
    expect(out).toContain("  Home:     http://localhost:8080/");
    expect(out).toContain("Extend it:");
    expect(out).toContain("  auggy augment list");
    expect(out).toContain("  auggy augment add <name>");
    expect(out).toContain("  auggy augment create <name>");
    expect(out).toContain("Deploy it:");
    expect(out).toMatch(/ {2}auggy deploy\s+Deploy to Railway/);
    expect(out).toContain("Config: /tmp/my-agent/agent.yaml");
    expect(out).toContain("Press Ctrl-C to stop.");
  });

  test("uses named deploy command when the agent was run by name", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "/tmp/zip/agent.yaml",
      deployCommand: "auggy deploy zip",
    });

    expect(out).toMatch(/ {2}auggy deploy zip\s+Deploy to Railway/);
  });

  test("prints a cloud boot banner without local next steps", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "agent.yaml",
      deployCommand: "auggy deploy zip",
      runtime: "railway",
      publicUrl: "https://zip-production.up.railway.app",
    });

    expect(out).toContain('Agent "zip" is live.');
    expect(out).toContain("  Chat:     https://zip-production.up.railway.app/console/chat");
    expect(out).toContain("  Console:  https://zip-production.up.railway.app/console");
    expect(out).toContain("  Health:   https://zip-production.up.railway.app/health");
    expect(out).toContain("  Home:     https://zip-production.up.railway.app");
    expect(out).toContain("Config: agent.yaml");
    expect(out).toContain("Runtime: Railway");
    expect(out).not.toContain("http://localhost:8080");
    expect(out).not.toContain("Extend it:");
    expect(out).not.toContain("Deploy it:");
    expect(out).not.toContain("Press Ctrl-C to stop.");
  });

  test("falls back to container-local URLs when Railway public URL is unavailable", () => {
    const out = formatDevReadyMessage({
      agentName: "zip",
      port: 8080,
      configPath: "agent.yaml",
      deployCommand: "auggy deploy zip",
      runtime: "railway",
      publicUrl: "",
    });

    expect(out).toContain("  Health:   http://localhost:8080/health");
    expect(out).toContain("Runtime: Railway");
  });

  test("formats config paths relative to the command cwd", () => {
    expect(formatRunDisplayPath("/repo/dx-agent/agent.yaml", "/repo")).toBe("dx-agent/agent.yaml");
    expect(formatRunDisplayPath("/repo/dx-agent/agent.yaml", "/repo/dx-agent")).toBe("agent.yaml");
  });
});
