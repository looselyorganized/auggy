import { randomUUID } from "node:crypto";
import { closeSync, fstatSync, fsyncSync } from "node:fs";
import { createPinnedFile, openPinnedChildDirectory, pinDirectory } from "../lib/anchored-files";
import { renameAt, unlinkAt } from "../lib/posix-at";
import {
  admitRuntimeStateIdentityFd,
  assertNoRuntimeStateRestoreFenceFd,
} from "./runtime-state-bundle";

export const RAILWAY_RUNTIME_DATA_ROOT = "/app/data";
const AGENT_MAIL_STATE_DIRECTORY = "agent-mail";

export interface RuntimeVolumeOptions {
  advertisedMount: string | undefined;
  runtimeDataRoot: string;
  agentId?: string;
  /** @internal Deterministic root-replacement barrier for regression tests. */
  __testHooks?: { afterRootPinned?: () => void };
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the admission failure that triggered cleanup.
  }
}

/**
 * Admit a deployment-owned runtime volume and prove its AgentMail state leaf
 * supports the durability operations used by SQLite and atomic JSON files.
 */
export function prepareRuntimeVolume({
  advertisedMount,
  runtimeDataRoot,
  agentId,
  __testHooks,
}: RuntimeVolumeOptions): string {
  if (advertisedMount !== runtimeDataRoot) {
    throw new Error(
      `[runtime-volume] expected RAILWAY_VOLUME_MOUNT_PATH=${runtimeDataRoot}, got ${advertisedMount ?? "unset"}`,
    );
  }
  let rootFd: number | undefined;
  let directoryFd: number | undefined;
  try {
    const pinned = pinDirectory(runtimeDataRoot, "[runtime-volume] runtime data root");
    rootFd = pinned.fd;
    const rootStat = fstatSync(rootFd);
    if ((rootStat.mode & 0o777) !== 0o700) {
      throw new Error(`[runtime-volume] runtime data root must have mode 0700: ${runtimeDataRoot}`);
    }
    __testHooks?.afterRootPinned?.();

    // A restored volume remains fail-closed until an operator has reconciled
    // downstream effects that cannot be rolled back with local files.
    assertNoRuntimeStateRestoreFenceFd(rootFd);
    if (agentId) admitRuntimeStateIdentityFd(rootFd, agentId);
    directoryFd = openPinnedChildDirectory(
      rootFd,
      AGENT_MAIL_STATE_DIRECTORY,
      "[runtime-volume] AgentMail state directory",
      true,
    );
    const stateStat = fstatSync(directoryFd);
    const stateMode = stateStat.mode & 0o777;
    if (stateMode !== 0o700) {
      throw new Error("AgentMail state directory must have mode 0700");
    }
  } catch (error) {
    closeQuietly(rootFd);
    closeQuietly(directoryFd);
    throw new Error(
      `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
      { cause: error },
    );
  }

  const probeId = `${process.pid}-${randomUUID()}`;
  const pendingLeaf = `.auggy-volume-probe-${probeId}.pending`;
  const committedLeaf = `.auggy-volume-probe-${probeId}.committed`;
  let ownsPendingProbe = false;
  let ownsCommittedProbe = false;

  try {
    ownsPendingProbe = createPinnedFile(
      directoryFd!,
      pendingLeaf,
      `auggy-runtime-volume-probe:${probeId}\n`,
      "[runtime-volume] durability probe",
    );
    if (!ownsPendingProbe) throw new Error("durability probe name collision");

    if (!renameAt(directoryFd!, pendingLeaf, directoryFd!, committedLeaf)) {
      throw new Error("durability probe rename failed");
    }
    ownsPendingProbe = false;
    ownsCommittedProbe = true;
    fsyncSync(directoryFd);
    if (!unlinkAt(directoryFd!, committedLeaf)) {
      throw new Error("durability probe removal failed");
    }
    ownsCommittedProbe = false;
    fsyncSync(directoryFd);
    closeSync(directoryFd);
    directoryFd = undefined;
    closeSync(rootFd!);
    rootFd = undefined;
  } catch (error) {
    try {
      if (directoryFd !== undefined && ownsPendingProbe) unlinkAt(directoryFd, pendingLeaf);
      if (directoryFd !== undefined && ownsCommittedProbe) unlinkAt(directoryFd, committedLeaf);
    } catch {
      // Preserve the admission failure; cleanup is best effort on a failing volume.
    }
    closeQuietly(directoryFd);
    closeQuietly(rootFd);
    throw new Error(
      `[runtime-volume] AgentMail state directory failed durability admission: ${(error as Error).message}`,
      { cause: error },
    );
  }

  return runtimeDataRoot;
}

/** Production entry point: Railway's durable volume contract is fixed at /app/data. */
export function prepareRailwayRuntimeVolume(
  advertisedMount: string | undefined,
  agentId: string,
): string {
  return prepareRuntimeVolume({
    advertisedMount,
    runtimeDataRoot: RAILWAY_RUNTIME_DATA_ROOT,
    agentId,
  });
}
