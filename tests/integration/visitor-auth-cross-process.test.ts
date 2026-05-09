/**
 * F19 — cross-process SQLite invariant for visitorAuth.
 *
 * The deployment posture for visitor-auth.db is:
 *   - The agent process (long-lived) opens the db read/write via WAL mode.
 *   - The operator runs `auggy visitors --revoke <email>` in a separate
 *     process while the agent is running. That separate process opens the
 *     same db file and writes to it.
 *
 * Invariant: when the operator's process commits a revoke, the agent's
 * process must observe that revoke on its next isVisitorRevoked() call —
 * with no app-level coordination, no broadcast, no restart.
 *
 * This is purely a SQLite/WAL property: WAL readers see committed writes
 * from other processes after their own statement-cache is invalidated
 * (which `bun:sqlite` handles). Without WAL mode, a long-lived reader
 * could hold an MVCC snapshot and miss the revoke. With WAL mode, every
 * new prepared-statement execution sees the latest committed state.
 *
 * The test exercises the invariant by:
 *   1. Spawning a Bun child process that opens the shared db, calls
 *      revokeByEmail(), then exits. (Mimics what `auggy visitors --revoke`
 *      does under the hood — the CLI wrapper isn't on the test path here
 *      because the cross-process invariant lives one layer down at the
 *      store/SQLite level.)
 *   2. Verifying that a long-lived store handle in the test process,
 *      opened BEFORE the child wrote, returns the post-revoke state on
 *      its next read.
 */

import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSqliteVisitorAuthStore } from "../../src/augments/visitor-auth/storage/sqlite-store";

describe("visitor-auth cross-process SQLite (F19)", () => {
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
      // Convert win32 paths to forward-slash for embedding into the script
      // (this test runs on macOS but be explicit).
      const storeImport = join(repoRoot, "src/augments/visitor-auth/storage/sqlite-store.ts");
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
      // state from the child. If WAL mode were not enabled (or if the
      // store cached the row in-memory), this would still return revoked=false.
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
