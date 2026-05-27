/**
 * Server-side helpers for the `/admin` Identity tab.
 *
 * `identity.md` is the agent's preamble — loaded at boot and pinned in
 * context on every turn. The path comes from `agent.yaml`'s `identity:`
 * field (typically `./identity.md`) and is resolved against `agentDir`.
 *
 * The Identity tab needs to read and write this file. Writes don't take
 * effect until the agent restarts (preamble is boot-loaded), so the SPA
 * surfaces a "restart required" banner on success.
 */

import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve, sep } from "node:path";

export interface IdentityReadResult {
  path: string;
  content: string;
  contentBytes: number;
  modifiedIso: string | null;
}

const MAX_IDENTITY_BYTES = 256 * 1024; // 256 KiB

/**
 * Resolve the identity.md path declared in `agent.yaml` against the agent
 * directory. Rejects absolute paths and any path that escapes `agentDir`
 * (path-traversal guard). Returns the resolved absolute path or `null`
 * when the inputs are invalid.
 */
export function resolveIdentityPath(
  agentDir: string | undefined,
  identityRel: string | undefined,
): string | null {
  if (!agentDir) return null;
  const rel = identityRel ?? "./identity.md";
  if (isAbsolute(rel)) return null;
  const full = resolve(agentDir, rel);
  const dirWithSep = agentDir.endsWith(sep) ? agentDir : agentDir + sep;
  if (!full.startsWith(dirWithSep) && full !== agentDir) return null;
  return full;
}

export function readIdentity(
  agentDir: string | undefined,
  identityRel: string | undefined,
): IdentityReadResult | { error: string } {
  const path = resolveIdentityPath(agentDir, identityRel);
  if (!path) return { error: "agent directory or identity path not configured" };
  if (!existsSync(path)) {
    return {
      path,
      content: "",
      contentBytes: 0,
      modifiedIso: null,
    };
  }
  let content = "";
  let contentBytes = 0;
  let modifiedIso: string | null = null;
  try {
    content = readFileSync(path, "utf-8");
    const st = statSync(path);
    contentBytes = st.size;
    modifiedIso = st.mtime.toISOString();
  } catch (err) {
    return { error: `read failed: ${(err as Error).message}` };
  }
  return { path, content, contentBytes, modifiedIso };
}

export interface IdentityWriteResult {
  ok: boolean;
  message: string;
  path?: string;
  modifiedIso?: string;
  contentBytes?: number;
}

export function writeIdentity(
  agentDir: string | undefined,
  identityRel: string | undefined,
  content: string,
): IdentityWriteResult {
  const path = resolveIdentityPath(agentDir, identityRel);
  if (!path) return { ok: false, message: "agent directory or identity path not configured" };
  if (Buffer.byteLength(content, "utf-8") > MAX_IDENTITY_BYTES) {
    return { ok: false, message: `identity.md exceeds ${MAX_IDENTITY_BYTES} bytes` };
  }
  try {
    writeFileSync(path, content, "utf-8");
    const st = statSync(path);
    return {
      ok: true,
      message: "Saved identity.md — restart the agent for changes to load into context.",
      path,
      modifiedIso: st.mtime.toISOString(),
      contentBytes: st.size,
    };
  } catch (err) {
    return { ok: false, message: `write failed: ${(err as Error).message}` };
  }
}
