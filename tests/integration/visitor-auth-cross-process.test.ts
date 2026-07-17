/**
 * F19 — cross-process SQLite invariant for visitorAuth.
 *
 * The deployment posture for visitor-auth.db is:
 *   - The agent process (long-lived) opens the db read/write.
 *   - The operator runs `auggy visitors --revoke <email>` in a separate
 *     process while the agent is running. That separate process opens
 *     the same db file and writes to it.
 *
 * Invariant: when the operator's process commits a revoke, the agent's
 * process must observe that revoke on its next isVisitorRevoked() call —
 * with no app-level coordination, no broadcast, no restart.
 *
 * Two facets, tested separately:
 *
 *  (a) WAL is configured. The store opens the db with `journal_mode = wal`
 *      so concurrent reader-writer access doesn't block. Without WAL, a
 *      long-running reader transaction in the agent would block the
 *      operator's writer (or vice versa) — operations work but degrade.
 *      Tested by reading `PRAGMA journal_mode` against the same file.
 *
 *  (b) bun:sqlite re-reads on each prepared-statement execution. A
 *      regression where the store caches row results in memory (or a
 *      future bug where prepared statements bind to a snapshot) would
 *      cause the long-lived agent to miss the revoke. Tested by spawning
 *      a Bun child process that revokes against the shared db, then
 *      re-reading from the long-lived store handle and asserting the
 *      revoked flag is now true.
 *
 * (b) does not on its own require WAL — bun:sqlite would re-read in
 * rollback-journal mode too. (a) is the WAL guarantee specifically.
 * Treat the two assertions as complementary, not redundant.
 *
 * The CLI wrapper (`auggy visitors --revoke`) is NOT on the test path —
 * the cross-process invariant lives one layer down at the store/SQLite
 * level, and the CLI's extra work (memory.db cascade) has its own
 * dedicated coverage in tests/cli/commands/visitors.test.ts.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createSqliteVisitorAuthStore } from "../../src/augments/visitorAuth/storage/sqlite-store";

describe("visitor-auth cross-process SQLite (F19)", () => {
  it("the store enables WAL mode (PRAGMA journal_mode = 'wal')", () => {
    const tmp = mkdtempSync(join(tmpdir(), "va-wal-pragma-"));
    const dbPath = join(tmp, "visitor-auth.db");
    let store: ReturnType<typeof createSqliteVisitorAuthStore> | undefined;
    let probe: Database | undefined;
    try {
      store = createSqliteVisitorAuthStore({ dbPath });
      store.initialize();
      // Read the journal-mode setting from a separate writable handle on the
      // same file. A WAL reader may need write access to the shared-memory
      // index, so OPEN_READONLY is not a valid concurrency probe here.
      probe = new Database(dbPath);
      const row = probe.prepare("PRAGMA journal_mode").get() as { journal_mode?: string } | null;
      probe.close();
      probe = undefined;
      store.close();
      store = undefined;
      // bun:sqlite returns the pragma value lower-cased; SQLite reports it
      // in lower-case too.
      expect(row?.journal_mode?.toLowerCase()).toBe("wal");
    } finally {
      probe?.close();
      store?.close();
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("running augment instance observes a revoke committed by a separate process", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "va-cross-process-"));
    const dbPath = join(tmp, "visitor-auth.db");
    try {
      // ---- 1. Long-lived store in THIS process. Mimics the running agent. ----
      const longLived = createSqliteVisitorAuthStore({ dbPath });
      longLived.initialize();

      // Seed a verified visitor.
      const VISITOR_ID = `vis_xprocess_${Date.now()}`;
      const EMAIL = "alice@example.com";
      const t0 = Date.now();
      longLived.recordVerifiedVisitor({
        visitorId: VISITOR_ID,
        email: EMAIL,
        verifiedAt: t0,
        lastSeenAt: t0,
        reverifyDueAt: t0 + 90 * 86_400_000,
        revoked: false,
        revokedAt: null,
        revokedReason: null,
      });

      // Sanity: the long-lived handle sees the row as not-revoked.
      const before = longLived.findVerifiedByEmail(EMAIL);
      expect(before?.revoked).toBe(false);

      // ---- 2. Spawn child process that revokes via the same db. ----
      // Inline script: opens the store, calls revokeByEmail, exits.
      const scriptPath = join(tmp, "revoke-script.ts");
      const repoRoot = join(import.meta.dir, "..", "..");
      const storeImport = join(repoRoot, "src/augments/visitorAuth/storage/sqlite-store.ts");
      writeFileSync(
        scriptPath,
        `
import { createSqliteVisitorAuthStore } from ${JSON.stringify(storeImport)};
const store = createSqliteVisitorAuthStore({ dbPath: ${JSON.stringify(dbPath)} });
store.initialize();
const visitorId = store.revokeByEmail(${JSON.stringify(EMAIL)}, "operator", Date.now());
store.close();
if (!visitorId) {
  console.error("revokeByEmail returned null");
  process.exit(2);
}
console.log(visitorId);
`,
      );
      const proc = Bun.spawn(["bun", "run", scriptPath], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const exitCode = await proc.exited;
      const stdout = await new Response(proc.stdout).text();
      const stderr = await new Response(proc.stderr).text();
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toBe(VISITOR_ID);
      expect(stderr).toBe("");

      // ---- 3. Long-lived handle re-reads. Must observe the revoke. ----
      // The prepared statements re-execute and see the latest committed
      // state from the child.
      const after = longLived.findVerifiedByEmail(EMAIL);
      expect(after).not.toBeNull();
      expect(after?.revoked).toBe(true);
      expect(after?.visitorId).toBe(VISITOR_ID);

      longLived.close();
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});
