import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  realpathSync,
} from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { constants, Database } from "bun:sqlite";

const DEFAULT_BUSY_TIMEOUT_MS = 5_000;
const DEFAULT_WAL_AUTOCHECKPOINT_PAGES = 1_000;
const DEFAULT_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;
const SQLITE_ARTIFACT_SUFFIXES = ["", "-wal", "-shm", "-journal"] as const;

export interface HardenedSqliteOptions {
  path: string;
  label: string;
  create?: boolean;
  /**
   * Opens database content with SQLite OPEN_READONLY. This is not forensic
   * filesystem immutability: SQLite WAL readers may update an existing -shm.
   */
  readonly?: boolean;
  foreignKeys?: boolean;
  busyTimeoutMs?: number;
  synchronous?: "FULL" | "NORMAL";
  quickCheck?: boolean;
  /**
   * Synchronous identity admission and migration hook. It runs after connection
   * safety settings and quick_check, but before WAL is enabled, so an unrelated
   * database can be rejected without changing its journal mode. The helper
   * owns the surrounding transaction; the hook must not end or replace it.
   */
  prepare?: (db: Database, context: SqlitePrepareContext) => void;
}

export interface SqlitePrepareContext {
  path: string;
  persistent: boolean;
  readonly: boolean;
  created: boolean;
}

export interface SqliteCheckpointResult {
  busy: number;
  log: number;
  checkpointed: number;
}

export interface SqliteDiagnostics {
  path: string;
  persistent: boolean;
  readonly: boolean;
  journalMode: string;
  synchronous: "full" | "normal" | "off" | "extra" | "unknown";
  busyTimeoutMs: number;
  foreignKeys: boolean;
  trustedSchema: boolean;
  pageCount: number;
  pageSize: number;
  quickCheck: "ok";
  walAutoCheckpoint: number;
  journalSizeLimit: number;
  fileSizes: {
    db: number | null;
    wal: number | null;
    shm: number | null;
    journal: number | null;
  };
}

export interface HardenedSqliteDatabase {
  db: Database;
  path: string;
  persistent: boolean;
  diagnostics(): SqliteDiagnostics;
  checkpoint(mode?: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE"): SqliteCheckpointResult;
  secureArtifacts(): void;
  /** Closes reliably; callers that require a checkpoint must request it first. */
  close(): void;
}

function contextualError(label: string, message: string, error?: unknown): Error {
  return new Error(`${label}: ${message}${error ? `: ${(error as Error).message}` : ""}`, {
    cause: error,
  });
}

function validateOptions(options: HardenedSqliteOptions): {
  busyTimeoutMs: number;
  synchronous: "FULL" | "NORMAL";
} {
  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_BUSY_TIMEOUT_MS;
  if (!Number.isSafeInteger(busyTimeoutMs) || busyTimeoutMs < 1 || busyTimeoutMs > 60_000) {
    throw contextualError(options.label, "busyTimeoutMs must be an integer from 1 to 60000");
  }
  return { busyTimeoutMs, synchronous: options.synchronous ?? "FULL" };
}

function canonicalPersistentPath(configuredPath: string, create: boolean, label: string): string {
  const lexicalPath = resolve(configuredPath);
  const parent = dirname(lexicalPath);
  if (create) mkdirSync(parent, { recursive: true, mode: 0o700 });
  let canonicalParent: string;
  try {
    canonicalParent = realpathSync.native(parent);
  } catch (error) {
    throw contextualError(label, `database parent does not exist: ${parent}`, error);
  }
  const parentStat = lstatSync(canonicalParent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) {
    throw contextualError(label, `database parent must be a real directory: ${canonicalParent}`);
  }
  if ((parentStat.mode & 0o022) !== 0) {
    throw contextualError(
      label,
      `database parent must not be group- or world-writable: ${canonicalParent}`,
    );
  }
  return join(canonicalParent, basename(lexicalPath));
}

function descriptorForArtifact(path: string, label: string): number | undefined {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat) return undefined;
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw contextualError(label, `SQLite artifact must be a regular non-symlink file: ${path}`);
  }
  if (stat.nlink !== 1) {
    throw contextualError(label, `SQLite artifact must not be hard-linked: ${path}`);
  }
  const fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  const descriptorStat = fstatSync(fd);
  if (
    !descriptorStat.isFile() ||
    descriptorStat.nlink !== 1 ||
    descriptorStat.dev !== stat.dev ||
    descriptorStat.ino !== stat.ino
  ) {
    closeSync(fd);
    throw contextualError(label, `SQLite artifact changed during admission: ${path}`);
  }
  if (typeof process.getuid === "function" && descriptorStat.uid !== process.getuid()) {
    closeSync(fd);
    throw contextualError(label, `SQLite artifact must be owned by the current user: ${path}`);
  }
  return fd;
}

