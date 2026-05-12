/**
 * .env parser + Railway env-var push plan.
 *
 * Parses the agent dir's `.env` file (excluded from the bundle by design) and
 * produces a structured plan the deploy command shows to the operator for
 * confirmation BEFORE pushing to Railway. Plan structure:
 *
 *   { variables: [{ key, value, redactedValue }], warnings: [...] }
 *
 * `redactedValue` masks the middle of each value so the operator can confirm
 * the right secret without the full key being printed to the terminal.
 *
 * This module does NOT call Railway. The deploy command calls `railway-cli`'s
 * `setVariable` for each plan entry after operator confirmation.
 */

import { existsSync, readFileSync } from "node:fs";

export interface EnvVariable {
  key: string;
  value: string;
  redactedValue: string;
}

export interface SecretsPlan {
  variables: EnvVariable[];
  warnings: string[];
}

const KEY_RE = /^[A-Z_][A-Z0-9_]*$/i;

function unquote(raw: string): string {
  if (raw.length >= 2) {
    if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
      return raw.slice(1, -1);
    }
  }
  return raw;
}

/**
 * Redact a secret for terminal display. Reveals the first 4 and last 4 chars
 * for values >= 12 chars; shorter values are fully masked. Empty strings stay
 * empty so the operator notices.
 */
export function redactValue(value: string): string {
  if (value.length === 0) return "";
  if (value.length < 12) return "*".repeat(value.length);
  return `${value.slice(0, 4)}${"*".repeat(value.length - 8)}${value.slice(-4)}`;
}

/**
 * Parse a `.env` file string into a SecretsPlan. Skips blank lines and
 * comments. Tolerates quoted values + `export KEY=value` shorthand. Records
 * a warning for any malformed line rather than throwing — operator gets the
 * full picture before deciding to push.
 */
export function parseEnvText(text: string): SecretsPlan {
  const variables: EnvVariable[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;

    let rest = line.startsWith("export ") ? line.slice("export ".length).trimStart() : line;
    const eqIdx = rest.indexOf("=");
    if (eqIdx < 0) {
      warnings.push(`line ${i + 1}: no '=' found, skipped: "${line}"`);
      continue;
    }

    const key = rest.slice(0, eqIdx).trim();
    const value = unquote(rest.slice(eqIdx + 1).trim());

    if (!KEY_RE.test(key)) {
      warnings.push(`line ${i + 1}: invalid key "${key}", skipped`);
      continue;
    }

    if (seen.has(key)) {
      warnings.push(`line ${i + 1}: duplicate key "${key}" — later value overrides earlier`);
    }
    seen.add(key);

    // Replace any prior entry for the same key.
    const existing = variables.findIndex((v) => v.key === key);
    const entry: EnvVariable = { key, value, redactedValue: redactValue(value) };
    if (existing >= 0) {
      variables[existing] = entry;
    } else {
      variables.push(entry);
    }
  }

  return { variables, warnings };
}

/**
 * Read the agent dir's `.env` file and return a SecretsPlan. Returns an empty
 * plan + warning when `.env` doesn't exist (the agent may have no secrets,
 * which is rare but allowed).
 */
export function loadSecretsPlan(envPath: string): SecretsPlan {
  if (!existsSync(envPath)) {
    return {
      variables: [],
      warnings: [`no .env file at ${envPath} — nothing to push to Railway`],
    };
  }
  const text = readFileSync(envPath, "utf-8");
  return parseEnvText(text);
}
