import { describe, test, expect, beforeEach, afterEach, mock } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import type { PidManifest } from "../../src/cli/types";

// We test the core logic by importing the functions and operating on
// temp directories. The real registry uses ~/.auggy/ but tests
// exercise the same code paths.

const TMP = join(import.meta.dir, ".tmp-pid-test");

// Since pid-registry.ts uses a hardcoded AUGGY_DIR, we test by
// directly testing the exported functions with real filesystem ops.
// For the atomic write and liveness checks, we use the actual module.
import {
  writePidManifest,
  readPidManifest,
  removePidManifest,
  listPidManifests,
  tryClaimName,
  isProcessAlive,
} from "../../src/cli/pid-registry";

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
    removePidManifest(testName);
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

    writePidManifest(manifest);
    const read = readPidManifest(testName);
    expect(read).not.toBeNull();
    expect(read!.pid).toBe(process.pid);
    expect(read!.name).toBe(testName);
    expect(read!.port).toBe(8080);
    expect(read!.mode).toBe("dev");
  });

  test("read returns null for non-existent manifest", () => {
    expect(readPidManifest("nonexistent-agent-xyz")).toBeNull();
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

    writePidManifest(manifest);
    expect(() => writePidManifest(manifest)).toThrow();
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

    writePidManifest(manifest);
    expect(readPidManifest(testName)).not.toBeNull();
    removePidManifest(testName);
    expect(readPidManifest(testName)).toBeNull();
  });

  test("remove is idempotent (doesn't throw if already gone)", () => {
    expect(() => removePidManifest("nonexistent-xyz")).not.toThrow();
  });
});

describe("listPidManifests", () => {
  const name1 = `list-test-1-${Date.now()}`;
  const name2 = `list-test-2-${Date.now()}`;

  afterEach(() => {
    removePidManifest(name1);
    removePidManifest(name2);
  });

  test("lists manifests with alive processes", () => {
    writePidManifest({
      pid: process.pid,
      name: name1,
      port: null,
      configPath: "/tmp/a.yaml",
      agentDir: "/tmp/a",
      startedAt: new Date().toISOString(),
      mode: "dev",
    });

    const list = listPidManifests();
    const found = list.find((m) => m.name === name1);
    expect(found).toBeDefined();
  });
});

describe("tryClaimName", () => {
  const testName = `claim-test-${Date.now()}`;

  afterEach(() => {
    removePidManifest(testName);
  });

  test("returns true when no manifest exists", () => {
    expect(tryClaimName(testName)).toBe(true);
  });

  test("returns false when agent is alive and recent", () => {
    writePidManifest({
      pid: process.pid,
      name: testName,
      port: null,
      configPath: "/tmp/a.yaml",
      agentDir: "/tmp/a",
      startedAt: new Date().toISOString(),
      mode: "dev",
    });

    expect(tryClaimName(testName)).toBe(false);
  });

  test("returns true and cleans up when process is dead", () => {
    writePidManifest({
      pid: 99999999, // dead PID
      name: testName,
      port: null,
      configPath: "/tmp/a.yaml",
      agentDir: "/tmp/a",
      startedAt: new Date().toISOString(),
      mode: "dev",
    });

    expect(tryClaimName(testName)).toBe(true);
    expect(readPidManifest(testName)).toBeNull();
  });
});
