/**
 * Agent-anchored ESM import helper.
 *
 * Resolves an npm specifier against the agent directory's `node_modules`
 * (not auggy's own `node_modules`) and dynamically imports it as ESM.
 *
 * This is the load-bearing primitive of the v0.3.2 package split: provider
 * SDKs and the `@auggy/link` augment moved out of auggy's core dependencies
 * and into per-agent `package.json` declarations. The CLI binary still ships
 * from a global install, but the engines + link augment resolve from each
 * agent's local install. That way an agent picking Anthropic-only doesn't
 * carry the OpenAI SDK in its supply chain.
 *
 * Why not `createRequire(...).require(specifier)`?
 *
 *   `@auggy/link` (and a growing fraction of modern packages) ship as
 *   pure-ESM (`"type": "module"`). CJS `require()` throws on those with
 *   ERR_REQUIRE_ESM. We want resolution + dynamic-import, never CJS load.
 *
 * Algorithm:
 *   1. Confirm `<agentDir>/package.json` exists (used as the resolution
 *      anchor; `createRequire` needs a real file path).
 *   2. `createRequire(...).resolve(specifier)` — pure resolution against
 *      the agent dir's `node_modules`. Honors the package's `exports` map
 *      and `type: module`; does NOT execute the module.
 *   3. `pathToFileURL` the resolved absolute path.
 *   4. `await import(url)` — dynamic ESM import. Works for both ESM and
 *      CJS packages (Node + Bun both accept either via this path).
 *
 * Error path:
 *   When the specifier is not installed, this throws a single clear error
 *   pointing the operator at `bun install` in the agent dir. The error text
 *   intentionally avoids prescribing the exact `auggy add` command because
 *   the specifier-to-augment mapping isn't 1:1 (e.g. `@supabase/supabase-js`
 *   is pulled in by the `supabaseMemory` augment).
 */

import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

export class MissingAgentDependencyError extends Error {
  readonly agentDir: string;
  readonly specifier: string;

  constructor(agentDir: string, specifier: string, cause?: unknown) {
    super(
      `Cannot find "${specifier}" in ${agentDir}/node_modules.\n` +
        `  Run: cd ${agentDir} && bun install\n` +
        `  (this usually means the agent's package.json was edited but install hasn't run, ` +
        `or the agent was scaffolded with auggy < 0.3.2).`,
    );
    this.name = "MissingAgentDependencyError";
    this.agentDir = agentDir;
    this.specifier = specifier;
    if (cause !== undefined) {
      (this as { cause?: unknown }).cause = cause;
    }
  }
}

export class MissingAgentManifestError extends Error {
  readonly agentDir: string;

  constructor(agentDir: string) {
    super(
      `Agent dir "${agentDir}" has no package.json. ` +
        `Re-scaffold via \`auggy create <name>\`, or write the manifest manually ` +
        `with \`auggy\` + the chosen \`@auggy/<engine>\` adapter as dependencies, ` +
        `then run \`bun install\` in the agent dir.`,
    );
    this.name = "MissingAgentManifestError";
    this.agentDir = agentDir;
  }
}

/**
 * Resolve and dynamically import an npm specifier from the agent dir's
 * `node_modules`. Returns the imported module (full namespace object).
 *
 * @throws {MissingAgentManifestError} when `<agentDir>/package.json` is absent.
 * @throws {MissingAgentDependencyError} when the specifier is not installed.
 */
export async function importFromAgent<T = unknown>(
  agentDir: string,
  specifier: string,
): Promise<T> {
  const manifestPath = join(agentDir, "package.json");
  if (!existsSync(manifestPath)) {
    throw new MissingAgentManifestError(agentDir);
  }

  // Explicit isolation guard (Codex 2nd-pass finding #3).
  //
  // Node's `require.resolve` walks UP from the caller's manifest location
  // and stops at the first matching `node_modules/<pkg>`. The `paths`
  // option theoretically restricts this, but Bun's `createRequire` does NOT
  // honor it as Node's docs describe — resolution still finds ancestor
  // packages. Without this guard, an agent created under a wrapping
  // monorepo (or a developer's `~/projects/<x>/`) silently satisfies a
  // missing dep from the parent's `node_modules`. The agent appears
  // healthy locally and breaks — or worse, runs against the wrong SDK
  // version — on a clean machine where only `<agentDir>/node_modules` is
  // present.
  //
  // Defense: probe `<agentDir>/node_modules/<pkg>` directly. If the
  // package directory isn't present agent-locally (real dir or symlink to
  // a workspace target both pass `existsSync`), refuse to resolve. The
  // subsequent `require.resolve` then operates on a tree we've confirmed
  // has the package as its FIRST hit during Node's upward walk.
  const packageName = extractPackageName(specifier);
  const packageRoot = join(agentDir, "node_modules", packageName);
  if (!existsSync(packageRoot)) {
    throw new MissingAgentDependencyError(agentDir, specifier);
  }

  const localRequire = createRequire(manifestPath);
  let resolved: string;
  try {
    resolved = localRequire.resolve(specifier);
  } catch (err) {
    // Node's resolution failure surfaces as MODULE_NOT_FOUND (or similar
    // shapes across runtimes). Treat any resolution failure as "package not
    // installed" — the existsSync above already excluded the missing-manifest
    // case, and a misnamed specifier at this layer is itself a missing-
    // dependency to the agent.
    throw new MissingAgentDependencyError(agentDir, specifier, err);
  }

  const moduleUrl = pathToFileURL(resolved).href;
  return (await import(moduleUrl)) as T;
}

/**
 * Extract the package-name portion of an npm specifier. Handles both
 * unscoped (`foo`, `foo/bar/baz` → `foo`) and scoped (`@scope/foo`,
 * `@scope/foo/sub/path` → `@scope/foo`) forms. Used by the isolation
 * guard above to probe `<agentDir>/node_modules/<pkg>`.
 */
function extractPackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const segments = specifier.split("/");
    const scope = segments[0];
    const name = segments[1];
    // Reject `@`, `@/foo`, `@scope`, `@scope/` — the scope itself must have
    // at least one character beyond the leading `@`, and the package name
    // must be a non-empty segment. npm itself rejects these shapes, but the
    // helper guards explicitly so misuse fails with a clear message rather
    // than probing a path that can never exist.
    if (!scope || scope.length <= 1 || !name) {
      throw new Error(`Invalid scoped specifier "${specifier}": expected @scope/name shape.`);
    }
    return `${scope}/${name}`;
  }
  const head = specifier.split("/")[0];
  if (!head) {
    throw new Error(`Invalid specifier "${specifier}": empty package name.`);
  }
  return head;
}
