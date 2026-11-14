/** Bounded dependency inspection only: never install, extract, rewrite a lock or contact a registry. */
import { constants, createReadStream, openSync } from "node:fs";
import { join, posix } from "node:path";
import { createGunzip } from "node:zlib";
import { decodeSnapshotText } from "../authoring/document-io";
import { hasBundleControlCharacters, validateBundleRelativePath } from "./bundle";
import { DEPLOYMENT_LIMITS } from "./contracts";

function fail(message: string): never {
  throw new Error(`[portable-dependencies] ${message}`);
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    fail("Expected dependency metadata mapping.");
  return value as Record<string, unknown>;
}

/** Bun v1 text locks use JSON with trailing commas. No eval, YAML coercion or duplicate keys. */
export function parseDependencyJSON(text: string, trailingCommas = false): unknown {
  let cursor = 0;
  let nodes = 0;
  const space = () => {
    while (/\s/.test(text[cursor] ?? "") && cursor < text.length) cursor++;
  };
  const string = (): string => {
    const start = cursor++;
    while (cursor < text.length) {
      const ch = text[cursor++];
      if (ch === "\\") cursor++;
      else if (ch === '"') {
        try {
          return JSON.parse(text.slice(start, cursor)) as string;
        } catch {
          fail("Invalid JSON string in dependency metadata.");
        }
      }
    }
    fail("Unterminated JSON string in dependency metadata.");
  };
  const value = (depth: number): unknown => {
    if (++nodes > 500_000 || depth > DEPLOYMENT_LIMITS.directoryDepth)
      fail("Dependency metadata exceeds structural limits.");
    space();
    const ch = text[cursor];
    if (ch === '"') return string();
    if (ch === "{" || ch === "[") {
      const object = ch === "{";
      const end = object ? "}" : "]";
      cursor++;
      const entries: Record<string, unknown> = Object.create(null);
      const items: unknown[] = [];
      space();
      if (text[cursor] === end) {
        cursor++;
        return object ? entries : items;
      }
      for (;;) {
        space();
        if (object) {
          if (text[cursor] !== '"') fail("Unsupported dependency JSON syntax.");
          const key = string();
          space();
          if (Object.hasOwn(entries, key) || text[cursor++] !== ":")
            fail("Duplicate or malformed dependency metadata key.");
          entries[key] = value(depth + 1);
        } else items.push(value(depth + 1));
        space();
        if (text[cursor] === end) {
          cursor++;
          break;
        }
        if (text[cursor++] !== ",") fail("Unsupported dependency JSON syntax.");
        space();
        if (text[cursor] === end) {
          if (!trailingCommas) fail("Unexpected trailing comma in package manifest.");
          cursor++;
          break;
        }
      }
      return object ? entries : items;
    }
    const token = /^(?:true|false|null|-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/.exec(
      text.slice(cursor),
    );
    if (!token) fail("Unsupported dependency JSON syntax; use a Bun v1 text lock.");
    cursor += token[0].length;
    return JSON.parse(token[0]);
  };
  const parsed = value(0);
  space();
  if (cursor !== text.length) fail("Unsupported trailing dependency metadata content.");
  return parsed;
}

function localPath(spec: string): string {
  const raw = spec.startsWith("file:") ? spec.slice(5) : spec;
  if (raw.includes("$"))
    fail(
      "Dependency archive paths must not contain $ because Docker COPY expands environment variables; rename the archive and refresh the lock locally.",
    );
  if (
    !raw ||
    raw.startsWith("/") ||
    raw.includes("\\") ||
    /^[A-Za-z]:/.test(raw) ||
    /[?#%]/.test(raw) ||
    hasBundleControlCharacters(raw)
  )
    fail("Local dependencies require contained relative .tgz paths.");
  const normalized = posix.normalize(raw);
  validateBundleRelativePath(normalized);
  if (!normalized.endsWith(".tgz"))
    fail("Local directories are unsupported; pack a contained relative .tgz dependency first.");
  return normalized;
}

function dependencySpec(value: unknown, local: Set<string>): void {
  if (
    typeof value !== "string" ||
    !value ||
    value !== value.trim() ||
    Buffer.byteLength(value) > DEPLOYMENT_LIMITS.pathBytes
  )
    fail("Dependency specifier must be a bounded literal string.");
  if (value.startsWith("file:")) {
    local.add(localPath(value));
    return;
  }
  if (value.startsWith("npm:")) {
    const alias = value.slice(4);
    const at = alias.lastIndexOf("@");
    if (at <= 0 || !/^(?:@[A-Za-z0-9_.-]+\/)?[A-Za-z0-9_.-]+$/.test(alias.slice(0, at)))
      fail("Unsupported registry alias.");
    dependencySpec(alias.slice(at + 1), local);
    return;
  }
  // Registry versions, ranges and dist-tags only. In particular a slash is not
  // accepted as GitHub shorthand and URL credentials never enter diagnostics.
  if (!/^[A-Za-z0-9*~^<>=|.+ -]+$/.test(value))
    fail(
      "Only registry ranges and contained file:.tgz dependencies are supported; remove Git, URL, workspace or directory sources.",
    );
}

function dependencies(
  manifest: Record<string, unknown>,
  local: Set<string>,
  project = false,
): void {
  if (
    (project &&
      (manifest.workspaces !== undefined ||
        manifest.patchedDependencies !== undefined ||
        manifest.catalog !== undefined ||
        manifest.catalogs !== undefined)) ||
    manifest.bundledDependencies !== undefined ||
    manifest.bundleDependencies !== undefined
  )
    fail(
      "Workspace, patched, catalog and bundled dependency graphs require a separate build path.",
    );
  // Installed dependency archives do not activate their development workspaces
  // or root-only overrides. This is material for Auggy's packed monorepo manifest.
  for (const field of project
    ? ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies", "resolutions"]
    : ["dependencies", "optionalDependencies", "peerDependencies"]) {
    if (manifest[field] === undefined) continue;
    for (const spec of Object.values(record(manifest[field]))) dependencySpec(spec, local);
  }
  const overrides = (value: unknown, depth = 0): void => {
    if (depth > DEPLOYMENT_LIMITS.directoryDepth)
      fail("Dependency overrides exceed structural limits.");
    if (typeof value === "string") dependencySpec(value, local);
    else for (const spec of Object.values(record(value))) overrides(spec, depth + 1);
  };
  if (project && manifest.overrides !== undefined) overrides(manifest.overrides);
}

interface ArchiveBudget {
  expanded: number;
  entries: number;
}

async function archiveManifest(
  path: string,
  budget: ArchiveBudget,
): Promise<Record<string, unknown>> {
  const source = createReadStream(path, {
    fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
    autoClose: true,
    highWaterMark: 64 * 1024,
  });
  const decoder = createGunzip({ chunkSize: 64 * 1024 });
  source.on("error", () => decoder.destroy(new Error("Cannot read dependency archive.")));
  source.pipe(decoder);
  const header = Buffer.alloc(512);
  let headerBytes = 0;
  let remaining = 0;
  let padding = 0;
  let capture: Buffer | undefined;
  let captured = 0;
  let manifest: Buffer | undefined;
  let expanded = 0;
  let zeroBlocks = 0;
  const paths = new Set<string>();
  const regularPaths = new Set<string>();
  const parentPaths = new Set<string>();
  const field = (offset: number, length: number): string => {
    const bytes = header.subarray(offset, offset + length);
    const nul = bytes.indexOf(0);
    return decodeSnapshotText(nul < 0 ? bytes : bytes.subarray(0, nul));
  };
  const octal = (offset: number, length: number): number => {
    const text = field(offset, length).trim();
    if (!/^[0-7]+$/.test(text)) fail("Unsupported archive numeric encoding.");
    const number = Number.parseInt(text, 8);
    if (!Number.isSafeInteger(number)) fail("Archive size exceeds supported bounds.");
    return number;
  };
  try {
    for await (const raw of decoder) {
      const chunk = raw as Buffer;
      expanded += chunk.length;
      budget.expanded += chunk.length;
      if (
        expanded > DEPLOYMENT_LIMITS.archiveExpandedBytes ||
        budget.expanded > DEPLOYMENT_LIMITS.aggregateArchiveExpandedBytes
      )
        fail("Dependency archives exceed decompressed byte limits.");
      let offset = 0;
      while (offset < chunk.length) {
        if (remaining > 0) {
          const count = Math.min(remaining, chunk.length - offset);
          if (capture) {
            chunk.copy(capture, captured, offset, offset + count);
            captured += count;
          }
          remaining -= count;
          offset += count;
          if (remaining === 0 && capture) {
            manifest = capture;
            capture = undefined;
          }
          continue;
        }
        if (padding > 0) {
          const count = Math.min(padding, chunk.length - offset);
          offset += count;
          padding -= count;
          continue;
        }
        const count = Math.min(512 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        offset += count;
        headerBytes += count;
        if (headerBytes !== 512) continue;
        headerBytes = 0;
        if (header.every((byte) => byte === 0)) {
          zeroBlocks++;
          continue;
        }
        if (zeroBlocks > 0) fail("Archive has data after its end marker.");
        if (++budget.entries > DEPLOYMENT_LIMITS.archiveEntries)
          fail("Dependency archives exceed the cumulative entry limit.");
        const checksum = octal(148, 8);
        let actual = 0;
        for (let i = 0; i < 512; i++) actual += i >= 148 && i < 156 ? 32 : header[i]!;
        if (actual !== checksum) fail("Dependency archive checksum is invalid.");
        const magic = field(257, 6);
        if (magic !== "ustar" && magic !== "ustar ")
          fail("Dependency archive must use supported ustar headers.");
        const prefix = field(345, 155);
        const name = `${prefix ? `${prefix}/` : ""}${field(0, 100)}`.replace(/\/$/, "");
        validateBundleRelativePath(name);
        if (name !== "package" && !name.startsWith("package/"))
          fail("Archive entries must be contained under package/.");
        if (paths.has(name)) fail("Duplicate dependency archive path.");
        paths.add(name);
        const kind = header[156];
        if (kind !== 0 && kind !== 48 && kind !== 53)
          fail("Archive links, devices and extended header formats are unsupported.");
        const parts = name.split("/");
        for (let i = 1; i < parts.length; i++) {
          const parent = parts.slice(0, i).join("/");
          if (regularPaths.has(parent)) fail("Archive file/directory paths conflict.");
          parentPaths.add(parent);
        }
        if (kind !== 53) {
          if (parentPaths.has(name)) fail("Archive file/directory paths conflict.");
          regularPaths.add(name);
        }
        remaining = octal(124, 12);
        if (remaining > DEPLOYMENT_LIMITS.archiveExpandedBytes)
          fail("Archive entry exceeds the decompressed byte limit.");
        if (kind === 53 && remaining !== 0) fail("Archive directory cannot contain a payload.");
        padding = (512 - (remaining % 512)) % 512;
        if (name === "package/package.json") {
          if (
            kind === 53 ||
            manifest ||
            capture ||
            remaining > DEPLOYMENT_LIMITS.archiveManifestBytes
          )
            fail("Archive requires one bounded ordinary package manifest.");
          capture = Buffer.alloc(remaining);
          captured = 0;
          if (remaining === 0) {
            manifest = capture;
            capture = undefined;
          }
        }
      }
    }
    if (headerBytes !== 0 || remaining !== 0 || padding !== 0 || zeroBlocks < 2 || !manifest)
      fail("Truncated archive or missing package manifest.");
    return record(parseDependencyJSON(decodeSnapshotText(manifest)));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("[portable-dependencies]")) throw error;
    fail("Dependency archive is invalid or unreadable; use a regular supported .tgz package.");
  } finally {
    source.destroy();
    decoder.destroy();
  }
}

/** All nested file dependencies use the root project base, verified with Bun 1.3.14 fixtures. */
export async function inspectPortableDependencies(
  stagingDir: string,
  packageBytes: Uint8Array,
  lockBytes: Uint8Array,
  availableFiles: ReadonlySet<string>,
): Promise<readonly string[]> {
  const manifest = record(parseDependencyJSON(decodeSnapshotText(packageBytes)));
  if (
    typeof record(manifest.dependencies ?? {}).auggy !== "string" &&
    typeof record(manifest.devDependencies ?? {}).auggy !== "string"
  )
    fail("Declare auggy in the project's local dependencies before exporting.");
  const local = new Set<string>();
  dependencies(manifest, local, true);
  const lock = record(parseDependencyJSON(decodeSnapshotText(lockBytes), true));
  if (
    lock.lockfileVersion !== 1 ||
    (lock.configVersion !== undefined && lock.configVersion !== 1) ||
    Object.keys(lock).some(
      (key) =>
        ![
          "lockfileVersion",
          "configVersion",
          "workspaces",
          "packages",
          "overrides",
          "trustedDependencies",
        ].includes(key),
    )
  )
    fail("Unsupported Bun lock syntax/version; regenerate a supported text lock locally.");
  const workspaces = record(lock.workspaces);
  if (Object.keys(workspaces).length !== 1 || !Object.hasOwn(workspaces, ""))
    fail("Portable export requires a single-project lock without workspaces.");
  const lockLocal = new Set<string>();
  dependencies(record(workspaces[""]), lockLocal, true);
  if (lock.overrides !== undefined) dependencies({ overrides: lock.overrides }, lockLocal, true);
  for (const entry of Object.values(record(lock.packages))) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string")
      fail("Unsupported Bun lock package entry.");
    const locator = entry[0].slice(entry[0].lastIndexOf("@") + 1);
    if (
      locator.startsWith("./") ||
      locator.startsWith("../") ||
      locator.startsWith("/") ||
      locator.startsWith("file:")
    ) {
      lockLocal.add(localPath(locator));
      if (entry.length !== 3 || typeof entry[2] !== "string" || !entry[2].startsWith("sha512-"))
        fail("Unsupported local archive lock entry.");
      dependencies(record(entry[1]), lockLocal);
    } else {
      dependencySpec(locator, lockLocal);
      if (
        entry.length !== 4 ||
        typeof entry[1] !== "string" ||
        typeof entry[3] !== "string" ||
        !entry[3].startsWith("sha512-")
      )
        fail("Unsupported registry lock entry.");
      if (entry[1] !== "") {
        let url: URL;
        try {
          url = new URL(entry[1]);
        } catch {
          fail("Unsupported registry lock location.");
        }
        if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
          fail("Registry lock locations must use credential-free HTTPS.");
      }
      dependencies(record(entry[2]), lockLocal);
    }
  }
  const budget: ArchiveBudget = { expanded: 0, entries: 0 };
  const visited = new Set<string>();
  // Set iteration sees newly discovered members; each canonical path is scanned once.
  for (const path of local) {
    if (visited.size >= DEPLOYMENT_LIMITS.visitedEntries)
      fail("Local dependency closure exceeds its entry limit.");
    if (!availableFiles.has(path))
      fail("A required local dependency is missing, excluded or not an ordinary contained file.");
    visited.add(path);
    dependencies(await archiveManifest(join(stagingDir, path), budget), local);
  }
  for (const path of lockLocal)
    if (!visited.has(path))
      fail(
        "Lock references a local archive outside the inspected manifest closure; refresh the lock locally.",
      );
  for (const path of visited)
    if (!lockLocal.has(path))
      fail("Local dependency is absent from the text lock; run a local install before exporting.");
  return [...visited].sort();
}
