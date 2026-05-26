import { findCsrfToken } from "@/lib/api";
import type { CsrfToken } from "@/lib/types";

async function identityFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base).toString();
  return fetch(url, init);
}

export interface IdentityRead {
  path: string;
  content: string;
  contentBytes: number;
  modifiedIso: string | null;
}

export async function readIdentity(): Promise<IdentityRead> {
  const res = await identityFetch("/console/api/identity");
  if (!res.ok) {
    const body = (await safeJson(res)) as { error?: string };
    throw new Error(body.error ?? `HTTP ${res.status}`);
  }
  return (await res.json()) as IdentityRead;
}

export interface IdentityWriteResult {
  ok: boolean;
  message: string;
  modifiedIso?: string;
  contentBytes?: number;
}

export async function writeIdentity(
  csrfTokens: CsrfToken[],
  content: string,
): Promise<IdentityWriteResult> {
  const csrf = findCsrfToken(csrfTokens, "identity-save");
  if (!csrf) return { ok: false, message: "Missing CSRF token for identity-save" };
  const res = await identityFetch("/console/api/identity", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, content }),
  });
  if (res.status === 419) {
    return { ok: false, message: "Session expired — reload the page." };
  }
  const body = (await safeJson(res)) as { ok?: boolean; message?: string; error?: string };
  if (!res.ok) {
    return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
  }
  return { ok: !!body.ok, message: body.message ?? body.error ?? "" };
}

async function safeJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return {};
  }
}
