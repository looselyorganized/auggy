import { readFileSync } from "node:fs";
import { parseEnvFile, serializeEnv, type EnvLine } from "./env-parse";
import { writeFileSafely } from "./safe-write";

export function upsertEnvValues(
  envPath: string,
  values: Record<string, string>,
  opts: { header?: string } = {},
): string[] {
  const lines: EnvLine[] = readEnvLines(envPath, opts.header);
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

  writeFileSafely(envPath, serializeEnv(updated), { mode: 0o600 });
  return [...replacements.keys()];
}

function readEnvLines(envPath: string, header?: string): EnvLine[] {
  try {
    return parseEnvFile(readFileSync(envPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [{ kind: "comment", raw: header ?? "# Agent secrets — gitignored." }, { kind: "blank" }];
  }
}
