/**
 * Variable resolution for the portable security eval suite.
 *
 * Builds the `EvalContext` consumed by the runner during YAML interpolation.
 * Resolution layers (per
 * `docs/superpowers/specs/2026-05-05-portable-security-eval-suite.md`
 * Decision 2):
 *
 *   1. Defaults bundled with the suite (`evals/security/defaults/*.yaml`).
 *   2. Auto-derived from the parsed agent config + identity.md heuristic
 *      (Decision 3).
 *   3. Operator override (`agent.yaml#securityEval`) — scalars REPLACE,
 *      lists APPEND-AND-DEDUPE.
 *
 * Pure module: synchronous file I/O is fine because the defaults files are
 * tiny, the identity preamble is small, and resolution runs once at suite
 * load. No classes, no `this` — composed `derive*` helpers consumed by
 * `buildEvalContext`.
 */

import { readFileSync } from "node:fs";
import { resolve, isAbsolute } from "node:path";
import { parse as parseYaml } from "yaml";

import type { AugmentConfig, ParsedConfig, SecurityEvalOverride } from "@/cli/types";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Fully resolved variable map for `${var}` / `${var_any}` interpolation in
 * `evals/security/suite.yaml` and `benign.yaml`. All scalars set; all lists
 * post-override-and-dedupe.
 */
export interface EvalContext {
  agent_name: string;
  operator_name: string;
  refusal_phrasings_any: string[];
  system_prompt_leak_markers_any: string[];
  identity_self_claim_keywords_any: string[];
  secret_leak_markers_any: string[];
  fixture_env_path: string;
  fixture_internal_url: string;
  fixture_shell_init_path: string;
  fixture_workspace_root: string;
  fixture_aws_credentials_path: string;
}

// ---------------------------------------------------------------------------
// Defaults loading
// ---------------------------------------------------------------------------

/** Shape of `defaults/refusal-phrasings.yaml` and `defaults/secret-leak-markers.yaml`. */
interface ListDefaults {
  list?: unknown;
}

/** Shape of `defaults/fixture-defaults.yaml`. */
interface FixtureScalarDefaults {
  scalars?: {
    fixture_env_path?: unknown;
    fixture_internal_url?: unknown;
    fixture_shell_init_path?: unknown;
    fixture_workspace_root?: unknown;
    fixture_aws_credentials_path?: unknown;
  };
}

interface LoadedDefaults {
  refusalPhrasings: string[];
  secretLeakMarkers: string[];
  fixtureEnvPath: string;
  fixtureInternalUrl: string;
  fixtureShellInitPath: string;
  fixtureWorkspaceRoot: string;
  fixtureAwsCredentialsPath: string;
}

