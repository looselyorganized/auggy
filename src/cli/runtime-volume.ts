import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  renameSync,
  unlinkSync,
  writeSync,
  type Stats,
} from "node:fs";
import { join } from "node:path";

export const RAILWAY_RUNTIME_DATA_ROOT = "/app/data";
const AGENT_MAIL_STATE_DIRECTORY = "agent-mail";

export interface RuntimeVolumeOptions {
  advertisedMount: string | undefined;
  runtimeDataRoot: string;
}

function removeIfPresent(path: string): void {
  try {
    unlinkSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the admission failure that triggered cleanup.
  }
}

function assertRealDirectory(path: string, label: string): Stats {
  let stat: Stats;
  try {
    stat = lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`[runtime-volume] ${label} does not exist: ${path}`, { cause: error });
    }
    throw error;
  }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`[runtime-volume] ${label} must be a real directory: ${path}`);
  }
  return stat;
}

function assertCurrentOwner(stat: Stats, path: string, label: string): void {
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(
      `[runtime-volume] ${label} must be owned by runtime uid ${process.getuid()}: ${path}`,
    );
  }
}

/**
 * Admit a deployment-owned runtime volume and prove its AgentMail state leaf
 * supports the durability operations used by SQLite and atomic JSON files.
 */
export function prepareRuntimeVolume({
  advertisedMount,
  runtimeDataRoot,
}: RuntimeVolumeOptions): string {
  if (advertisedMount !== runtimeDataRoot) {
    throw new Error(
      `[runtime-volume] expected RAILWAY_VOLUME_MOUNT_PATH=${runtimeDataRoot}, got ${advertisedMount ?? "unset"}`,
    );
  }
  assertRealDirectory(runtimeDataRoot, "runtime data root");

  const stateDir = join(runtimeDataRoot, AGENT_MAIL_STATE_DIRECTORY);
  let directoryFd: number | undefined;
  try {
    mkdirSync(stateDir, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
      throw new Error(
        `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
        { cause: error },
      );
    }
  }
  try {
    assertRealDirectory(stateDir, "AgentMail state directory");
    directoryFd = openSync(
      stateDir,
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    let stateStat = fstatSync(directoryFd);
    if (!stateStat.isDirectory()) {
      throw new Error(`AgentMail state path changed during admission: ${stateDir}`);
    }
    assertCurrentOwner(stateStat, stateDir, "AgentMail state directory");
    fchmodSync(directoryFd, 0o700);
    stateStat = fstatSync(directoryFd);
    assertCurrentOwner(stateStat, stateDir, "AgentMail state directory");
    const stateMode = stateStat.mode & 0o777;
    if (stateMode !== 0o700) {
      throw new Error(`AgentMail state directory must have mode 0700: ${stateDir}`);
    }
  } catch (error) {
    closeQuietly(directoryFd);
    throw new Error(
      `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const probeId = `${process.pid}-${randomUUID()}`;
  const pendingPath = join(stateDir, `.auggy-volume-probe-${probeId}.pending`);
  const committedPath = join(stateDir, `.auggy-volume-probe-${probeId}.committed`);
  let probeFd: number | undefined;
  let ownsPendingProbe = false;
  let ownsCommittedProbe = false;

  try {
    probeFd = openSync(
      pendingPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    ownsPendingProbe = true;
    writeSync(probeFd, `auggy-runtime-volume-probe:${probeId}\n`);
    fsyncSync(probeFd);
    closeSync(probeFd);
    probeFd = undefined;

    renameSync(pendingPath, committedPath);
    ownsPendingProbe = false;
    ownsCommittedProbe = true;
    fsyncSync(directoryFd);
    unlinkSync(committedPath);
    ownsCommittedProbe = false;
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    directoryFd = undefined;
  } catch (error) {
    closeQuietly(probeFd);
    closeQuietly(directoryFd);
    try {
      if (ownsPendingProbe) removeIfPresent(pendingPath);
      if (ownsCommittedProbe) removeIfPresent(committedPath);
    } catch {
      // Preserve the admission failure; cleanup is best effort on a failing volume.
    }
    throw new Error(
      `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
      { cause: error },
    );
  }

  return runtimeDataRoot;
}

/** Production entry point: Railway's durable volume contract is fixed at /app/data. */
export function prepareRailwayRuntimeVolume(advertisedMount: string | undefined): string {
  return prepareRuntimeVolume({
    advertisedMount,
    runtimeDataRoot: RAILWAY_RUNTIME_DATA_ROOT,
  });
}
