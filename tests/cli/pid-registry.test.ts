import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { PidManifest } from "../../src/cli/types";

// We test the core logic by importing the functions and operating on
// temp directories. Production uses ~/.auggy/, but the same code paths
// support an explicit auggyDir override for tests and embedded callers.
import {
  writePidManifest,
  claimRuntimePidManifest,
  releaseRuntimePidManifest,
  readPidManifest,
  removePidManifest,
  listPidManifests,
  tryClaimName,
  isProcessAlive,
} from "../../src/cli/pid-registry";

let auggyDir: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "pid-registry-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("isProcessAlive", () => {
  test("returns true for the current process", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
  });

  test("returns false for a non-existent PID", () => {
    // PID 99999999 is extremely unlikely to exist.
    expect(isProcessAlive(99999999)).toBe(false);
  });
});

describe("PID manifest lifecycle", () => {
  const testName = `test-agent-${Date.now()}`;

  afterEach(() => {
    removePidManifest(testName, { auggyDir });
  });

  test("write + read round-trip", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: 8080,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    const read = readPidManifest(testName, { auggyDir });
    expect(read).not.toBeNull();
    expect(read!.pid).toBe(process.pid);
    expect(read!.name).toBe(testName);
    expect(read!.port).toBe(8080);
    expect(read!.mode).toBe("dev");
  });

  test("read returns null for non-existent manifest", () => {
    expect(readPidManifest("nonexistent-agent-xyz", { auggyDir })).toBeNull();
  });

  test("write throws on duplicate (atomic wx flag)", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: null,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    expect(() => writePidManifest(manifest, { auggyDir })).toThrow();
  });

  test("remove cleans up the manifest", () => {
    const manifest: PidManifest = {
      pid: process.pid,
      name: testName,
      port: null,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      startedAt: new Date().toISOString(),
      mode: "dev",
    };

    writePidManifest(manifest, { auggyDir });
    expect(readPidManifest(testName, { auggyDir })).not.toBeNull();
    removePidManifest(testName, { auggyDir });
    expect(readPidManifest(testName, { auggyDir })).toBeNull();
  });

  test("remove is idempotent (doesn't throw if already gone)", () => {
    expect(() => removePidManifest("nonexistent-xyz", { auggyDir })).not.toThrow();
  });
});

describe("runtime PID manifest policy", () => {
  test("Railway boot ignores a stale same-PID manifest without deleting it", () => {
    const name = "railway-stale";
    const manifest = {
      pid: process.pid,
      name,
      port: 8080,
      configPath: "/app/agent.yaml",
      agentDir: "/app",
      startedAt: new Date(0).toISOString(),
      mode: "dev" as const,
    };
    writePidManifest(manifest, { auggyDir });

    const claimed = claimRuntimePidManifest(manifest, {
      auggyDir,
      internalMode: "railway",
    });
    expect(claimed).toBe(false);
    releaseRuntimePidManifest(name, claimed, { auggyDir });
    expect(readPidManifest(name, { auggyDir })).toEqual(manifest);
  });

  test("local and launchd boots retain exclusive PID claims", () => {
    const manifest = {
      pid: process.pid,
      name: "exclusive-runtime",
      port: 8080,
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp",
      startedAt: new Date().toISOString(),
      mode: "launchd" as const,
    };
    expect(claimRuntimePidManifest(manifest, { auggyDir, internalMode: "launchd" })).toBe(true);
    expect(() =>
      claimRuntimePidManifest(manifest, { auggyDir, internalMode: "launchd" }),
    ).toThrow();
    releaseRuntimePidManifest(manifest.name, true, { auggyDir });
    expect(readPidManifest(manifest.name, { auggyDir })).toBeNull();
  });
});

describe("listPidManifests", () => {
  const name1 = `list-test-1-${Date.now()}`;
  const name2 = `list-test-2-${Date.now()}`;

  afterEach(() => {
    removePidManifest(name1, { auggyDir });
    removePidManifest(name2, { auggyDir });
  });

  test("lists manifests with alive processes", () => {
    writePidManifest(
      {
        pid: process.pid,
        name: name1,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    const list = listPidManifests({ auggyDir });
    const found = list.find((m) => m.name === name1);
    expect(found).toBeDefined();
  });
});

describe("tryClaimName", () => {
  const testName = `claim-test-${Date.now()}`;

  afterEach(() => {
    removePidManifest(testName, { auggyDir });
  });

  test("returns true when no manifest exists", () => {
    expect(tryClaimName(testName, { auggyDir })).toBe(true);
  });

  test("returns false when agent is alive and recent", () => {
    writePidManifest(
      {
        pid: process.pid,
        name: testName,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    expect(tryClaimName(testName, { auggyDir })).toBe(false);
  });

  test("returns true and cleans up when process is dead", () => {
    writePidManifest(
      {
        pid: 99999999, // dead PID
        name: testName,
        port: null,
        configPath: "/tmp/a.yaml",
        agentDir: "/tmp/a",
        startedAt: new Date().toISOString(),
        mode: "dev",
      },
      { auggyDir },
    );

    expect(tryClaimName(testName, { auggyDir })).toBe(true);
    expect(readPidManifest(testName, { auggyDir })).toBeNull();
  });
});
