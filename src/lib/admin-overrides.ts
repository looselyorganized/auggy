import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fstatSync,
  fsyncSync,
  openSync,
  readSync,
  realpathSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { z } from "zod";
import { openAbsoluteDirectoryNoFollow, openAt, renameAt, tryOpenAt, unlinkAt } from "./posix-at";

/**
 * Schema for the persistent admin-overrides file. Stored at
 * `<agentDir>/admin-overrides.json`. Updated atomically (temp file + rename)
 * with mode 0o600. Read once at agent boot; the closure values are the
 * runtime source of truth thereafter.
 *
 * v1.0 supports five runtime-tunable knobs:
 *   - webTransport.allowAnonymous
 *   - webTransport.publicIntegration
 *   - budgets.dailyBudgetUsd
 *   - notify.globalMaxPerHour
 *   - agentMail.globalMaxPerHour
 *
 * Adding a new override field is a schema migration — bump the version
 * number and add a per-version branch here.
 */
const AdminOverridesV1Schema = z
  .object({
    version: z.literal(1),
    lastModified: z.string().datetime(),
    lastModifiedBy: z.string(),
    overrides: z
      .object({
        webTransport: z
          .object({
            allowAnonymous: z.boolean().optional(),
            publicIntegration: z.boolean().optional(),
          })
          .strict()
          .optional(),
        budgets: z.object({ dailyBudgetUsd: z.number().positive().optional() }).strict().optional(),
        notify: z
          .object({ globalMaxPerHour: z.number().int().positive().optional() })
          .strict()
          .optional(),
        agentMail: z
          .object({ globalMaxPerHour: z.number().int().positive().optional() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type AdminOverrides = z.infer<typeof AdminOverridesV1Schema>;

const OVERRIDE_FILE = "admin-overrides.json";
const MAX_OVERRIDE_BYTES = 1024 * 1024;
const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const roots = new Map<string, { canonical: string; fd: number; retainCount: number }>();
let acquisitionHook: ((canonicalPath: string) => void) | undefined;

/** @internal Deterministic acquisition hook for boundary regression tests. */
export function __setAdminOverrideRootAcquisitionHookForTest(
  hook: ((canonicalPath: string) => void) | undefined,
): void {
  acquisitionHook = hook;
}

/** Release a process-pinned override root. Primarily useful for test teardown. */
export function releaseAdminOverrideRoot(agentDir: string | undefined): void {
  if (!agentDir) return;
  const key = resolve(agentDir);
  const root = roots.get(key);
  if (!root) return;
  if (root.retainCount > 1) {
    root.retainCount--;
    return;
  }
  roots.delete(key);
  try {
    closeSync(root.fd);
  } catch {
    // Process teardown may already have invalidated the descriptor.
  }
}

/** Pin one configured override root until the owning augment shuts down. */
export function retainAdminOverrideRoot(agentDir: string | undefined): boolean {
  if (!agentDir) return false;
  const root = overrideRoot(agentDir, false);
  if (!root) return false;
  root.retainCount++;
  return true;
}

function overrideRoot(
  agentDir: string,
  missingIsNull: boolean,
): {
  canonical: string;
  fd: number;
  retainCount: number;
} | null {
  if (process.platform !== "darwin" && process.platform !== "linux") {
    throw new Error("[admin-overrides] descriptor-relative policy storage requires macOS or Linux");
  }
  const key = resolve(agentDir);
  const cached = roots.get(key);
  if (cached) return cached;

  let fd: number | null = null;
  let canonical: string;
  try {
    fd = openSync(key, constants.O_RDONLY | constants.O_DIRECTORY | O_CLOEXEC);
    canonical = realpathSync.native(key);
  } catch (error) {
    if (fd !== null) closeSync(fd);
    if (missingIsNull && (error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    const expected = fstatSync(fd);
    if (!expected.isDirectory()) {
      throw new Error("[admin-overrides] policy root must be a real directory");
    }
    acquisitionHook?.(canonical);
    const verificationFd = openAbsoluteDirectoryNoFollow(canonical);
    let opened: ReturnType<typeof fstatSync>;
    try {
      opened = fstatSync(verificationFd);
    } finally {
      closeSync(verificationFd);
    }
    if (!opened.isDirectory() || opened.dev !== expected.dev || opened.ino !== expected.ino) {
      throw new Error("[admin-overrides] policy root changed during acquisition");
    }
    const root = { canonical, fd, retainCount: 0 };
    roots.set(key, root);
    fd = null;
    return root;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

function readOverrideJson(root: { canonical: string; fd: number }): unknown | null {
  const opened = tryOpenAt(
    root.fd,
    OVERRIDE_FILE,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
  );
  if ("errno" in opened) {
    if (opened.errno === 2) return null;
    throw new Error(`[admin-overrides] failed to open ${join(root.canonical, OVERRIDE_FILE)}`);
  }
  try {
    const stats = fstatSync(opened.fd);
    if (!stats.isFile() || stats.nlink !== 1) {
      throw new Error(
        `[admin-overrides] ${join(root.canonical, OVERRIDE_FILE)} must be a single-link regular file`,
      );
    }
    if (stats.size > MAX_OVERRIDE_BYTES) {
      throw new Error(
        `[admin-overrides] ${join(root.canonical, OVERRIDE_FILE)} exceeds the ${MAX_OVERRIDE_BYTES}-byte limit`,
      );
    }
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= MAX_OVERRIDE_BYTES) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, MAX_OVERRIDE_BYTES + 1 - total));
      const bytesRead = readSync(opened.fd, chunk, 0, chunk.byteLength, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > MAX_OVERRIDE_BYTES) {
        throw new Error(
          `[admin-overrides] ${join(root.canonical, OVERRIDE_FILE)} exceeds the ${MAX_OVERRIDE_BYTES}-byte limit`,
        );
      }
      chunks.push(chunk.subarray(0, bytesRead));
    }
    return JSON.parse(Buffer.concat(chunks, total).toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(
      `[admin-overrides] failed to read ${join(root.canonical, OVERRIDE_FILE)}: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    closeSync(opened.fd);
  }
}

function writeOverrideJson(root: { canonical: string; fd: number }, value: AdminOverrides): void {
  const serialized = JSON.stringify(value);
  const existing = tryOpenAt(
    root.fd,
    OVERRIDE_FILE,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK | O_CLOEXEC,
  );
  if ("fd" in existing) {
    try {
      const stats = fstatSync(existing.fd);
      if (!stats.isFile() || stats.nlink !== 1) {
        throw new Error("existing policy is not a single-link regular file");
      }
    } finally {
      closeSync(existing.fd);
    }
  } else if (existing.errno !== 2) {
    throw new Error("existing policy is a symlink or is unreadable");
  }

  const tempName = `.${randomUUID()}.tmp.${process.pid}`;
  let tempFd: number | null = null;
  let ownsTemp = false;
  try {
    tempFd = openAt(
      root.fd,
      tempName,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW | O_CLOEXEC,
      0o600,
    );
    ownsTemp = true;
    fchmodSync(tempFd, 0o600);
    writeFileSync(tempFd, serialized, "utf8");
    fsyncSync(tempFd);
    closeSync(tempFd);
    tempFd = null;
    if (!renameAt(root.fd, tempName, root.fd, OVERRIDE_FILE)) {
      throw new Error("atomic policy rename failed");
    }
    ownsTemp = false;
    fsyncSync(root.fd);
  } catch (error) {
    throw new Error(
      `[admin-overrides] failed to write ${join(root.canonical, OVERRIDE_FILE)}: ${(error as Error).message}`,
      { cause: error },
    );
  } finally {
    if (tempFd !== null) closeSync(tempFd);
    if (ownsTemp) unlinkAt(root.fd, tempName);
  }
}

/**
 * Read the override file. Returns null when:
 *   - agentDir is undefined (no scaffold-aware launch path)
 *   - the file doesn't exist
 * Corrupt JSON, symlinks, unknown versions, and invalid fields throw so a
 * security-relevant override store can never silently reset to yaml values.
 */
export function readOverrides(agentDir: string | undefined): AdminOverrides | null {
  if (!agentDir) return null;
  let root: { canonical: string; fd: number } | null;
  try {
    root = overrideRoot(agentDir, true);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!root) return null;
  const path = join(root.canonical, OVERRIDE_FILE);
  const parsed = readOverrideJson(root);
  if (parsed === null) return null;

  const result = AdminOverridesV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[admin-overrides] ${path} failed validation; refusing to reset runtime policy: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return result.data;
}

/**
 * Write the override file atomically with mode 0o600.
 * Pattern: write to a temp file, then rename to the final path. Rename is
 * atomic on POSIX filesystems, so concurrent readers never observe a
 * partially-written file.
 *
 * The 0o600 mode means only the agent process user can read the file —
 * protects the operator's runtime knob state on multi-user hosts.
 */
export function writeOverrides(agentDir: string, overrides: AdminOverrides): void {
  const parsed = AdminOverridesV1Schema.parse(overrides);
  const root = overrideRoot(agentDir, false);
  if (!root) throw new Error("[admin-overrides] policy root is unavailable");
  writeOverrideJson(root, parsed);
}
