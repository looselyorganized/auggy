/**
 * Builders for the per-agent `package.json` written by `auggy create` and
 * mutated by `auggy augment add`. Pure functions; no filesystem access (the caller
 * does the I/O so tests stay hermetic).
 *
 * Per the v0.3.2 package split, every scaffolded agent dir is a real Node
 * package: it declares `auggy` and the chosen `@auggy/<provider>` engine
 * adapter as `dependencies`, plus any per-augment package deps from the
 * catalog (e.g. `@auggy/link` when the link augment is selected). `bun install`
 * in the agent dir hydrates `node_modules`, and the runtime resolves the
 * engine + ESM-only augments from there via `importFromAgent`.
 *
 * Why `auggy` is in the agent's deps (not just an engine peer):
 *   - The engine adapter packages declare `auggy` as a `peerDependency`.
 *     Without `auggy` installed in the agent's tree, `bun install` warns on
 *     peer-mismatch AND the adapter's `import { ... } from "auggy"` (for
 *     `ModelClient`, etc.) can't resolve at runtime.
 *   - Pinning `auggy` per-agent also means an agent uses the runtime it was
 *     scaffolded against, not whatever happens to be globally installed.
 */

import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import pkg from "../../package.json" with { type: "json" };
import type { CatalogEntry } from "./augment-catalog";
import type { Provider } from "./model-picker";

/**
 * Engine provider → npm package mapping. Single source of truth for which
 * adapter package an agent installs. Sibling to `PROVIDER_DEFAULTS` in
 * `commands/create.ts`; lives here because `auggy augment add` may also need it
 * later (e.g. if we ever support an `--engine` migration verb).
 */
export const PROVIDER_TO_PACKAGE: Record<Provider, string> = {
  anthropic: "@auggy/anthropic",
  openai: "@auggy/openai",
  openrouter: "@auggy/openrouter",
  ollama: "@auggy/ollama",
};

export interface BuildAgentPackageJsonInput {
  /** Agent name — used as the scaffolded package's name. */
  agentName: string;
  /** auggy core version this scaffold was built against (caret-pinned). */
  auggyVersion: string;
  /** Optional explicit core package specifier for local pack/install smoke tests. */
  auggyPackageSpecifier?: string;
  /** Optional exact package specifiers for coordinated local package testing. */
  packageSpecifiers?: Record<string, string>;
  /** Selected engine provider — chooses the adapter package. */
  provider: Provider;
  /** Selected augments — drives the per-augment `packageDeps` merge. */
  augments: CatalogEntry[];
}

/**
 * Build the JSON text for `<agentDir>/package.json`. Stringified with
 * 2-space indent + trailing newline so the output diff-cleanly under `git`
 * and Bun's lockfile generator.
 */
export function buildAgentPackageJson(input: BuildAgentPackageJsonInput): string {
  const versionRange = `^${input.auggyVersion}`;
  const auggySpecifier =
    input.packageSpecifiers?.auggy?.trim() || input.auggyPackageSpecifier?.trim() || versionRange;

  const dependencies: Record<string, string> = {
    auggy: auggySpecifier,
    [PROVIDER_TO_PACKAGE[input.provider]]: versionRange,
  };

  // Merge per-augment packageDeps from the catalog. If two augments declare
  // the same package at different specifiers, the later one wins — the merge
  // is in catalog order. (No catalog entries collide today; this is the
  // simplest forward-compatible policy.)
  for (const entry of input.augments) {
    if (!entry.packageDeps) continue;
    for (const [pkg, range] of Object.entries(entry.packageDeps)) {
      dependencies[pkg] = range;
    }
  }

  // Exact local package specs must win over semver defaults and augment deps.
  // This keeps a pre-publish checkout internally coherent when core and its
  // provider adapters share a version that does not exist on npm yet.
  for (const [packageName, specifier] of Object.entries(input.packageSpecifiers ?? {})) {
    if (specifier.trim()) dependencies[packageName] = specifier.trim();
  }

  const manifest = {
    name: `auggy-agent-${input.agentName}`,
    private: true,
    type: "module" as const,
    dependencies: sortedRecord(dependencies),
  };

  return `${JSON.stringify(manifest, null, 2)}\n`;
}

/**
 * Merge new package deps into an existing agent `package.json` text. Used
 * by `auggy augment add` when the operator picks an augment that brings external
 * packages. Returns the new JSON text + the diff (added/upgraded keys) so
 * the caller can decide whether to skip `bun install` if nothing changed.
 *
 * Re-stringifies with sorted dependencies for stable diffs across edits.
 */
export interface MergeResult {
  /** New `package.json` text (stringified with sorted deps). */
  text: string;
  /** Packages added or upgraded by this merge. Empty when no-op. */
  added: string[];
}

export function mergePackageDeps(
  existingText: string,
  additions: Record<string, string>,
): MergeResult {
  const parsed = JSON.parse(existingText) as Record<string, unknown>;
  const deps = (parsed.dependencies ?? {}) as Record<string, string>;

  const added: string[] = [];
  for (const [pkg, range] of Object.entries(additions)) {
    if (deps[pkg] !== range) {
      deps[pkg] = range;
      added.push(pkg);
    }
  }

  parsed.dependencies = sortedRecord(deps);
  return { text: `${JSON.stringify(parsed, null, 2)}\n`, added };
}

/**
 * Read the running auggy CLI's own `package.json.version`. Used by create /
 * add to caret-pin scaffolded agents against the runtime they were
 * scaffolded with.
 *
 * Sources from the static JSON import at the top of this module — the same
 * pattern `src/cli/index.ts` uses to populate `auggy --version` and that
 * `src/cli/commands/chat.ts` uses for the GUI version. Bun + Node both
 * include `package.json` in published tarballs by default, so the lookup
 * is reliable across install layouts (global npm, bun link, workspace).
 */
