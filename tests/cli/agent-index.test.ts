import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  readIndex,
  writeIndex,
  addAgent,
  removeAgent,
  getAgent,
  listAgents,
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
    writeFileSync(
      join(auggyDir, "agents.json"),
      JSON.stringify({ version: 99, agents: {} }),
    );
    expect(() => readIndex({ auggyDir })).toThrow(/version/i);
  });

  test("recovers from corrupt JSON by backing up and recreating", () => {
    writeFileSync(join(auggyDir, "agents.json"), "{ not valid json");
    const idx = readIndex({ auggyDir });
    expect(idx).toEqual({ version: 1, agents: {} });
    // backup file should exist
    const files = require("node:fs").readdirSync(auggyDir);
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
