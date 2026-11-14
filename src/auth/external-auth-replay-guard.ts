import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeFileSync } from "node:fs";
import { inspectPinnedFile } from "../lib/anchored-files";
import { readFileFdBounded, renameAt, tryOpenAt, unlinkAt } from "../lib/posix-at";
import { withRuntimeDataAdmission } from "../runtime-data-admission";
import type { RuntimeDataAdmission } from "../runtime-data-contracts";
import {
  EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS,
  EXTERNAL_AUTH_REPLAY_GUARD_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
  EXTERNAL_AUTH_REPLAY_GUARD_VERSION,
  EXTERNAL_AUTH_REPLAY_MAX_GUARD_BYTES,
  EXTERNAL_AUTH_REPLAY_MAX_RETRY_AFTER_SECONDS,
  EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS,
  type ExternalAuthReplayGuardV1,
  type ExternalAuthReplayRestoreGuardOptions,
  type ManagedReplayClaim,
  type ReplayAvailability,
} from "./external-auth-replay-contracts";

export type ReplayGuardWriteStage =
  | "opened"
  | "written"
  | "file-synced"
  | "renamed"
  | "directory-synced";
/** Package-private deterministic seams. Production callers omit this argument. */
export interface ExternalAuthReplayTestHooks {
  now?: () => number;
  onGuardWriteStage?: (stage: ReplayGuardWriteStage) => void;
  busyTimeoutMs?: number;
}

type GuardFailure = Exclude<ReplayAvailability, { status: "ready" }>;
type GuardOutcome = ReplayAvailability | ManagedReplayClaim;
const productionClock = () => Date.now();
const clockFailures = new WeakSet<Error>();
const agentIdPattern = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function guardError(): Error {
  return new Error("[external-auth-replay] guard is missing, unsafe or incompatible");
}

function clockError(): Error {
  const error = new Error("[external-auth-replay] clock or timing bound is invalid");
  clockFailures.add(error);
  return error;
}

function sampleClock(clock: () => number): number {
  let value: number;
  try {
    value = clock();
  } catch {
    throw clockError();
  }
  if (!isReplayTimestamp(value)) throw clockError();
  return value;
}

export function isReplayTimestamp(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= EXTERNAL_AUTH_REPLAY_MAX_TIMESTAMP_MS
  );
}

export function replayTtlMilliseconds(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0 || !isReplayTimestamp(seconds * 1_000)) {
    throw clockError();
  }
  return seconds * 1_000;
}

function assertRoot(rootFd: number): void {
  const stat = fstatSync(rootFd);
  if (
    !stat.isDirectory() ||
    (stat.mode & 0o7777) !== 0o700 ||
    (typeof process.getuid === "function" && stat.uid !== process.getuid())
  )
    throw guardError();
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).length === keys.length &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseGuard(bytes: Buffer): ExternalAuthReplayGuardV1 {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw guardError();
  }
  if (
    !exactKeys(raw, ["version", "agentId", "latestRestore", "highWaterMs"]) ||
    raw.version !== EXTERNAL_AUTH_REPLAY_GUARD_VERSION ||
    typeof raw.agentId !== "string" ||
    !agentIdPattern.test(raw.agentId) ||
    !isReplayTimestamp(raw.highWaterMs)
  )
    throw guardError();
  if (raw.latestRestore !== null) {
    if (
      !exactKeys(raw.latestRestore, ["restoreId", "restoredAtMs"]) ||
      typeof raw.latestRestore.restoreId !== "string" ||
      !uuidPattern.test(raw.latestRestore.restoreId) ||
      !isReplayTimestamp(raw.latestRestore.restoredAtMs) ||
      raw.latestRestore.restoredAtMs > raw.highWaterMs
    )
      throw guardError();
  }
  return raw as unknown as ExternalAuthReplayGuardV1;
}

function readControl(rootFd: number, leaf: string): Buffer | null {
  const opened = inspectPinnedFile(rootFd, leaf, "external auth replay control file");
  if (!opened) return null;
  try {
    if (
      (opened.stat.mode & 0o7777) !== 0o600 ||
      opened.stat.size > EXTERNAL_AUTH_REPLAY_MAX_GUARD_BYTES
    )
      throw guardError();
    const read = readFileFdBounded(opened.fd, EXTERNAL_AUTH_REPLAY_MAX_GUARD_BYTES);
    if (read.exceeded) throw guardError();
    return read.buffer;
  } finally {
    closeSync(opened.fd);
  }
}

