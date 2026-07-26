import { closeSync, lstatSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { openPinnedChildDirectory, pinDirectory } from "../lib/anchored-files";
import { registerOwnedSqlitePath } from "../lib/sqlite";

function isContained(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return (
    fromRoot === "" ||
    (fromRoot !== ".." && !fromRoot.startsWith(`..${sep}`) && !isAbsolute(fromRoot))
  );
}

/**
 * Resolve a configured state file beneath an owned root and descriptor-walk
 * every existing parent without following symlinks. The canonical root is
 * returned so benign symlinks above the owned root cannot be reinterpreted by
 * a downstream path-based database opener.
 */
export function resolveOwnedStatePath(
  configuredPath: string,
  agentDir: string,
  ownedRoot: string,
  label: string,
  options: { createParents?: boolean } = {},
): string {
  const normalizedRoot = resolve(ownedRoot);
  const configured = isAbsolute(configuredPath)
    ? resolve(configuredPath)
    : resolve(agentDir, configuredPath);
  const candidate = isContained(normalizedRoot, configured)
    ? configured
    : isAbsolute(configuredPath)
      ? configured
      : resolve(normalizedRoot, configuredPath);
  if (!isContained(normalizedRoot, candidate) || candidate === normalizedRoot) {
    throw new Error(
      `[owned-state] ${label} must stay within its state directory/runtime data root`,
    );
  }

  const relativeTarget = relative(normalizedRoot, candidate);
  const segments = relativeTarget.split(sep).filter(Boolean);
  const leaf = segments.pop();
  if (!leaf) throw new Error(`[owned-state] ${label} must name a file beneath its state root`);

  const pinnedRoot = pinDirectory(normalizedRoot, `${label} root`);
  let currentFd = pinnedRoot.fd;
  const canonicalSegments: string[] = [];
  try {
    for (const [index, segment] of segments.entries()) {
      try {
        const childFd = openPinnedChildDirectory(
          currentFd,
          segment,
          label,
          options.createParents === true,
        );
        closeSync(currentFd);
        currentFd = childFd;
        canonicalSegments.push(segment);
      } catch (error) {
        if (options.createParents === true) throw error;
        const attempted = join(pinnedRoot.canonical, ...segments.slice(0, index + 1));
        if (lstatSync(attempted, { throwIfNoEntry: false })) throw error;
        // A missing parent means the database cannot exist yet. Returning the
        // canonical, contained target lets read-only callers report absence.
        const missingTarget = join(pinnedRoot.canonical, ...segments, leaf);
        registerOwnedSqlitePath(missingTarget, pinnedRoot.canonical);
        return missingTarget;
      }
    }
    const target = join(pinnedRoot.canonical, ...canonicalSegments, leaf);
    registerOwnedSqlitePath(target, pinnedRoot.canonical);
    return target;
  } finally {
    closeSync(currentFd);
  }
}
