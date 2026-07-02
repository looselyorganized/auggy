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

import { existsSync } from "node:fs";
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
  const auggySpecifier = input.auggyPackageSpecifier?.trim() || versionRange;

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

/**
 * Stable key ordering for dependency maps. Same shape Bun uses when it
 * normalises lockfile output — keeps diffs predictable.
 */
function sortedRecord(input: Record<string, string>): Record<string, string> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}
