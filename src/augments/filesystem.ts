import { z } from "zod";
import { readFile, writeFile, readdir, mkdir, rm, realpath, stat, lstat } from "node:fs/promises";
import { resolve, join, relative, extname, isAbsolute, sep } from "node:path";
import { Glob } from "bun";
import type { Augment, ContextBlock } from "../types";
import { defineTool } from "../helpers";

/**
 * Filesystem augment — scoped, multi-mount file access for Auggy agents.
 *
 * The operator declares named mounts, each with its own physical path
 * and permission level. The model sees logical paths (mount-name/...)
 * and the augment resolves to physical paths with security enforcement.
 *
 * Security model:
 *  - fs.realpath() resolves symlinks before every boundary check
 *  - startsWith() against the realpath'd mount root prevents traversal
 *  - Per-mount read/write/delete permissions enforced per operation
 *  - Binary file detection on read prevents garbage in tool results
 *  - maxReadSize truncation prevents large files from blowing context
 *
 * The mount model follows the Docker volumes pattern: operators declare
 * boundaries, the augment enforces them, the model sees logical paths.
 *
 * IMPORTANT: Filesystem mount paths must NOT overlap with fileMemory
 * source paths. If the same file is owned by fileMemory (cached at boot)
 * and accessible via a writable filesystem mount, writes through the
 * filesystem augment won't invalidate fileMemory's cache, causing stale
 * context on subsequent turns. This is an operator responsibility in v1;
 * future versions may enforce it at defineAgent time via augment metadata.
 */

export interface FsMount {
  /** Logical name the model uses as the first path segment. */
  name: string;
  /** Physical path on disk. */
  path: string;
  /** Allow fs_write and fs_mkdir. Default false. */
  writable?: boolean;
  /** Allow fs_remove. Default false. Requires writable. */
  deletable?: boolean;
  /** Max bytes returned by fs_read. Default 262144 (256KB). */
  maxReadSize?: number;
  /** Max bytes accepted by fs_write. Default 1048576 (1MB). */
  maxWriteSize?: number;
  /** Glob patterns excluded from fs_search. Default [".git", "node_modules"]. */
  searchExcludes?: string[];
}

export interface FilesystemOptions {
  /** Named mount points the agent can access. */
  mounts: FsMount[];
  /**
   * Optional SKILL.md path. If provided, the file is boot-loaded and
   * returned as an evictable context block on each turn — teaching the
   * model when/why/how to use the filesystem tools.
   */
  skillFile?: string;
}

const DEFAULT_MAX_READ = 256 * 1024; // 256KB
const DEFAULT_MAX_WRITE = 1024 * 1024; // 1MB
const DEFAULT_SEARCH_EXCLUDES = [".git", "node_modules", ".next", "__pycache__", ".DS_Store"];

const BINARY_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".bmp",
  ".ico",
  ".webp",
  ".svg",
  ".pdf",
  ".zip",
  ".gz",
  ".tar",
  ".bz2",
  ".7z",
  ".rar",
  ".mp3",
  ".mp4",
  ".avi",
  ".mov",
  ".wav",
  ".flac",
  ".woff",
  ".woff2",
  ".ttf",
  ".otf",
  ".eot",
  ".exe",
  ".dll",
  ".so",
  ".dylib",
  ".o",
  ".a",
  ".wasm",
  ".pyc",
  ".class",
]);

/**
 * Boundary check via `path.relative()`. Rejects:
 *   - targets whose relative path escapes the mount ("..", "../foo", etc.)
 *   - targets on a different filesystem root (Windows cross-drive —
 *     `relative()` returns an absolute path in that case).
 * Accepts the mount root itself (relative "") and any descendant.
 *
 * Chose `relative()` over `startsWith(mountRoot + sep)` because the
 * separator-suffix form breaks when mountRoot is itself a filesystem root
 * (e.g. "/" on POSIX → `mountRoot + sep` becomes "//", which never matches
 * any real child path). The relative-based check handles both the
 * root-mount case and the prefix-collision case (mount `/var/data/work`
 * vs sibling `/var/data/workspace`) uniformly. Exported for testability.
 */
