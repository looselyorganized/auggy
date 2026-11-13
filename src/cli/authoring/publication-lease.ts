import { closeSync, constants, fchmodSync, fstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import {
  mkdirAt,
  openAbsoluteDirectoryNoFollow,
  openAt,
  tryLockFileExclusive,
  tryOpenAt,
} from "../../lib/posix-at";
import type { ProjectMutationLease } from "./contracts";
import { canonicalProject, fail } from "./publication-common";

const closeOnExec = process.platform === "darwin" ? 0x1000000 : 0x80000;
export const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | closeOnExec;
export const FILE_FLAGS = constants.O_NOFOLLOW | constants.O_NONBLOCK | closeOnExec;
export interface LeaseState {
  readonly projectDir: string;
  readonly rootFd: number;
  readonly privateFd: number;
  readonly lockFd: number;
  readonly dev: string;
  readonly ino: string;
  released: boolean;
}
const leases = new WeakMap<ProjectMutationLease, LeaseState>();
const held = new Set<string>();

function checkOwned(fd: number, directory: boolean): void {
  const stat = fstatSync(fd);
  if (
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (process.getuid && stat.uid !== process.getuid()) ||
    (stat.mode & 0o777) !== (directory ? 0o700 : 0o600) ||
    (!directory && stat.nlink !== 1)
  ) {
    fail("publication-lock", "The private authoring lock directory or lock file is unsafe.");
  }
}

/** Stable inode flock; no PID records, heartbeat expiry, stealing, or unlink-on-release. */
export function acquireProjectMutationLease(projectDir: string): ProjectMutationLease {
  const canonical = canonicalProject(projectDir);
  if (held.has(canonical))
    fail(
      "publication-busy",
      "Another authoring operation holds this project lease; retry after it finishes.",
    );
  let rootFd: number | undefined;
  let privateFd: number | undefined;
  let lockFd: number | undefined;
  try {
    rootFd = openAbsoluteDirectoryNoFollow(canonical);
    mkdirAt(rootFd, ".auggy", 0o700);
    privateFd = openAt(rootFd, ".auggy", DIRECTORY_FLAGS);
    const privateStat = fstatSync(privateFd);
    if (
      privateStat.isDirectory() &&
      (!process.getuid || privateStat.uid === process.getuid()) &&
      (privateStat.mode & 0o777) === 0o755
    )
      fchmodSync(privateFd, 0o700);
    checkOwned(privateFd, true);
    const created = tryOpenAt(
      privateFd,
      "authoring.lock",
      constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | FILE_FLAGS,
      0o600,
    );
    if ("fd" in created) {
      lockFd = created.fd;
      fchmodSync(lockFd, 0o600);
    } else if (created.errno === 17)
      lockFd = openAt(privateFd, "authoring.lock", constants.O_RDWR | FILE_FLAGS);
    else fail("publication-lock", "The stable authoring lock could not be opened safely.");
    checkOwned(lockFd, false);
    if (tryLockFileExclusive(lockFd) === "busy")
      fail(
        "publication-busy",
        "Another authoring operation holds this project lease; retry after it finishes.",
      );
    const root = fstatSync(rootFd, { bigint: true });
    const state: LeaseState = {
      projectDir: canonical,
      rootFd,
      privateFd,
      lockFd,
      dev: String(root.dev),
      ino: String(root.ino),
      released: false,
    };
    const lease = Object.freeze({
      projectDir: canonical,
      release() {
        if (state.released) return;
        state.released = true;
        held.delete(canonical);
        for (const fd of [state.lockFd, state.privateFd, state.rootFd]) closeSync(fd);
      },
    }) as ProjectMutationLease;
    leases.set(lease, state);
    validateProjectLease(lease, canonical);
    held.add(canonical);
    return lease;
  } catch (error) {
    for (const fd of [lockFd, privateFd, rootFd])
      if (fd !== undefined) {
        try {
          closeSync(fd);
        } catch {}
      }
    if (error instanceof Error && error.name === "AuthoringError") throw error;
    return fail("publication-lock", "The project authoring lease could not be acquired safely.");
  }
}

export function validateProjectLease(lease: ProjectMutationLease, projectDir: string): LeaseState {
  const state = leases.get(lease);
  if (!state || state.released || state.projectDir !== projectDir)
    fail("publication-lease", "A live authoring lease for this exact project is required.");
  let rootFd: number | undefined;
  let privateFd: number | undefined;
  let lockFd: number | undefined;
  try {
    if (realpathSync.native(projectDir) !== state.projectDir) throw new Error();
    rootFd = openAbsoluteDirectoryNoFollow(projectDir);
    privateFd = openAt(rootFd, ".auggy", DIRECTORY_FLAGS);
    const lock = tryOpenAt(privateFd, "authoring.lock", constants.O_RDONLY | FILE_FLAGS);
    if (!("fd" in lock)) throw new Error();
    lockFd = lock.fd;
    for (const [actual, expected] of [
      [rootFd, state.rootFd],
      [privateFd, state.privateFd],
      [lockFd, state.lockFd],
    ]) {
      const a = fstatSync(actual!, { bigint: true });
      const b = fstatSync(expected!, { bigint: true });
      if (a.dev !== b.dev || a.ino !== b.ino) throw new Error();
    }
    checkOwned(privateFd, true);
    checkOwned(lockFd, false);
    return state;
  } catch {
    return fail(
      "publication-lease",
      "The project or stable authoring lock identity changed; recovery requires manual review.",
    );
  } finally {
    for (const fd of [lockFd, privateFd, rootFd]) if (fd !== undefined) closeSync(fd);
  }
}

export function receiptDirectory(projectDir: string, operationId: string): string {
  return join(projectDir, ".auggy", "operations", operationId);
}
