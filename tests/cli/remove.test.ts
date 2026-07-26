import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Mock @inquirer/prompts so we can drive the confirm() return value per-test.
let confirmAnswer = true;
let onConfirm: (() => void) | undefined;
mock.module("@inquirer/prompts", () => ({
  Separator: class Separator {
    readonly type = "separator";
    constructor(readonly separator = "") {}
  },
  checkbox: async () => [],
  confirm: async () => {
    onConfirm?.();
    return confirmAnswer;
  },
  input: async () => "",
  select: async (config: { choices?: Array<{ value: unknown }> }) => config.choices?.[0]?.value,
}));

const removeCommands = await import("../../src/cli/commands/remove");
const runRemove: typeof removeCommands.runRemove = (name, opts = {}) =>
  removeCommands.runRemove(name, {
    processIdentityForPid: () => "test-process:remove",
    ...opts,
  });
const { getAgent, seedAgentForTest, setCloud } = await import("../../src/cli/agent-index");
const { claimRuntimePidManifest, releaseRuntimePidManifest, writePidManifest, removePidManifest } =
  await import("../../src/cli/pid-registry");
const { agentStateRootClaims } = await import("../../src/cli/runtime-resource-claims");

const IMMUTABLE_ID = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";

let auggyDir: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "remove-test-auggy-"));
  confirmAnswer = true;
  onConfirm = undefined;
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

