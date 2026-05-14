import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageBundle } from "../../../src/cli/deploy/bundle";

describe("stageBundle", () => {
  let agentDir: string;
  let cleanup: string[] = [];

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "auggy-bundle-test-"));
    cleanup.push(agentDir);
  });

  afterEach(() => {
    for (const d of cleanup) {
      try {
        rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort
      }
    }
    cleanup = [];
  });

  function seedAgentDir() {
    writeFileSync(join(agentDir, "agent.yaml"), "name: zip\n");
    writeFileSync(join(agentDir, "identity.md"), "# Identity\n");
    // v0.3.2 per-agent manifest + lockfile — MUST land in the staged bundle
    // so the Dockerfile's `COPY package.json` + `bun install` layer works.
    writeFileSync(
      join(agentDir, "package.json"),
      `{"name":"auggy-agent-zip","private":true,"type":"module","dependencies":{"auggy":"^0.3.1","@auggy/anthropic":"^0.3.1"}}\n`,
    );
    writeFileSync(join(agentDir, "bun.lock"), `# bun lockfile placeholder\n`);
    writeFileSync(join(agentDir, ".env"), "ANTHROPIC_API_KEY=secret\n");
    writeFileSync(join(agentDir, ".env.example"), "ANTHROPIC_API_KEY=\n");
    writeFileSync(join(agentDir, "memory.db"), "binary");
    writeFileSync(join(agentDir, "memory.db-wal"), "wal");
    writeFileSync(join(agentDir, "memory.db-shm"), "shm");
    writeFileSync(join(agentDir, "budgets.db"), "binary");
    writeFileSync(join(agentDir, "visitor-auth.db"), "binary");
    writeFileSync(join(agentDir, "link.db"), "binary");
    mkdirSync(join(agentDir, "workspace"));
    writeFileSync(join(agentDir, "workspace", "scratch.txt"), "ephemeral");
    mkdirSync(join(agentDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(agentDir, "node_modules", "x", "index.js"), "x");
    mkdirSync(join(agentDir, ".git"));
    writeFileSync(join(agentDir, ".git", "HEAD"), "ref");
    mkdirSync(join(agentDir, ".worktrees", "feat-x"), { recursive: true });
    writeFileSync(join(agentDir, ".worktrees", "feat-x", "marker"), "ignore");
    mkdirSync(join(agentDir, ".claude"));
    writeFileSync(join(agentDir, ".claude", "settings.json"), "{}");
    mkdirSync(join(agentDir, "skills", "facility"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "facility", "SKILL.md"), "# skill");
    writeFileSync(join(agentDir, ".DS_Store"), "junk");
  }

  test("copies non-excluded files into the staging dir", () => {
    seedAgentDir();
    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, "agent.yaml"))).toBe(true);
    expect(existsSync(join(staged, "identity.md"))).toBe(true);
    expect(existsSync(join(staged, "skills", "facility", "SKILL.md"))).toBe(true);
    expect(existsSync(join(staged, ".env.example"))).toBe(true);
  });

  test("includes package.json + bun.lock (Phase 7: Dockerfile COPY+install relies on these)", () => {
    // Regression guard for the Phase 7 Dockerfile rewrite: if these files
    // ever fall out of the staged bundle, the cloud image's `bun install`
    // step would fail at build time and the agent never boots.
    seedAgentDir();
    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, "package.json"))).toBe(true);
    expect(existsSync(join(staged, "bun.lock"))).toBe(true);
  });

  test("excludes .env, *.db*, workspace/, node_modules/, .git/, .DS_Store, .worktrees/, .claude/", () => {
    seedAgentDir();
    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, ".env"))).toBe(false);
    expect(existsSync(join(staged, "memory.db"))).toBe(false);
    expect(existsSync(join(staged, "memory.db-wal"))).toBe(false);
    expect(existsSync(join(staged, "memory.db-shm"))).toBe(false);
    expect(existsSync(join(staged, "budgets.db"))).toBe(false);
    expect(existsSync(join(staged, "visitor-auth.db"))).toBe(false);
    expect(existsSync(join(staged, "link.db"))).toBe(false);
    expect(existsSync(join(staged, "workspace"))).toBe(false);
    expect(existsSync(join(staged, "node_modules"))).toBe(false);
    expect(existsSync(join(staged, ".git"))).toBe(false);
    expect(existsSync(join(staged, ".worktrees"))).toBe(false);
    expect(existsSync(join(staged, ".claude"))).toBe(false);
    expect(existsSync(join(staged, ".DS_Store"))).toBe(false);
  });

  test("returns an absolute path to a fresh staging dir each call", () => {
    seedAgentDir();
    const a = stageBundle({ agentDir, agentName: "zip" });
    const b = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(a, b);
    expect(a).not.toBe(b);
    expect(a.startsWith("/")).toBe(true);
  });

  test("throws when the agent dir does not exist", () => {
    expect(() => stageBundle({ agentDir: "/no/such/path", agentName: "zip" })).toThrow();
  });
});
