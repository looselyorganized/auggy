import { closeSync, fstatSync, realpathSync } from "node:fs";
import { openAbsoluteDirectoryNoFollow, tryLockFileExclusive } from "../lib/posix-at";

const heldAgentDirs = new Set<string>();

export class AgentEnvMutationLockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentEnvMutationLockError";
  }
}

export interface AgentEnvMutationLease {
  release(): void;
}

export function isAgentEnvMutationLockSupportedPlatform(platform: string): boolean {
  return platform === "darwin" || platform === "linux";
}

/**
 * Acquire the cross-process lease protecting one agent's `.env` mutations.
 *
 * The advisory lock is held directly on a securely opened descriptor for the
 * canonical agent directory. It creates no project artifact, and closing the
 * descriptor releases the lock, including after process termination.
 */
export function acquireAgentEnvMutationLock(agentDir: string): AgentEnvMutationLease {
  if (!isAgentEnvMutationLockSupportedPlatform(process.platform)) {
    throw unsupportedPlatformLockError();
  }
  let canonicalDir: string;
  try {
    canonicalDir = realpathSync.native(agentDir);
  } catch {
    throw unavailableLockError();
  }
  if (heldAgentDirs.has(canonicalDir)) throw busyLockError();

  let fd: number | undefined;
  try {
    fd = openAbsoluteDirectoryNoFollow(canonicalDir);
    const stat = fstatSync(fd);
    if (!stat.isDirectory()) throw unavailableLockError();
    if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
      throw unavailableLockError();
    }
    if (tryLockFileExclusive(fd) === "busy") throw busyLockError();
    heldAgentDirs.add(canonicalDir);
  } catch (error) {
    if (fd !== undefined) closeQuietly(fd);
    if (error instanceof AgentEnvMutationLockError) throw error;
    throw unavailableLockError();
  }

  let released = false;
  return {
    release(): void {
      if (released) return;
      released = true;
      heldAgentDirs.delete(canonicalDir);
      closeQuietly(fd);
    },
  };
}

export async function withAgentEnvMutationLock<T>(
  agentDir: string,
  operation: () => Promise<T>,
): Promise<T> {
  const lease = acquireAgentEnvMutationLock(agentDir);
  try {
    return await operation();
  } finally {
    lease.release();
  }
}

export function withAgentEnvMutationLockSync<T>(agentDir: string, operation: () => T): T {
  const lease = acquireAgentEnvMutationLock(agentDir);
  try {
    return operation();
  } finally {
    lease.release();
  }
}

function busyLockError(): AgentEnvMutationLockError {
  return new AgentEnvMutationLockError(
    "Agent credentials are being updated by another Auggy operation. Wait for it to finish, then retry; no files were changed.",
  );
}

function unavailableLockError(): AgentEnvMutationLockError {
  return new AgentEnvMutationLockError(
    "Could not acquire the agent credential mutation lock safely. Check the agent directory ownership and permissions, then retry; no files were changed.",
  );
}

function unsupportedPlatformLockError(): AgentEnvMutationLockError {
  return new AgentEnvMutationLockError(
    "Safe AgentMail credential mutation is supported on macOS and Linux. On this platform, configure .env and augment.yaml with ordinary project tooling; no files were changed.",
  );
}

function closeQuietly(fd: number | undefined): void {
  if (fd === undefined) return;
  try {
    closeSync(fd);
  } catch {
    // Preserve the lock or mutation failure that triggered cleanup.
  }
}
