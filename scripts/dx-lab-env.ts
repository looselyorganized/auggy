import { readFileSync } from "node:fs";
import { parseEnvFile } from "../src/cli/env-parse";

/** Read one DX secret with the same dotenv semantics used by the runtime. */
export function readDxLabEnvValue(path: string, key: string): string | undefined {
  for (const line of parseEnvFile(readFileSync(path, "utf-8"))) {
    if (line.kind !== "kv" || line.key !== key || line.value.length === 0) continue;
    if (/[\0\r\n]/.test(line.value)) {
      throw new Error(`${key} must be a single-line value in the DX secrets file`);
    }
    return line.value;
  }
  return undefined;
}

if (import.meta.main) {
  const [path, key] = process.argv.slice(2);
  if (!path || !key) throw new Error("usage: dx-lab-env.ts <path> <key>");
  const value = readDxLabEnvValue(path, key);
  if (value !== undefined) process.stdout.write(value);
}
