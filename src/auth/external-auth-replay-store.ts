import { createHash } from "node:crypto";
import { closeSync, fstatSync, fsyncSync, realpathSync, type Stats } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  ANCHORED_DIRECTORY_FLAGS,
  inspectPinnedFile,
  openPinnedChildDirectory,
} from "../lib/anchored-files";
import { duplicateFd, tryOpenAt } from "../lib/posix-at";
import {
  admitOwnedSqliteSchema,
  canonicalSqliteSchemaSql,
  openHardenedSqlite,
  registerOwnedSqlitePath,
  type HardenedSqliteDatabase,
} from "../lib/sqlite";
import { withRuntimeDataAdmission } from "../runtime-data-admission";
import {
  EXTERNAL_AUTH_REPLAY_APPLICATION_ID,
  EXTERNAL_AUTH_REPLAY_BUSY_TIMEOUT_MS,
  EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS,
  EXTERNAL_AUTH_REPLAY_GUARD_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
  EXTERNAL_AUTH_REPLAY_MAX_JTI_BYTES,
  EXTERNAL_AUTH_REPLAY_MAX_JTI_SCALARS,
  EXTERNAL_AUTH_REPLAY_MAX_MANAGED_DATABASES,
  EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS,
  EXTERNAL_AUTH_REPLAY_MAX_UNEXPIRED_ENTRIES,
  EXTERNAL_AUTH_REPLAY_SCHEMA_VERSION,
  type ManagedExternalAuthReplay,
  type ManagedExternalAuthReplayOptions,
  type ManagedReplayClaim,
  type ManagedReplayVerifiedInput,
} from "./external-auth-replay-contracts";
import {
  acquireExternalAuthReplayGuard,
  isReplayTimestamp,
  replayTtlMilliseconds,
  type ExternalAuthReplayTestHooks,
} from "./external-auth-replay-guard";

const label = "external auth replay store";
const artifacts = ["", "-wal", "-shm", "-journal"] as const;
const reserved = [
  EXTERNAL_AUTH_REPLAY_GUARD_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
  ".auggy-state-identity.json",
  ".auggy-restore-fence.json",
  ".auggy-runtime-singleton.lock",
];
const collator = new Intl.Collator("und", {
  usage: "search",
  sensitivity: "base",
  ignorePunctuation: false,
  numeric: false,
});
const schema = [
  `CREATE TABLE external_auth_replay_claims (
    claim_hash TEXT NOT NULL PRIMARY KEY CHECK(length(claim_hash) = 64 AND claim_hash NOT GLOB '*[^0-9a-f]*'),
    expires_at INTEGER NOT NULL CHECK(typeof(expires_at) = 'integer' AND expires_at >= 0 AND expires_at <= ${EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS})
  ) WITHOUT ROWID`,
  "CREATE INDEX external_auth_replay_expiry ON external_auth_replay_claims(expires_at)",
];
const expectedSchema = new Map([
  ["external_auth_replay_claims", canonicalSqliteSchemaSql(schema[0]!)],
  ["external_auth_replay_expiry", canonicalSqliteSchemaSql(schema[1]!)],
]);

function storageError(): Error {
  return new Error("[external-auth-replay] managed database path or storage is unsafe");
}

