import { randomUUID } from "node:crypto";
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, writeFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import {
  openPinnedChildDirectory,
  pinDirectory,
  type PinnedDirectory,
} from "../lib/anchored-files";
import {
  listDirectoryFd,
  renameAt,
  tryLockFileExclusive,
  tryOpenAt,
  unlinkAt,
} from "../lib/posix-at";
import { issueRuntimeDataAdmission } from "../runtime-data-admission";
import {
  RAILWAY_RUNTIME_DATA_ROOT,
  type AdmittedRuntimeVolumeLease,
  type RuntimeDataSelection,
  type SelectRuntimeDataRoot,
} from "../runtime-data-contracts";
import { assertImmutableAgentId } from "./agent-isolation";
import {
  admitRuntimeStateIdentityFd,
  assertNoRuntimeStateRestoreFenceFd,
} from "./runtime-state-bundle";

export { RAILWAY_RUNTIME_DATA_ROOT } from "../runtime-data-contracts";
const AGENT_MAIL_STATE_DIRECTORY = "agent-mail";
export const RUNTIME_SINGLETON_LOCK_FILE = ".auggy-runtime-singleton.lock";

export interface RuntimeVolumeOptions {
  advertisedMount: string | undefined;
  runtimeDataRoot: string;
  agentId?: string;
  /** @internal Deterministic root-replacement barrier for regression tests. */
  __testHooks?: { afterRootPinned?: () => void; beforeCapabilityIssued?: () => void };
}

export interface RuntimeVolumeLease {
  runtimeDataRoot: string;
  release(): void;
}

function validateExplicitRoot(value: string): void {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    !isAbsolute(value) ||
    value.includes("\0")
  ) {
    throw new Error("[runtime-volume] AUGGY_DATA_DIR must be a nonempty absolute filesystem path");
  }
  // pinDirectory canonicalizes benign parent aliases. Reject dot components
  // first so lexical normalization cannot hide a symlink followed by traversal.
  if (value.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error("[runtime-volume] runtime data root must not contain . or .. path components");
  }
}

export const selectRuntimeDataRoot: SelectRuntimeDataRoot = (mode, environment) => {
  const explicit = environment.auggyDataDir;
  if (explicit !== undefined) validateExplicitRoot(explicit);
  if (mode === "railway") {
    if (environment.railwayVolumeMountPath !== RAILWAY_RUNTIME_DATA_ROOT) {
      throw new Error(
        `[runtime-volume] expected RAILWAY_VOLUME_MOUNT_PATH=${RAILWAY_RUNTIME_DATA_ROOT}, got ${environment.railwayVolumeMountPath ?? "unset"}`,
      );
    }
    if (explicit !== undefined && explicit !== RAILWAY_RUNTIME_DATA_ROOT) {
      throw new Error(
        `[runtime-volume] Railway requires AUGGY_DATA_DIR=${RAILWAY_RUNTIME_DATA_ROOT}`,
      );
    }
    return { kind: "railway", runtimeDataRoot: RAILWAY_RUNTIME_DATA_ROOT };
  }
  return explicit === undefined
    ? { kind: "local" }
    : { kind: "explicit", runtimeDataRoot: explicit };
};

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the admission failure that triggered cleanup.
  }
}

function verifyPinnedRootPath(root: PinnedDirectory, configuredPath: string): void {
  const expected = fstatSync(root.fd);
  if (!expected.isDirectory()) throw new Error("runtime data root must be a directory");
  if (typeof process.getuid === "function" && expected.uid !== process.getuid()) {
    throw new Error("runtime data root must be owned by the current user");
  }
  const current = pinDirectory(configuredPath, "[runtime-volume] runtime data root");
  try {
    const stat = fstatSync(current.fd);
    if (
      current.canonical !== root.canonical ||
      stat.dev !== expected.dev ||
      stat.ino !== expected.ino
    ) {
      throw new Error("runtime data root changed during admission");
    }
  } finally {
    closeSync(current.fd);
  }
}

/**
 * Package-private provisioning, called only by explicit Railway admission.
 * No mount creation, ownership change, recursive repair or content mutation.
 * The separate helper lets tests exercise actual default-mode temporary mounts.
 */
