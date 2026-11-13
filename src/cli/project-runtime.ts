import { createHash } from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep, win32 } from "node:path";

export interface RuntimeCapabilities {
  readonly schemaVersion: 1;
  readonly launcherProtocol: 1;
  readonly applicationContracts: readonly number[];
}

export interface ProjectRuntime {
  readonly projectDir: string;
  readonly packageRoot: string;
  readonly cliPath: string;
  readonly version: string;
  readonly manifestSHA256: string;
  readonly capabilities: RuntimeCapabilities | null;
  readonly applicationPath: string | null;
}

function mapping(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function satisfies(version: string, range: string): boolean {
  // Bun treats some unparseable ranges (for example "garbage") as wildcards.
  // Validate comparator syntax before asking it to evaluate a trusted manifest.
  const integer = "(?:0|[1-9]\\d*)";
  const identifier = `(?:${integer}|[0-9]*[A-Za-z-][0-9A-Za-z-]*)`;
  const prerelease = `(?:-${identifier}(?:\\.${identifier})*)?`;
  const build = "(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?";
  const complete = `${integer}\\.${integer}\\.${integer}${prerelease}${build}`;
  const wildcard = "[xX*]";
  const partial = `(?:${wildcard}|${integer}(?:\\.(?:${wildcard}(?:\\.${wildcard})?|${integer}(?:\\.${wildcard})?))?)`;
  const target = `v?(?:${complete}|${partial})`;
  const comparator = `(?:<=|>=|<|>|=|~|\\^)?\\s*${target}`;
  const branch = new RegExp(
    `^(?:${comparator})(?:\\s+${comparator})*$|^${target}\\s+-\\s+${target}$`,
  );
  if (!new RegExp(`^${complete}$`).test(version)) {
    return false;
  }
  if (!range.split("||").every((alternative) => branch.test(alternative.trim()))) return false;
  try {
    return Bun.semver.satisfies(version, range);
  } catch {
    return false;
  }
}

/** Select Bun's ESM export conditions directly; project tsconfig aliases are not metadata. */
function applicationExportTarget(value: unknown): string | null | undefined {
  if (typeof value === "string") return value;
  if (!mapping(value)) return null;
  for (const [condition, target] of Object.entries(value)) {
    if (["bun", "node", "import", "default"].includes(condition)) {
      const selected = applicationExportTarget(target);
      // An unmatched nested condition permits a later outer fallback. Explicit
      // null still blocks resolution, including when an outer default exists.
      if (selected !== undefined) return selected;
    }
  }
  return undefined;
}

export function parseRuntimeCapabilities(value: unknown): RuntimeCapabilities | null {
  if (value === undefined) return null;
  if (
    !mapping(value) ||
    Object.keys(value).some(
      (key) => !["schemaVersion", "launcherProtocol", "applicationContracts"].includes(key),
    ) ||
    value.schemaVersion !== 1 ||
    value.launcherProtocol !== 1 ||
    !Array.isArray(value.applicationContracts) ||
    value.applicationContracts.length === 0 ||
    value.applicationContracts.some((entry) => !Number.isSafeInteger(entry) || entry < 1) ||
    new Set(value.applicationContracts).size !== value.applicationContracts.length
  ) {
    throw new Error(
      "[runtime] local Auggy has unsupported or malformed runtime capability metadata",
    );
  }
  return Object.freeze({
    schemaVersion: 1,
    launcherProtocol: 1,
    applicationContracts: Object.freeze([...value.applicationContracts]),
  });
}

function containedFile(path: string, packageRoot: string): string {
  const actual = realpathSync(path);
  const rel = relative(packageRoot, actual);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !statSync(actual).isFile()) {
    throw new Error("invalid-package-entry");
  }
  return actual;
}

