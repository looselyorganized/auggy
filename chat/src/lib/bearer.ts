import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

/**
 * Reads `<agentDir>/.env` and extracts the value of `AUGGY_WEB_TOKEN`.
 * Returns null if the file or variable is missing.
 *
 * Minimal .env parser: handles quoted/unquoted values, comments, CRLF.
 * Does NOT support variable interpolation, multi-line values, or escaped quotes.
 */
export function extractBearerFromEnv(agentDir: string): string | null {
  const envPath = join(agentDir, ".env");
  if (!existsSync(envPath)) return null;

  const content = readFileSync(envPath, "utf8");
  const lines = content.split(/\r?\n/);

  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;

    const eq = line.indexOf("=");
    if (eq < 0) continue;

    const key = line.slice(0, eq).trim();
    if (key !== "AUGGY_WEB_TOKEN") continue;

    let value = line.slice(eq + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return null;
}