function requireAgent(guard: ExternalAuthReplayGuardV1, agentId: string): void {
  if (!agentIdPattern.test(agentId) || guard.agentId !== agentId) throw guardError();
}

function sameEpoch(first: ExternalAuthReplayGuardV1, second: ExternalAuthReplayGuardV1): boolean {
  return first.latestRestore === null
    ? second.latestRestore === null
    : second.latestRestore !== null &&
        first.latestRestore.restoreId === second.latestRestore.restoreId &&
        first.latestRestore.restoredAtMs === second.latestRestore.restoredAtMs;
}

/** Read-only backup admission. Pending state is never repaired by inspection. */
export function inspectExternalAuthReplayGuard(
  rootFd: number,
  agentId: string,
  options: { allowMissing?: boolean } = {},
): ExternalAuthReplayGuardV1 | null {
  assertRoot(rootFd);
  if (readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE) !== null) throw guardError();
  const bytes = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_FILE);
  if (bytes === null) {
    if (options.allowMissing) return null;
    throw guardError();
  }
  const guard = parseGuard(bytes);
  requireAgent(guard, agentId);
  return guard;
}

function writeGuard(
  rootFd: number,
  guard: ExternalAuthReplayGuardV1,
  hooks: ExternalAuthReplayTestHooks,
): void {
  const bytes = Buffer.from(JSON.stringify(guard));
  if (bytes.byteLength > EXTERNAL_AUTH_REPLAY_MAX_GUARD_BYTES) throw guardError();
  const opened = tryOpenAt(
    rootFd,
    EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW |
      ((constants as unknown as Record<string, number>).O_CLOEXEC ?? 0),
    0o600,
  );
  if ("errno" in opened) throw guardError();
  try {
    fchmodSync(opened.fd, 0o600);
    hooks.onGuardWriteStage?.("opened");
    writeFileSync(opened.fd, bytes);
    hooks.onGuardWriteStage?.("written");
    fsyncSync(opened.fd);
    hooks.onGuardWriteStage?.("file-synced");
    const retained = fstatSync(opened.fd);
    const current = inspectPinnedFile(
      rootFd,
      EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
      "external auth replay pending guard",
    );
    if (!current) throw guardError();
    try {
      if (
        current.stat.dev !== retained.dev ||
        current.stat.ino !== retained.ino ||
        (current.stat.mode & 0o7777) !== 0o600
      )
        throw guardError();
    } finally {
      closeSync(current.fd);
    }
    // Revalidate the destination immediately before publication. A failed or
    // concurrent write cannot silently replace corrupt state or a newer image.
    const destination = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_FILE);
    if (destination !== null) {
      const currentGuard = parseGuard(destination);
      requireAgent(currentGuard, guard.agentId);
      if (!sameEpoch(currentGuard, guard) || currentGuard.highWaterMs > guard.highWaterMs)
        throw guardError();
    }
    if (
      !renameAt(
        rootFd,
        EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
        rootFd,
        EXTERNAL_AUTH_REPLAY_GUARD_FILE,
      )
    )
      throw guardError();
    hooks.onGuardWriteStage?.("renamed");
    fsyncSync(rootFd);
    hooks.onGuardWriteStage?.("directory-synced");
  } finally {
    closeSync(opened.fd);
    // A failed write intentionally leaves only the exact reserved pending leaf.
    // Ordinary admission refuses partial content; COPYING restore may repair it.
  }
}

function readRuntimeGuard(rootFd: number, agentId: string): ExternalAuthReplayGuardV1 | null {
  const bytes = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_FILE);
  const pendingBytes = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE);
  if (bytes === null) {
    if (pendingBytes !== null) throw guardError();
    return null;
  }
  let guard = parseGuard(bytes);
  requireAgent(guard, agentId);
  if (pendingBytes !== null) {
    const pending = parseGuard(pendingBytes);
    requireAgent(pending, agentId);
    if (!sameEpoch(guard, pending)) throw guardError();
    if (pending.highWaterMs >= guard.highWaterMs) {
      const opened = inspectPinnedFile(
        rootFd,
        EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
        "external auth replay pending guard",
      );
      if (!opened) throw guardError();
      try {
        fsyncSync(opened.fd);
      } finally {
        closeSync(opened.fd);
      }
      if (
        !renameAt(
          rootFd,
          EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
          rootFd,
          EXTERNAL_AUTH_REPLAY_GUARD_FILE,
        )
      )
        throw guardError();
      guard = pending;
    } else if (!unlinkAt(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE)) throw guardError();
    fsyncSync(rootFd);
  }
  return guard;
}

