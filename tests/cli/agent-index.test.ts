import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readIndex,
  writeIndex,
  addAgent,
  removeAgent,
  getAgent,
  listAgents,
  setCloud,
  clearCloud,
} from "../../src/cli/agent-index";
import type { IndexFile } from "../../src/cli/types";

let auggyDir: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "agent-index-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("readIndex", () => {
  test("returns empty index when file does not exist", () => {
    const idx = readIndex({ auggyDir });
    expect(idx).toEqual({ version: 1, agents: {} });
  });

  test("reads a valid existing index", () => {
    const file: IndexFile = {
      version: 1,
      agents: {
        zip: {
          localDir: "/tmp/zip",
          createdAt: "2026-05-01T00:00:00Z",
          cloud: null,
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(file));
    const idx = readIndex({ auggyDir });
    expect(idx).toEqual(file);
  });

  test("rejects unknown schema versions", () => {
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify({ version: 99, agents: {} }));
    expect(() => readIndex({ auggyDir })).toThrow(/version/i);
  });

  test("recovers from corrupt JSON by backing up and recreating", () => {
    writeFileSync(join(auggyDir, "agents.json"), "{ not valid json");
    const idx = readIndex({ auggyDir });
    expect(idx).toEqual({ version: 1, agents: {} });
    // backup file should exist
    const files = readdirSync(auggyDir);
    expect(files.some((f: string) => f.startsWith("agents.json.corrupt-"))).toBe(true);
  });
});

describe("writeIndex", () => {
  test("creates file atomically (no .tmp leftover)", () => {
    const file: IndexFile = {
      version: 1,
      agents: {
        zip: { localDir: "/tmp/zip", createdAt: "2026-05-01T00:00:00Z", cloud: null },
      },
    };
    writeIndex(file, { auggyDir });
    expect(existsSync(join(auggyDir, "agents.json"))).toBe(true);
    expect(existsSync(join(auggyDir, "agents.json.tmp"))).toBe(false);
    const round = readIndex({ auggyDir });
    expect(round).toEqual(file);
  });

  test("creates ~/.auggy/ if missing", () => {
    rmSync(auggyDir, { recursive: true, force: true });
    writeIndex({ version: 1, agents: {} }, { auggyDir });
    expect(existsSync(auggyDir)).toBe(true);
    expect(existsSync(join(auggyDir, "agents.json"))).toBe(true);
  });
});

describe("addAgent", () => {
  test("adds a new entry", () => {
    addAgent("zip", "/tmp/zip", { auggyDir });
    const entry = getAgent("zip", { auggyDir });
    expect(entry).not.toBeNull();
    expect(entry!.localDir).toBe("/tmp/zip");
    expect(entry!.cloud).toBeNull();
    expect(entry!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("refuses duplicate names", () => {
    addAgent("zip", "/tmp/zip", { auggyDir });
    expect(() => addAgent("zip", "/tmp/elsewhere", { auggyDir })).toThrow(
      /already (exists|registered)/i,
    );
  });
});

describe("removeAgent", () => {
  test("removes an existing entry", () => {
    addAgent("zip", "/tmp/zip", { auggyDir });
    removeAgent("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })).toBeNull();
  });

  test("is idempotent for non-existent names", () => {
    expect(() => removeAgent("ghost", { auggyDir })).not.toThrow();
  });
});

describe("listAgents", () => {
  test("returns empty array for empty index", () => {
    expect(listAgents({ auggyDir })).toEqual([]);
  });

  test("returns all agents with their names", () => {
    addAgent("zip", "/tmp/zip", { auggyDir });
    addAgent("concierge", "/tmp/concierge", { auggyDir });
    const list = listAgents({ auggyDir });
    expect(list).toHaveLength(2);
    expect(list.map((a) => a.name).sort()).toEqual(["concierge", "zip"]);
  });
});

describe("agent-index — concurrency", () => {
  test("addAgent acquires and releases the lock file", () => {
    addAgent("zip", "/tmp/zip", { auggyDir });
    // After addAgent returns, the lock file should NOT exist.
    expect(existsSync(join(auggyDir, "agents.json.lock"))).toBe(false);
  });

  test("removeAgent releases the lock even if no entry exists", () => {
    removeAgent("ghost", { auggyDir });
    expect(existsSync(join(auggyDir, "agents.json.lock"))).toBe(false);
  });

  test("acquireLock force-recovers from a stale lock after timeout", () => {
    // Plant a stale lock (content is irrelevant — recovery is time-based, not
    // PID-based, after the CodeQL refactor).
    writeFileSync(
      join(auggyDir, "agents.json.lock"),
      JSON.stringify({ pid: 99999999, acquired: "2026-05-04T00:00:00Z" }),
    );
    // addAgent should wait LOCK_TIMEOUT_MS (~5s), then force-unlink and acquire.
    addAgent("zip", "/tmp/zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.localDir).toBe("/tmp/zip");
    expect(existsSync(join(auggyDir, "agents.json.lock"))).toBe(false);
  }, 10000);
});

describe("setCloud", () => {
  test("writes a cloud record on a registered agent", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "proj_abc",
        serviceId: "svc_def",
        url: "https://zip-production.up.railway.app",
        volumeId: "vol_ghi",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );
    expect(getAgent("zip", { auggyDir })?.cloud).toEqual({
      provider: "railway",
      projectId: "proj_abc",
      serviceId: "svc_def",
      url: "https://zip-production.up.railway.app",
      volumeId: "vol_ghi",
      deployedAt: "2026-05-12T00:00:00.000Z",
    });
  });

  test("overwrites an existing cloud record (redeploy)", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud("zip", {
      provider: "railway", projectId: "p1", serviceId: "s1", url: "u1", volumeId: "v1", deployedAt: "2026-05-01T00:00:00.000Z",
    }, { auggyDir });
    setCloud("zip", {
      provider: "railway", projectId: "p1", serviceId: "s1", url: "u2", volumeId: "v1", deployedAt: "2026-05-12T00:00:00.000Z",
    }, { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud?.url).toBe("u2");
    expect(getAgent("zip", { auggyDir })?.cloud?.deployedAt).toBe("2026-05-12T00:00:00.000Z");
  });

  test("throws when the agent is not registered", () => {
    expect(() =>
      setCloud(
        "ghost",
        { provider: "railway", projectId: "p", serviceId: "s", url: "u", volumeId: "v", deployedAt: "2026-05-12T00:00:00.000Z" },
        { auggyDir },
      ),
    ).toThrow(/not registered/);
  });

  test("releases the lock even on throw", () => {
    expect(() =>
      setCloud(
        "ghost",
        { provider: "railway", projectId: "p", serviceId: "s", url: "u", volumeId: "v", deployedAt: "2026-05-12T00:00:00.000Z" },
        { auggyDir },
      ),
    ).toThrow();
    expect(existsSync(join(auggyDir, "agents.json.lock"))).toBe(false);
  });
});

describe("clearCloud", () => {
  test("nulls the cloud record; idempotent on already-null", () => {
    addAgent("zip", "/agents/zip", { auggyDir });
    setCloud("zip", {
      provider: "railway", projectId: "p", serviceId: "s", url: "u", volumeId: "v", deployedAt: "2026-05-12T00:00:00.000Z",
    }, { auggyDir });
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
    // Second call: still null, no throw.
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("no-op on missing agent (does not throw)", () => {
    expect(() => clearCloud("ghost", { auggyDir })).not.toThrow();
  });
});
