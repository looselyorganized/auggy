import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { constants, Database } from "bun:sqlite";
import {
  chmodSync,
  closeSync,
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { prepareRuntimeDataVolume } from "../../src/cli/runtime-volume";
import { pinDirectory } from "../../src/lib/anchored-files";
import type {
  AdmittedRuntimeVolumeLease,
  RuntimeDataAdmission,
} from "../../src/runtime-data-contracts";
import {
  EXTERNAL_AUTH_REPLAY_APPLICATION_ID,
  EXTERNAL_AUTH_REPLAY_GUARD_FILE as GUARD,
  EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS as MAX_TIME,
  type ManagedExternalAuthReplay,
  type ManagedExternalAuthReplayOptions,
  type ManagedReplayVerifiedInput,
} from "../../src/auth/external-auth-replay-contracts";
import {
  createExternalAuthAssertion,
  verifyExternalAuthAssertion,
} from "../../src/auth/external-auth";
import {
  ensureRestoredExternalAuthReplayGuard,
  type ExternalAuthReplayTestHooks,
} from "../../src/auth/external-auth-replay-guard";
import {
  createManagedExternalAuthReplay,
  validateManagedReplayVerifiedInput,
} from "../../src/auth/external-auth-replay-store";

const agentId = "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211";
const fixedNow = () => 2_000_000;
const roots: string[] = [];
const stores: ManagedExternalAuthReplay[] = [];
const leases: AdmittedRuntimeVolumeLease[] = [];
function setup(): {
  root: string;
  lease: AdmittedRuntimeVolumeLease;
  options: ManagedExternalAuthReplayOptions;
} {
  const root = mkdtempSync(join(tmpdir(), "auggy-replay-store-"));
  roots.push(root);
  chmodSync(root, 0o700);
  const lease = prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId);
  leases.push(lease);
  const dbPath = join(root, "replay.db");
  return {
    root,
    lease,
    options: {
      admission: lease.runtimeDataAdmission,
      dbPath,
      managedDbPaths: [dbPath],
      maxTtlSeconds: 60,
    },
  };
}
function open(
  options: ManagedExternalAuthReplayOptions,
  hooks: ExternalAuthReplayTestHooks = { now: fixedNow },
): ManagedExternalAuthReplay {
  const replay = createManagedExternalAuthReplay(options, hooks);
  stores.push(replay);
  return replay;
}
function input(
  jti = "claim",
  overrides: Partial<ManagedReplayVerifiedInput> = {},
): ManagedReplayVerifiedInput {
  return {
    audience: "company-a",
    jti,
    issuedAt: fixedNow(),
    expiresAt: fixedNow() + 60_000,
    maxTtlSeconds: 60,
    ...overrides,
  };
}
function rows(path: string): Array<{ claim_hash: string; expires_at: number }> {
  const db = new Database(path, constants.SQLITE_OPEN_READWRITE);
  try {
    return db
      .query<{ claim_hash: string; expires_at: number }, []>(
        "SELECT * FROM external_auth_replay_claims ORDER BY claim_hash",
      )
      .all();
  } finally {
    db.close();
  }
}
afterEach(() => {
  for (const store of stores.splice(0)) store.close();
  for (const lease of leases.splice(0)) lease.release();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("managed replay SQLite claims", () => {
  test("restoring an older real DB blocks a post-backup claim until every old assertion has expired", async () => {
    const source = setup();
    const replay = open(source.options);
    const snapshot = join(source.root, "snapshot.db");
    const db = new Database(source.options.dbPath);
    try {
      db.query("VACUUM INTO ?").run(snapshot);
    } finally {
      db.close();
    }
    expect(await replay.consumeVerified(input("after-backup"))).toEqual({ status: "consumed" });
    replay.close();
    source.lease.release();

    const destination = mkdtempSync(join(tmpdir(), "auggy-replay-restored-"));
    roots.push(destination);
    chmodSync(destination, 0o700);
    const restoredAtMs = fixedNow() + 5_000;
    let time = restoredAtMs;
    const pin = pinDirectory(destination, "restore destination");
    try {
      ensureRestoredExternalAuthReplayGuard(
        pin.fd,
        {
          agentId,
          restore: {
            restoreId: "9fb78f48-61f3-41ca-a38f-0be277897f52",
            restoredAtMs,
          },
        },
        { now: () => time },
      );
    } finally {
      closeSync(pin.fd);
    }
    const destinationDb = join(destination, "replay.db");
    copyFileSync(snapshot, destinationDb);
    const owned = prepareRuntimeDataVolume(
      { kind: "explicit", runtimeDataRoot: destination },
      agentId,
    );
    leases.push(owned);
    const restored = open(
      {
        admission: owned.runtimeDataAdmission,
        dbPath: destinationDb,
        managedDbPaths: [destinationDb],
        maxTtlSeconds: 60,
      },
      { now: () => time },
    );
    expect(await restored.consumeVerified(input("after-backup"))).toEqual({
      status: "held",
      retryAfterSeconds: 90,
    });
    time = restoredAtMs + 90_000;
    expect(await restored.consumeVerified(input("after-backup"))).toEqual({
      status: "rejected",
      reason: "expired",
    });
    expect(
      await restored.consumeVerified(input("fresh", { issuedAt: time, expiresAt: time + 60_000 })),
    ).toEqual({ status: "consumed" });
    expect(rows(destinationDb)).toHaveLength(1);
    expect(
      JSON.parse(readFileSync(join(destination, GUARD), "utf8")).latestRestore.restoredAtMs,
    ).toBe(restoredAtMs);
  });

  test("uses the EARP identity, exact schema and durable hardened settings", async () => {
    const { options } = setup();
    const replay = open(options);
    expect(await replay.consumeVerified(input())).toEqual({ status: "consumed" });
    const db = new Database(options.dbPath);
    try {
      expect(db.query("PRAGMA application_id").get()).toEqual({
        application_id: EXTERNAL_AUTH_REPLAY_APPLICATION_ID,
      });
      expect(db.query("PRAGMA user_version").get()).toEqual({ user_version: 1 });
      expect(db.query("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
      expect(db.query("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
      expect(
        db
          .query("SELECT name FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY name")
          .all(),
      ).toEqual([{ name: "external_auth_replay_claims" }, { name: "external_auth_replay_expiry" }]);
    } finally {
      db.close();
    }
    const stored = rows(options.dbPath);
    expect(stored).toHaveLength(1);
    expect(stored[0]!.claim_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(stored[0]!.expires_at).toBe(input().expiresAt);
    expect(JSON.stringify(stored)).not.toContain("company-a");
    expect(JSON.stringify(stored)).not.toContain('"claim"');
  });

  test("concurrent same-token claims across real handles have exactly one winner", async () => {
    const { options } = setup();
    const first = open(options);
    const second = open(options);
    const results = await Promise.all(
      Array.from({ length: 32 }, (_, index) =>
        (index % 2 ? first : second).consumeVerified(input()),
      ),
    );
    expect(results.filter((result) => result.status === "consumed")).toHaveLength(1);
    expect(
      results.filter((result) => result.status === "rejected" && result.reason === "replay"),
    ).toHaveLength(31);
    expect(rows(options.dbPath)).toHaveLength(1);
  });

  test("queued verified claims keep the same assertion fields and TTL", async () => {
    const { options } = setup();
    const replay = open(options);
    const verified = { ...input("original") };
    const pending = replay.consumeVerified(verified);
    verified.jti = "changed";
    verified.maxTtlSeconds = 0;
    expect(await pending).toEqual({ status: "consumed" });
    expect(await replay.consumeVerified(input("original"))).toEqual({
      status: "rejected",
      reason: "replay",
    });
    expect(await replay.consumeVerified(input("changed"))).toEqual({ status: "consumed" });
  });

  test("the exact audience namespace survives restart and avoids delimiter or Unicode normalization collisions", async () => {
    const { root, lease, options } = setup();
    let replay = open(options);
    expect((await replay.consumeVerified(input("same", { audience: "one" }))).status).toBe(
      "consumed",
    );
    expect((await replay.consumeVerified(input("same", { audience: "two" }))).status).toBe(
      "consumed",
    );
    expect((await replay.consumeVerified(input("b:c", { audience: "a" }))).status).toBe("consumed");
    expect((await replay.consumeVerified(input("c", { audience: "a:b" }))).status).toBe("consumed");
    expect((await replay.consumeVerified(input("é"))).status).toBe("consumed");
    expect((await replay.consumeVerified(input("e\u0301"))).status).toBe("consumed");
    replay.close();
    lease.release();
    const newLease = prepareRuntimeDataVolume({ kind: "explicit", runtimeDataRoot: root }, agentId);
    leases.push(newLease);
    replay = open({ ...options, admission: newLease.runtimeDataAdmission });
    expect(await replay.consumeVerified(input("same", { audience: "one" }))).toEqual({
      status: "rejected",
      reason: "replay",
    });
    expect(rows(options.dbPath)).toHaveLength(6);
  });

  test("signing-key rotation cannot make the same audience/jti reusable", async () => {
    const { options } = setup();
    const replay = open(options);
    const secrets = [
      { keyId: "old", secret: "a".repeat(48) },
      { keyId: "new", secret: "b".repeat(48) },
    ];
    const results = [];
    for (const key of secrets) {
      const assertion = createExternalAuthAssertion({
        ...key,
        audience: "company-a",
        provider: "app",
        subject: "account",
        jti: "same",
        ttlSeconds: 60,
        now: fixedNow(),
      });
      const verified = verifyExternalAuthAssertion(assertion, {
        secrets,
        audience: "company-a",
        now: fixedNow(),
        maxTtlSeconds: 60,
      });
      expect(verified.ok).toBe(true);
      if (!verified.ok) throw new Error("test assertion failed verification");
      results.push(
        await replay.consumeVerified({
          ...verified.claims,
          jti: verified.claims.jti!,
          maxTtlSeconds: 60,
        }),
      );
    }
    expect(results).toEqual([{ status: "consumed" }, { status: "rejected", reason: "replay" }]);
  });

  test("expiry prunes only expired entries and exact expiry rejects the old assertion", async () => {
    const { options } = setup();
    let time = fixedNow();
    const replay = open(options, { now: () => time });
    expect((await replay.consumeVerified(input("expiring", { expiresAt: time + 1 }))).status).toBe(
      "consumed",
    );
    expect((await replay.consumeVerified(input("live"))).status).toBe("consumed");
    time++;
    expect(await replay.consumeVerified(input("expiring", { expiresAt: time }))).toEqual({
      status: "rejected",
      reason: "expired",
    });
    expect(
      await replay.consumeVerified(input("expiring", { issuedAt: time, expiresAt: time + 60_000 })),
    ).toEqual({ status: "consumed" });
    expect(await replay.consumeVerified(input("live"))).toEqual({
      status: "rejected",
      reason: "replay",
    });
    expect(rows(options.dbPath)).toHaveLength(2);
  });

  test("the physical DB cap is exactly 100000 live entries, with no cross-audience eviction", async () => {
    const { options } = setup();
    let time = fixedNow();
    const replay = open(options, { now: () => time });
    const db = new Database(options.dbPath);
    try {
      const insert = db.query("INSERT INTO external_auth_replay_claims VALUES (?, ?)");
      db.transaction(() => {
        for (let i = 0; i < 99_999; i++) insert.run(i.toString(16).padStart(64, "0"), time + 1);
      }).immediate();
    } finally {
      db.close();
    }
    expect(await replay.consumeVerified(input("last", { audience: "one" }))).toEqual({
      status: "consumed",
    });
    expect(await replay.consumeVerified(input("overflow", { audience: "two" }))).toEqual({
      status: "unavailable",
      reason: "capacity",
    });
    expect(await replay.consumeVerified(input("last", { audience: "one" }))).toEqual({
      status: "rejected",
      reason: "replay",
    });
    expect(rows(options.dbPath)).toHaveLength(100_000);
    time++;
    expect(await replay.consumeVerified(input("overflow", { audience: "two" }))).toEqual({
      status: "consumed",
    });
    expect(rows(options.dbPath)).toHaveLength(2);
  });

  test("SQLite busy failure is bounded and commits no claim", async () => {
    const { options } = setup();
    const replay = open(options, { now: fixedNow, busyTimeoutMs: 20 });
    const blocker = new Database(options.dbPath);
    blocker.run("BEGIN IMMEDIATE");
    const started = performance.now();
    try {
      expect(await replay.consumeVerified(input())).toEqual({
        status: "unavailable",
        reason: "storage",
      });
      expect(performance.now() - started).toBeLessThan(1_000);
    } finally {
      blocker.run("ROLLBACK");
      blocker.close();
    }
    expect(rows(options.dbPath)).toEqual([]);
    expect(await replay.consumeVerified(input())).toEqual({ status: "consumed" });
  });

  test("closed stores cancel queued work without releasing another store's guard", async () => {
    const { options } = setup();
    const first = open(options);
    const second = open(options);
    const queued = first.consumeVerified(input("cancelled"));
    first.close();
    expect(await queued).toEqual({ status: "unavailable", reason: "storage" });
    expect(await first.checkAvailability(60)).toEqual({ status: "unavailable", reason: "storage" });
    expect(await second.consumeVerified(input())).toEqual({ status: "consumed" });
    expect(rows(options.dbPath)).toHaveLength(1);
  });
});

describe("managed claim validation", () => {
  test.each([
    "",
    "x".repeat(257),
    "😀".repeat(257),
    "\ud800",
    "\udfff",
    "a\u0000b",
    "a\u0085b",
    "a\u007fb",
  ])("rejects unsafe bounded jti %j before storing it", async (jti) => {
    const { options } = setup();
    const replay = open(options);
    expect(validateManagedReplayVerifiedInput(input(jti), fixedNow())).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    expect(await replay.consumeVerified(input(jti))).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    expect(rows(options.dbPath)).toEqual([]);
  });

  test("accepts exactly 256 astral scalars / 1024 UTF-8 bytes without normalization", async () => {
    const { options } = setup();
    const replay = open(options);
    expect(await replay.consumeVerified(input("😀".repeat(256)))).toEqual({ status: "consumed" });
    expect(await replay.consumeVerified(input("x".repeat(256)))).toEqual({ status: "consumed" });
    expect(await replay.consumeVerified(input("surrogate-a", { audience: "\ud800" }))).toEqual({
      status: "consumed",
    });
    expect(await replay.consumeVerified(input("surrogate-a", { audience: "\ud801" }))).toEqual({
      status: "consumed",
    });
  });

  test.each([NaN, Infinity, -1, 0.5, MAX_TIME + 1])(
    "rejects invalid timestamp %s",
    async (value) => {
      const { options } = setup();
      const replay = open(options);
      expect(await replay.consumeVerified(input("one", { issuedAt: value }))).toEqual({
        status: "rejected",
        reason: "invalid",
      });
      expect(await replay.consumeVerified(input("two", { expiresAt: value }))).toEqual({
        status: "rejected",
        reason: "invalid",
      });
      expect(rows(options.dbPath)).toEqual([]);
    },
  );

  test("enforces future skew, current TTL and exact audience verifier bounds", async () => {
    const { options } = setup();
    const replay = open(options);
    expect(
      await replay.consumeVerified(
        input("future", { issuedAt: fixedNow() + 30_001, expiresAt: fixedNow() + 31_000 }),
      ),
    ).toEqual({ status: "rejected", reason: "invalid" });
    expect(await replay.consumeVerified(input("ttl", { expiresAt: fixedNow() + 60_001 }))).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    expect(await replay.consumeVerified(input("equal", { expiresAt: fixedNow() }))).toEqual({
      status: "rejected",
      reason: "invalid",
    });
    for (const audience of ["", "x".repeat(257), "a\nb"])
      expect(
        validateManagedReplayVerifiedInput(input("aud", { audience }), fixedNow())?.reason,
      ).toBe("invalid");
    expect(
      await replay.consumeVerified(
        input("at-skew", { issuedAt: fixedNow() + 30_000, expiresAt: fixedNow() + 31_000 }),
      ),
    ).toEqual({ status: "consumed" });
  });
});

describe("managed database admission and tampering", () => {
  test("query preparation failure closes the native DB and releases the shared guard", async () => {
    const { root, lease, options } = setup();
    const originalQuery = Database.prototype.query;
    const originalClose = Database.prototype.close;
    let nativeCloses = 0;
    const query = spyOn(Database.prototype, "query").mockImplementation(function (
      this: Database,
      sql: string,
    ) {
      if (sql.startsWith("DELETE FROM external_auth_replay_claims")) {
        throw new Error("injected query preparation failure");
      }
      return originalQuery.call(this, sql);
    } as typeof Database.prototype.query);
    const close = spyOn(Database.prototype, "close").mockImplementation(function (
      this: Database,
      ...args: Parameters<typeof originalClose>
    ) {
      nativeCloses++;
      return originalClose.apply(this, args);
    });
    try {
      expect(() => open(options)).toThrow("injected query preparation failure");
      expect(nativeCloses).toBe(1);
    } finally {
      query.mockRestore();
      close.mockRestore();
    }
    lease.release();
    const recoveredLease = prepareRuntimeDataVolume(
      { kind: "explicit", runtimeDataRoot: root },
      agentId,
    );
    leases.push(recoveredLease);
    const recovered = open(
      { ...options, admission: recoveredLease.runtimeDataAdmission },
      { now: () => fixedNow() },
    );
    expect(await recovered.consumeVerified(input())).toEqual({ status: "consumed" });
  });

  test("rejects forged admission before creating guard or DB", () => {
    const { root, options } = setup();
    expect(() =>
      open({ ...options, admission: { ...options.admission } as RuntimeDataAdmission }),
    ).toThrow("admission is invalid");
    expect(existsSync(join(root, GUARD))).toBe(false);
    expect(existsSync(options.dbPath)).toBe(false);
  });

  test.each([
    ".auggy-auth-replay-guard.json",
    ".AUGGY-AUTH-REPLAY-GUARD.JSON",
    ".auggy-auth-replay-guard.pending",
    ".auggy-state-identity.json",
    ".auggy-restore-fence.json",
    ".auggy-runtime-singleton.lock",
  ])("rejects reserved control path %s before any guard or DB write", (leaf) => {
    const { root, options } = setup();
    const before = readdirSync(root);
    const path = join(root, leaf);
    expect(() => open({ ...options, dbPath: path, managedDbPaths: [path] })).toThrow("unsafe");
    expect(readdirSync(root)).toEqual(before);
  });

  test("rejects absent inventory membership, outside paths, case aliases and DB-sidecar aliases", () => {
    const { root, options } = setup();
    const other = join(root, "other.db");
    for (const paths of [
      [other],
      [options.dbPath, join(dirname(root), "outside.db")],
      [options.dbPath, join(root, "REPLAY.DB")],
      [options.dbPath, `${options.dbPath}-wal`],
    ]) {
      expect(() => open({ ...options, managedDbPaths: paths })).toThrow("unsafe");
    }
    for (const path of [":memory:", "file:/tmp/replay.db", "relative.db", `${root}/../escape.db`]) {
      expect(() => open({ ...options, dbPath: path, managedDbPaths: [path] })).toThrow("unsafe");
    }
    expect(existsSync(join(root, GUARD))).toBe(false);
    expect(existsSync(options.dbPath)).toBe(false);
  });

  test.each(["symlink-parent", "symlink-db", "hardlink-db", "sidecar"])(
    "refuses unsafe %s without touching its target",
    (fault) => {
      const { root, options } = setup();
      const target = join(root, "untouched");
      writeFileSync(target, "unchanged", { mode: 0o600 });
      let path = options.dbPath;
      if (fault === "symlink-parent") {
        const directory = join(root, "directory");
        mkdirSync(directory, { mode: 0o700 });
        symlinkSync(directory, join(root, "alias"));
        path = join(root, "alias", "replay.db");
      } else if (fault === "symlink-db") symlinkSync(target, path);
      else if (fault === "hardlink-db") linkSync(target, path);
      else symlinkSync(target, `${path}-wal`);
      expect(() => open({ ...options, dbPath: path, managedDbPaths: [path] })).toThrow();
      expect(readFileSync(target, "utf8")).toBe("unchanged");
      expect(existsSync(join(root, GUARD))).toBe(false);
    },
  );

  test.each(["foreign-brand", "lookalike", "newer", "extra-object"])(
    "refuses an incompatible %s database",
    (fault) => {
      const { options } = setup();
      open(options).close();
      const db = new Database(options.dbPath);
      try {
        if (fault === "foreign-brand") db.run("PRAGMA application_id = 42");
        else if (fault === "lookalike") {
          db.run("PRAGMA application_id = 0");
          db.run("PRAGMA user_version = 0");
        } else if (fault === "newer") db.run("PRAGMA user_version = 2");
        else db.run("CREATE TABLE unrelated(value TEXT)");
      } finally {
        db.close();
      }
      expect(() => open(options)).toThrow();
    },
  );

  test.each(["root", "database", "parent", "guard", "released"])(
    "fails closed after live %s replacement",
    async (fault) => {
      const { root, lease, options } = setup();
      const nested = {
        ...options,
        dbPath: join(root, "nested", "replay.db"),
        managedDbPaths: [join(root, "nested", "replay.db")],
      };
      const replay = open(fault === "parent" ? nested : options);
      if (fault === "root") {
        renameSync(root, `${root}-old`);
        roots.push(`${root}-old`);
        mkdirSync(root, { mode: 0o700 });
      } else if (fault === "database") {
        renameSync(options.dbPath, `${options.dbPath}-old`);
        writeFileSync(options.dbPath, "", { mode: 0o600 });
      } else if (fault === "parent") {
        renameSync(join(root, "nested"), join(root, "nested-old"));
        mkdirSync(join(root, "nested"), { mode: 0o700 });
      } else if (fault === "guard") writeFileSync(join(root, GUARD), "bad");
      else lease.release();
      const availability = await replay.checkAvailability(60);
      const consumed = await replay.consumeVerified(input());
      expect(availability.status).toBe("unavailable");
      expect(consumed.status).toBe("unavailable");
      expect(() => replay.close()).not.toThrow();
    },
  );

  test("first-use guard survives failed schema open and can serve a later correct retry", () => {
    const { root, options } = setup();
    let interrupt = true;
    const hooks = {
      now: fixedNow,
      onGuardWriteStage(stage: string) {
        if (interrupt && stage === "directory-synced") {
          interrupt = false;
          throw new Error("first-use crash before DB open");
        }
      },
    };
    expect(() => open(options, hooks)).toThrow("first-use crash");
    expect(existsSync(join(root, GUARD))).toBe(true);
    expect(existsSync(options.dbPath)).toBe(false);
    expect(() => open(options, hooks)).not.toThrow();
  });
});