function setupAgent(name: string, yaml?: string): string {
  return seedAgentForTest(name, {
    auggyDir,
    yaml: yaml ?? `id: ${IMMUTABLE_ID}\nname: ${name}\n`,
  });
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

  test("--yes deletes the current project-local agent when name is omitted", async () => {
    const dir = setupAgent("zip");
    await runRemove(undefined, { yes: true, auggyDir, cwd: dir });
    expect(existsSync(dir)).toBe(false);
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("refuses named removal inside an agent project when the name is not the agent name", async () => {
    const dir = setupAgent(
      "zip",
      "id: aug1_test\nname: zip\naugments:\n  - name: visitorAuth\n    type: visitorAuth\n",
    );

    await expect(runRemove("visitorAuth", { yes: true, auggyDir, cwd: dir })).rejects.toThrow(
      /auggy augment remove visitorAuth/,
    );
    expect(existsSync(dir)).toBe(true);
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

  test("holds the immutable agent claim through confirmation and releases it afterward", async () => {
    const dir = setupAgent("zip");
    const contender = {
      pid: process.pid,
      name: "zip",
      agentId: IMMUTABLE_ID,
      claimNonce: "11111111-1111-4111-8111-111111111111",
      processIdentity: "test-process:remove-race",
      resourceClaims: [`agent-id:${IMMUTABLE_ID}`],
      resourceClaimStore: "sqlite-v1" as const,
      port: null,
      configPath: join(dir, "agent.yaml"),
      agentDir: dir,
      startedAt: new Date().toISOString(),
      mode: "dev" as const,
    };
    let conflict: unknown;
    confirmAnswer = false;
    onConfirm = () => {
      try {
        claimRuntimePidManifest(contender, {
          auggyDir,
          processIdentityForPid: () => "test-process:remove-race",
        });
      } catch (error) {
        conflict = error;
      }
    };

    await runRemove("zip", {
      auggyDir,
      processIdentityForPid: () => "test-process:remove-race",
    });
    expect(String(conflict)).toMatch(/resource.*claimed/i);
    expect(existsSync(dir)).toBe(true);
    expect(
      claimRuntimePidManifest(contender, {
        auggyDir,
        processIdentityForPid: () => "test-process:remove-race",
      }),
    ).toBe(true);
    releaseRuntimePidManifest(contender, true, { auggyDir });
  });

  test("refuses to remove a parent state root containing a live child agent", async () => {
    const parent = setupAgent("zip");
    const child = join(parent, "child");
    const childId = "aug1_99999999-9999-4999-8999-999999999999";
    mkdirSync(child);
    writeFileSync(join(child, "agent.yaml"), `id: ${childId}\nname: child\n`);
    const manifest = {
      pid: process.pid,
      name: "child",
      agentId: childId,
      claimNonce: "22222222-2222-4222-8222-222222222222",
      processIdentity: "test-process:remove",
      resourceClaims: [`agent-id:${childId}`, ...agentStateRootClaims(child)].sort(),
      resourceClaimStore: "sqlite-v1" as const,
      port: null,
      configPath: join(child, "agent.yaml"),
      agentDir: child,
      startedAt: new Date().toISOString(),
      mode: "dev" as const,
    };
    expect(
      claimRuntimePidManifest(manifest, {
        auggyDir,
        processIdentityForPid: () => "test-process:remove",
      }),
    ).toBe(true);
    try {
      await expect(runRemove("zip", { yes: true, auggyDir })).rejects.toThrow(
        /state directory overlaps/i,
      );
      expect(existsSync(parent)).toBe(true);
      expect(existsSync(child)).toBe(true);
    } finally {
      releaseRuntimePidManifest(manifest, true, { auggyDir });
    }
  });

  test("refuses a same-path replacement that occurs during confirmation", async () => {
    const original = setupAgent("zip");
    const moved = `${original}.captured`;
    onConfirm = () => {
      renameSync(original, moved);
      mkdirSync(original);
      writeFileSync(join(original, "agent.yaml"), `id: ${IMMUTABLE_ID}\nname: zip\n`);
    };
    await expect(runRemove("zip", { auggyDir })).rejects.toThrow(/directory generation.*changed/i);
    expect(existsSync(original)).toBe(true);
    expect(existsSync(moved)).toBe(true);
  });

  test("refuses cloud destruction when deployment metadata belongs to another agent", async () => {
    const dir = setupAgent("zip");
    writeFileSync(
      join(dir, ".auggy-cloud.json"),
      JSON.stringify({
        version: 1,
        agentId: "aug1_99999999-9999-4999-8999-999999999999",
        provider: "railway",
        projectId: "victim-project",
        serviceId: "victim-service",
        url: "https://victim.example",
        volumeId: "victim-volume",
        deployedAt: new Date().toISOString(),
      }),
    );
    await expect(runRemove("zip", { yes: true, cloud: true, auggyDir })).rejects.toThrow(
      /belongs to another immutable agent/i,
    );
    expect(existsSync(dir)).toBe(true);
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
    writeFileSync(join(dir, "agent.yaml"), `id: ${IMMUTABLE_ID}\nname: zippy\n`);
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

  test("refuses to delete a running immutable agent after its display name changes", async () => {
    const dir = setupAgent("zip", `id: ${IMMUTABLE_ID}\nname: renamed\n`);
    writePidManifest(
      {
        pid: process.pid,
        name: "original",
        agentId: IMMUTABLE_ID,
        claimNonce: "8a3d7828-1597-4db4-bd0e-adc1a1036211",
        processIdentity: "test-process:running",
        resourceClaims: [`agent-id:${IMMUTABLE_ID}`],
        resourceClaimStore: "sqlite-v1",
        port: 8081,
        configPath: join(dir, "agent.yaml"),
        agentDir: dir,
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );
    try {
      await expect(
        runRemove(undefined, {
          yes: true,
          auggyDir,
          cwd: dir,
          processIdentityForPid: () => "test-process:running",
        }),
      ).rejects.toThrow(/running|stop it first/i);
      expect(existsSync(dir)).toBe(true);
    } finally {
      removePidManifest(IMMUTABLE_ID, { auggyDir });
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
      async listWorkspaces() {
        return [];
      },
      async listProjects() {
        return [];
      },
      async link() {
        calls.link++;
      },
      async createProject() {
        return "proj_created";
      },
      async linkProject() {},
      async linkService() {},
      async createService() {},
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

  test("--cloud from inside project-local agent links the saved Railway service id", async () => {
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
    const dir = join(auggyDir, "agents", "zip");

    const calls: Array<{ projectId: string; serviceName: string }> = [];
    const mockCli = {
      async checkPresence() {
        return true as const;
      },
      async checkAuth() {
        return "x@y.z";
      },
      async listWorkspaces() {
        return [];
      },
      async listProjects() {
        return [];
      },
      async link(args: { projectId: string; serviceName: string }) {
        calls.push(args);
      },
      async createProject() {
        return "proj_created";
      },
      async linkProject() {},
      async linkService() {},
      async createService() {},
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
      async destroyService() {},
      async logs() {},
    };

    await runRemove(undefined, { yes: true, cloud: true, auggyDir, cwd: dir, railwayCli: mockCli });
    expect(calls).toEqual([
      expect.objectContaining({ projectId: "proj_abc", serviceName: "svc_def" }),
    ]);
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
      async listWorkspaces() {
        return [];
      },
      async listProjects() {
        return [];
      },
      async link() {},
      async createProject() {
        return "proj_created";
      },
      async linkProject() {},
      async linkService() {},
      async createService() {},
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
