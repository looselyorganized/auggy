import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runVisitorsList, type VisitorsCommandOptions } from "../../../src/cli/commands/visitors";
import { createSqliteVisitorAuthStore } from "../../../src/augments/visitor-auth/storage/sqlite-store";

let tmp: string;
let agentDir: string;
let auggyDir: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitors-cmd-"));
  agentDir = join(tmp, "agents", "zip");
  auggyDir = join(tmp, "auggy");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(auggyDir, { recursive: true });
  writeFileSync(
    join(auggyDir, "agents.json"),
    JSON.stringify({
      version: 1,
      agents: {
        zip: { localDir: agentDir, createdAt: new Date().toISOString(), cloud: null },
      },
    }),
  );
  writeFileSync(
    join(agentDir, "agent.yaml"),
    `augments:
  - type: visitorAuth
    name: visitor-auth
    options:
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

function seed(rows: Array<{ visitorId: string; email: string; verifiedAt: number; revoked?: boolean }>): void {
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
