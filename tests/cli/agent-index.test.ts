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
  writeAgentMeta,
} from "../../src/cli/agent-index";

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

  test("returns entry with synthesized createdAt when meta is missing", () => {
    const dir = join(auggyDir, "agents", "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_zip\n");
    const entry = getAgent("zip", { auggyDir });
    expect(entry).not.toBeNull();
    expect(entry!.localDir).toBe(dir);
    expect(entry!.cloud).toBeNull();
    expect(entry!.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("reads createdAt and cloud from .auggy-meta.json when present", () => {
    seedAgentForTest("zip", {
      auggyDir,
      createdAt: "2026-05-15T00:00:00.000Z",
      cloud: {
        provider: "railway",
        projectId: "p",
        serviceId: "s",
        url: "https://x",
        volumeId: "v",
        deployedAt: "2026-05-15T00:00:00.000Z",
      },
    });
    const entry = getAgent("zip", { auggyDir });
    expect(entry?.createdAt).toBe("2026-05-15T00:00:00.000Z");
    expect(entry?.cloud?.projectId).toBe("p");
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

describe("setCloud / clearCloud", () => {
  test("setCloud writes cloud record into .auggy-meta.json", () => {
    seedAgentForTest("zip", { auggyDir });
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
    const meta = JSON.parse(
      readFileSync(join(auggyDir, "agents", "zip", ".auggy-meta.json"), "utf-8"),
    );
    expect(meta.cloud.projectId).toBe("proj_abc");
    expect(getAgent("zip", { auggyDir })?.cloud?.projectId).toBe("proj_abc");
  });

  test("setCloud throws when the agent dir is missing", () => {
    expect(() =>
      setCloud(
        "ghost",
        {
          provider: "railway",
          projectId: "p",
          serviceId: "s",
          url: "u",
          volumeId: "v",
          deployedAt: "2026-05-12T00:00:00.000Z",
        },
        { auggyDir },
      ),
    ).toThrow(/agent dir not found/i);
  });

  test("setCloud overwrites prior cloud record (redeploy case)", () => {
    seedAgentForTest("zip", { auggyDir });
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "p1",
        serviceId: "s1",
        url: "u1",
        volumeId: "v1",
        deployedAt: "2026-05-01T00:00:00.000Z",
      },
      { auggyDir },
    );
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "p1",
        serviceId: "s1",
        url: "u2",
        volumeId: "v1",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );
    expect(getAgent("zip", { auggyDir })?.cloud?.url).toBe("u2");
  });

  test("clearCloud nulls the cloud record; idempotent on already-null", () => {
    seedAgentForTest("zip", { auggyDir });
    setCloud(
      "zip",
      {
        provider: "railway",
        projectId: "p",
        serviceId: "s",
        url: "u",
        volumeId: "v",
        deployedAt: "2026-05-12T00:00:00.000Z",
      },
      { auggyDir },
    );
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
    clearCloud("zip", { auggyDir });
    expect(getAgent("zip", { auggyDir })?.cloud).toBeNull();
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

describe("writeAgentMeta", () => {
  test("writes a meta file readable by getAgent", () => {
    const dir = join(auggyDir, "agents", "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_zip\n");
    writeAgentMeta(dir, { createdAt: "2026-05-15T00:00:00.000Z" });
    expect(getAgent("zip", { auggyDir })?.createdAt).toBe("2026-05-15T00:00:00.000Z");
  });

  test("throws when dir does not exist", () => {
    expect(() => writeAgentMeta(join(auggyDir, "nope"))).toThrow();
  });
});

describe("sweepStaleTempDirs", () => {
  test("removes .tmp-* dirs older than maxAgeMs", () => {
    const root = join(auggyDir, "agents");
    mkdirSync(root, { recursive: true });
    const stale = join(root, ".tmp-old");
    mkdirSync(stale);
    // Manually set mtime in the past via utimesSync.
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
  test("distributes legacy agents.json entries into per-agent .auggy-meta.json", () => {
    // Set up a legacy index with two agents whose dirs live under auggyDir/agents/.
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
          cloud: {
            provider: "railway",
            projectId: "p",
            serviceId: "s",
            url: "u",
            volumeId: "v",
            deployedAt: "2026-05-02T00:00:00.000Z",
          },
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(legacy));

    migrateLegacyIndex({ auggyDir });

    expect(existsSync(join(zipDir, ".auggy-meta.json"))).toBe(true);
    expect(existsSync(join(conciergeDir, ".auggy-meta.json"))).toBe(true);

    const zipEntry = getAgent("zip", { auggyDir });
    expect(zipEntry?.createdAt).toBe("2026-05-01T00:00:00.000Z");
    const conciergeEntry = getAgent("concierge", { auggyDir });
    expect(conciergeEntry?.cloud?.projectId).toBe("p");
  });

  test("renames agents.json aside with a timestamp suffix", () => {
    seedAgentForTest("zip", { auggyDir });
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify({ version: 1, agents: {} }));
    migrateLegacyIndex({ auggyDir });
    expect(existsSync(join(auggyDir, "agents.json"))).toBe(false);
    const moved = readdirSync(auggyDir).find((f) => f.startsWith("agents.json.migrated-"));
    expect(moved).toBeDefined();
  });

  test("skips entries whose localDir no longer exists", () => {
    const legacy = {
      version: 1,
      agents: {
        gone: {
          localDir: "/nonexistent/path",
          createdAt: "2026-05-01T00:00:00.000Z",
          cloud: null,
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(legacy));
    expect(() => migrateLegacyIndex({ auggyDir })).not.toThrow();
  });

  test("does not overwrite an existing .auggy-meta.json", () => {
    seedAgentForTest("zip", {
      auggyDir,
      createdAt: "2026-05-15T00:00:00.000Z",
    });
    const legacy = {
      version: 1,
      agents: {
        zip: {
          localDir: join(auggyDir, "agents", "zip"),
          createdAt: "2026-01-01T00:00:00.000Z",
          cloud: null,
        },
      },
    };
    writeFileSync(join(auggyDir, "agents.json"), JSON.stringify(legacy));
    migrateLegacyIndex({ auggyDir });
    expect(getAgent("zip", { auggyDir })?.createdAt).toBe("2026-05-15T00:00:00.000Z");
  });

  test("getAgent triggers migration lazily when agents.json is present", () => {
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
            cloud: null,
          },
        },
      }),
    );
    expect(existsSync(join(zipDir, ".auggy-meta.json"))).toBe(false);
    getAgent("zip", { auggyDir });
    expect(existsSync(join(zipDir, ".auggy-meta.json"))).toBe(true);
  });
});
