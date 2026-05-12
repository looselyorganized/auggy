import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock @inquirer/prompts so we can drive the confirm() return value per-test.
// Default is `true` (accept) — only the decline test flips this to `false`.
// The mock must be registered BEFORE remove.ts is imported so its bound
// `confirm` reference points at our mock.
let confirmAnswer = true;
mock.module("@inquirer/prompts", () => ({
  confirm: async () => confirmAnswer,
}));

const { runRemove } = await import("../../src/cli/commands/remove");
const { addAgent, getAgent } = await import("../../src/cli/agent-index");
const { writePidManifest, removePidManifest } = await import("../../src/cli/pid-registry");

let auggyDir: string;
let agentParent: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "remove-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "remove-test-agents-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

function setupAgent(name: string): string {
  const dir = join(agentParent, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
  writeFileSync(join(dir, "identity.md"), "test");
  addAgent(name, dir, { auggyDir });
  return dir;
}

describe("runRemove", () => {
  test("refuses when name is not in index", async () => {
    await expect(runRemove("ghost", { yes: true, auggyDir })).rejects.toThrow(/not registered/i);
  });

  test("refuses when agent process is alive", async () => {
    setupAgent("zip");
    // Use the current test process PID — guaranteed alive.
    writePidManifest({
      pid: process.pid,
      name: "zip",
      port: 8080,
      configPath: join(agentParent, "zip", "agent.yaml"),
      agentDir: join(agentParent, "zip"),
      startedAt: new Date().toISOString(),
      mode: "dev",
    });
    try {
      await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
        /running|stop it first/i,
      );
    } finally {
      removePidManifest("zip");
    }
  });

  test("--yes deletes dir and clears index", async () => {
    const dir = setupAgent("zip");
    await runRemove("zip", { yes: true, auggyDir });
    expect(existsSync(dir)).toBe(false);
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("tolerates missing localDir (already deleted manually)", async () => {
    const dir = setupAgent("zip");
    rmSync(dir, { recursive: true, force: true });
    await runRemove("zip", { yes: true, auggyDir });
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("tolerates stale PID manifest (pid dead)", async () => {
    setupAgent("zip");
    // Use a PID that is essentially guaranteed dead.
    writePidManifest({
      pid: 99999999,
      name: "zip",
      port: 8080,
      configPath: join(agentParent, "zip", "agent.yaml"),
      agentDir: join(agentParent, "zip"),
      startedAt: new Date().toISOString(),
      mode: "dev",
    });
    await runRemove("zip", { yes: true, auggyDir });
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("without --yes, prompt rejection (n) leaves dir and index entry intact", async () => {
    const dir = setupAgent("zip");
    // Drive the mocked confirm() to return false (operator declines).
    confirmAnswer = false;
    try {
      await runRemove("zip", { auggyDir });
      expect(existsSync(dir)).toBe(true);
      expect(getAgent("zip", { auggyDir })).not.toBeNull();
    } finally {
      // Restore default so any subsequent tests aren't affected.
      confirmAnswer = true;
    }
  });

  test("refuses delete when localDir lacks agent.yaml (corrupt-index protection)", async () => {
    const dir = setupAgent("zip");
    // Remove the agent.yaml but keep the dir.
    rmSync(join(dir, "agent.yaml"), { force: true });
    await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
      /Refusing to delete|does not contain agent\.yaml/i,
    );
    // Dir should still exist (we refused).
    expect(existsSync(dir)).toBe(true);
    // Index entry should still exist (we refused before touching it).
    const { getAgent } = await import("../../src/cli/agent-index");
    expect(getAgent("zip", { auggyDir })).not.toBeNull();
  });

  test("refuses delete when agent.yaml's name is alive under different PID manifest key (Codex I3)", async () => {
    const dir = setupAgent("zip");
    // Edit agent.yaml so config.name differs from the index key
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\nname: zippy\n");
    // Plant a live PID manifest under config.name "zippy"
    writePidManifest({
      pid: process.pid,
      name: "zippy",
      port: 8081,
      configPath: join(dir, "agent.yaml"),
      agentDir: dir,
      startedAt: new Date().toISOString(),
      mode: "dev",
    });
    try {
      await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
        /running|stop it first/i,
      );
    } finally {
      removePidManifest("zippy");
    }
  });

  test("--cloud destroys the Railway service AND clears the index entry", async () => {
    const { setCloud } = await import("../../src/cli/agent-index");
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
    };

    await runRemove("zip", { yes: true, cloud: true, auggyDir, railwayCli: mockCli });
    expect(calls.link).toBe(1);
    expect(calls.destroy).toBe(1);
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("--cloud surfaces Railway destruction errors as a warning, still clears the local index", async () => {
    const { setCloud } = await import("../../src/cli/agent-index");
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
    };

    // Should NOT throw — local cleanup proceeds even if Railway destruction fails.
    await runRemove("zip", { yes: true, cloud: true, auggyDir, railwayCli: mockCli });
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });
});
