import { findCsrfToken } from "@/lib/api";
import type { CsrfToken } from "@/lib/types";

async function credFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base).toString();
  return fetch(url, init);
}

export interface CredentialsEntry {
  key: string;
  length: number;
  empty: boolean;
}

export interface CredentialsList {
  path: string;
  exists: boolean;
  modifiedIso: string | null;
  entries: CredentialsEntry[];
}

export async function listCredentials(): Promise<CredentialsList> {
  const res = await credFetch("/console/api/credentials");
  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as CredentialsList;
}

export async function revealCredential(
  csrfTokens: CsrfToken[],
  key: string,
): Promise<{ value: string } | { error: string }> {
  const csrf = findCsrfToken(csrfTokens, "cred-reveal");
  if (!csrf) return { error: "Missing CSRF token for cred-reveal" };
  const res = await credFetch("/console/api/credentials/reveal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, key }),
  });
  if (res.status === 419) return { error: "Session expired — reload the page." };
  const body = (await safeJson(res)) as { value?: string; error?: string };
  if (!res.ok) return { error: body.error ?? `HTTP ${res.status}` };
  return { value: body.value ?? "" };
}

export interface CredentialMutationResult {
  ok: boolean;
  message: string;
}

async function postCred(
  path: string,
  csrfTokens: CsrfToken[],
  actionId: string,
  payload: Record<string, unknown>,
): Promise<CredentialMutationResult> {
  const csrf = findCsrfToken(csrfTokens, actionId);
  if (!csrf) return { ok: false, message: `Missing CSRF token for ${actionId}` };
  const res = await credFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, ...payload }),
  });
  if (res.status === 419) return { ok: false, message: "Session expired — reload the page." };
  const body = (await safeJson(res)) as { ok?: boolean; message?: string; error?: string };
  if (!res.ok) return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
  return { ok: !!body.ok, message: body.message ?? body.error ?? "" };
}

export function setCredential(
  csrfTokens: CsrfToken[],
  key: string,
  value: string,
): Promise<CredentialMutationResult> {
  return postCred("/console/api/credentials/set", csrfTokens, "cred-set", { key, value });
}

export function deleteCredential(
  csrfTokens: CsrfToken[],
  key: string,
): Promise<CredentialMutationResult> {
  return postCred("/console/api/credentials/delete", csrfTokens, "cred-delete", { key });
}

/**
 * Atomic rename. Replaces the previous delete-then-set sequence which could
 * permanently drop the secret if the set step failed. The server performs
 * one read/modify/write — there is no intermediate state where the secret
 * is missing from .env.
 */
export function renameCredential(
  csrfTokens: CsrfToken[],
  oldKey: string,
  newKey: string,
  value: string,
): Promise<CredentialMutationResult> {
  return postCred("/console/api/credentials/rename", csrfTokens, "cred-rename", {
    oldKey,
    newKey,
    value,
  });
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
