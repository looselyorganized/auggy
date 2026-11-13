import { readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep, win32 } from "node:path";
import { parse as parseYaml } from "yaml";
import type { ApplicationConfig } from "./types";

/** Metadata only: no configuration factories, environment loading, or runtime imports. */
export interface ResolvedApplicationDefinition {
  readonly configPath: string;
  readonly projectDir: string;
  readonly entrypointPath: string;
  readonly application: ApplicationConfig;
}

export function parseApplicationDeclaration(value: unknown): ApplicationConfig | undefined {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("application: must be an object with entrypoint and contractVersion");
  }
  const block = value as Record<string, unknown>;
  if (Object.keys(block).some((key) => key !== "entrypoint" && key !== "contractVersion")) {
    throw new Error("application: only entrypoint and contractVersion are supported");
  }
  if (block.contractVersion !== 1) {
    throw new Error("application.contractVersion: this runtime supports integer contract 1");
  }
  const entrypoint = block.entrypoint;
  if (
    typeof entrypoint !== "string" ||
    entrypoint.length === 0 ||
    entrypoint.trim() !== entrypoint ||
    entrypoint.includes("\\") ||
    Array.from(entrypoint).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127) ||
    entrypoint.includes("${") ||
    isAbsolute(entrypoint) ||
    win32.isAbsolute(entrypoint) ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(entrypoint)
  ) {
    throw new Error("application.entrypoint: must be a literal relative filesystem path");
  }
  return Object.freeze({ entrypoint, contractVersion: 1 });
}

/**
 * Preserve existing config-relative project semantics. Canonicalize the selected
 * directory, not a config symlink's target parent; both augments and application
 * entrypoints remain relative to the directory the operator selected.
 */
export function resolveApplicationDefinition(
  configPath: string,
  application: ApplicationConfig,
): ResolvedApplicationDefinition {
  const declaration = parseApplicationDeclaration(application)!;
  let projectDir: string;
  let entrypointPath: string;
  try {
    projectDir = realpathSync(dirname(resolve(configPath)));
    entrypointPath = realpathSync(resolve(projectDir, declaration.entrypoint));
    const rel = relative(projectDir, entrypointPath);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error("outside-project");
    }
    if (!statSync(entrypointPath).isFile()) throw new Error("not-file");
  } catch {
    throw new Error("application.entrypoint: must resolve to a regular file inside the project");
  }
  return Object.freeze({
    configPath: join(projectDir, basename(resolve(configPath))),
    projectDir,
    entrypointPath,
    application: declaration,
  });
}

/** Small preflight reader, deliberately independent from the full config parser. */
export function readApplicationDefinition(
  configPath: string,
): ResolvedApplicationDefinition | undefined {
  let document: unknown;
  try {
    document = parseYaml(readFileSync(configPath, "utf8"));
  } catch {
    // YAML diagnostics can include secret-bearing source excerpts.
    throw new Error("application: selected configuration must be readable, valid YAML");
  }
  if (document === null || typeof document !== "object" || Array.isArray(document)) {
    throw new Error("application: selected configuration must be a YAML mapping");
  }
  const application = parseApplicationDeclaration(
    (document as Record<string, unknown>).application,
  );
  return application ? resolveApplicationDefinition(configPath, application) : undefined;
}