export function initializeEmptyRailwayRuntimeMount(
  root: PinnedDirectory,
  configuredPath: string,
): void {
  verifyPinnedRootPath(root, configuredPath);
  if ((fstatSync(root.fd).mode & 0o7777) === 0o700) return;
  const assertEmpty = () => {
    // Reading at most one entry proves emptiness without traversing contents.
    const entries = listDirectoryFd(root.fd, 1);
    if (entries.names.length !== 0 || entries.truncated) {
      throw new Error(
        "[runtime-volume] nonempty Railway mount must already have mode 0700; prepare its ownership and permissions while stopped",
      );
    }
  };
  assertEmpty();
  verifyPinnedRootPath(root, configuredPath);
  assertEmpty();
  fchmodSync(root.fd, 0o700);
  fsyncSync(root.fd);
  verifyPinnedRootPath(root, configuredPath);
  assertEmpty();
  if ((fstatSync(root.fd).mode & 0o7777) !== 0o700) {
    throw new Error("[runtime-volume] Railway mount mode changed during initialization");
  }
}

interface AdmissionOptions extends Omit<RuntimeVolumeOptions, "advertisedMount"> {
  holdSingletonLease: boolean;
  managed: boolean;
  initializeRailwayMount?: boolean;
}

/** Common descriptor-relative identity, singleton and durability admission. */
function admitRuntimeVolume({
  runtimeDataRoot,
  agentId,
  __testHooks,
  holdSingletonLease,
  managed,
  initializeRailwayMount,
}: AdmissionOptions): string | RuntimeVolumeLease | AdmittedRuntimeVolumeLease {
  let root: PinnedDirectory | undefined;
  let directoryFd: number | undefined;
  let singletonFd: number | undefined;
  let probeFd: number | undefined;
  let issued: ReturnType<typeof issueRuntimeDataAdmission> | undefined;
  const probeId = `${process.pid}-${randomUUID()}`;
  const pendingLeaf = `.auggy-volume-probe-${probeId}.pending`;
  const committedLeaf = `.auggy-volume-probe-${probeId}.committed`;
  let ownsPendingProbe = false;
  let ownsCommittedProbe = false;

  try {
    root = pinDirectory(runtimeDataRoot, "[runtime-volume] runtime data root");
    if (initializeRailwayMount) initializeEmptyRailwayRuntimeMount(root, runtimeDataRoot);
    if ((fstatSync(root.fd).mode & 0o7777) !== 0o700) {
      throw new Error(`[runtime-volume] runtime data root must have mode 0700: ${runtimeDataRoot}`);
    }
    __testHooks?.afterRootPinned?.();
    if (managed) verifyPinnedRootPath(root, runtimeDataRoot);

    // Restore reconciliation and immutable identity precede runtime work.
    assertNoRuntimeStateRestoreFenceFd(root.fd);
    if (agentId) admitRuntimeStateIdentityFd(root.fd, agentId);
    if (holdSingletonLease) {
      const oCloexec = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
      const opened = tryOpenAt(
        root.fd,
        RUNTIME_SINGLETON_LOCK_FILE,
        constants.O_RDWR |
          constants.O_CREAT |
          constants.O_NONBLOCK |
          constants.O_NOFOLLOW |
          oCloexec,
        0o600,
      );
      if ("errno" in opened) {
        throw new Error("runtime singleton lock must be a regular non-symlink file");
      }
      singletonFd = opened.fd;
      const singletonStat = fstatSync(singletonFd);
      if (!singletonStat.isFile() || singletonStat.nlink !== 1) {
        throw new Error("runtime singleton lock must be a singly linked regular file");
      }
      if (typeof process.getuid === "function" && singletonStat.uid !== process.getuid()) {
        throw new Error("runtime singleton lock must be owned by the current user");
      }
      fchmodSync(singletonFd, 0o600);
      if (tryLockFileExclusive(singletonFd) === "busy") {
        throw new Error("another live replica owns this agent volume");
      }
    }
    directoryFd = openPinnedChildDirectory(
      root.fd,
      AGENT_MAIL_STATE_DIRECTORY,
      "[runtime-volume] AgentMail state directory",
      true,
      !managed,
    );
    if ((fstatSync(directoryFd).mode & 0o7777) !== 0o700) {
      throw new Error("AgentMail state directory must have mode 0700");
    }
    const probe = tryOpenAt(
      directoryFd,
      pendingLeaf,
      constants.O_WRONLY |
        constants.O_CREAT |
        constants.O_EXCL |
        constants.O_NOFOLLOW |
        ((constants as unknown as Record<string, number>).O_CLOEXEC ?? 0),
      0o600,
    );
    if ("errno" in probe) throw new Error("durability probe could not create an exclusive file");
    probeFd = probe.fd;
    // Record ownership before any write/fsync can fail, so partial probes can
    // be removed without ever deleting a pre-existing or concurrent file.
    ownsPendingProbe = true;
    fchmodSync(probeFd, 0o600);
    writeFileSync(probeFd, `auggy-runtime-volume-probe:${probeId}\n`, "utf8");
    fsyncSync(probeFd);
    closeSync(probeFd);
    probeFd = undefined;
    fsyncSync(directoryFd);
    if (!renameAt(directoryFd, pendingLeaf, directoryFd, committedLeaf)) {
      throw new Error("durability probe rename failed");
    }
    ownsPendingProbe = false;
    ownsCommittedProbe = true;
    fsyncSync(directoryFd);
    if (!unlinkAt(directoryFd, committedLeaf)) {
      throw new Error("durability probe removal failed");
    }
    ownsCommittedProbe = false;
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    directoryFd = undefined;

    if (managed) {
      __testHooks?.beforeCapabilityIssued?.();
      issued = issueRuntimeDataAdmission(root, runtimeDataRoot, agentId!, {
        fd: singletonFd!,
        leaf: RUNTIME_SINGLETON_LOCK_FILE,
      });
    }
    if (!holdSingletonLease) {
      closeSync(root.fd);
      root = undefined;
      return runtimeDataRoot;
    }
  } catch (error) {
    issued?.revoke();
    closeQuietly(probeFd);
    try {
      if (directoryFd !== undefined && ownsPendingProbe) unlinkAt(directoryFd, pendingLeaf);
      if (directoryFd !== undefined && ownsCommittedProbe) unlinkAt(directoryFd, committedLeaf);
    } catch {
      // Preserve the admission failure; cleanup is best effort on a failing volume.
    }
    closeQuietly(directoryFd);
    closeQuietly(root?.fd);
    closeQuietly(singletonFd);
    throw new Error(
      `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let released = false;
  return {
    runtimeDataRoot,
    ...(issued ? { runtimeDataAdmission: issued.admission } : {}),
    release() {
      if (released) return;
      released = true;
      issued?.revoke();
      // Revoke first and attempt both closes even if one descriptor close fails.
      let failure: unknown;
      for (const fd of [root!.fd, singletonFd!]) {
        try {
          closeSync(fd);
        } catch (error) {
          failure ??= error;
        }
      }
      if (failure) throw failure;
    },
  };
}

function verifyLegacyAdvertisedMount(options: RuntimeVolumeOptions): void {
  if (options.advertisedMount !== options.runtimeDataRoot) {
    throw new Error(
      `[runtime-volume] expected RAILWAY_VOLUME_MOUNT_PATH=${options.runtimeDataRoot}, got ${options.advertisedMount ?? "unset"}`,
    );
  }
}

export function prepareRuntimeVolume(options: RuntimeVolumeOptions): string {
  verifyLegacyAdvertisedMount(options);
  return admitRuntimeVolume({ ...options, holdSingletonLease: false, managed: false }) as string;
}

export function prepareRuntimeVolumeLease(options: RuntimeVolumeOptions): RuntimeVolumeLease {
  verifyLegacyAdvertisedMount(options);
  return admitRuntimeVolume({
    ...options,
    holdSingletonLease: true,
    managed: false,
  }) as RuntimeVolumeLease;
}

/** Production admission for an explicitly selected, already provisioned root. */
export function prepareRuntimeDataVolume(
  selection: Exclude<RuntimeDataSelection, { kind: "local" }>,
  agentId: string,
  options: { __testHooks?: RuntimeVolumeOptions["__testHooks"] } = {},
): AdmittedRuntimeVolumeLease {
  if (selection.kind !== "explicit" && selection.kind !== "railway") {
    throw new Error("[runtime-volume] managed admission requires an explicit runtime data root");
  }
  validateExplicitRoot(selection.runtimeDataRoot);
  assertImmutableAgentId(agentId);
  if (selection.kind === "railway" && selection.runtimeDataRoot !== RAILWAY_RUNTIME_DATA_ROOT) {
    throw new Error(
      `[runtime-volume] Railway runtime data root must be ${RAILWAY_RUNTIME_DATA_ROOT}`,
    );
  }
  return admitRuntimeVolume({
    runtimeDataRoot: selection.runtimeDataRoot,
    agentId,
    __testHooks: options.__testHooks,
    holdSingletonLease: true,
    managed: true,
    initializeRailwayMount: selection.kind === "railway",
  }) as AdmittedRuntimeVolumeLease;
}

/** Compatibility entry point; Railway policy remains fixed at /app/data. */
export function prepareRailwayRuntimeVolume(
  advertisedMount: string | undefined,
  agentId: string,
): AdmittedRuntimeVolumeLease {
  const selection = selectRuntimeDataRoot("railway", {
    auggyDataDir: undefined,
    railwayVolumeMountPath: advertisedMount,
  });
  if (selection.kind !== "railway") throw new Error("[runtime-volume] invalid Railway selection");
  return prepareRuntimeDataVolume(selection, agentId);
}
