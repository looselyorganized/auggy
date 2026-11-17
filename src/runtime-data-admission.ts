import { closeSync, fstatSync, type Stats } from "node:fs";
import { inspectPinnedFile, pinDirectory, type PinnedDirectory } from "./lib/anchored-files";
import type { RuntimeDataAdmission, WithRuntimeDataAdmission } from "./runtime-data-contracts";

interface LiveAdmission {
  readonly root: PinnedDirectory;
  readonly configuredPath: string;
  readonly device: number;
  readonly inode: number;
  readonly singleton: {
    readonly fd: number;
    readonly leaf: string;
    readonly device: number;
    readonly inode: number;
  };
}

const liveAdmissions = new WeakMap<RuntimeDataAdmission, LiveAdmission>();

function requirePrivateDirectory(stat: Stats): void {
  if (!stat.isDirectory() || (stat.mode & 0o7777) !== 0o700) {
    throw new Error("[runtime-data] admitted root must remain a private directory with mode 0700");
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error("[runtime-data] admitted root must remain owned by the current user");
  }
}

function validateLiveRoot(live: LiveAdmission): void {
  const retained = fstatSync(live.root.fd);
  requirePrivateDirectory(retained);
  if (retained.dev !== live.device || retained.ino !== live.inode) {
    throw new Error("[runtime-data] admitted root descriptor changed");
  }
  const current = pinDirectory(live.configuredPath, "[runtime-data] admitted root");
  try {
    const stat = fstatSync(current.fd);
    requirePrivateDirectory(stat);
    if (
      current.canonical !== live.root.canonical ||
      stat.dev !== live.device ||
      stat.ino !== live.inode
    ) {
      throw new Error("[runtime-data] admitted root path changed");
    }
  } finally {
    closeSync(current.fd);
  }
  const singleton = fstatSync(live.singleton.fd);
  if (
    !singleton.isFile() ||
    singleton.nlink !== 1 ||
    (singleton.mode & 0o7777) !== 0o600 ||
    singleton.dev !== live.singleton.device ||
    singleton.ino !== live.singleton.inode ||
    (typeof process.getuid === "function" && singleton.uid !== process.getuid())
  ) {
    throw new Error("[runtime-data] admitted singleton lock changed or is unsafe");
  }
  const currentSingleton = inspectPinnedFile(
    live.root.fd,
    live.singleton.leaf,
    "[runtime-data] admitted singleton lock",
  );
  if (!currentSingleton) throw new Error("[runtime-data] admitted singleton lock is missing");
  try {
    if (
      currentSingleton.stat.dev !== live.singleton.device ||
      currentSingleton.stat.ino !== live.singleton.inode
    ) {
      throw new Error("[runtime-data] admitted singleton lock path changed");
    }
  } finally {
    closeSync(currentSingleton.fd);
  }
}

/**
 * Internal issuer used only after volume identity, singleton and durability
 * admission. The volume lease retains both descriptors and revokes this token
 * before closing either. This function does not transfer descriptor ownership.
 */
export function issueRuntimeDataAdmission(
  root: PinnedDirectory,
  configuredPath: string,
  agentId: string,
  singleton: { fd: number; leaf: string },
): { admission: RuntimeDataAdmission; revoke(): void } {
  const stat = fstatSync(root.fd);
  const singletonStat = fstatSync(singleton.fd);
  const live: LiveAdmission = {
    root: { fd: root.fd, canonical: root.canonical },
    configuredPath,
    device: stat.dev,
    inode: stat.ino,
    singleton: {
      fd: singleton.fd,
      leaf: singleton.leaf,
      device: singletonStat.dev,
      inode: singletonStat.ino,
    },
  };
  validateLiveRoot(live);
  // The unexported type brand prevents accidental structural construction. Only
  // membership in this registry establishes runtime authority.
  const admission = Object.freeze({
    runtimeDataRoot: configuredPath,
    agentId,
  }) as RuntimeDataAdmission;
  liveAdmissions.set(admission, live);
  return {
    admission,
    revoke() {
      liveAdmissions.delete(admission);
    },
  };
}

export const withRuntimeDataAdmission: WithRuntimeDataAdmission = (admission, operation) => {
  const live = liveAdmissions.get(admission);
  if (!live) throw new Error("[runtime-data] admission is invalid or its lease has been released");
  validateLiveRoot(live);
  const result = operation(live.root.fd);
  if (
    result !== null &&
    (typeof result === "object" || typeof result === "function") &&
    "then" in result &&
    typeof result.then === "function"
  ) {
    throw new Error("[runtime-data] descriptor borrowing must be synchronous");
  }
  // Also catch an internal callback that replaced the root while borrowing it.
  if (liveAdmissions.get(admission) !== live) {
    throw new Error("[runtime-data] admission was released during descriptor borrowing");
  }
  validateLiveRoot(live);
  return result;
};
