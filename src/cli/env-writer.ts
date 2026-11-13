import { readFileSync } from "node:fs";
import { parseEnvFile, serializeEnv, type EnvLine } from "./env-parse";
import { writeFileSafely } from "./safe-write";

export function upsertEnvValues(
  envPath: string,
  values: Record<string, string>,
  opts: { header?: string } = {},
): string[] {
  const source = readEnvSource(envPath);
  writeFileSafely(envPath, renderEnvValues(source, values, opts), { mode: 0o600 });
  return Object.keys(values);
}

/** Pure counterpart for callers that already hold a bounded credential snapshot. */
export function renderEnvValues(
  source: string | undefined,
  values: Record<string, string>,
  opts: { header?: string } = {},
): string {
  const lines: EnvLine[] =
    source === undefined
      ? [
          { kind: "comment", raw: opts.header ?? "# Agent secrets — gitignored." },
          { kind: "blank" },
        ]
      : parseEnvFile(source);
  const replacements = new Map(Object.entries(values));
  const replaced = new Set<string>();
  const updated: EnvLine[] = [];

  for (const line of lines) {
    if (line.kind !== "kv" || !replacements.has(line.key)) {
      updated.push(line);
      continue;
    }
    // Keep one definition at the first existing position and remove later
    // duplicates. Runtime .env loading is first-definition-wins, so leaving a
    // stale earlier value would make the successful write ineffective.
    if (replaced.has(line.key)) continue;
    const value = replacements.get(line.key)!;
    updated.push({ kind: "kv", key: line.key, value, raw: `${line.key}=${value}` });
    replaced.add(line.key);
  }

  for (const [key, value] of replacements) {
    if (replaced.has(key)) continue;
    updated.push({ kind: "kv", key, value, raw: `${key}=${value}` });
  }

  return serializeEnv(updated);
}

function readEnvSource(envPath: string): string | undefined {
  try {
    return readFileSync(envPath, "utf-8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return undefined;
  }
}