/** Resolve explicit project-local installation metadata without executing a package. */
export function inspectProjectRuntime(
  projectDir: string,
  options: { applicationContract?: number; bunVersion?: string } = {},
): ProjectRuntime {
  const bunVersion = options.bunVersion ?? Bun.version;
  if (!satisfies(bunVersion, ">=1.3.14")) {
    throw new Error("[runtime] this launcher requires Bun 1.3.14 or newer");
  }

  let project: string;
  let packageRoot: string;
  let manifestBytes: Buffer;
  let manifest: Record<string, unknown>;
  try {
    project = realpathSync(resolve(projectDir));
    if (!mapping(JSON.parse(readFileSync(join(project, "package.json"), "utf8")))) {
      throw new Error("invalid-project-manifest");
    }
    // Probe this exact directory; generic resolution must not walk to an ancestor.
    packageRoot = realpathSync(join(project, "node_modules", "auggy"));
    if (!statSync(packageRoot).isDirectory()) throw new Error("invalid-package-root");
    const manifestPath = containedFile(join(packageRoot, "package.json"), packageRoot);
    manifestBytes = readFileSync(manifestPath);
    const parsed: unknown = JSON.parse(manifestBytes.toString("utf8"));
    if (!mapping(parsed) || parsed.name !== "auggy") throw new Error("invalid-runtime-manifest");
    manifest = parsed;
  } catch {
    throw new Error(
      "[runtime] install Auggy explicitly in this project with bun install; a valid local auggy package is required",
    );
  }

  const version = manifest.version;
  if (
    typeof version !== "string" ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error("[runtime] local Auggy package has an invalid version field");
  }
  const capabilities = parseRuntimeCapabilities(manifest.auggyRuntime);
  const bunRange = mapping(manifest.engines) ? manifest.engines.bun : undefined;
  if (
    (capabilities !== null && (typeof bunRange !== "string" || bunRange.trim() === "")) ||
    (bunRange !== undefined && (typeof bunRange !== "string" || !satisfies(bunVersion, bunRange)))
  ) {
    throw new Error("[runtime] local Auggy's declared Bun requirement is not satisfied");
  }
  const requestedContract = options.applicationContract;
  if (
    requestedContract !== undefined &&
    (!Number.isSafeInteger(requestedContract) ||
      requestedContract !== 1 ||
      !capabilities?.applicationContracts.includes(requestedContract))
  ) {
    throw new Error(
      "[runtime] local Auggy does not support application contract 1; update the project dependency before starting this application",
    );
  }

  let cliPath: string;
  let applicationPath: string | null = null;
  try {
    const bin =
      typeof manifest.bin === "string"
        ? manifest.bin
        : mapping(manifest.bin)
          ? manifest.bin.auggy
          : undefined;
    if (
      typeof bin !== "string" ||
      !bin ||
      bin !== bin.trim() ||
      bin.includes("\\") ||
      [...bin].some(
        (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      isAbsolute(bin) ||
      win32.isAbsolute(bin) ||
      /^[A-Za-z][A-Za-z0-9+.-]*:/.test(bin)
    ) {
      throw new Error("invalid-cli-entry");
    }
    cliPath = containedFile(resolve(packageRoot, bin), packageRoot);
    if (requestedContract !== undefined) {
      if (!mapping(manifest.exports) || !Object.hasOwn(manifest.exports, "./application")) {
        throw new Error("missing-application-export");
      }
      const target = applicationExportTarget(manifest.exports["./application"]);
      if (!target?.startsWith("./") || target.includes("\\")) {
        throw new Error("invalid-application-export");
      }
      applicationPath = containedFile(resolve(packageRoot, target), packageRoot);
      const projectImport = containedFile(
        Bun.resolveSync("auggy/application", project),
        packageRoot,
      );
      if (applicationPath !== projectImport) throw new Error("application-export-redirected");
    }
  } catch {
    throw new Error(
      "[runtime] local Auggy's CLI or application export is missing or escapes its package",
    );
  }
  return Object.freeze({
    projectDir: project,
    packageRoot,
    cliPath,
    version,
    manifestSHA256: createHash("sha256").update(manifestBytes).digest("hex"),
    capabilities,
    applicationPath,
  });
}