export function isWithinMount(realTarget: string, mountRoot: string): boolean {
  const rel = relative(mountRoot, realTarget);
  if (rel === "") return true;
  if (rel === ".." || rel.startsWith(`..${sep}`)) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

/**
 * Filesystem augment factory.
 *
 * Usage:
 * ```ts
 * filesystem({
 *   mounts: [
 *     { name: "skills",    path: "./augments",     writable: false },
 *     { name: "workspace", path: "./workspace",    writable: true, deletable: true },
 *     { name: "repo",      path: "/repos/platform", writable: false },
 *   ],
 * })
 * ```
 */
export function filesystem(opts: FilesystemOptions): Augment {
  // Validate mount names are unique
  const names = new Set<string>();
  for (const m of opts.mounts) {
    if (names.has(m.name)) {
      throw new Error(`filesystem: duplicate mount name "${m.name}"`);
    }
    if (m.name.includes("/") || m.name.includes("\\")) {
      throw new Error(`filesystem: mount name "${m.name}" must not contain path separators`);
    }
    if (m.deletable && !m.writable) {
      throw new Error(
        `filesystem: mount "${m.name}" is deletable but not writable — deletable requires writable`,
      );
    }
    names.add(m.name);
  }

  const mountMap = new Map<string, FsMount>();
  const resolvedRoots = new Map<string, string>();
  let cachedSkill: string | null = null;

  // --- Path resolution and security ---

  async function resolveMountRoot(mount: FsMount): Promise<string> {
    const cached = resolvedRoots.get(mount.name);
    if (cached) return cached;
    try {
      const real = await realpath(resolve(mount.path));
      resolvedRoots.set(mount.name, real);
      return real;
    } catch {
      // Mount path doesn't exist yet — resolve without following symlinks
      const resolved = resolve(mount.path);
      resolvedRoots.set(mount.name, resolved);
      return resolved;
    }
  }

  function parseLogicalPath(logicalPath: string): {
    mountName: string;
    subPath: string;
  } {
    const normalized = logicalPath.replace(/\\/g, "/");
    const firstSlash = normalized.indexOf("/");
    if (firstSlash === -1) {
      return { mountName: normalized, subPath: "." };
    }
    return {
      mountName: normalized.slice(0, firstSlash),
      subPath: normalized.slice(firstSlash + 1) || ".",
    };
  }

  async function resolveAndValidate(
    logicalPath: string,
    requireMount?: (m: FsMount) => string | null,
  ): Promise<{ physicalPath: string; mount: FsMount }> {
    const { mountName, subPath } = parseLogicalPath(logicalPath);
    const mount = mountMap.get(mountName);
    if (!mount) {
      throw new Error(
        `Unknown mount "${mountName}". Available mounts: ${[...mountMap.keys()].join(", ")}`,
      );
    }

    // Permission check
    if (requireMount) {
      const err = requireMount(mount);
      if (err) throw new Error(err);
    }

    const mountRoot = await resolveMountRoot(mount);
    const targetPath = resolve(mountRoot, subPath);

    // Resolve symlinks on the target to catch symlink escapes
    let realTarget: string;
    try {
      realTarget = await realpath(targetPath);
    } catch {
      // Target doesn't exist yet (for writes/mkdirs) — use the resolved
      // path but still validate it's within the mount boundary
      realTarget = targetPath;
    }

    if (!isWithinMount(realTarget, mountRoot)) {
      throw new Error(`Path "${logicalPath}" resolves outside mount "${mountName}" boundary`);
    }

    return { physicalPath: realTarget, mount };
  }

  // --- Tools ---

  const fsRead = defineTool({
    name: "fs_read",
    description:
      "Read file contents from a mounted directory. Path format: mount-name/path/to/file. Use fs_list first to check file sizes before reading large files.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Logical path: mount-name/path/to/file"),
    }),
    execute: async ({ path: logicalPath }) => {
      const { physicalPath, mount } = await resolveAndValidate(logicalPath);

      // Check if it's a symlink pointing outside (extra safety)
      const lstats = await lstat(physicalPath).catch(() => null);
      if (lstats?.isSymbolicLink()) {
        const realTarget = await realpath(physicalPath);
        const mountRoot = await resolveMountRoot(mount);
        if (!isWithinMount(realTarget, mountRoot)) {
          return `Error: Symlink "${logicalPath}" points outside mount boundary`;
        }
      }

      // Binary detection
      const ext = extname(physicalPath).toLowerCase();
      if (BINARY_EXTENSIONS.has(ext)) {
        const stats = await stat(physicalPath);
        return `Error: Binary file (${ext}, ${formatSize(stats.size)}). Use fs_list to see metadata.`;
      }

      // Read with size cap
      const maxRead = mount.maxReadSize ?? DEFAULT_MAX_READ;
      const stats = await stat(physicalPath);

      if (stats.isDirectory()) {
        return `Error: "${logicalPath}" is a directory. Use fs_list instead.`;
      }

      const content = await Bun.file(physicalPath).slice(0, maxRead).text();

      if (stats.size > maxRead) {
        return `${content}\n\n[truncated at ${formatSize(maxRead)}, total size: ${formatSize(stats.size)}]`;
      }
      return content;
    },
  });

  const fsWrite = defineTool({
    name: "fs_write",
    description:
      "Write content to a file in a writable mount. Creates parent directories automatically. Path format: mount-name/path/to/file.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Logical path: mount-name/path/to/file"),
      content: z.string().describe("File content to write"),
    }),
    execute: async ({ path: logicalPath, content }) => {
      const { physicalPath, mount } = await resolveAndValidate(logicalPath, (m) =>
        m.writable ? null : `Mount "${m.name}" is read-only`,
      );

      const maxWrite = mount.maxWriteSize ?? DEFAULT_MAX_WRITE;
      if (content.length > maxWrite) {
        return `Error: Content exceeds max write size (${formatSize(content.length)} > ${formatSize(maxWrite)})`;
      }

      // Ensure parent directory exists
      const parentDir = physicalPath.slice(0, physicalPath.lastIndexOf("/"));
      await mkdir(parentDir, { recursive: true });

      await writeFile(physicalPath, content, "utf-8");
      return `Written ${formatSize(content.length)} to "${logicalPath}"`;
    },
  });

  const fsList = defineTool({
    name: "fs_list",
    description:
      "List directory contents with file sizes and types. Path format: mount-name/path/to/dir. Omit the path after mount name to list the mount root.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Logical path: mount-name or mount-name/path/to/dir"),
    }),
    execute: async ({ path: logicalPath }) => {
      const { physicalPath } = await resolveAndValidate(logicalPath);

      const stats = await stat(physicalPath);
      if (!stats.isDirectory()) {
        // Single file stat
        return JSON.stringify({
          path: logicalPath,
          type: "file",
          size: stats.size,
          sizeFormatted: formatSize(stats.size),
          modified: stats.mtime.toISOString(),
        });
      }

      const entries = await readdir(physicalPath, { withFileTypes: true });
      const results = await Promise.all(
        entries
          .filter((e) => !e.name.startsWith(".") || e.name === ".gitignore")
          .map(async (entry) => {
            const entryPath = join(physicalPath, entry.name);
            try {
              const s = await stat(entryPath);
              return {
                name: entry.name,
                type: entry.isDirectory() ? "dir" : "file",
                size: entry.isDirectory() ? undefined : s.size,
                sizeFormatted: entry.isDirectory() ? undefined : formatSize(s.size),
                modified: s.mtime.toISOString(),
              };
            } catch {
              return {
                name: entry.name,
                type: "unknown",
              };
            }
          }),
      );

      // Sort: directories first, then files, alphabetical within each
      results.sort((a, b) => {
        if (a.type === "dir" && b.type !== "dir") return -1;
        if (a.type !== "dir" && b.type === "dir") return 1;
        return a.name.localeCompare(b.name);
      });

      return JSON.stringify({ path: logicalPath, entries: results });
    },
  });

  const fsMkdir = defineTool({
    name: "fs_mkdir",
    description:
      "Create a directory (and parent directories) in a writable mount. Path format: mount-name/path/to/new-dir.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Logical path for the new directory"),
    }),
    execute: async ({ path: logicalPath }) => {
      const { physicalPath } = await resolveAndValidate(logicalPath, (m) =>
        m.writable ? null : `Mount "${m.name}" is read-only`,
      );
      await mkdir(physicalPath, { recursive: true });
      return `Created directory "${logicalPath}"`;
    },
  });

  const fsRemove = defineTool({
    name: "fs_remove",
    description:
      "Delete a file or empty directory in a deletable mount. Path format: mount-name/path/to/target. Will not delete non-empty directories.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Logical path to the file or empty directory to remove"),
    }),
    execute: async ({ path: logicalPath }) => {
      const { physicalPath, mount } = await resolveAndValidate(logicalPath, (m) => {
        if (!m.writable) return `Mount "${m.name}" is read-only`;
        if (!m.deletable) return `Mount "${m.name}" does not allow deletion`;
        return null;
      });

      const stats = await stat(physicalPath);
      if (stats.isDirectory()) {
        // Only remove empty directories
        const entries = await readdir(physicalPath);
        if (entries.length > 0) {
          return `Error: Directory "${logicalPath}" is not empty (${entries.length} entries). Remove contents first.`;
        }
        await rm(physicalPath, { recursive: false });
        return `Removed empty directory "${logicalPath}"`;
      }

      // Prevent deleting the mount root itself
      const mountRoot = await resolveMountRoot(mount);
      if (physicalPath === mountRoot) {
        return `Error: Cannot delete mount root "${mount.name}"`;
      }

      await rm(physicalPath);
      return `Removed file "${logicalPath}"`;
    },
  });

  const fsSearch = defineTool({
    name: "fs_search",
    description:
      "Search for files matching a glob pattern within a mount. Returns up to 100 results. Excludes .git and node_modules by default. Path format: mount-name or mount-name/subdir.",
    category: "meta",
    input: z.object({
      path: z.string().describe("Mount name or mount-name/subdir to search within"),
      pattern: z.string().describe('Glob pattern (e.g. "*.md", "**/*.ts", "config.*")'),
      maxResults: z.number().optional().describe("Max results to return (default 100)"),
    }),
    execute: async ({ path: logicalPath, pattern, maxResults }) => {
      const { physicalPath, mount } = await resolveAndValidate(logicalPath);
      const cap = Math.min(maxResults ?? 100, 1000);

      const excludes = mount.searchExcludes ?? DEFAULT_SEARCH_EXCLUDES;

      const glob = new Glob(pattern);
      const results: string[] = [];

      for await (const entry of glob.scan({
        cwd: physicalPath,
        absolute: false,
        dot: false,
      })) {
        // Check excludes
        const shouldExclude = excludes.some(
          (ex) => entry.includes(`/${ex}/`) || entry.startsWith(`${ex}/`) || entry === ex,
        );
        if (shouldExclude) continue;

        results.push(`${logicalPath}/${entry}`);
        if (results.length >= cap) break;
      }

      if (results.length === 0) {
        return `No files matching "${pattern}" in "${logicalPath}"`;
      }

      const truncated = results.length >= cap;
      return JSON.stringify({
        pattern,
        searchPath: logicalPath,
        results,
        count: results.length,
        truncated,
      });
    },
  });

  // --- Augment definition ---

  return {
    name: "filesystem",
    capabilities: ["tools", "context"],
    constraints: {
      maxToolCallsPerTurn: 15,
      // Structural Layer 1 defaults: mutation tools are hidden from the
      // untrusted peer's tool list entirely. Destruction is further restricted
      // to facility/operator. Mount-level `writable` / `deletable` flags are a
      // separate, complementary defense — they run inside the tool after it
      // has already been exposed and called. perTrustLevel runs before the
      // model sees the tool.
      perTrustLevel: {
        public: { neverExpose: ["fs_write", "fs_mkdir", "fs_remove"] },
        agent: { neverExpose: ["fs_remove"] },
      },
    },

    tools: [fsRead, fsWrite, fsList, fsMkdir, fsRemove, fsSearch],

    async onBoot() {
      // Resolve and cache all mount roots at boot
      for (const mount of opts.mounts) {
        mountMap.set(mount.name, mount);
        await resolveMountRoot(mount);
      }

      // Boot-load SKILL.md if provided
      if (opts.skillFile) {
        try {
          cachedSkill = await readFile(opts.skillFile, "utf-8");
        } catch (err) {
          // SKILL.md is optional — missing file is not a boot failure,
          // but log so the operator knows the teaching layer is absent.
          console.warn(`filesystem: failed to load SKILL.md from "${opts.skillFile}": ${err}`);
        }
      }
    },

    context:
      cachedSkill !== null || opts.skillFile
        ? async (): Promise<ContextBlock[]> => {
            if (!cachedSkill) return [];
            return [
              {
                source: "filesystem",
                content: cachedSkill,
                placement: "preamble",
                provenance: "augment",
                priority: "evictable",
                eviction: "drop",
                origin: "operator",
              },
            ];
          }
        : undefined,
  };
}

// --- Helpers ---

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
