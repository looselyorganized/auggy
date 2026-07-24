import { closeSync, constants, fstatSync } from "node:fs";
import { basename } from "node:path";
import { Glob } from "bun";
import { duplicateFd, listDirectoryFd, openAt, tryOpenAt } from "../../lib/posix-at";

const DEFAULT_MAX_ENTRIES = 24;
const DEFAULT_SCAN_LIMIT = 500;
const DEFAULT_MAX_DEPTH = 4;
const MAX_PATH_CHARS = 180;
const STOP_WORDS = new Set([
  "about",
  "after",
  "again",
  "also",
  "and",
  "are",
  "can",
  "could",
  "does",
  "for",
  "from",
  "have",
  "into",
  "just",
  "need",
  "that",
  "the",
  "their",
  "this",
  "use",
  "want",
  "what",
  "when",
  "where",
  "which",
  "will",
  "with",
  "would",
  "workspace",
]);

export interface WorkspaceCatalogScanOptions {
  mountName: string;
  rootFd: number;
  query?: string;
  maxEntries?: number;
  scanLimit?: number;
  maxDepth?: number;
  excludes?: readonly string[];
  allowDirectory?: (input: {
    fd: number;
    name: string;
    relativePath: string;
    depth: number;
  }) => boolean | Promise<boolean>;
}

export interface WorkspaceCatalogEntry {
  path: string;
  size: number;
  modified: string;
  relevance: number;
}

export interface WorkspaceCatalog {
  entries: WorkspaceCatalogEntry[];
  discoveredFiles: number;
  inspectedEntries: number;
  truncated: boolean;
  maxDepth: number;
}

interface ScannedFile {
  path: string;
  size: number;
  modifiedMs: number;
}

interface PendingDirectory {
  segments: string[];
  logicalPath: string;
  relativePath: string;
  depth: number;
  expectedIdentity?: { dev: number; ino: number };
}

const O_CLOEXEC = (constants as unknown as Record<string, number>).O_CLOEXEC ?? 0;
const DIRECTORY_FLAGS =
  constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW | O_CLOEXEC;

function openDirectoryFromRoot(rootFd: number, segments: readonly string[]): number {
  let current = duplicateFd(rootFd);
  try {
    for (const segment of segments) {
      const child = openAt(current, segment, DIRECTORY_FLAGS);
      closeSync(current);
      current = child;
    }
    return current;
  } catch (error) {
    closeSync(current);
    throw error;
  }
}

/**
 * Build a bounded metadata-only catalog for a workspace mount.
 *
 * File contents are intentionally never read. Workspace files may contain
 * peer- or agent-authored text, and silently injecting that text would create
 * a second, unreviewed context channel. The catalog gives the model enough
 * orientation to choose fs_list/fs_search/fs_read explicitly instead.
 */
export async function scanWorkspaceCatalog(
  opts: WorkspaceCatalogScanOptions,
): Promise<WorkspaceCatalog> {
  const maxEntries = boundedInteger(opts.maxEntries, DEFAULT_MAX_ENTRIES, 1, 100);
  const scanLimit = boundedInteger(opts.scanLimit, DEFAULT_SCAN_LIMIT, maxEntries, 5000);
  const maxDepth = boundedInteger(opts.maxDepth, DEFAULT_MAX_DEPTH, 1, 12);
  const isExcluded = createPathExcluder(opts.excludes ?? []);
  const queryTerms = termsForQuery(opts.query ?? "");
  const queue: PendingDirectory[] = [
    { segments: [], logicalPath: opts.mountName, relativePath: "", depth: 0 },
  ];
  const files: ScannedFile[] = [];
  let inspectedEntries = 0;
  let truncated = false;

  while (queue.length > 0 && inspectedEntries < scanLimit) {
    const current = queue.shift()!;
    let directoryFd: number | null = null;
    try {
      directoryFd = openDirectoryFromRoot(opts.rootFd, current.segments);
      if (current.expectedIdentity) {
        const opened = fstatSync(directoryFd);
        if (
          opened.dev !== current.expectedIdentity.dev ||
          opened.ino !== current.expectedIdentity.ino
        ) {
          continue;
        }
      }
      const listed = listDirectoryFd(directoryFd, Math.max(0, scanLimit - inspectedEntries));
      if (listed.truncated) truncated = true;
      const children = listed.names.sort((left, right) => left.localeCompare(right));

      for (const name of children) {
        if (inspectedEntries >= scanLimit) {
          truncated = true;
          break;
        }
        inspectedEntries++;
        if (name.startsWith(".")) continue;

        const logicalPath = `${current.logicalPath}/${name}`;
        const relativePath = current.relativePath ? `${current.relativePath}/${name}` : name;
        if (isExcluded(relativePath)) continue;

        const opened = tryOpenAt(
          directoryFd,
          name,
          constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW | O_CLOEXEC,
        );
        if ("errno" in opened) continue;
        try {
          const stats = fstatSync(opened.fd);
          if (stats.isDirectory()) {
            if (
              opts.allowDirectory &&
              !(await opts.allowDirectory({
                fd: opened.fd,
                name,
                relativePath,
                depth: current.depth + 1,
              }))
            ) {
              continue;
            }
            if (current.depth + 1 < maxDepth) {
              queue.push({
                segments: [...current.segments, name],
                logicalPath,
                relativePath,
                depth: current.depth + 1,
                expectedIdentity: { dev: stats.dev, ino: stats.ino },
              });
            }
            continue;
          }
          if (!stats.isFile() || stats.nlink !== 1) continue;
          files.push({
            path: logicalPath,
            size: stats.size,
            modifiedMs: stats.mtimeMs,
          });
        } finally {
          closeSync(opened.fd);
        }
      }
    } catch {
      // A concurrently removed or replaced directory is omitted from this
      // bounded metadata snapshot rather than retraversed by pathname.
    } finally {
      if (directoryFd !== null) closeSync(directoryFd);
    }
  }

  if (queue.length > 0) truncated = true;

  const ranked = files
    .map((file) => ({ ...file, relevance: relevanceForPath(file.path, queryTerms) }))
    .sort((left, right) => {
      if (right.relevance !== left.relevance) return right.relevance - left.relevance;
      if (right.modifiedMs !== left.modifiedMs) return right.modifiedMs - left.modifiedMs;
      return left.path.localeCompare(right.path);
    })
    .slice(0, maxEntries)
    .map((file) => ({
      path: truncatePath(file.path),
      size: file.size,
      modified: new Date(file.modifiedMs).toISOString().slice(0, 10),
      relevance: file.relevance,
    }));

  return {
    entries: ranked,
    discoveredFiles: files.length,
    inspectedEntries,
    truncated,
    maxDepth,
  };
}

