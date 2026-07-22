import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  closeSync,
  existsSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { constants, Database } from "bun:sqlite";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  type OwnedSqliteSchemaOptions,
  type SqliteSchemaObject,
} from "../../src/lib/sqlite";

type SqliteHandle = ReturnType<typeof openHardenedSqlite>;

const roots: string[] = [];
const handles: SqliteHandle[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "auggy-hardened-sqlite-"));
  roots.push(root);
  return root;
}

function open(
  path: string,
  options: Omit<Parameters<typeof openHardenedSqlite>[0], "path" | "label"> = {},
): SqliteHandle {
  const handle = openHardenedSqlite({
    path,
    label: "test SQLite",
    ...options,
  });
  handles.push(handle);
  return handle;
}

afterEach(() => {
  for (const handle of handles.splice(0)) {
    try {
      handle.close();
    } catch {
      // Tests that exercise initialization and close failures still clean up.
    }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function mode(path: string): number {
  return statSync(path).mode & 0o777;
}

const OWNED_TEST_APPLICATION_ID = 0x41554759;
const OWNED_TEST_OLD_SCHEMA = "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL)";
const OWNED_TEST_CURRENT_SCHEMA =
  "CREATE TABLE records (id INTEGER PRIMARY KEY, value TEXT NOT NULL, note TEXT NOT NULL DEFAULT '')";

function exactSchema(objects: readonly SqliteSchemaObject[], expectedSql: string): boolean {
  return (
    objects.length === 1 &&
    objects[0]?.type === "table" &&
    objects[0].name === "records" &&
    canonicalSqliteSchemaSql(objects[0].sql) === canonicalSqliteSchemaSql(expectedSql)
  );
}

function ownedTestOptions(
  overrides: Partial<OwnedSqliteSchemaOptions> = {},
): OwnedSqliteSchemaOptions {
  return {
    label: "owned test SQLite",
    applicationId: OWNED_TEST_APPLICATION_ID,
    schemaVersion: 2,
    initialize(db) {
      db.run(OWNED_TEST_CURRENT_SCHEMA);
    },
    validate(_db, objects) {
      if (!exactSchema(objects, OWNED_TEST_CURRENT_SCHEMA)) {
        throw new Error("current schema validation failed");
      }
    },
    isLegacy: () => false,
    ...overrides,
  };
}

function seedOwnedTestDatabase(
  path: string,
  applicationId = OWNED_TEST_APPLICATION_ID,
  userVersion = 1,
): void {
  const seed = new Database(path, { create: true });
  seed.run(OWNED_TEST_OLD_SCHEMA);
  seed.run("INSERT INTO records (value) VALUES ('preserved')");
  seed.run(`PRAGMA application_id = ${applicationId}`);
  seed.run(`PRAGMA user_version = ${userVersion}`);
  seed.close();
}

const sqliteArtifacts = [
  { name: "database", suffix: "" },
  { name: "WAL", suffix: "-wal" },
  { name: "shared-memory", suffix: "-shm" },
  { name: "rollback journal", suffix: "-journal" },
] as const;

describe("openHardenedSqlite", () => {
  test("supports an in-memory database without filesystem artifacts", () => {
    const root = tempRoot();
    const handle = open(":memory:", { foreignKeys: true });
    handle.db.run("CREATE TABLE example (id INTEGER PRIMARY KEY)");
    handle.db.run("INSERT INTO example DEFAULT VALUES");

    expect(
      handle.db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM example").get(),
    ).toEqual({ count: 1 });
    expect(handle.path).toBe(":memory:");
    expect(handle.persistent).toBe(false);
    expect(handle.diagnostics()).toMatchObject({
      path: ":memory:",
      persistent: false,
      foreignKeys: true,
      quickCheck: "ok",
    });
    expect(handle.diagnostics().fileSizes).toEqual({
      db: null,
      wal: null,
      shm: null,
      journal: null,
    });
    expect(existsSync(join(root, ":memory:"))).toBe(false);
  });

  test("creates the database owner-only on its first open", () => {
    const dbPath = join(tempRoot(), "state.sqlite");
    const handle = open(dbPath);

    expect(mode(dbPath)).toBe(0o600);
    expect(handle.path).toBe(join(realpathSync.native(dirname(dbPath)), basename(dbPath)));
    expect(handle.persistent).toBe(true);
  });

  test("canonicalizes the benign macOS /var filesystem alias without resolving the leaf", () => {
    const root = tempRoot();
    if (process.platform !== "darwin" || !root.startsWith("/var/")) return;

    const handle = open(join(root, "state.sqlite"));
    handle.db.run("CREATE TABLE alias_probe (value TEXT NOT NULL)");

    expect(handle.path).toStartWith("/private/var/");
    expect(handle.diagnostics().quickCheck).toBe("ok");
  });

  test("repairs an existing regular database to owner-only permissions", () => {
    const dbPath = join(tempRoot(), "state.sqlite");
    const seed = openHardenedSqlite({ path: dbPath, label: "seed SQLite" });
    seed.close();
    chmodSync(dbPath, 0o644);

    const handle = open(dbPath);
    expect(mode(dbPath)).toBe(0o600);
    expect(handle.diagnostics().quickCheck).toBe("ok");
  });

  test("rejects a writable database parent before creating the database", () => {
    const root = tempRoot();
    chmodSync(root, 0o777);
    const dbPath = join(root, "state.sqlite");

    expect(() => open(dbPath)).toThrow(/parent.*writable/i);
    expect(existsSync(dbPath)).toBe(false);
  });

  for (const artifact of sqliteArtifacts) {
    test(`rejects a ${artifact.name} symlink without chmod-following its target`, () => {
      const root = tempRoot();
      const dbPath = join(root, "state.sqlite");
      const candidate = `${dbPath}${artifact.suffix}`;
      const target = join(root, `${artifact.name.replaceAll(" ", "-")}-target`);
      writeFileSync(target, "unchanged");
      chmodSync(target, 0o644);
      symlinkSync(target, candidate);

      expect(() => open(dbPath)).toThrow();
      expect(mode(target)).toBe(0o644);
      expect(readFileSync(target, "utf8")).toBe("unchanged");
    });

    test(`rejects a dangling ${artifact.name} symlink`, () => {
      const root = tempRoot();
      const dbPath = join(root, "state.sqlite");
      const candidate = `${dbPath}${artifact.suffix}`;
      const missingTarget = join(root, "missing-target");
      symlinkSync(missingTarget, candidate);

      expect(() => open(dbPath)).toThrow();
      expect(lstatSync(candidate).isSymbolicLink()).toBe(true);
      expect(existsSync(missingTarget)).toBe(false);
    });

    test(`rejects a directory at the ${artifact.name} path`, () => {
      const root = tempRoot();
      const dbPath = join(root, "state.sqlite");
      const candidate = `${dbPath}${artifact.suffix}`;
      mkdirSync(candidate);

      expect(() => open(dbPath)).toThrow();
      expect(lstatSync(candidate).isDirectory()).toBe(true);
    });

    test(`rejects a hard-linked ${artifact.name} without chmodding the shared inode`, () => {
      const root = tempRoot();
      const dbPath = join(root, "state.sqlite");
      const candidate = `${dbPath}${artifact.suffix}`;
      const target = join(root, `${artifact.name.replaceAll(" ", "-")}-target`);
      writeFileSync(target, "unchanged");
      chmodSync(target, 0o644);
      linkSync(target, candidate);

      expect(() => open(dbPath)).toThrow();
      expect(mode(target)).toBe(0o644);
      const fd = openSync(target, "r");
      try {
        expect(fstatSync(fd).nlink).toBe(2);
        expect(readFileSync(fd, "utf8")).toBe("unchanged");
      } finally {
        closeSync(fd);
      }
    });

    test(`rejects a FIFO at the ${artifact.name} path without blocking`, () => {
      if (process.platform === "win32") return;
      const root = tempRoot();
      const dbPath = join(root, "state.sqlite");
      const candidate = `${dbPath}${artifact.suffix}`;
      const result = Bun.spawnSync(["mkfifo", candidate]);
      if (result.exitCode !== 0) return;
      const initialMode = lstatSync(candidate).mode & 0o777;

      expect(() => open(dbPath)).toThrow();
      expect(lstatSync(candidate).isFIFO()).toBe(true);
      expect(lstatSync(candidate).mode & 0o777).toBe(initialMode);
    });
  }

  test("sets and reports the verified durability and safety PRAGMAs", () => {
    const dbPath = join(tempRoot(), "state.sqlite");
    const handle = open(dbPath, {
      busyTimeoutMs: 1_234,
      foreignKeys: true,
      synchronous: "FULL",
      quickCheck: true,
    });
    const diagnostics = handle.diagnostics();

    expect(diagnostics).toMatchObject({
      path: handle.path,
      persistent: true,
      readonly: false,
      journalMode: "wal",
      synchronous: "full",
      foreignKeys: true,
      busyTimeoutMs: 1_234,
      trustedSchema: false,
      quickCheck: "ok",
    });
    expect(diagnostics.walAutoCheckpoint).toBeGreaterThan(0);
    expect(diagnostics.journalSizeLimit).toBeGreaterThanOrEqual(-1);

    expect(
      handle.db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("wal");
    expect(
      handle.db.query<{ synchronous: number }, []>("PRAGMA synchronous").get()?.synchronous,
    ).toBe(2);
    expect(handle.db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(
      1_234,
    );
    expect(
      handle.db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys,
    ).toBe(1);
    expect(
      handle.db.query<{ trusted_schema: number }, []>("PRAGMA trusted_schema").get()
        ?.trusted_schema,
    ).toBe(0);
  });

  test("opens owner-only databases read-only with connection safety settings", () => {
    const dbPath = join(tempRoot(), "readonly.sqlite");
    const seed = open(dbPath);
    seed.db.run("CREATE TABLE records (value TEXT NOT NULL)");
    seed.db.run("INSERT INTO records VALUES ('preserved')");
    seed.checkpoint("TRUNCATE");
    seed.close();
    const bytes = readFileSync(dbPath);
    const initialMode = mode(dbPath);

    const readonly = open(dbPath, { readonly: true });
    expect(readonly.diagnostics()).toMatchObject({
      readonly: true,
      foreignKeys: true,
      trustedSchema: false,
      synchronous: "full",
    });
    expect(readonly.db.query<{ value: string }, []>("SELECT value FROM records").get()).toEqual({
      value: "preserved",
    });
    expect(() => readonly.db.run("INSERT INTO records VALUES ('blocked')")).toThrow();
    readonly.close();

    expect(readFileSync(dbPath)).toEqual(bytes);
    expect(mode(dbPath)).toBe(initialMode);
  });

  test("rejects insecure read-only permissions without repairing them", () => {
    const dbPath = join(tempRoot(), "readonly-mode.sqlite");
    const seed = open(dbPath);
    seed.close();
    chmodSync(dbPath, 0o644);

    expect(() => open(dbPath, { readonly: true })).toThrow(/readonly.*0600/i);
    expect(mode(dbPath)).toBe(0o644);
  });

  test("rolls back a failed prepare hook before enabling WAL", () => {
    const dbPath = join(tempRoot(), "prepare-failure.sqlite");

    expect(() =>
      open(dbPath, {
        prepare(db) {
          db.run("CREATE TABLE leaked (value TEXT NOT NULL)");
          db.run("INSERT INTO leaked VALUES ('must roll back')");
          throw new Error("migration rejected");
        },
      }),
    ).toThrow("migration rejected");
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
    }

    let leakedTableCount: number | undefined;
    const recovered = open(dbPath, {
      prepare(db) {
        leakedTableCount = db
          .query<{ count: number }, []>(
            "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'leaked'",
          )
          .get()?.count;
      },
    });
    expect(leakedTableCount).toBe(0);
    recovered.close();
  });

  test("transactionally migrates an exact branded older owned schema", () => {
    const dbPath = join(tempRoot(), "owned-migration.sqlite");
    seedOwnedTestDatabase(dbPath);
    let migrationCalls = 0;

    const handle = open(dbPath, {
      prepare(db) {
        admitOwnedSqliteSchema(
          db,
          ownedTestOptions({
            migrateOwned(migrationDb, fromVersion, objects) {
              migrationCalls += 1;
              if (fromVersion !== 1 || !exactSchema(objects, OWNED_TEST_OLD_SCHEMA)) {
                throw new Error("unsupported prior owned schema");
              }
              migrationDb.run("ALTER TABLE records ADD COLUMN note TEXT NOT NULL DEFAULT ''");
            },
          }),
        );
      },
    });

    expect(migrationCalls).toBe(1);
    expect(
      handle.db.query<{ application_id: number }, []>("PRAGMA application_id").get()
        ?.application_id,
    ).toBe(OWNED_TEST_APPLICATION_ID);
    expect(
      handle.db.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(2);
    expect(
      handle.db.query<{ value: string; note: string }, []>("SELECT value, note FROM records").get(),
    ).toEqual({ value: "preserved", note: "" });
  });

  test("rejects an older branded schema when no owned migration is registered", () => {
    const dbPath = join(tempRoot(), "owned-migration-missing.sqlite");
    seedOwnedTestDatabase(dbPath);

    expect(() =>
      open(dbPath, {
        prepare(db) {
          admitOwnedSqliteSchema(db, ownedTestOptions());
        },
      }),
    ).toThrow(/schema 1 requires a migration to version 2/i);

    const inspect = new Database(dbPath);
    expect(
      inspect.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(1);
    expect(
      inspect
        .query<{ name: string }, []>("PRAGMA table_info(records)")
        .all()
        .map(({ name }) => name),
    ).toEqual(["id", "value"]);
    inspect.close();
  });

  test("rolls back failed owned migration DDL and marker changes", () => {
    const dbPath = join(tempRoot(), "owned-migration-rollback.sqlite");
    seedOwnedTestDatabase(dbPath);

    expect(() =>
      open(dbPath, {
        prepare(db) {
          admitOwnedSqliteSchema(
            db,
            ownedTestOptions({
              migrateOwned(migrationDb, fromVersion, objects) {
                if (fromVersion !== 1 || !exactSchema(objects, OWNED_TEST_OLD_SCHEMA)) {
                  throw new Error("unsupported prior owned schema");
                }
                migrationDb.run("ALTER TABLE records ADD COLUMN note TEXT NOT NULL DEFAULT ''");
                migrationDb.run("PRAGMA user_version = 99");
                throw new Error("owned migration rejected");
              },
            }),
          );
        },
      }),
    ).toThrow("owned migration rejected");

    const inspect = new Database(dbPath);
    expect(
      inspect.query<{ application_id: number }, []>("PRAGMA application_id").get()?.application_id,
    ).toBe(OWNED_TEST_APPLICATION_ID);
    expect(
      inspect.query<{ user_version: number }, []>("PRAGMA user_version").get()?.user_version,
    ).toBe(1);
    expect(
      inspect
        .query<{ name: string }, []>("PRAGMA table_info(records)")
        .all()
        .map(({ name }) => name),
    ).toEqual(["id", "value"]);
    inspect.close();
  });

  test("never offers wrong, future, or unowned lookalike schemas to owned migration", () => {
    const cases = [
      {
        name: "wrong-application",
        applicationId: OWNED_TEST_APPLICATION_ID + 1,
        userVersion: 1,
        error: /another application/i,
      },
      {
        name: "future-version",
        applicationId: OWNED_TEST_APPLICATION_ID,
        userVersion: 3,
        error: /newer than supported/i,
      },
      {
        name: "unowned-lookalike",
        applicationId: 0,
        userVersion: 0,
        error: /not a recognized legacy schema/i,
      },
    ];
    let migrationCalls = 0;

    for (const candidate of cases) {
      const dbPath = join(tempRoot(), `${candidate.name}.sqlite`);
      seedOwnedTestDatabase(dbPath, candidate.applicationId, candidate.userVersion);

      expect(() =>
        open(dbPath, {
          prepare(db) {
            admitOwnedSqliteSchema(
              db,
              ownedTestOptions({
                migrateOwned() {
                  migrationCalls += 1;
                },
              }),
            );
          },
        }),
      ).toThrow(candidate.error);
    }

    expect(migrationCalls).toBe(0);
  });

  test("rejects an unrelated database in prepare without changing its bytes or journal mode", () => {
    const dbPath = join(tempRoot(), "unrelated.sqlite");
    const seed = new Database(dbPath, { create: true });
    seed.run("CREATE TABLE another_application (value TEXT NOT NULL)");
    seed.run("INSERT INTO another_application VALUES ('preserved')");
    seed.close();
    chmodSync(dbPath, 0o600);
    const bytes = readFileSync(dbPath);

    expect(() =>
      open(dbPath, {
        prepare(db) {
          const known = db
            .query<{ count: number }, []>(
              "SELECT COUNT(*) AS count FROM sqlite_schema WHERE name = 'expected_application'",
            )
            .get()?.count;
          if (known !== 1) throw new Error("unrelated database");
        },
      }),
    ).toThrow("unrelated database");

    expect(readFileSync(dbPath)).toEqual(bytes);
    const canonicalPath = join(realpathSync.native(dirname(dbPath)), basename(dbPath));
    const inspect = new Database(
      canonicalPath,
      constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW,
    );
    expect(
      inspect.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode,
    ).toBe("delete");
    inspect.close();
  });

  test("refuses corruption before creating sidecars or mutating the database", () => {
    const dbPath = join(tempRoot(), "corrupt.sqlite");
    const corruptBytes = Buffer.from("not a sqlite database\n", "utf8");
    writeFileSync(dbPath, corruptBytes, { mode: 0o600 });

    expect(() => open(dbPath, { quickCheck: true })).toThrow();
    expect(readFileSync(dbPath)).toEqual(corruptBytes);
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      expect(existsSync(`${dbPath}${suffix}`)).toBe(false);
    }
  });

  test("honors inter-connection write contention and recovers after rollback", () => {
    const dbPath = join(tempRoot(), "contended.sqlite");
    const first = open(dbPath, { busyTimeoutMs: 10 });
    first.db.run("CREATE TABLE writes (value TEXT NOT NULL)");
    const second = open(dbPath, { busyTimeoutMs: 10 });

    first.db.run("BEGIN IMMEDIATE");
    first.db.run("INSERT INTO writes VALUES ('first-uncommitted')");
    expect(() => second.db.run("INSERT INTO writes VALUES ('blocked')")).toThrow();
    first.db.run("ROLLBACK");

    second.db.run("INSERT INTO writes VALUES ('recovered')");
    expect(second.db.query<{ value: string }, []>("SELECT value FROM writes").all()).toEqual([
      { value: "recovered" },
    ]);
  });

  test("checkpoints WAL and reports checkpoint counters", () => {
    const dbPath = join(tempRoot(), "checkpoint.sqlite");
    const handle = open(dbPath);
    handle.db.run("CREATE TABLE writes (value TEXT NOT NULL)");
    handle.db.run("INSERT INTO writes VALUES ('durable')");

    const result = handle.checkpoint("TRUNCATE");
    expect(result.busy).toBe(0);
    expect(result.log).toBeGreaterThanOrEqual(0);
    expect(result.checkpointed).toBeGreaterThanOrEqual(0);
    expect(handle.diagnostics().quickCheck).toBe("ok");
  });

  test("reports database and WAL-family file sizes", () => {
    const dbPath = join(tempRoot(), "diagnostics.sqlite");
    const handle = open(dbPath);
    handle.db.run("CREATE TABLE writes (value TEXT NOT NULL)");
    handle.db.run("INSERT INTO writes VALUES ('diagnostics')");

    const sizes = handle.diagnostics().fileSizes;
    expect(sizes.db).toBeGreaterThan(0);
    expect(sizes.wal).toBeGreaterThanOrEqual(0);
    expect(sizes.shm).toBeGreaterThan(0);
    expect(sizes.journal).toBeNull();
    expect(mode(`${dbPath}-wal`)).toBe(0o600);
    expect(mode(`${dbPath}-shm`)).toBe(0o600);
  });

  test("reports passive checkpoint progress and rejects a busy blocking checkpoint", () => {
    const dbPath = join(tempRoot(), "busy-checkpoint.sqlite");
    const writer = open(dbPath, { busyTimeoutMs: 10 });
    writer.db.run("CREATE TABLE records (value TEXT NOT NULL)");
    writer.db.run("INSERT INTO records VALUES ('snapshot')");
    const reader = open(dbPath, { busyTimeoutMs: 10 });
    reader.db.run("BEGIN");
    reader.db.query("SELECT * FROM records").all();
    writer.db.run("INSERT INTO records VALUES ('after-snapshot')");

    const passive = writer.checkpoint("PASSIVE");
    expect(passive.busy).toBe(0);
    expect(passive.log).toBeGreaterThan(0);
    expect(() => writer.checkpoint("TRUNCATE")).toThrow();

    reader.db.run("COMMIT");
    expect(writer.checkpoint("TRUNCATE").busy).toBe(0);
  });

  test("closes idempotently and rejects handle operations after close", () => {
    const handle = open(join(tempRoot(), "closed.sqlite"));
    handle.close();
    expect(() => handle.close()).not.toThrow();

    expect(() => handle.db.run("SELECT 1")).toThrow();
    expect(() => handle.diagnostics()).toThrow(/closed/i);
    expect(() => handle.checkpoint()).toThrow(/closed/i);
    expect(() => handle.secureArtifacts()).toThrow(/closed/i);
  });
});
