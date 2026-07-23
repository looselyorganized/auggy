/**
 * Server-side helpers for the console identity API.
 *
 * `identity.md` is the agent's preamble — loaded at boot and pinned in
 * context on every turn. The path comes from `agent.yaml`'s `identity:`
 * field (typically `./identity.md`) and is resolved against `agentDir`.
 *
 * Console identity endpoints can read and write this file for future editor
 * surfaces. Writes don't take effect until the agent restarts because the
 * preamble is boot-loaded.
 */

import { readManagedText, resolveManagedPath, writeManagedText } from "./admin-managed-files";

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
  const rel = identityRel ?? "./identity.md";
  return resolveManagedPath(agentDir, rel);
}

export function readIdentity(
  agentDir: string | undefined,
  identityRel: string | undefined,
): IdentityReadResult | { error: string } {
  const path = resolveIdentityPath(agentDir, identityRel);
  if (!path) return { error: "agent directory or identity path not configured" };
  const result = readManagedText(agentDir, identityRel ?? "./identity.md", MAX_IDENTITY_BYTES);
  if ("error" in result) return result;
  if ("missing" in result) {
    return {
      path,
      content: "",
      contentBytes: 0,
      modifiedIso: null,
    };
  }
  return {
    path: result.path,
    content: result.content,
    contentBytes: result.contentBytes,
    modifiedIso: result.modifiedIso,
  };
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
  const result = writeManagedText(agentDir, identityRel ?? "./identity.md", content, {
    maxBytes: MAX_IDENTITY_BYTES,
    mode: 0o600,
  });
  if ("error" in result) return { ok: false, message: result.error };
  return {
    ok: true,
    message: "Saved identity.md — restart the agent for changes to load into context.",
    path: result.path,
    modifiedIso: result.modifiedIso,
    contentBytes: result.contentBytes,
  };
}