function hasAudienceControl(value: string): boolean {
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

function contained(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

interface ManagedPath {
  path: string;
  segments: string[];
}
interface PathInventory {
  root: string;
  current: ManagedPath;
  paths: ManagedPath[];
}

function pathInventory(options: ManagedExternalAuthReplayOptions): PathInventory {
  if (
    !Array.isArray(options.managedDbPaths) ||
    options.managedDbPaths.length < 1 ||
    options.managedDbPaths.length > EXTERNAL_AUTH_REPLAY_MAX_MANAGED_DATABASES
  )
    throw storageError();
  const canonicalRoot = realpathSync.native(options.admission.runtimeDataRoot);
  const configuredRoot = resolve(options.admission.runtimeDataRoot);
  const canonicalize = (path: string): ManagedPath => {
    if (
      typeof path !== "string" ||
      !isAbsolute(path) ||
      path.includes("\0") ||
      path.split("/").some((part) => part === "." || part === "..") ||
      /^(?:file|sqlite):/i.test(path)
    )
      throw storageError();
    let canonical: string;
    if (contained(canonicalRoot, path)) canonical = resolve(path);
    else if (contained(configuredRoot, path))
      canonical = join(canonicalRoot, relative(configuredRoot, path));
    else throw storageError();
    const segments = relative(canonicalRoot, canonical).split(sep);
    if (!segments.length || reserved.some((leaf) => collator.compare(segments[0]!, leaf) === 0))
      throw storageError();
    return { path: canonical, segments };
  };
  const current = canonicalize(options.dbPath);
  const paths = [
    ...new Map(
      options.managedDbPaths.map((path) => {
        const resolved = canonicalize(path);
        return [resolved.path, resolved] as const;
      }),
    ).values(),
  ].sort((a, b) => collator.compare(a.path, b.path));
  if (!paths.some((path) => path.path === current.path)) throw storageError();
  const allArtifacts = paths
    .flatMap((path) => artifacts.map((suffix) => `${path.path}${suffix}`))
    .sort(collator.compare);
  for (let i = 1; i < allArtifacts.length; i++) {
    if (collator.compare(allArtifacts[i - 1]!, allArtifacts[i]!) === 0) throw storageError();
  }
  return { root: canonicalRoot, current, paths };
}

/** Every descendant is walked relative to the admitted root, without links. */
function inspectDatabasePath(
  rootFd: number,
  path: ManagedPath,
  createParents = false,
): Stats | null {
  let parentFd = duplicateFd(rootFd);
  try {
    for (const segment of path.segments.slice(0, -1)) {
      let child: number;
      if (createParents) {
        child = openPinnedChildDirectory(parentFd, segment, label, true, false);
        try {
          fsyncSync(parentFd);
        } catch (error) {
          closeSync(child);
          throw error;
        }
      } else {
        const opened = tryOpenAt(parentFd, segment, ANCHORED_DIRECTORY_FLAGS);
        if ("errno" in opened) {
          if (opened.errno === 2) return null;
          throw storageError();
        }
        child = opened.fd;
      }
      closeSync(parentFd);
      parentFd = child;
      const stat = fstatSync(parentFd);
      if (
        !stat.isDirectory() ||
        (stat.mode & 0o7777) !== 0o700 ||
        (typeof process.getuid === "function" && stat.uid !== process.getuid())
      )
        throw storageError();
    }
    let main: Stats | null = null;
    let sidecar = false;
    for (const suffix of artifacts) {
      const opened = inspectPinnedFile(parentFd, `${path.segments.at(-1)!}${suffix}`, label);
      if (!opened) continue;
      try {
        if (suffix === "") main = opened.stat;
        else sidecar = true;
      } finally {
        closeSync(opened.fd);
      }
    }
    if (!main && sidecar) throw storageError();
    return main;
  } finally {
    closeSync(parentFd);
  }
}

/** Reused by transport admission, including deferred completed-response replay. */
export function validateManagedReplayVerifiedInput(
  input: ManagedReplayVerifiedInput,
  nowMs: number,
): Extract<ManagedReplayClaim, { status: "rejected" }> | null {
  const invalid = { status: "rejected", reason: "invalid" } as const;
  if (
    !input ||
    typeof input.audience !== "string" ||
    input.audience.length < 1 ||
    input.audience.length > 256 ||
    hasAudienceControl(input.audience) ||
    typeof input.jti !== "string" ||
    input.jti.length < 1 ||
    input.jti.length > EXTERNAL_AUTH_REPLAY_MAX_JTI_SCALARS * 2 ||
    Buffer.byteLength(input.jti, "utf8") > EXTERNAL_AUTH_REPLAY_MAX_JTI_BYTES ||
    /\p{Cc}/u.test(input.jti)
  )
    return invalid;
  let scalars = 0;
  for (const point of input.jti) {
    const code = point.codePointAt(0)!;
    if ((code >= 0xd800 && code <= 0xdfff) || ++scalars > EXTERNAL_AUTH_REPLAY_MAX_JTI_SCALARS)
      return invalid;
  }
  if (
    !isReplayTimestamp(nowMs) ||
    !isReplayTimestamp(input.issuedAt) ||
    !isReplayTimestamp(input.expiresAt) ||
    input.expiresAt <= input.issuedAt ||
    !isReplayTimestamp(nowMs + EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS)
  )
    return invalid;
  let ttlMs: number;
  try {
    ttlMs = replayTtlMilliseconds(input.maxTtlSeconds);
  } catch {
    return invalid;
  }
  if (
    !isReplayTimestamp(input.issuedAt + ttlMs) ||
    input.expiresAt - input.issuedAt > ttlMs ||
    input.issuedAt > nowMs + EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS
  )
    return invalid;
  if (input.expiresAt <= nowMs) return { status: "rejected", reason: "expired" };
  return null;
}

/** Package-private managed mode; never wraps or owns caller-provided replay stores. */
export function createManagedExternalAuthReplay(
  options: ManagedExternalAuthReplayOptions,
  hooks: ExternalAuthReplayTestHooks = {},
): ManagedExternalAuthReplay {
  const admission = options.admission;
  replayTtlMilliseconds(options.maxTtlSeconds);
  const timeout = hooks.busyTimeoutMs ?? EXTERNAL_AUTH_REPLAY_BUSY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(timeout) ||
    timeout < 1 ||
    timeout > EXTERNAL_AUTH_REPLAY_BUSY_TIMEOUT_MS
  )
    throw storageError();
  const inspected = withRuntimeDataAdmission(admission, (rootFd) => {
    const inventory = pathInventory(options);
    let existing = false;
    for (const path of inventory.paths) if (inspectDatabasePath(rootFd, path)) existing = true;
    return { inventory, existing };
  });
  const inventory = inspected.inventory;
  const guard = acquireExternalAuthReplayGuard(
    {
      admission,
      managedDbPaths: inventory.paths.map((path) => path.path),
      hasExistingManagedState: inspected.existing,
      maxTtlSeconds: options.maxTtlSeconds,
    },
    hooks,
  );
  let database: HardenedSqliteDatabase | undefined;
  let identity: Stats;
  try {
    identity = withRuntimeDataAdmission(admission, (rootFd) => {
      inspectDatabasePath(rootFd, inventory.current, true);
      registerOwnedSqlitePath(inventory.current.path, inventory.root);
      database = openHardenedSqlite({
        path: inventory.current.path,
        label,
        busyTimeoutMs: timeout,
        synchronous: "FULL",
        prepare(db) {
          admitOwnedSqliteSchema(db, {
            label,
            applicationId: EXTERNAL_AUTH_REPLAY_APPLICATION_ID,
            schemaVersion: EXTERNAL_AUTH_REPLAY_SCHEMA_VERSION,
            initialize(target) {
              for (const statement of schema) target.run(statement);
            },
            isLegacy() {
              return false;
            },
            validate(_target, objects) {
              if (
                objects.length !== expectedSchema.size ||
                objects.some(
                  (object) =>
                    expectedSchema.get(object.name) !== canonicalSqliteSchemaSql(object.sql),
                )
              )
                throw storageError();
            },
          });
        },
      });
      const stat = inspectDatabasePath(rootFd, inventory.current);
      if (!stat) throw storageError();
      return stat;
    });
  } catch (error) {
    // Construction may have lost its path authority. Close the native handle
    // without hardened close's path-based artifact chmod in that failure case.
    try {
      database?.db.close();
    } finally {
      guard.close();
    }
    throw error;
  }
  const owned = database!;
  try {
    const db = owned.db;
    let closed = false;
    const prune = db.query("DELETE FROM external_auth_replay_claims WHERE expires_at <= ?");
    const find = db.query<{ claim_hash: string }, [string]>(
      "SELECT claim_hash FROM external_auth_replay_claims WHERE claim_hash = ?",
    );
    const count = db.query<{ total: number }, []>(
      "SELECT COUNT(*) AS total FROM external_auth_replay_claims",
    );
    const insert = db.query(
      "INSERT INTO external_auth_replay_claims(claim_hash, expires_at) VALUES (?, ?)",
    );
    const claim = db.transaction(
      (digest: string, expiresAt: number, nowMs: number): ManagedReplayClaim => {
        prune.run(nowMs);
        if (find.get(digest)) return { status: "rejected", reason: "replay" };
        if (
          (count.get()?.total ?? EXTERNAL_AUTH_REPLAY_MAX_UNEXPIRED_ENTRIES) >=
          EXTERNAL_AUTH_REPLAY_MAX_UNEXPIRED_ENTRIES
        ) {
          return { status: "unavailable", reason: "capacity" };
        }
        insert.run(digest, expiresAt);
        return { status: "consumed" };
      },
    );
    const assertCurrentDatabase = () =>
      withRuntimeDataAdmission(admission, (rootFd) => {
        const stat = inspectDatabasePath(rootFd, inventory.current);
        if (
          !stat ||
          stat.dev !== identity.dev ||
          stat.ino !== identity.ino ||
          (stat.mode & 0o7777) !== 0o600
        )
          throw storageError();
      });
    return {
      checkAvailability(maxTtlSeconds) {
        return guard.run(maxTtlSeconds, (nowMs) => {
          try {
            if (closed) throw storageError();
            assertCurrentDatabase();
            return { status: "ready", nowMs } as const;
          } catch {
            return { status: "unavailable", reason: "storage" } as const;
          }
        });
      },
      consumeVerified(input) {
        // Keep the verified claim and its TTL together while queued for the
        // shared guard; caller mutation cannot change one after admission.
        const verified = { ...input };
        return guard.run(verified.maxTtlSeconds, (nowMs) => {
          const rejected = validateManagedReplayVerifiedInput(verified, nowMs);
          if (rejected) return rejected;
          try {
            if (closed) throw storageError();
            assertCurrentDatabase();
            const digest = createHash("sha256")
              .update(
                JSON.stringify(["auggy.external-auth.replay.v1", verified.audience, verified.jti]),
              )
              .digest("hex");
            const result = claim.immediate(digest, verified.expiresAt, nowMs);
            assertCurrentDatabase();
            return result;
          } catch {
            return { status: "unavailable", reason: "storage" } as const;
          }
        });
      },
      close() {
        if (closed) return;
        closed = true;
        let safePath = false;
        try {
          assertCurrentDatabase();
          safePath = true;
        } catch {
          /* Always close; never chmod through a replaced path. */
        }
        try {
          if (safePath) owned.close();
          else db.close();
        } finally {
          guard.close();
        }
      },
    };
  } catch (error) {
    try {
      owned.db.close();
    } finally {
      guard.close();
    }
    throw error;
  }
}
