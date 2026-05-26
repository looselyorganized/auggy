/**
 * Server-side helpers for the `/admin` Credentials tab.
 *
 * Reads, parses, and writes `<agentDir>/.env` while preserving comments and
 * blank lines. Values are masked in list responses and only revealed via an
 * explicit per-request endpoint (still bearer + CSRF-gated).
 *
 * Constraints:
 *   - Keys must match POSIX env-var rules: `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Values may contain anything; we double-quote on write when they contain
 *     whitespace, `=`, `"`, `'`, `$`, `#`, or leading/trailing whitespace.
 *   - File round-trips through `parseEnvFile` → mutations → `serializeEnv`
 *     so the operator's comments and ordering survive edits.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// ---------------------------------------------------------------------------
// File parsing / serialization
// ---------------------------------------------------------------------------

export type EnvLine =
  | { kind: "kv"; key: string; value: string; raw: string }
  | { kind: "comment"; raw: string }
  | { kind: "blank" };

const KV_LINE_RE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Parse a .env file body into an ordered list of lines. Each line is either
 * a key/value, a comment, or a blank line. Comments and blanks are preserved
 * verbatim so a round-trip leaves the operator's structure intact.
 *
 * Quoting: handles `'…'` and `"…"` wrappers (strips the quotes for the
 * runtime value). Backslash escapes inside double quotes (\n, \t, \", \\)
 * are decoded; single-quoted values pass through literally.
 */
export function parseEnvFile(text: string): EnvLine[] {
  const lines = text.split(/\r?\n/);
  // Drop a trailing empty line caused by a file ending in \n so we don't
  // emit a phantom blank on every round-trip.
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();

  const out: EnvLine[] = [];
  for (const raw of lines) {
    if (raw.trim().length === 0) {
      out.push({ kind: "blank" });
      continue;
    }
    if (raw.trim().startsWith("#")) {
      out.push({ kind: "comment", raw });
      continue;
    }
    const m = raw.match(KV_LINE_RE);
    if (!m) {
      // Unrecognized — treat as a comment so it survives the round-trip.
      out.push({ kind: "comment", raw });
      continue;
    }
    const key = m[1]!;
    const value = decodeEnvValue(m[2]!);
    out.push({ kind: "kv", key, value, raw });
  }
  return out;
}

