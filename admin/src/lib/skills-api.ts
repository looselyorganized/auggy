import { findCsrfToken } from "@/lib/api";
import type { CsrfToken } from "@/lib/types";

/**
 * Same-origin fetch helper for the skills endpoints. Mirrors `adminFetch`
 * in `lib/api.ts` — strips userinfo from `window.location` so relative URLs
 * resolve cleanly even when the operator authenticated via inline credentials.
 */
async function skillsFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base).toString();
  return fetch(url, init);
}

export async function readSkillContent(folder: string): Promise<string> {
  const res = await skillsFetch(`/admin/api/skills/${encodeURIComponent(folder)}/content`);
  if (!res.ok) {
    const detail = await safeText(res);
    throw new Error(`${res.status} ${res.statusText}${detail ? ` — ${detail}` : ""}`);
  }
  const body = (await res.json()) as { content: string };
  return body.content;
}

export interface SkillMutationResult {
  ok: boolean;
  message: string;
}

async function postSkillJson(
  path: string,
  csrfTokens: CsrfToken[],
  actionId: string,
  folder: string,
  extra: Record<string, unknown> = {},
): Promise<SkillMutationResult> {
  const csrf = findCsrfToken(csrfTokens, actionId, folder);
  if (!csrf) return { ok: false, message: `Missing CSRF token for ${actionId}/${folder}` };
  const res = await skillsFetch(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, ...extra }),
  });
  if (res.status === 419) {
    return { ok: false, message: "Session expired — reload the page." };
  }
  let body: { ok?: boolean; message?: string; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* keep empty */
  }
  if (!res.ok) {
    return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
  }
  return { ok: !!body.ok, message: body.message ?? body.error ?? "" };
}

export function editSkill(
  csrfTokens: CsrfToken[],
  folder: string,
  content: string,
): Promise<SkillMutationResult> {
  return postSkillJson(
    `/admin/api/skills/${encodeURIComponent(folder)}/edit`,
    csrfTokens,
    "skill-edit",
    folder,
    { content },
  );
}

export function removeSkill(csrfTokens: CsrfToken[], folder: string): Promise<SkillMutationResult> {
  return postSkillJson(
    `/admin/api/skills/${encodeURIComponent(folder)}/remove`,
    csrfTokens,
    "skill-remove",
    folder,
  );
}

export function resetSkill(csrfTokens: CsrfToken[], folder: string): Promise<SkillMutationResult> {
  return postSkillJson(
    `/admin/api/skills/${encodeURIComponent(folder)}/reset`,
    csrfTokens,
    "skill-reset",
    folder,
  );
}

export function installSkill(csrfTokens: CsrfToken[], folder: string): Promise<SkillMutationResult> {
  return postSkillJson(
    `/admin/api/skills/${encodeURIComponent(folder)}/install`,
    csrfTokens,
    "skill-install",
    folder,
  );
}

export async function createSkill(
  csrfTokens: CsrfToken[],
  folder: string,
  content?: string,
): Promise<SkillMutationResult> {
  const csrf = findCsrfToken(csrfTokens, "skill-create");
  if (!csrf) return { ok: false, message: "Missing CSRF token for skill-create" };
  const res = await skillsFetch("/admin/api/skills/create", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ csrf, folder, content }),
  });
  if (res.status === 419) {
    return { ok: false, message: "Session expired — reload the page." };
  }
  let body: { ok?: boolean; message?: string; error?: string } = {};
  try {
    body = (await res.json()) as typeof body;
  } catch {
    /* keep empty */
  }
  if (!res.ok) {
    return { ok: false, message: body.error ?? body.message ?? `HTTP ${res.status}` };
  }
  return { ok: !!body.ok, message: body.message ?? body.error ?? "" };
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}