/**
 * Compile mount exclusion rules once and apply them consistently to search
 * results and workspace-catalog traversal. Bare names match any path segment;
 * glob rules match the full mount-relative path or its basename.
 */
export function createPathExcluder(patterns: readonly string[]): (path: string) => boolean {
  const rules = patterns
    .map((raw) => raw.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, ""))
    .filter(Boolean)
    .map((pattern) => ({
      pattern,
      bareName: !pattern.includes("/") && !/[?*{}[\]]/.test(pattern),
      glob: new Glob(pattern),
    }));

  return (path: string) => {
    const normalized = path
      .replaceAll("\\", "/")
      .replace(/^\.\//, "")
      .replace(/^\/+|\/+$/g, "");
    if (!normalized) return false;
    const segments = normalized.split("/");
    const name = segments.at(-1) ?? normalized;

    return rules.some((rule) => {
      if (rule.bareName) return segments.includes(rule.pattern);
      if (rule.glob.match(normalized) || rule.glob.match(name)) return true;

      // A rule can name a directory without matching its descendants itself
      // (for example, "generated/*"). Check each ancestor as well.
      for (let i = 1; i < segments.length; i++) {
        if (rule.glob.match(segments.slice(0, i).join("/"))) return true;
      }
      return false;
    });
  };
}

export function renderWorkspaceCatalog(
  catalog: WorkspaceCatalog,
  opts: { mountName: string; query?: string },
): string {
  const lines = [
    `Workspace file metadata for ${JSON.stringify(opts.mountName)}. File contents were not loaded.`,
  ];

  if (catalog.entries.length === 0) {
    lines.push(
      catalog.truncated
        ? `No visible files were found within the bounded scan of ${catalog.inspectedEntries} entries and depth ${catalog.maxDepth}. Omitted paths may still exist; use fs_search(${JSON.stringify(opts.mountName)}, pattern) for broader discovery.`
        : "The workspace currently has no visible files.",
    );
    return lines.join("\n");
  }

  const hasRelevant = catalog.entries.some((entry) => entry.relevance > 0);
  lines.push(
    `${catalog.discoveredFiles} visible file(s) found${catalog.truncated ? ` within a bounded scan of ${catalog.inspectedEntries} entries and depth ${catalog.maxDepth}` : ""}. ${
      hasRelevant && opts.query
        ? "Likely request-relevant paths are ranked first."
        : "Most recently modified paths are shown first."
    }`,
  );

  for (const entry of catalog.entries) {
    lines.push(
      `- ${JSON.stringify(entry.path)} (${formatSize(entry.size)}, modified ${entry.modified})`,
    );
  }

  lines.push(
    `This catalog is bounded metadata. An omitted path may still exist; use fs_search(${JSON.stringify(opts.mountName)}, pattern) for broader discovery.`,
  );
  return lines.join("\n");
}

function termsForQuery(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9._-]+/)
        .map(trimQueryTermBoundaryPunctuation)
        .filter((term) => term.length >= 3 && !STOP_WORDS.has(term)),
    ),
  ].slice(0, 20);
}

/**
 * Trim query punctuation in linear time. Avoid a boundary-alternation regex
 * here because the query is library input and long punctuation runs can cause
 * polynomial backtracking in some JavaScript regexp engines.
 */
function trimQueryTermBoundaryPunctuation(term: string): string {
  let start = 0;
  let end = term.length;
  while (start < end && isQueryTermBoundaryPunctuation(term.charCodeAt(start))) start++;
  while (end > start && isQueryTermBoundaryPunctuation(term.charCodeAt(end - 1))) end--;
  return term.slice(start, end);
}

function isQueryTermBoundaryPunctuation(code: number): boolean {
  return code === 46 || code === 95 || code === 45; // ., _, -
}

function relevanceForPath(path: string, queryTerms: readonly string[]): number {
  if (queryTerms.length === 0) return 0;
  const normalizedPath = path.toLowerCase();
  const name = basename(normalizedPath);
  let score = 0;
  for (const term of queryTerms) {
    if (name === term || name.startsWith(`${term}.`) || name.startsWith(`${term}-`)) score += 8;
    else if (name.includes(term)) score += 5;
    else if (normalizedPath.includes(term)) score += 2;
  }
  return score;
}

function truncatePath(path: string): string {
  if (path.length <= MAX_PATH_CHARS) return path;
  const keep = MAX_PATH_CHARS - 1;
  return `…${path.slice(-keep)}`;
}

function boundedInteger(
  value: number | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value!)));
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
