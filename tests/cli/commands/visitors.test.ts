import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVisitorsList, type VisitorsCommandOptions } from "../../../src/cli/commands/visitors";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitorAuth/storage/sqlite-store";
import { createSqliteStore } from "../../../src/augments/layeredMemory/storage/sqlite-store";
import { seedAgentForTest } from "../../../src/cli/agent-index";

let tmp: string;
let agentDir: string;
let auggyDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitors-cmd-"));
  auggyDir = join(tmp, "auggy");
  agentDir = seedAgentForTest("zip", {
    auggyDir,
    yaml: `augments:
  - visitorAuth
`,
  });
  mkdirSync(join(agentDir, "augments", "visitorAuth"), { recursive: true });
  writeFileSync(
    join(agentDir, "augments", "visitorAuth", "augment.yaml"),
    `type: visitorAuth
config:
  publicUrl: https://zip.test
  dbPath: ./visitor-auth.db
  agentMail:
    apiKey: am_x
    inboxId: ibx_x
  signingKey: sig
  layeredMemoryDbPath: ./memory.db
`,
  );
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function seed(
  rows: Array<{ visitorId: string; email: string; verifiedAt: number; revoked?: boolean }>,
): void {
  const store = createSqliteVisitorAuthStore({ dbPath: join(agentDir, "visitor-auth.db") });
  store.initialize();
  for (const r of rows) {
    store.recordVerifiedVisitor({
      visitorId: r.visitorId,
      email: r.email,
      verifiedAt: r.verifiedAt,
      lastSeenAt: null,
      reverifyDueAt: r.verifiedAt + 90 * 86_400_000,
      revoked: false,
      revokedAt: null,
      revokedReason: null,
    });
    if (r.revoked) {
      store.revokeByEmail(r.email, "operator", r.verifiedAt + 1000);
    }
  }
  store.close();
}

describe("auggy visitors <agent> (list)", () => {
  test("prints a header + row per visitor", async () => {
    seed([
      { visitorId: "vis_aaaaaaaa", email: "alice@x", verifiedAt: 1_700_000_000_000 },
      { visitorId: "vis_bbbbbbbb", email: "bob@x", verifiedAt: 1_700_000_001_000 },
    ]);
    const lines: string[] = [];
    await runVisitorsList("zip", {
      auggyDir,
      log: (l) => lines.push(l),
    } as VisitorsCommandOptions);
    const joined = lines.join("\n");
    expect(joined).toContain("EMAIL");
    expect(joined).toContain("alice@x");
    expect(joined).toContain("bob@x");
  });

  test("prints '(none)' when no visitors are verified", async () => {
    const lines: string[] = [];
    await runVisitorsList("zip", { auggyDir, log: (l) => lines.push(l) } as VisitorsCommandOptions);
    expect(lines.join("\n").toLowerCase()).toContain("none");
  });

  test("marks revoked rows as 'revoked'", async () => {
    seed([{ visitorId: "vis_x", email: "ex@x", verifiedAt: 1_000, revoked: true }]);
    const lines: string[] = [];
    await runVisitorsList("zip", { auggyDir, log: (l) => lines.push(l) } as VisitorsCommandOptions);
    expect(lines.join("\n")).toContain("revoked");
  });

  test("errors clearly when the agent is unknown", async () => {
    await expect(
      runVisitorsList("nonexistent-agent", {
        auggyDir,
        log: () => {},
      } as VisitorsCommandOptions),
    ).rejects.toThrow();
  });
});

import { runVisitorsRevoke } from "../../../src/cli/commands/visitors-revoke";
import { Database } from "bun:sqlite";

async function seedMemoryDb(memDbPath: string, peerId: string, n: number): Promise<void> {
  const store = createSqliteStore({ dbPath: memDbPath, retentionDays: 90 });
  for (let i = 0; i < n; i++) {
    await store.write({
      label: `ep:${peerId}:${i}`,
      content: `c${i}`,
      peerId,
      trustLevel: "public",
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
  }
  await store.close();
}

describe("auggy visitors <agent> --revoke <email>", () => {
  test("hard-revokes the row + cascades memory_forget", async () => {
    seed([{ visitorId: "vis_rev1", email: "revoke@x", verifiedAt: 1000 }]);
    await seedMemoryDb(join(agentDir, "memory.db"), "vis_rev1", 4);
    const lines: string[] = [];
    await runVisitorsRevoke("zip", "revoke@x", {
      auggyDir,
      confirm: false,
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/revoked/i);
    expect(out).toMatch(/4/);

    // Verify memory.db rows are gone:
    const db = new Database(join(agentDir, "memory.db"));
    const c = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE peer_id = ?`).get("vis_rev1") as
      | { c: number }
      | undefined;
    db.close();
    expect(c?.c).toBe(0);
  });

  test("errors with clear message when email is not a verified visitor", async () => {
    const lines: string[] = [];
    await expect(
      runVisitorsRevoke("zip", "unknown@x", {
        auggyDir,
        confirm: false,
        log: (l) => lines.push(l),
      }),
    ).rejects.toThrow(/not.*found|unknown/i);
  });

  test("skips memory cascade with a warning when memory.db is missing", async () => {
    seed([{ visitorId: "vis_no_mem", email: "nomem@x", verifiedAt: 1000 }]);
    const lines: string[] = [];
    await runVisitorsRevoke("zip", "nomem@x", {
      auggyDir,
      confirm: false,
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/revoked/i);
    expect(out).toMatch(/skipping|not found/i);
  });

  test("with confirm:true and decline, makes no changes", async () => {
    seed([{ visitorId: "vis_safe", email: "safe@x", verifiedAt: 1000 }]);
    await seedMemoryDb(join(agentDir, "memory.db"), "vis_safe", 2);
    const lines: string[] = [];
    await runVisitorsRevoke("zip", "safe@x", {
      auggyDir,
      confirm: true,
      _confirmAnswer: () => false, // user said "no"
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/cancel/i);
    // Verify nothing got revoked:
    const store = createSqliteVisitorAuthStore({ dbPath: join(agentDir, "visitor-auth.db") });
    store.initialize();
    expect(store.findVerifiedByEmail("safe@x")?.revoked).toBe(false);
    store.close();
  });

  test("re-running revoke on an already-revoked email cleans up orphan memory rows", async () => {
    // Simulate an interrupted revoke: visitor-auth row is already revoked, but
    // memory.db still has rows under that visitorId (operator hit Ctrl-C
    // between the two operations, or the cascade threw mid-DELETE).
    seed([{ visitorId: "vis_orph", email: "orphan@x", verifiedAt: 1000, revoked: true }]);
    await seedMemoryDb(join(agentDir, "memory.db"), "vis_orph", 3);
    const lines: string[] = [];
    await runVisitorsRevoke("zip", "orphan@x", {
      auggyDir,
      confirm: false,
      log: (l) => lines.push(l),
    });
    const out = lines.join("\n");
    expect(out).toMatch(/already revoked/i);
    expect(out).toMatch(/3/); // 3 stale rows cleaned up
    const db = new Database(join(agentDir, "memory.db"));
    const c = db.prepare(`SELECT COUNT(*) AS c FROM entries WHERE peer_id = ?`).get("vis_orph") as
      | { c: number }
      | undefined;
    db.close();
    expect(c?.c).toBe(0);
  });
});