function validateTime(
  guard: ExternalAuthReplayGuardV1,
  nowMs: number,
  ttlSeconds: number,
): number | null {
  const ttlMs = replayTtlMilliseconds(ttlSeconds);
  if (
    !isReplayTimestamp(nowMs) ||
    nowMs < guard.highWaterMs ||
    !isReplayTimestamp(nowMs + ttlMs + EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS)
  )
    throw clockError();
  if (guard.latestRestore === null) return null;
  const barrier = guard.latestRestore.restoredAtMs + ttlMs + EXTERNAL_AUTH_REPLAY_FUTURE_SKEW_MS;
  if (!isReplayTimestamp(barrier)) throw clockError();
  return barrier;
}

/**
 * Offline restore only. Caller must first validate the actual COPYING fence and
 * exact destination file set, and pass that fence's original ID/time unchanged.
 */
export function ensureRestoredExternalAuthReplayGuard(
  rootFd: number,
  options: ExternalAuthReplayRestoreGuardOptions,
  hooks: ExternalAuthReplayTestHooks = {},
): void {
  assertRoot(rootFd);
  if (
    !agentIdPattern.test(options.agentId) ||
    !uuidPattern.test(options.restore.restoreId) ||
    !isReplayTimestamp(options.restore.restoredAtMs)
  )
    throw guardError();
  const currentBytes = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_FILE);
  const pendingBytes = readControl(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE);
  let highWater = options.restore.restoredAtMs;
  let currentHighWater = -1;
  let pending: ExternalAuthReplayGuardV1 | undefined;
  const expected: ExternalAuthReplayGuardV1 = {
    version: EXTERNAL_AUTH_REPLAY_GUARD_VERSION,
    agentId: options.agentId,
    latestRestore: { ...options.restore },
    highWaterMs: highWater,
  };
  if (currentBytes !== null) {
    const current = parseGuard(currentBytes);
    requireAgent(current, options.agentId);
    if (!sameEpoch(current, expected)) throw guardError();
    highWater = Math.max(highWater, current.highWaterMs);
    currentHighWater = current.highWaterMs;
  }
  if (pendingBytes !== null) {
    try {
      pending = parseGuard(pendingBytes);
    } catch {
      /* Partial COPYING write: no ingress was admitted. */
    }
    if (pending) {
      requireAgent(pending, options.agentId);
      if (!sameEpoch(pending, expected)) throw guardError();
      highWater = Math.max(highWater, pending.highWaterMs);
    }
  }
  const nowMs = sampleClock(hooks.now ?? productionClock);
  if (!isReplayTimestamp(nowMs) || nowMs < highWater) throw clockError();
  // No control mutation occurs until all existing metadata, final state, epoch
  // and trusted time have passed validation.
  if (pendingBytes !== null) {
    if (pending && pending.highWaterMs >= currentHighWater) {
      const opened = inspectPinnedFile(
        rootFd,
        EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
        "external auth replay pending guard",
      );
      if (!opened) throw guardError();
      try {
        fsyncSync(opened.fd);
      } finally {
        closeSync(opened.fd);
      }
      if (
        !renameAt(
          rootFd,
          EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE,
          rootFd,
          EXTERNAL_AUTH_REPLAY_GUARD_FILE,
        )
      )
        throw guardError();
    } else if (!unlinkAt(rootFd, EXTERNAL_AUTH_REPLAY_GUARD_PENDING_FILE)) throw guardError();
    fsyncSync(rootFd);
  }
  writeGuard(rootFd, { ...expected, highWaterMs: Math.max(highWater, nowMs) }, hooks);
}

interface Coordinator {
  readonly admission: RuntimeDataAdmission;
  readonly paths: string;
  readonly now: () => number;
  readonly writeHook: ExternalAuthReplayTestHooks["onGuardWriteStage"];
  state: ExternalAuthReplayGuardV1;
  references: number;
  pending: number;
  tail: Promise<void>;
}
const coordinators = new Map<string, Coordinator>();

export interface ExternalAuthReplayGuardLease {
  run<T extends GuardOutcome>(
    maxTtlSeconds: number,
    operation: (nowMs: number) => T,
  ): Promise<T | GuardFailure>;
  close(): void;
}

