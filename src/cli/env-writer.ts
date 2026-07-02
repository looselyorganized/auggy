import { readFileSync } from "node:fs";
import { parseEnvFile, serializeEnv, type EnvLine } from "./env-parse";
import { writeFileSafely } from "./safe-write";

export function upsertEnvValues(
  envPath: string,
  values: Record<string, string>,
  opts: { header?: string } = {},
): string[] {
  const lines: EnvLine[] = readEnvLines(envPath, opts.header);

  const existing = new Map<string, number>();
  lines.forEach((line, index) => {
    if (line.kind === "kv") existing.set(line.key, index);
  });

  const written: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    const index = existing.get(key);
    const line: EnvLine = { kind: "kv", key, value, raw: `${key}=${value}` };
    if (index === undefined) {
      lines.push(line);
      existing.set(key, lines.length - 1);
    } else {
      lines[index] = line;
    }
    written.push(key);
  }

  writeFileSafely(envPath, serializeEnv(lines), { mode: 0o600 });
  return written;
}

function readEnvLines(envPath: string, header?: string): EnvLine[] {
  try {
    return parseEnvFile(readFileSync(envPath, "utf-8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    return [{ kind: "comment", raw: header ?? "# Agent secrets — gitignored." }, { kind: "blank" }];
  }
}
