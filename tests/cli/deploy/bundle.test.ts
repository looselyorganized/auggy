import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
    writeFileSync(join(agentDir, "mail.sqlite"), "DO_NOT_STAGE_SQLITE");
    writeFileSync(join(agentDir, "mail.sqlite-wal"), "DO_NOT_STAGE_SQLITE_WAL");
    writeFileSync(join(agentDir, "mail.sqlite-shm"), "DO_NOT_STAGE_SQLITE_SHM");
    writeFileSync(join(agentDir, "mail.sqlite-journal"), "DO_NOT_STAGE_SQLITE_JOURNAL");
    writeFileSync(join(agentDir, "legacy.db-journal"), "DO_NOT_STAGE_DB_JOURNAL");
    mkdirSync(join(agentDir, "workspace"));
    writeFileSync(join(agentDir, "workspace", "scratch.txt"), "ephemeral");
    mkdirSync(join(agentDir, "data", "workspace"), { recursive: true });
    writeFileSync(join(agentDir, "data", "workspace", "scratch.txt"), "ephemeral");
    writeFileSync(join(agentDir, "data", "memory.sqlite"), "binary");
    mkdirSync(join(agentDir, "node_modules", "x"), { recursive: true });
    writeFileSync(join(agentDir, "node_modules", "x", "index.js"), "x");
    mkdirSync(join(agentDir, ".git"));
    writeFileSync(join(agentDir, ".git", "HEAD"), "ref");
    mkdirSync(join(agentDir, ".worktrees", "feat-x"), { recursive: true });
    writeFileSync(join(agentDir, ".worktrees", "feat-x", "marker"), "ignore");
    mkdirSync(join(agentDir, ".claude"));
    writeFileSync(join(agentDir, ".claude", "settings.json"), "{}");
    mkdirSync(join(agentDir, ".auggy"));
    writeFileSync(join(agentDir, ".auggy", "models.lock.json"), "{}");
    mkdirSync(join(agentDir, "skills", "facility"), { recursive: true });
    writeFileSync(join(agentDir, "skills", "facility", "SKILL.md"), "# skill");
    writeFileSync(join(agentDir, ".DS_Store"), "junk");
  }

  function stagedText(root: string): string {
    const contents: string[] = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      const path = join(root, entry.name);
      if (entry.isDirectory()) {
        contents.push(stagedText(path));
      } else if (entry.isFile()) {
        const fd = openSync(path, "r");
        try {
          expect(fstatSync(fd).isFile()).toBe(true);
          contents.push(readFileSync(fd, "utf8"));
        } finally {
          closeSync(fd);
        }
      }
    }
    return contents.join("\n");
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

  test("excludes .env, *.db*, workspace/, data/, node_modules/, .git/, .DS_Store, .worktrees/, .claude/, .auggy/", () => {
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
    expect(existsSync(join(staged, "mail.sqlite"))).toBe(false);
    expect(existsSync(join(staged, "mail.sqlite-wal"))).toBe(false);
    expect(existsSync(join(staged, "mail.sqlite-shm"))).toBe(false);
    expect(existsSync(join(staged, "mail.sqlite-journal"))).toBe(false);
    expect(existsSync(join(staged, "legacy.db-journal"))).toBe(false);
    expect(existsSync(join(staged, "workspace"))).toBe(false);
    expect(existsSync(join(staged, "data"))).toBe(false);
    expect(existsSync(join(staged, "node_modules"))).toBe(false);
    expect(existsSync(join(staged, ".git"))).toBe(false);
    expect(existsSync(join(staged, ".worktrees"))).toBe(false);
    expect(existsSync(join(staged, ".claude"))).toBe(false);
    expect(existsSync(join(staged, ".auggy"))).toBe(false);
    expect(existsSync(join(staged, ".DS_Store"))).toBe(false);
  });

  test("excludes exact config-derived database paths regardless of extension", () => {
    seedAgentDir();
    const runtime = join(agentDir, "nested", "runtime");
    mkdirSync(runtime, { recursive: true });
    for (const name of ["mail-ledger.bin", "mail-ledger.bin-wal", "mail-ledger.bin-shm"]) {
      writeFileSync(join(runtime, name), `DO_NOT_STAGE_CONFIGURED_${name}`);
    }

    const excludedPaths = [
      "nested/runtime/mail-ledger.bin",
      "nested/runtime/mail-ledger.bin-wal",
      "nested/runtime/mail-ledger.bin-shm",
    ];
    const staged = stageBundle({ agentDir, agentName: "zip", excludedPaths });
    cleanup.push(staged);
    expect(existsSync(join(staged, "nested", "runtime", "mail-ledger.bin"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "mail-ledger.bin-wal"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "mail-ledger.bin-shm"))).toBe(false);
    expect(stagedText(staged)).not.toContain("DO_NOT_STAGE_CONFIGURED");
  });

  test("never stages AgentMail state, shared overrides, durable temp files, or symlink targets", () => {
    seedAgentDir();
    writeFileSync(join(agentDir, "agent-mail-reviews.json"), "DO_NOT_STAGE_ROOT_STATE");
    writeFileSync(join(agentDir, ".env.local"), "TOKEN=DO_NOT_STAGE_ENV");
    const nested = join(agentDir, "nested", "runtime");
    mkdirSync(nested, { recursive: true });
    writeFileSync(
      join(nested, "agent-mail-reviews.json"),
      "body=DO_NOT_STAGE_BODY recipient=private@example.com fingerprint=secret-fingerprint",
    );
    writeFileSync(join(nested, "agent-mail-state.json"), "recipient=private@example.com");
    writeFileSync(join(nested, "admin-overrides.json"), "override=DO_NOT_STAGE_OVERRIDE");
    writeFileSync(join(nested, "agent-mail-reviews.json.bak"), "DO_NOT_STAGE_REVIEW_BACKUP");
    writeFileSync(join(nested, "agent-mail-state.json.backup"), "DO_NOT_STAGE_STATE_BACKUP");
    writeFileSync(join(nested, "admin-overrides.json.old"), "DO_NOT_STAGE_OVERRIDE_BACKUP");
    writeFileSync(join(nested, "agent-mail-state.json.tmp.1.uuid"), "DO_NOT_STAGE_OLD_TEMP");
    writeFileSync(join(nested, ".uuid.tmp.1"), "DO_NOT_STAGE_DURABLE_TEMP");
    const externalDir = mkdtempSync(join(tmpdir(), "auggy-bundle-secret-"));
    cleanup.push(externalDir);
    const externalSecret = join(externalDir, "private-mail-body.txt");
    writeFileSync(externalSecret, "DO_NOT_STAGE_SYMLINK_TARGET");
    symlinkSync(externalSecret, join(nested, "innocent-looking.md"));
    const externalSecretDir = join(externalDir, "private-mail-dir");
    mkdirSync(externalSecretDir);
    writeFileSync(join(externalSecretDir, "message.txt"), "DO_NOT_STAGE_DIRECTORY_TARGET");
    symlinkSync(externalSecretDir, join(nested, "innocent-looking-dir"));

    const staged = stageBundle({ agentDir, agentName: "zip" });
    cleanup.push(staged);
    expect(existsSync(join(staged, "agent-mail-reviews.json"))).toBe(false);
    expect(existsSync(join(staged, ".env.local"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "agent-mail-reviews.json"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "agent-mail-state.json"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "admin-overrides.json"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "agent-mail-reviews.json.bak"))).toBe(
      false,
    );
    expect(existsSync(join(staged, "nested", "runtime", "agent-mail-state.json.backup"))).toBe(
      false,
    );
    expect(existsSync(join(staged, "nested", "runtime", "admin-overrides.json.old"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "agent-mail-state.json.tmp.1.uuid"))).toBe(
      false,
    );
    expect(existsSync(join(staged, "nested", "runtime", ".uuid.tmp.1"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "innocent-looking.md"))).toBe(false);
    expect(existsSync(join(staged, "nested", "runtime", "innocent-looking-dir"))).toBe(false);
    expect(stagedText(staged)).not.toContain("DO_NOT_STAGE");
  });

  test("rejects a symlinked agent directory", () => {
    seedAgentDir();
    const linkedRoot = join(tmpdir(), `auggy-bundle-link-${crypto.randomUUID()}`);
    cleanup.push(linkedRoot);
    symlinkSync(agentDir, linkedRoot);
    expect(() => stageBundle({ agentDir: linkedRoot, agentName: "zip" })).toThrow(
      /must be a real directory/,
    );
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