export function getAuggyVersion(): string {
  return pkg.version;
}

/**
 * Optional escape hatch for release smoke tests.
 *
 * Normal users should get semver ranges from npm. Local tarball verification
 * can set `AUGGY_SCAFFOLD_AUGGY_SPEC=file:/abs/path/auggy-x.y.z.tgz` so the
 * generated agent installs the exact runtime tarball being tested instead of
 * whatever version is currently published on the registry.
 */
export function getAuggyPackageSpecifierOverride(env = process.env): string | undefined {
  const spec = env.AUGGY_SCAFFOLD_AUGGY_SPEC?.trim();
  return spec || undefined;
}

export interface ResolveAuggyPackageSpecifierOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  version?: string;
}

export interface ResolveScaffoldPackageSpecifiersOptions
  extends ResolveAuggyPackageSpecifierOptions {
  provider: Provider;
  /** Test seam, or an explicit linked source root. False disables source fallback. */
  sourceRoot?: string | false;
}

const LOCAL_PROVIDER_PACKAGES: Record<Provider, string[]> = {
  anthropic: ["@auggy/anthropic"],
  openai: ["@auggy/openai"],
  openrouter: ["@auggy/openai", "@auggy/openrouter"],
  ollama: ["@auggy/ollama"],
};

/**
 * Resolve the coordinated package set used by `auggy create`.
 *
 * Registry installs use semver defaults. Inside an Auggy source checkout, core
 * and matching provider packages resolve from that checkout. Explicit tarball
 * overrides remain available for isolated release smoke tests.
 */
export function resolveScaffoldPackageSpecifiersForCreate(
  opts: ResolveScaffoldPackageSpecifiersOptions,
): Record<string, string> {
  const env = opts.env ?? process.env;
  const version = opts.version ?? getAuggyVersion();
  const cwd = opts.cwd ?? process.cwd();
  const linkedSourceRoot =
    opts.sourceRoot === false
      ? undefined
      : opts.sourceRoot
        ? resolve(opts.sourceRoot)
        : resolve(import.meta.dir, "../..");
  const workspaceRoot =
    findNearestAuggyWorkspace(cwd, version, opts.provider) ??
    (linkedSourceRoot && isMatchingAuggyWorkspace(linkedSourceRoot, version, opts.provider)
      ? linkedSourceRoot
      : undefined);
  const explicitAuggySpecifier = getAuggyPackageSpecifierOverride(env);
  const auggySpecifier =
    explicitAuggySpecifier ??
    (workspaceRoot
      ? `file:${workspaceRoot}`
      : resolveAuggyPackageSpecifierForCreate({ env: {}, cwd, version }));
  const specifiers: Record<string, string> = {};

  if (auggySpecifier) specifiers.auggy = auggySpecifier;

  const explicitEngineSpecifier = env.AUGGY_SCAFFOLD_ENGINE_SPEC?.trim();
  if (explicitEngineSpecifier) {
    specifiers[PROVIDER_TO_PACKAGE[opts.provider]] = explicitEngineSpecifier;
  }

  if (!auggySpecifier?.startsWith("file:")) return specifiers;

  if (!workspaceRoot) return specifiers;

  for (const packageName of LOCAL_PROVIDER_PACKAGES[opts.provider]) {
    if (specifiers[packageName]) continue;
    const packageDir = join(workspaceRoot, "packages", packageName.slice("@auggy/".length));
    if (isMatchingLocalPackage(packageDir, packageName, version)) {
      specifiers[packageName] = `file:${packageDir}`;
    }
  }

  return specifiers;
}

/**
 * Resolve an optional Auggy core package specifier for newly scaffolded agents.
 *
 * Published users should get semver (`^x.y.z`). Local release/DX smoke tests
 * should get the packed tarball being tested, otherwise `bun install` may pull
 * the already-published package with the same semver but an older runtime shape.
 */
export function resolveAuggyPackageSpecifierForCreate(
  opts: ResolveAuggyPackageSpecifierOptions = {},
): string | undefined {
  const explicit = getAuggyPackageSpecifierOverride(opts.env ?? process.env);
  if (explicit) return explicit;

  const version = opts.version ?? getAuggyVersion();
  const tarball = findNearestPackedAuggyTarball(opts.cwd ?? process.cwd(), version);
  return tarball ? `file:${tarball}` : undefined;
}

function findNearestPackedAuggyTarball(startDir: string, version: string): string | undefined {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = join(dir, `auggy-${version}.tgz`);
    if (existsSync(candidate)) return candidate;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function findNearestAuggyWorkspace(
  startDir: string,
  version: string,
  provider: Provider,
): string | undefined {
  let dir = resolve(startDir);
  for (let depth = 0; depth < 8; depth += 1) {
    if (isMatchingAuggyWorkspace(dir, version, provider)) return dir;

    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

function isMatchingAuggyWorkspace(dir: string, version: string, provider: Provider): boolean {
  if (!isMatchingLocalPackage(dir, "auggy", version)) return false;

  return LOCAL_PROVIDER_PACKAGES[provider].every((packageName) => {
    const packageDir = join(dir, "packages", packageName.slice("@auggy/".length));
    return isMatchingLocalPackage(packageDir, packageName, version);
  });
}

function isMatchingLocalPackage(dir: string, packageName: string, version: string): boolean {
  const manifestPath = join(dir, "package.json");
  if (!existsSync(manifestPath)) return false;

  try {
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === packageName && manifest.version === version;
  } catch {
    return false;
  }
}

/**
 * Stable key ordering for dependency maps. Same shape Bun uses when it
 * normalises lockfile output — keeps diffs predictable.
 */
function sortedRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