function decodeEnvValue(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, '"')
      .replace(/\\\\/g, "\\");
  }
  if (trimmed.length >= 2 && trimmed.startsWith("'") && trimmed.endsWith("'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Re-emit an EnvLine array as a `.env` body, always ending with a newline. */
export function serializeEnv(lines: EnvLine[]): string {
  return (
    lines
      .map((line) => {
        if (line.kind === "blank") return "";
        if (line.kind === "comment") return line.raw;
        return `${line.key}=${encodeEnvValue(line.value)}`;
      })
      .join("\n") + "\n"
  );
}

function encodeEnvValue(value: string): string {
  if (value === "") return "";
  // Quote when the value would round-trip ambiguously otherwise.
  const needsQuotes =
    /[\s"'=$#]|^\s|\s$/.test(value) || value.includes("\n") || value.includes("\t");
  if (!needsQuotes) return value;
  const escaped = value
    .replace(/\\/g, "\\\\")
    .replace(/"/g, '\\"')
    .replace(/\n/g, "\\n")
    .replace(/\t/g, "\\t");
  return `"${escaped}"`;
}

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function envPath(agentDir: string | undefined): string | null {
  if (!agentDir) return null;
  return join(agentDir, ".env");
}

function readEnvFile(agentDir: string | undefined):
  | {
      lines: EnvLine[];
      path: string;
      exists: boolean;
      modifiedIso: string | null;
    }
  | { error: string } {
  const path = envPath(agentDir);
  if (!path) return { error: "agent directory not configured" };
  if (!existsSync(path)) {
    return { lines: [], path, exists: false, modifiedIso: null };
  }
  try {
    const text = readFileSync(path, "utf-8");
    const st = statSync(path);
    return {
      lines: parseEnvFile(text),
      path,
      exists: true,
      modifiedIso: st.mtime.toISOString(),
    };
  } catch (err) {
    return { error: `read failed: ${(err as Error).message}` };
  }
}

function writeEnvFile(
  agentDir: string | undefined,
  lines: EnvLine[],
): { ok: true; modifiedIso: string } | { ok: false; message: string } {
  const path = envPath(agentDir);
  if (!path) return { ok: false, message: "agent directory not configured" };
  try {
    writeFileSync(path, serializeEnv(lines), "utf-8");
    const st = statSync(path);
    return { ok: true, modifiedIso: st.mtime.toISOString() };
  } catch (err) {
    return { ok: false, message: `write failed: ${(err as Error).message}` };
  }
}

// ---------------------------------------------------------------------------
// API surface
// ---------------------------------------------------------------------------

export interface CredentialsEntry {
  key: string;
  /** Number of characters in the value — useful for "x chars" UI hint. */
  length: number;
  /** True when the value is empty. */
  empty: boolean;
}

export interface CredentialsList {
  path: string;
  exists: boolean;
  modifiedIso: string | null;
  entries: CredentialsEntry[];
}

const MASK_HIDDEN_KEYS_BUT_ENV = new Set([
  // Keep this list short — most "interesting" keys are credentials and the
  // operator already knows what they store. Listed here only for keys that
  // are NEVER credentials by convention so the UI can offer reveal-by-default.
  // (Currently empty — all keys are treated as sensitive until reveal.)
]);

export function listCredentials(agentDir: string | undefined): CredentialsList | { error: string } {
  const result = readEnvFile(agentDir);
  if ("error" in result) return result;
  const entries: CredentialsEntry[] = result.lines
    .filter((l): l is Extract<EnvLine, { kind: "kv" }> => l.kind === "kv")
    .map((l) => ({
      key: l.key,
      length: l.value.length,
      empty: l.value.length === 0,
    }));
  return {
    path: result.path,
    exists: result.exists,
    modifiedIso: result.modifiedIso,
    entries,
  };
}

export function revealCredential(
  agentDir: string | undefined,
  key: string,
): { value: string } | { error: string } {
  if (!KEY_RE.test(key)) return { error: "invalid key" };
  const result = readEnvFile(agentDir);
  if ("error" in result) return result;
  // Last write wins — match the runtime's loadEnvFile behavior.
  let value: string | undefined;
  for (const line of result.lines) {
    if (line.kind === "kv" && line.key === key) value = line.value;
  }
  if (value === undefined) return { error: "key not found" };
  return { value };
}

export interface CredentialMutationResult {
  ok: boolean;
  message: string;
  modifiedIso?: string;
}

/**
 * Upsert a credential. Updates the first matching line in place; appends a
 * new line at the end when the key is new. Preserves comments and blanks.
 */
export function setCredential(
  agentDir: string | undefined,
  key: string,
  value: string,
): CredentialMutationResult {
  if (!KEY_RE.test(key)) {
    return { ok: false, message: "key must match [A-Za-z_][A-Za-z0-9_]* (no spaces or hyphens)" };
  }
  if (value.includes("\0")) return { ok: false, message: "value contains a null byte" };
  if (value.length > 64 * 1024) return { ok: false, message: "value exceeds 64 KiB" };

  const result = readEnvFile(agentDir);
  if ("error" in result) return { ok: false, message: result.error };
  const lines: EnvLine[] = [...result.lines];
  let replaced = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind === "kv" && line.key === key) {
      lines[i] = { kind: "kv", key, value, raw: `${key}=${value}` };
      replaced = true;
      break;
    }
  }
  if (!replaced) {
    // New key: ensure a blank line separates it from prior content for
    // readability, but only when the file isn't empty AND the last line
    // isn't already blank.
    if (lines.length > 0 && lines[lines.length - 1]!.kind !== "blank") {
      lines.push({ kind: "blank" });
    }
    lines.push({ kind: "kv", key, value, raw: `${key}=${value}` });
  }
  const w = writeEnvFile(agentDir, lines);
  if (!w.ok) return { ok: false, message: w.message };
  return {
    ok: true,
    message: replaced ? `Updated ${key}` : `Added ${key}`,
    modifiedIso: w.modifiedIso,
  };
}

export function deleteCredential(
  agentDir: string | undefined,
  key: string,
): CredentialMutationResult {
  if (!KEY_RE.test(key)) return { ok: false, message: "invalid key" };
  const result = readEnvFile(agentDir);
  if ("error" in result) return { ok: false, message: result.error };
  const filtered = result.lines.filter((l) => !(l.kind === "kv" && l.key === key));
  if (filtered.length === result.lines.length) {
    return { ok: false, message: "key not found" };
  }
  const w = writeEnvFile(agentDir, filtered);
  if (!w.ok) return { ok: false, message: w.message };
  return { ok: true, message: `Removed ${key}`, modifiedIso: w.modifiedIso };
}

// Exposed for tests + future code that wants to know which keys never get
// masked. Today unused at runtime; lint won't warn since referenced below.
void MASK_HIDDEN_KEYS_BUT_ENV;
