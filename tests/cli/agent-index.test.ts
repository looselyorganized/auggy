import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  clearCloud,
  getAgent,
  listAgents,
  migrateLegacyIndex,
  removeAgent,
  resolveAgentDir,
  seedAgentForTest,
  setCloud,
  sweepStaleTempDirs,
} from "../../src/cli/agent-index";

const CLOUD_FIXTURE = {
  provider: "railway" as const,
  projectId: "proj_abc",
  serviceId: "svc_def",
  url: "https://zip.up.railway.app",
  volumeId: "zip-data",
  deployedAt: "2026-05-12T00:00:00.000Z",
};

let auggyDir: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "agent-store-test-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
});

describe("getAgent — filesystem-as-truth", () => {
  test("returns null when no dir exists", () => {
    expect(getAgent("ghost", { auggyDir })).toBeNull();
  });

  test("returns null when dir exists but agent.yaml is missing", () => {
    mkdirSync(join(auggyDir, "agents", "incomplete"), { recursive: true });
    expect(getAgent("incomplete", { auggyDir })).toBeNull();
  });

  test("createdAt derives from filesystem birthtime/mtime", () => {
    const dir = join(auggyDir, "agents", "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_zip\n");
    const entry = getAgent("zip", { auggyDir });
    expect(entry).not.toBeNull();
    expect(entry!.localDir).toBe(dir);
    expect(entry!.cloud).toBeNull();
    expect(entry!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("cloud is null when .auggy-cloud.json is absent", () => {
    seedAgentForTest("zip", { auggyDir });
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toBeNull();
    expect(existsSync(join(auggyDir, "agents", "zip", ".auggy-cloud.json"))).toBe(false);
  });

  test("cloud is populated when .auggy-cloud.json exists", () => {
    seedAgentForTest("zip", { auggyDir, cloud: CLOUD_FIXTURE });
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.cloud).toEqual(CLOUD_FIXTURE);
  });
});

describe("listAgents — filesystem scan", () => {
  test("returns empty when agents dir does not exist", () => {
    expect(listAgents({ auggyDir })).toEqual([]);
  });

  test("returns entries for every dir under agents/ that has agent.yaml", () => {
    seedAgentForTest("zip", { auggyDir });
    seedAgentForTest("concierge", { auggyDir });
    const list = listAgents({ auggyDir });
    expect(list.map((a) => a.name).sort()).toEqual(["concierge", "zip"]);
  });

  test("skips dirs without agent.yaml (incomplete scaffolds)", () => {
    seedAgentForTest("zip", { auggyDir });
    mkdirSync(join(auggyDir, "agents", "half-done"), { recursive: true });
    expect(listAgents({ auggyDir }).map((a) => a.name)).toEqual(["zip"]);
  });

  test("skips hidden dirs (.tmp-* staging)", () => {
    seedAgentForTest("zip", { auggyDir });
    mkdirSync(join(auggyDir, "agents", ".tmp-abc123"), { recursive: true });
    writeFileSync(
      join(auggyDir, "agents", ".tmp-abc123", "agent.yaml"),
      "id: aug1_partial\n",
    );
    expect(listAgents({ auggyDir }).map((a) => a.name)).toEqual(["zip"]);
  });
});

describe("removeAgent", () => {
  test("removes an existing agent dir", () => {
    seedAgentForTest("zip", { auggyDir });
    removeAgent("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })).toBeNull();
    expect(existsSync(join(auggyDir, "agents", "zip"))).toBe(false);
  });

  test("is idempotent for non-existent agents", () => {
    expect(() => removeAgent("ghost", { auggyDir })).not.toThrow();
  });

  test("refuses to remove a dir that lacks agent.yaml", () => {
    mkdirSync(join(auggyDir, "agents", "no-yaml"), { recursive: true });
    expect(() => removeAgent("no-yaml", { auggyDir })).toThrow(/agent\.yaml/);
    expect(existsSync(join(auggyDir, "agents", "no-yaml"))).toBe(true);
  });
});

describe("setCloud / clearCloud — file-existence semantics", () => {
  test("setCloud creates .auggy-cloud.json", () => {
    seedAgentForTest("zip", { auggyDir });
    setCloud("zip", CLOUD_FIXTURE, { auggyDir });
    const cloudFile = join(auggyDir, "agents", "zip", ".auggy-cloud.json");
    expect(existsSync(cloudFile)).toBe(true);
    expect(JSON.parse(readFileSync(cloudFile, "utf-8"))).toEqual(CLOUD_FIXTURE);
  });

  test("setCloud throws when the agent dir is missing", () => {
    expect(() => setCloud("ghost", CLOUD_FIXTURE, { auggyDir })).toThrow(
      /agent dir not found/i,
    );
  });

  test("setCloud overwrites a prior cloud record (redeploy case)", () => {
    seedAgentForTest("zip", { auggyDir });
    setCloud(
      "zip",
      { ...CLOUD_FIXTURE, url: "https://old.example" },
      { auggyDir },
    );
    setCloud(
      "zip",
      { ...CLOUD_FIXTURE, url: "https://new.example" },
      { auggyDir },
    );
    expect(getAgent("zip", { auggyDir })?.cloud?.url).toBe("https://new.example");
  });

  test("clearCloud deletes the file; subsequent reads return null", () => {
    seedAgentForTest("zip", { auggyDir, cloud: CLOUD_FIXTURE });
    clearCloud("zip", { auggyDir });
    expect(existsSync(join(auggyDir, "agents", "zip", ".auggy-cloud.json"))).toBe(false);
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
  });

  test("clearCloud is idempotent when no file exists", () => {
    seedAgentForTest("zip", { auggyDir });
    expect(() => clearCloud("zip", { auggyDir })).not.toThrow();
  });

  test("clearCloud is a no-op for missing agents", () => {
    expect(() => clearCloud("ghost", { auggyDir })).not.toThrow();
  });
});

describe("resolveAgentDir", () => {
  test("returns the canonical path without checking existence", () => {
    expect(resolveAgentDir("zip", { auggyDir })).toBe(join(auggyDir, "agents", "zip"));
  });
});

describe("sweepStaleTempDirs", () => {
  test("removes .tmp-* dirs older than maxAgeMs", () => {
    const root = join(auggyDir, "agents");
    mkdirSync(root, { recursive: true });
    const stale = join(root, ".tmp-old");
    mkdirSync(stale);
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    require("node:fs").utimesSync(stale, past, past);
    const fresh = join(root, ".tmp-new");
    mkdirSync(fresh);
    sweepStaleTempDirs({ auggyDir, maxAgeMs: 60 * 60 * 1000 });
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  test("does not touch normal agent dirs", () => {
    seedAgentForTest("zip", { auggyDir });
    sweepStaleTempDirs({ auggyDir, maxAgeMs: 0 });
    expect(getAgent("zip", { auggyDir })).not.toBeNull();
  });
});

describe("migrateLegacyIndex", () => {
  test("legacy agents.json: distributes only non-null cloud entries to .auggy-cloud.json", () => {
    const zipDir = join(auggyDir, "agents", "zip");
    const conciergeDir = join(auggyDir, "agents", "concierge");
    mkdirSync(zipDir, { recursive: true });
    mkdirSync(conciergeDir, { recursive: true });
    writeFileSync(join(zipDir, "agent.yaml"), "id: aug1_zip\n");
    writeFileSync(join(conciergeDir, "agent.yaml"), "id: aug1_concierge\n");

    const legacy = {
      version: 1,
      agents: {
        zip: {
          localDir: zipDir,
          createdAt: "2026-05-01T00:00:00.000Z",
          cloud: null,
        },
        concierge: {
          localDir: conciergeDir,
          createdAt: "2026-05-02T00:00:00.000Z",
          cloud: CLOUD_FIXTURE,
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(legacy));

    migrateLegacyIndex({ auggyDir });

    expect(existsSync(join(zipDir, ".auggy-cloud.json"))).toBe(false);
    expect(existsSync(join(conciergeDir, ".auggy-cloud.json"))).toBe(true);
    expect(getAgent("concierge", { auggyDir })?.cloud?.projectId).toBe("proj_abc");
  });

  test("legacy agents.json: renamed aside with a timestamp suffix", () => {
    seedAgentForTest("zip", { auggyDir });
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify({ version: 1, agents: {} }));
    migrateLegacyIndex({ auggyDir });
    expect(existsSync(join(auggyDir, "agents.json"))).toBe(false);
    const moved = readdirSync(auggyDir).find((f) => f.startsWith("agents.json.migrated-"));
    expect(moved).toBeDefined();
  });

  test("legacy agents.json: skips entries whose localDir no longer exists", () => {
    const legacy = {
      version: 1,
      agents: {
        gone: {
          localDir: "/nonexistent/path",
          createdAt: "2026-05-01T00:00:00.000Z",
          cloud: CLOUD_FIXTURE,
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(legacy));
    expect(() => migrateLegacyIndex({ auggyDir })).not.toThrow();
  });

  test("legacy .auggy-meta.json: converts to .auggy-cloud.json when cloud is set", () => {
    const zipDir = seedAgentForTest("zip", { auggyDir });
    writeFileSync(
      join(zipDir, ".auggy-meta.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-05-01T00:00:00.000Z",
        cloud: CLOUD_FIXTURE,
      }),
    );
    migrateLegacyIndex({ auggyDir });
    expect(existsSync(join(zipDir, ".auggy-meta.json"))).toBe(false);
    expect(existsSync(join(zipDir, ".auggy-cloud.json"))).toBe(true);
    expect(getAgent("zip", { auggyDir })?.cloud?.projectId).toBe("proj_abc");
  });

  test("legacy .auggy-meta.json: deletes the file even when cloud is null", () => {
    const zipDir = seedAgentForTest("zip", { auggyDir });
    writeFileSync(
      join(zipDir, ".auggy-meta.json"),
      JSON.stringify({
        version: 1,
        createdAt: "2026-05-01T00:00:00.000Z",
        cloud: null,
      }),
    );
    migrateLegacyIndex({ auggyDir });
    expect(existsSync(join(zipDir, ".auggy-meta.json"))).toBe(false);
    expect(existsSync(join(zipDir, ".auggy-cloud.json"))).toBe(false);
  });

  test("getAgent triggers migration lazily when legacy state is present", () => {
    const zipDir = join(auggyDir, "agents", "zip");
    mkdirSync(zipDir, { recursive: true });
    writeFileSync(join(zipDir, "agent.yaml"), "id: aug1_zip\n");
    writeFileSync(
      join(auggyDir, "agents.json"),
      JSON.stringify({
        version: 1,
        agents: {
          zip: {
            localDir: zipDir,
            createdAt: "2026-05-01T00:00:00.000Z",
            cloud: CLOUD_FIXTURE,
          },
        },
      }),
    );
    expect(existsSync(join(zipDir, ".auggy-cloud.json"))).toBe(false);
    getAgent("zip", { auggyDir });
    expect(existsSync(join(zipDir, ".auggy-cloud.json"))).toBe(true);
  });
});