function admitArtifacts(path: string, label: string, mutateModes: boolean): void {
  for (const suffix of SQLITE_ARTIFACT_SUFFIXES) {
    const candidate = `${path}${suffix}`;
    const fd = descriptorForArtifact(candidate, label);
    if (fd === undefined) continue;
    try {
      const mode = fstatSync(fd).mode & 0o777;
      if (mutateModes) fchmodSync(fd, 0o600);
      else if (mode !== 0o600) {
        throw contextualError(label, `readonly SQLite artifact must have mode 0600: ${candidate}`);
      }
    } finally {
      closeSync(fd);
    }
  }
}

function precreateDatabase(path: string, label: string): boolean {
  if (lstatSync(path, { throwIfNoEntry: false })) return false;
  const parentFd = openSync(
    dirname(path),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW,
  );
  let fd: number | undefined;
  try {
    fd = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    fchmodSync(fd, 0o600);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    fsyncSync(parentFd);
    return true;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    throw contextualError(label, `failed to securely create ${path}`, error);
  } finally {
    closeSync(parentFd);
  }
}

function scalarNumber(db: Database, pragma: string, key: string, label: string): number {
  const row = db.query(pragma).get() as Record<string, unknown> | null;
  const value = row?.[key];
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw contextualError(label, `unexpected result from ${pragma}`);
  }
  return value;
}

function quickCheck(db: Database, label: string): void {
  const rows = db.query("PRAGMA quick_check(1)").all() as Array<Record<string, unknown>>;
  const values = rows.flatMap((row) => Object.values(row));
  if (values.length !== 1 || values[0] !== "ok") {
    throw contextualError(label, `SQLite quick_check failed: ${values.join("; ") || "no result"}`);
  }
}

function artifactSize(path: string): number | null {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  return stat?.isFile() ? stat.size : null;
}