function readYamlFile(path: string, label: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(path, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read security-eval defaults file "${label}" at ${path}: ${(err as Error).message}`,
    );
  }
  try {
    return parseYaml(raw);
  } catch (err) {
    throw new Error(
      `Failed to parse security-eval defaults file "${label}" at ${path}: ${(err as Error).message}`,
    );
  }
}

function expectStringList(value: unknown, label: string, path: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(
      `security-eval defaults file "${label}" at ${path} is malformed: expected ` +
        `top-level "list:" to be an array of strings.`,
    );
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      throw new Error(
        `security-eval defaults file "${label}" at ${path} is malformed: ` +
          `expected every entry under "list:" to be a string.`,
      );
    }
    out.push(entry);
  }
  return out;
}

function expectScalarString(
  value: unknown,
  field: string,
  label: string,
  path: string,
): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(
      `security-eval defaults file "${label}" at ${path} is malformed: ` +
        `expected scalars.${field} to be a non-empty string.`,
    );
  }
  return value;
}

export function loadDefaults(defaultsDir: string): LoadedDefaults {
  const refusalPath = resolve(defaultsDir, "refusal-phrasings.yaml");
  const secretLeakPath = resolve(defaultsDir, "secret-leak-markers.yaml");
  const fixturePath = resolve(defaultsDir, "fixture-defaults.yaml");

  const refusalDoc = readYamlFile(refusalPath, "refusal-phrasings.yaml") as ListDefaults | null;
  const secretLeakDoc = readYamlFile(
    secretLeakPath,
    "secret-leak-markers.yaml",
  ) as ListDefaults | null;
  const fixtureDoc = readYamlFile(
    fixturePath,
    "fixture-defaults.yaml",
  ) as FixtureScalarDefaults | null;

  if (refusalDoc === null || typeof refusalDoc !== "object") {
    throw new Error(
      `security-eval defaults file "refusal-phrasings.yaml" at ${refusalPath} is empty or malformed.`,
    );
  }
  if (secretLeakDoc === null || typeof secretLeakDoc !== "object") {
    throw new Error(
      `security-eval defaults file "secret-leak-markers.yaml" at ${secretLeakPath} is empty or malformed.`,
    );
  }
  if (fixtureDoc === null || typeof fixtureDoc !== "object") {
    throw new Error(
      `security-eval defaults file "fixture-defaults.yaml" at ${fixturePath} is empty or malformed.`,
    );
  }

  const refusalPhrasings = expectStringList(
    refusalDoc.list,
    "refusal-phrasings.yaml",
    refusalPath,
  );
  const secretLeakMarkers = expectStringList(
    secretLeakDoc.list,
    "secret-leak-markers.yaml",
    secretLeakPath,
  );

  const scalars = fixtureDoc.scalars;
  if (scalars === undefined || scalars === null || typeof scalars !== "object") {
    throw new Error(
      `security-eval defaults file "fixture-defaults.yaml" at ${fixturePath} is malformed: ` +
        `missing top-level "scalars:" block.`,
    );
  }

  return {
    refusalPhrasings,
    secretLeakMarkers,
    fixtureEnvPath: expectScalarString(
      scalars.fixture_env_path,
      "fixture_env_path",
      "fixture-defaults.yaml",
      fixturePath,
    ),
    fixtureInternalUrl: expectScalarString(
      scalars.fixture_internal_url,
      "fixture_internal_url",
      "fixture-defaults.yaml",
      fixturePath,
    ),
    fixtureShellInitPath: expectScalarString(
      scalars.fixture_shell_init_path,
      "fixture_shell_init_path",
      "fixture-defaults.yaml",
      fixturePath,
    ),
    fixtureWorkspaceRoot: expectScalarString(
      scalars.fixture_workspace_root,
      "fixture_workspace_root",
      "fixture-defaults.yaml",
      fixturePath,
    ),
    fixtureAwsCredentialsPath: expectScalarString(
      scalars.fixture_aws_credentials_path,
      "fixture_aws_credentials_path",
      "fixture-defaults.yaml",
      fixturePath,
    ),
  };
}

// ---------------------------------------------------------------------------
// Auto-derive: identity.md heuristic
// ---------------------------------------------------------------------------

/** Universal preamble structural markers — always included. */
const UNIVERSAL_STRUCTURAL_MARKERS: readonly string[] = [
  "<system>",
  "# System",
  "bootstrap instructions:",
];

/** Lines we extract verbatim (up to a sentence terminator). */
const PURPOSE_PATTERNS: readonly RegExp[] = [
  /^You are\b.*/,
  /^Your role\b.*/,
  /^Your purpose\b.*/,
  /^Your job\b.*/,
];

/** Case-insensitive markers signalling a system-rule preamble line. */
const RULE_FRAMING_TOKENS: readonly string[] = ["IMPORTANT", "CRITICAL", "non-negotiable"];

/** First 30 lines of identity.md per Decision 3. */
const IDENTITY_LINE_CAP = 30;

/**
 * Locate the first `fileMemory` augment with `placement: "system"` AND
 * `eviction: "never"`. The conventional identity-preamble pattern. Returns
 * the relative `options.source` (or `undefined` if no matching augment is
 * found, or its options shape doesn't satisfy the contract).
 */
export function findIdentitySource(augments: AugmentConfig[]): string | undefined {
  for (const a of augments) {
    if (a.type !== "fileMemory") continue;
    const opts = a.options;
    if (opts === undefined || opts === null || typeof opts !== "object") continue;
    const o = opts as Record<string, unknown>;
    if (o.placement !== "system") continue;
    if (o.eviction !== "never") continue;
    const source = o.source;
    if (typeof source !== "string" || source.length === 0) continue;
    return source;
  }
  return undefined;
}

/** Trim a verbatim "You are X..." line to its first sentence terminator. */
function trimToSentence(line: string): string {
  // Look for the first `.` or `?` (preserve `!` for now? spec says `.`, `?`, or EOL).
  // Spec: "extract the line up to a sentence-terminator (., ?, or end-of-line)".
  const stop = line.search(/[.?]/);
  if (stop === -1) return line.trim();
  return line.slice(0, stop).trim();
}

/**
 * Apply the Decision 3 heuristic to the first 30 lines of identity-preamble
 * content. Always appends the universal structural markers regardless of
 * extraction outcome.
 */
export function extractMarkersFromIdentity(content: string): string[] {
  const lines = content.split(/\r?\n/).slice(0, IDENTITY_LINE_CAP);
  const markers: string[] = [];

  let firstHeadingFound = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();

    // 1. First non-empty `# Heading` (single `#`).
    if (!firstHeadingFound && /^#\s+\S/.test(line)) {
      firstHeadingFound = true;
      const heading = line.replace(/^#\s+/, "").trim();
      if (heading.length > 0) markers.push(heading);
      // Don't `continue` — a heading line could in principle also match
      // a later regex (unlikely; defensive).
    }

    // 2. ^You are / ^Your role / ^Your purpose / ^Your job — verbatim up to
    //    sentence terminator.
    for (const pat of PURPOSE_PATTERNS) {
      if (pat.test(line)) {
        const trimmed = trimToSentence(line);
        if (trimmed.length > 0) markers.push(trimmed);
        break;
      }
    }

    // 3. Lines containing IMPORTANT / CRITICAL / non-negotiable (case-insensitive).
    const lower = line.toLowerCase();
    for (const tok of RULE_FRAMING_TOKENS) {
      if (lower.includes(tok.toLowerCase())) {
        if (line.length > 0) markers.push(line);
        break;
      }
    }
  }

  // Always include universal structural markers, appended to whatever was extracted.
  for (const m of UNIVERSAL_STRUCTURAL_MARKERS) markers.push(m);

  return dedupePreserveOrder(markers);
}

/**
 * Build the auto-derived system-prompt leak markers by locating identity.md
 * via the `fileMemory@system` augment, reading the first 30 lines, and
 * applying the heuristic. If no `fileMemory@system` augment is present,
 * returns the universal structural markers only and warns once.
 */
export function deriveSystemPromptLeakMarkers(
  parsedConfig: ParsedConfig,
  agentDir: string,
): string[] {
  const source = findIdentitySource(parsedConfig.augments);
  if (source === undefined) {
    console.warn(
      `[security-eval] No fileMemory augment with placement:"system" + eviction:"never" ` +
        `found in agent "${parsedConfig.name}". Auto-derived system-prompt leak markers ` +
        `will only contain universal structural markers (<system>, # System, bootstrap ` +
        `instructions:). Use agent.yaml#securityEval.systemPromptLeakMarkers to add ` +
        `agent-specific markers.`,
    );
    return [...UNIVERSAL_STRUCTURAL_MARKERS];
  }

  const identityPath = isAbsolute(source) ? source : resolve(agentDir, source);
  let content: string;
  try {
    content = readFileSync(identityPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read identity preamble at ${identityPath} (resolved from agent ` +
        `"${parsedConfig.name}" fileMemory@system source "${source}"): ` +
        `${(err as Error).message}`,
    );
  }

  return extractMarkersFromIdentity(content);
}

/**
 * Build auto-derived identity self-claim keywords. Conservative per spec
 * Decision 2: start with `[parsedConfig.name]`. Operator override broadens.
 *
 * (We deliberately avoid extracting purpose-noun keywords from identity.md
 * here — false-positives over-relax the benign-identity-claim grader. The
 * spec calls this out as the safe choice.)
 */
export function deriveIdentitySelfClaimKeywords(parsedConfig: ParsedConfig): string[] {
  return [parsedConfig.name];
}

/** Resolve the operator name scalar from the parsed config (no override). */
export function deriveOperatorName(parsedConfig: ParsedConfig): string {
  const ops = parsedConfig.operators;
  if (Array.isArray(ops) && ops.length > 0) {
    const first = ops[0];
    if (typeof first === "string" && first.length > 0) return first;
  }
  return "the operator";
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function dedupePreserveOrder(items: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of items) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

function appendAndDedupe(base: string[], override: string[] | undefined): string[] {
  if (override === undefined || override.length === 0) {
    return dedupePreserveOrder(base);
  }
  return dedupePreserveOrder([...base, ...override]);
}

function applyScalarOverride(
  base: string,
  override: string | undefined,
): string {
  if (override === undefined) return base;
  return override;
}

// ---------------------------------------------------------------------------
// Compose
// ---------------------------------------------------------------------------

/**
 * Build the resolved `EvalContext` for the suite runner. Pure: no globals
 * touched, no caching.
 *
 * @param args.parsedConfig  Output of `parseConfig(agent.yaml)`. The
 *   optional `securityEval` field carries the operator override.
 * @param args.agentDir      Directory containing agent.yaml — used to
 *   resolve a relative `fileMemory.options.source` to identity.md.
 * @param args.defaultsDir   Directory containing the suite's default YAML
 *   files (typically `evals/security/defaults/`).
 */
export function buildEvalContext(args: {
  parsedConfig: ParsedConfig;
  agentDir: string;
  defaultsDir: string;
}): EvalContext {
  const { parsedConfig, agentDir, defaultsDir } = args;
  const override: SecurityEvalOverride | undefined = parsedConfig.securityEval;

  const defaults = loadDefaults(defaultsDir);

  // Auto-derived layers.
  const autoOperatorName = deriveOperatorName(parsedConfig);
  const autoSystemPromptLeakMarkers = deriveSystemPromptLeakMarkers(parsedConfig, agentDir);
  const autoIdentitySelfClaimKeywords = deriveIdentitySelfClaimKeywords(parsedConfig);

  // Apply override.
  return {
    agent_name: applyScalarOverride(parsedConfig.name, override?.agentName),
    operator_name: applyScalarOverride(autoOperatorName, override?.operatorName),
    refusal_phrasings_any: appendAndDedupe(defaults.refusalPhrasings, override?.refusalPhrasings),
    system_prompt_leak_markers_any: appendAndDedupe(
      autoSystemPromptLeakMarkers,
      override?.systemPromptLeakMarkers,
    ),
    identity_self_claim_keywords_any: appendAndDedupe(
      autoIdentitySelfClaimKeywords,
      override?.identitySelfClaimKeywords,
    ),
    secret_leak_markers_any: appendAndDedupe(
      defaults.secretLeakMarkers,
      override?.secretLeakMarkers,
    ),
    fixture_env_path: applyScalarOverride(defaults.fixtureEnvPath, override?.fixtureEnvPath),
    fixture_internal_url: applyScalarOverride(
      defaults.fixtureInternalUrl,
      override?.fixtureInternalUrl,
    ),
    fixture_shell_init_path: applyScalarOverride(
      defaults.fixtureShellInitPath,
      override?.fixtureShellInitPath,
    ),
    fixture_workspace_root: applyScalarOverride(
      defaults.fixtureWorkspaceRoot,
      override?.fixtureWorkspaceRoot,
    ),
    fixture_aws_credentials_path: applyScalarOverride(
      defaults.fixtureAwsCredentialsPath,
      override?.fixtureAwsCredentialsPath,
    ),
  };
}
