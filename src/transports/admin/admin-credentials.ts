/**
 * Server-side helpers for the console credentials API.
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
 *
 * IMPORTANT: parsing/serialization is owned by `src/cli/env-parse.ts`, which
 * is also used by `loadEnvFile` so the runtime and the UI agree on disk
 * format by construction. Do not duplicate the parser here.
 */

import { ENV_KEY_RE, parseEnvFile, serializeEnv, type EnvLine } from "../../cli/env-parse";
import { readManagedText, resolveManagedPath, writeManagedText } from "./admin-managed-files";

export type { EnvLine } from "../../cli/env-parse";
export { parseEnvFile, serializeEnv } from "../../cli/env-parse";

const KEY_RE = ENV_KEY_RE;
const MAX_ENV_FILE_BYTES = 1024 * 1024;

// ---------------------------------------------------------------------------
// File I/O
// ---------------------------------------------------------------------------

function envPath(agentDir: string | undefined): string | null {
  return resolveManagedPath(agentDir, ".env");
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
  const file = readManagedText(agentDir, ".env", MAX_ENV_FILE_BYTES);
  if ("error" in file) return file;
  if ("missing" in file) {
    return { lines: [], path, exists: false, modifiedIso: null };
  }
  return {
    lines: parseEnvFile(file.content),
    path: file.path,
    exists: true,
    modifiedIso: file.modifiedIso,
  };
}

function writeEnvFile(
  agentDir: string | undefined,
  lines: EnvLine[],
): { ok: true; modifiedIso: string } | { ok: false; message: string } {
  const path = envPath(agentDir);
  if (!path) return { ok: false, message: "agent directory not configured" };
  const result = writeManagedText(agentDir, ".env", serializeEnv(lines), {
    maxBytes: MAX_ENV_FILE_BYTES,
    mode: 0o600,
  });
  if ("error" in result) return { ok: false, message: result.error };
  return { ok: true, modifiedIso: result.modifiedIso };
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

/**
 * Atomically rename a credential. Removes the old entry and writes the new
 * key/value in a single read/modify/write pass — there is no intermediate
 * filesystem state where the secret is missing.
 *
 * Codex adversarial-review Medium-1 fix. The previous flow was
 * delete-then-set client-side: a failure on the set step would have
 * permanently dropped the operator's secret with no rollback. This server
 * op is the safe replacement.
 *
 * Refuses to overwrite an existing destination key (unless oldKey===newKey,
 * which collapses to a value update). Refuses if the source key is missing.
 */
export function renameCredential(
  agentDir: string | undefined,
  oldKey: string,
  newKey: string,
  value: string,
): CredentialMutationResult {
  if (!KEY_RE.test(oldKey)) return { ok: false, message: "invalid oldKey" };
  if (!KEY_RE.test(newKey)) {
    return {
      ok: false,
      message: "newKey must match [A-Za-z_][A-Za-z0-9_]* (no spaces or hyphens)",
    };
  }
  if (value.includes("\0")) return { ok: false, message: "value contains a null byte" };
  if (value.length > 64 * 1024) return { ok: false, message: "value exceeds 64 KiB" };

  const result = readEnvFile(agentDir);
  if ("error" in result) return { ok: false, message: result.error };
  const lines: EnvLine[] = [...result.lines];

  let oldIdx = -1;
  let newIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.kind !== "kv") continue;
    if (line.key === oldKey) oldIdx = i;
    if (line.key === newKey) newIdx = i;
  }
  if (oldIdx === -1) return { ok: false, message: `key not found: ${oldKey}` };
  if (oldKey !== newKey && newIdx !== -1) {
    return { ok: false, message: `destination key already exists: ${newKey}` };
  }

  // Replace in place at the old key's position so ordering and surrounding
  // comments are preserved. When oldKey===newKey we still want a value
  // update; the in-place replace handles both.
  lines[oldIdx] = { kind: "kv", key: newKey, value, raw: `${newKey}=${value}` };

  const w = writeEnvFile(agentDir, lines);
  if (!w.ok) return { ok: false, message: w.message };
  return {
    ok: true,
    message: oldKey === newKey ? `Updated ${newKey}` : `Renamed ${oldKey} → ${newKey}`,
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