export function openHardenedSqlite(options: HardenedSqliteOptions): HardenedSqliteDatabase {
  const { busyTimeoutMs, synchronous } = validateOptions(options);
  const readonly = options.readonly === true;
  const create = options.create ?? !readonly;
  if (readonly && create) {
    throw contextualError(options.label, "readonly and create cannot both be enabled");
  }
  const persistent = options.path !== ":memory:";
  const path = persistent
    ? canonicalPersistentPath(options.path, create, options.label)
    : options.path;

  let created = false;
  if (persistent) {
    if (create) created = precreateDatabase(path, options.label);
    else if (!lstatSync(path, { throwIfNoEntry: false })) {
      throw contextualError(options.label, `database does not exist: ${path}`);
    }
    admitArtifacts(path, options.label, !readonly);
  }

  let db: Database | undefined;
  let closed = false;
  try {
    const flags = readonly
      ? constants.SQLITE_OPEN_READONLY | constants.SQLITE_OPEN_NOFOLLOW
      : persistent
        ? constants.SQLITE_OPEN_READWRITE | constants.SQLITE_OPEN_NOFOLLOW
        : { create: true };
    db = new Database(path, flags);
    db.run(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
    db.run(`PRAGMA synchronous = ${synchronous}`);
    db.run(`PRAGMA foreign_keys = ${options.foreignKeys === false ? "OFF" : "ON"}`);
    db.run("PRAGMA trusted_schema = OFF");

    const expectedSynchronous = synchronous === "FULL" ? 2 : 1;
    if (
      scalarNumber(db, "PRAGMA synchronous", "synchronous", options.label) !== expectedSynchronous
    ) {
      throw contextualError(options.label, `SQLite synchronous=${synchronous} was not applied`);
    }
    const expectedForeignKeys = options.foreignKeys === false ? 0 : 1;
    if (
      scalarNumber(db, "PRAGMA foreign_keys", "foreign_keys", options.label) !== expectedForeignKeys
    ) {
      throw contextualError(options.label, "SQLite foreign_keys setting was not applied");
    }
    if (scalarNumber(db, "PRAGMA trusted_schema", "trusted_schema", options.label) !== 0) {
      throw contextualError(options.label, "SQLite trusted_schema=OFF was not applied");
    }
    if (scalarNumber(db, "PRAGMA busy_timeout", "timeout", options.label) !== busyTimeoutMs) {
      throw contextualError(options.label, "SQLite busy_timeout setting was not applied");
    }

    if (options.quickCheck !== false) quickCheck(db, options.label);
    if (options.prepare) {
      db.run(readonly ? "BEGIN" : "BEGIN IMMEDIATE");
      try {
        const prepareResult = options.prepare(db, {
          path,
          persistent,
          readonly,
          created,
        }) as unknown;
        if (prepareResult && typeof (prepareResult as PromiseLike<unknown>).then === "function") {
          throw contextualError(options.label, "SQLite prepare hook must be synchronous");
        }
        if (!db.inTransaction) {
          throw contextualError(
            options.label,
            "SQLite prepare hook ended its admission transaction",
          );
        }
        if (options.quickCheck !== false) quickCheck(db, options.label);
        db.run("COMMIT");
      } catch (error) {
        if (db.inTransaction) {
          try {
            db.run("ROLLBACK");
          } catch {
            // Preserve the admission or migration failure.
          }
        }
        throw error;
      }
    }

    if (!readonly && persistent) {
      const row = db.query("PRAGMA journal_mode = WAL").get() as {
        journal_mode?: unknown;
      } | null;
      if (row?.journal_mode !== "wal") {
        throw contextualError(
          options.label,
          `SQLite WAL mode is required, got ${String(row?.journal_mode)}`,
        );
      }
      db.run(`PRAGMA wal_autocheckpoint = ${DEFAULT_WAL_AUTOCHECKPOINT_PAGES}`);
      db.run(`PRAGMA journal_size_limit = ${DEFAULT_JOURNAL_SIZE_LIMIT_BYTES}`);
      if (
        scalarNumber(db, "PRAGMA wal_autocheckpoint", "wal_autocheckpoint", options.label) !==
        DEFAULT_WAL_AUTOCHECKPOINT_PAGES
      ) {
        throw contextualError(options.label, "SQLite wal_autocheckpoint setting was not applied");
      }
      if (
        scalarNumber(db, "PRAGMA journal_size_limit", "journal_size_limit", options.label) !==
        DEFAULT_JOURNAL_SIZE_LIMIT_BYTES
      ) {
        throw contextualError(options.label, "SQLite journal_size_limit setting was not applied");
      }
    }
    if (persistent) admitArtifacts(path, options.label, !readonly);
  } catch (error) {
    try {
      db?.close();
    } catch {
      // Preserve the admission/configuration failure.
    }
    throw error;
  }

  function assertOpen(): Database {
    if (closed || !db) throw contextualError(options.label, "database is closed");
    return db;
  }

  function secureArtifacts(): void {
    assertOpen();
    if (persistent) admitArtifacts(path, options.label, !readonly);
  }

  function checkpoint(
    mode: "PASSIVE" | "FULL" | "RESTART" | "TRUNCATE" = "PASSIVE",
  ): SqliteCheckpointResult {
    if (readonly || !persistent) {
      throw contextualError(options.label, "checkpoint requires a writable persistent database");
    }
    const row = assertOpen().query(`PRAGMA wal_checkpoint(${mode})`).get() as {
      busy?: unknown;
      log?: unknown;
      checkpointed?: unknown;
    } | null;
    if (
      typeof row?.busy !== "number" ||
      typeof row.log !== "number" ||
      typeof row.checkpointed !== "number"
    ) {
      throw contextualError(options.label, "unexpected wal_checkpoint result");
    }
    if (mode !== "PASSIVE" && row.busy !== 0) {
      throw contextualError(options.label, `wal_checkpoint(${mode}) remained busy`);
    }
    if (persistent) admitArtifacts(path, options.label, !readonly);
    return { busy: row.busy, log: row.log, checkpointed: row.checkpointed };
  }

  function diagnostics(): SqliteDiagnostics {
    const current = assertOpen();
    const journalRow = current.query("PRAGMA journal_mode").get() as {
      journal_mode?: unknown;
    } | null;
    const synchronousValue = scalarNumber(
      current,
      "PRAGMA synchronous",
      "synchronous",
      options.label,
    );
    const synchronousName =
      synchronousValue === 0
        ? "off"
        : synchronousValue === 1
          ? "normal"
          : synchronousValue === 2
            ? "full"
            : synchronousValue === 3
              ? "extra"
              : "unknown";
    quickCheck(current, options.label);
    return {
      path,
      persistent,
      readonly,
      journalMode: String(journalRow?.journal_mode ?? "unknown"),
      synchronous: synchronousName,
      busyTimeoutMs: scalarNumber(current, "PRAGMA busy_timeout", "timeout", options.label),
      foreignKeys:
        scalarNumber(current, "PRAGMA foreign_keys", "foreign_keys", options.label) === 1,
      trustedSchema:
        scalarNumber(current, "PRAGMA trusted_schema", "trusted_schema", options.label) === 1,
      pageCount: scalarNumber(current, "PRAGMA page_count", "page_count", options.label),
      pageSize: scalarNumber(current, "PRAGMA page_size", "page_size", options.label),
      quickCheck: "ok",
      walAutoCheckpoint: scalarNumber(
        current,
        "PRAGMA wal_autocheckpoint",
        "wal_autocheckpoint",
        options.label,
      ),
      journalSizeLimit: scalarNumber(
        current,
        "PRAGMA journal_size_limit",
        "journal_size_limit",
        options.label,
      ),
      fileSizes: persistent
        ? {
            db: artifactSize(path),
            wal: artifactSize(`${path}-wal`),
            shm: artifactSize(`${path}-shm`),
            journal: artifactSize(`${path}-journal`),
          }
        : { db: null, wal: null, shm: null, journal: null },
    };
  }

  function close(): void {
    if (closed) return;
    let failure: unknown;
    // Checkpointing is deliberately explicit. Prepared/cached statements or a
    // concurrent reader can make even a passive checkpoint busy; close must
    // still release this handle reliably during shutdown and error unwinding.
    try {
      assertOpen().close();
    } catch (error) {
      failure ??= error;
    } finally {
      closed = true;
    }
    try {
      if (persistent) admitArtifacts(path, options.label, !readonly);
    } catch (error) {
      failure ??= error;
    }
    if (failure) throw failure;
  }

  return { db, path, persistent, diagnostics, checkpoint, secureArtifacts, close };
}
