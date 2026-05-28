import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock @inquirer/prompts so we can drive the confirm() return value per-test.
let confirmAnswer = true;
mock.module("@inquirer/prompts", () => ({
  checkbox: async () => [],
  confirm: async () => confirmAnswer,
  input: async () => "",
  select: async (config: { choices?: Array<{ value: unknown }> }) => config.choices?.[0]?.value,
}));

const { runRemove } = await import("../../src/cli/commands/remove");
const { getAgent, seedAgentForTest, setCloud } = await import("../../src/cli/agent-index");
const { writePidManifest, removePidManifest } = await import("../../src/cli/pid-registry");

let auggyDir: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "remove-test-auggy-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

function setupAgent(name: string, yaml?: string): string {
  return seedAgentForTest(name, { auggyDir, yaml: yaml ?? "id: aug1_test\n" });
}

describe("runRemove", () => {
  test("refuses when agent dir does not exist", async () => {
    await expect(runRemove("ghost", { yes: true, auggyDir })).rejects.toThrow(/not found/i);
  });

  test("refuses when agent process is alive", async () => {
    const dir = setupAgent("zip");
    writePidManifest(
      {
        pid: process.pid,
        name: "zip",
        port: 8080,
        configPath: join(dir, "agent.yaml"),
        agentDir: dir,
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );
    try {
      await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
        /running|stop it first/i,
      );
    } finally {
      removePidManifest("zip", { auggyDir });
    }
  });

  test("--yes deletes the agent dir", async () => {
    const dir = setupAgent("zip");
    await runRemove("zip", { yes: true, auggyDir });
    expect(existsSync(dir)).toBe(false);
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("tolerates stale PID manifest (pid dead)", async () => {
    setupAgent("zip");
    writePidManifest(
      {
        pid: 99999999,
        name: "zip",
        port: 8080,
        configPath: join(auggyDir, "agents", "zip", "agent.yaml"),
        agentDir: join(auggyDir, "agents", "zip"),
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );
    await runRemove("zip", { yes: true, auggyDir });
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("without --yes, prompt rejection (n) leaves dir intact", async () => {
    const dir = setupAgent("zip");
    confirmAnswer = false;
    try {
      await runRemove("zip", { auggyDir });
      expect(existsSync(dir)).toBe(true);
      expect(getAgent("zip", { auggyDir })).not.toBeNull();
    } finally {
      confirmAnswer = true;
    }
  });

  test("refuses delete when localDir lacks agent.yaml (safety guard)", async () => {
    const dir = setupAgent("zip");
    rmSync(join(dir, "agent.yaml"), { force: true });
    // With no agent.yaml, getAgent returns null → "not found" thrown.
    await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(/not found/i);
    // Dir still exists.
    expect(existsSync(dir)).toBe(true);
  });

  test("refuses delete when agent.yaml's name is alive under different PID manifest key", async () => {
    const dir = setupAgent("zip");
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\nname: zippy\n");
    writePidManifest(
      {
        pid: process.pid,
        name: "zippy",
        port: 8081,
        configPath: join(dir, "agent.yaml"),
        agentDir: dir,
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );
    try {
      await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
        /running|stop it first/i,
      );
    } finally {
      removePidManifest("zippy", { auggyDir });
    }
  });

  test("--cloud destroys the Railway service AND removes the agent dir", async () => {
    setupAgent("zip");
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );

    const calls: { link: number; destroy: number } = { link: 0, destroy: 0 };
    const mockCli = {
      async checkPresence() {
        return true as const;
      },
      async checkAuth() {
        return "x@y.z";
      },
      async link() {
        calls.link++;
      },
      async setVariable() {},
      async up() {},
      async generateDomain() {
        return "https://x";
      },
      async addVolume() {},
      async status() {
        return {
          project: { id: "x", name: "x" },
          service: { id: "x", name: "x" },
          deployment: { status: "SUCCESS" },
        };
      },
      async destroyService() {
        calls.destroy++;
      },
      async logs() {},
    };

    await runRemove("zip", { yes: true, cloud: true, auggyDir, railwayCli: mockCli });
    expect(calls.link).toBe(1);
    expect(calls.destroy).toBe(1);
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("--cloud surfaces Railway destruction errors as a warning, still removes the local dir", async () => {
    setupAgent("zip");
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip.up.railway.app",
        volumeId: "zip-data",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );

    const mockCli = {
      async checkPresence() {
        return true as const;
      },
      async checkAuth() {
        return "x@y.z";
      },
      async link() {},
      async setVariable() {},
      async up() {},
      async generateDomain() {
        return "https://x";
      },
      async addVolume() {},
      async status() {
        return {
          project: { id: "x", name: "x" },
          service: { id: "x", name: "x" },
          deployment: { status: "SUCCESS" },
        };
      },
      async destroyService() {
        throw new Error("Railway API timeout");
      },
      async logs() {},
    };

    await runRemove("zip", { yes: true, cloud: true, auggyDir, railwayCli: mockCli });
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });
});