/** Internal store handoff; inventory was independently inspected before any DB open. */
export function acquireExternalAuthReplayGuard(
  options: {
    admission: RuntimeDataAdmission;
    managedDbPaths: readonly string[];
    hasExistingManagedState: boolean;
    maxTtlSeconds: number;
  },
  hooks: ExternalAuthReplayTestHooks = {},
): ExternalAuthReplayGuardLease {
  const clock = hooks.now ?? productionClock;
  if (
    typeof clock !== "function" ||
    (hooks.onGuardWriteStage !== undefined && typeof hooks.onGuardWriteStage !== "function")
  )
    throw guardError();
  const key = withRuntimeDataAdmission(options.admission, (rootFd) => {
    const stat = fstatSync(rootFd);
    return `${stat.dev}:${stat.ino}`;
  });
  const paths = JSON.stringify([...options.managedDbPaths].sort());
  let coordinator = coordinators.get(key);
  if (
    coordinator &&
    (coordinator.admission !== options.admission ||
      coordinator.paths !== paths ||
      coordinator.now !== clock ||
      coordinator.writeHook !== hooks.onGuardWriteStage)
  ) {
    throw new Error("[external-auth-replay] shared guard dependencies disagree");
  }
  const observed = withRuntimeDataAdmission(options.admission, (rootFd) => {
    let guard = readRuntimeGuard(rootFd, options.admission.agentId);
    if (!guard) {
      if (coordinator || options.hasExistingManagedState) throw guardError();
      const nowMs = sampleClock(clock);
      guard = {
        version: EXTERNAL_AUTH_REPLAY_GUARD_VERSION,
        agentId: options.admission.agentId,
        latestRestore: null,
        highWaterMs: nowMs,
      };
      validateTime(guard, nowMs, options.maxTtlSeconds);
      writeGuard(rootFd, guard, hooks);
    } else {
      if (
        coordinator &&
        (!sameEpoch(guard, coordinator.state) || guard.highWaterMs < coordinator.state.highWaterMs)
      )
        throw guardError();
      validateTime(guard, sampleClock(clock), options.maxTtlSeconds);
    }
    return guard;
  });
  if (!coordinator) {
    coordinator = {
      admission: options.admission,
      paths,
      now: clock,
      writeHook: hooks.onGuardWriteStage,
      state: observed,
      references: 0,
      pending: 0,
      tail: Promise.resolve(),
    };
    coordinators.set(key, coordinator);
  } else coordinator.state = observed;
  const shared = coordinator;
  shared.references++;
  let closed = false;
  const collect = () => {
    if (shared.references === 0 && shared.pending === 0 && coordinators.get(key) === shared)
      coordinators.delete(key);
  };
  return {
    run<T extends GuardOutcome>(
      maxTtlSeconds: number,
      operation: (nowMs: number) => T,
    ): Promise<T | GuardFailure> {
      if (closed) return Promise.resolve({ status: "unavailable", reason: "storage" });
      shared.pending++;
      const task = shared.tail.then((): GuardOutcome => {
        if (closed) return { status: "unavailable", reason: "storage" } as const;
        try {
          return withRuntimeDataAdmission<GuardOutcome>(shared.admission, (rootFd) => {
            const nowMs = sampleClock(shared.now);
            const guard = readRuntimeGuard(rootFd, shared.admission.agentId);
            if (!guard) throw guardError();
            if (!sameEpoch(guard, shared.state) || guard.highWaterMs < shared.state.highWaterMs)
              throw guardError();
            const barrier = validateTime(guard, nowMs, maxTtlSeconds);
            const next = { ...guard, highWaterMs: nowMs };
            writeGuard(rootFd, next, { onGuardWriteStage: shared.writeHook });
            shared.state = next;
            if (barrier !== null && nowMs < barrier)
              return {
                status: "held",
                retryAfterSeconds: Math.max(
                  1,
                  Math.min(
                    EXTERNAL_AUTH_REPLAY_MAX_RETRY_AFTER_SECONDS,
                    Math.ceil((barrier - nowMs) / 1_000),
                  ),
                ),
              } as const;
            return operation(nowMs);
          });
        } catch (error) {
          return {
            status: "unavailable",
            reason: error instanceof Error && clockFailures.has(error) ? "clock" : "guard",
          } as const;
        }
      });
      shared.tail = task.then(
        () => {
          shared.pending--;
          collect();
        },
        () => {
          shared.pending--;
          collect();
        },
      );
      // The serialized section returns only operation's T or a guard failure.
      return task as Promise<T | GuardFailure>;
    },
    close() {
      if (closed) return;
      closed = true;
      shared.references--;
      collect();
    },
  };
}
