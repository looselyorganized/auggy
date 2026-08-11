/**
 * .env parser + Railway env-var push plan.
 *
 * Parses the agent dir's `.env` file (excluded from the bundle by design) and
 * produces a structured plan the deploy command shows to the operator for
 * confirmation BEFORE pushing to Railway. Plan structure:
 *
 *   { variables: [{ key, value, redactedValue }], warnings: [...] }
 *
 * `redactedValue` is a fixed marker. It never derives output from secret
 * bytes because prompts may be recorded in terminal scrollback or CI logs.
 *
 * This module does NOT call Railway. The deploy command calls `railway-cli`'s
 * `setVariable` for each plan entry after operator confirmation.
 */

import { existsSync, readFileSync } from "node:fs";
import { ENV_KEY_RE, parseEnvFile } from "../env-parse";

export interface EnvVariable {
  key: string;
  value: string;
  redactedValue: string;
}

export interface SecretsPlan {
  variables: EnvVariable[];
  warnings: string[];
}

const AGENTMAIL_SETUP_ONLY_KEYS = new Set([
  "AGENTMAIL_ACCOUNT_API_KEY",
  "AGENTMAIL_PARENT_API_KEY",
]);

/**
 * Describe whether a secret is set without exposing any value-derived bytes.
 */
export function redactValue(value: string): string {
  return value.length === 0 ? "<empty>" : "<set>";
}

/**
 * Parse a `.env` file string into a SecretsPlan. Skips blank lines and
 * comments. Tolerates quoted values + `export KEY=value` shorthand. Like the
 * runtime loader, an empty definition is skipped and the first nonempty
 * definition wins. Records a warning for malformed and duplicate lines rather
 * than throwing — operator gets the full picture before deciding to push.
 */
export function parseEnvText(text: string): SecretsPlan {
  const variables: EnvVariable[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  const lines = parseEnvFile(text);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind === "blank") continue;
    if (line.kind === "comment") {
      const raw = line.raw.trim();
      if (raw.startsWith("#")) continue;
      const rest = raw.startsWith("export ") ? raw.slice("export ".length).trimStart() : raw;
      const eqIdx = rest.indexOf("=");
      warnings.push(
        eqIdx < 0
          ? `line ${i + 1}: missing '=' delimiter; skipped`
          : `line ${i + 1}: invalid variable name; skipped`,
      );
      continue;
    }
    const { key, value } = line;
    // Keep this defense at the deploy boundary even though parseEnvFile has
    // already validated the key with the same shared contract.
    if (!ENV_KEY_RE.test(key)) throw new Error("shared dotenv parser returned an invalid key");
    if (AGENTMAIL_SETUP_ONLY_KEYS.has(key)) {
      warnings.push(
        `line ${i + 1}: ${key} is not a runtime credential; skipped. Deploy AGENTMAIL_API_KEY instead`,
      );
      continue;
    }

    if (seen.has(key)) {
      warnings.push(`line ${i + 1}: duplicate variable name; first nonempty value is retained`);
    }
    seen.add(key);

    if (value.length === 0) continue;

    // Match loadEnvFile: the first nonempty dotenv definition wins.
    const existing = variables.findIndex((v) => v.key === key);
    if (existing >= 0) continue;
    const entry: EnvVariable = { key, value, redactedValue: redactValue(value) };
    variables.push(entry);
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
