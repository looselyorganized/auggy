import type { DashboardData, CsrfToken } from "./types";

/**
 * Same-origin fetch. Modern browsers send HTTP Basic creds automatically on
 * same-origin requests once the user has authenticated to the origin (via the
 * native auth prompt). We deliberately do NOT set `credentials: "include"` —
 * that mode rejects URLs containing user:password in the address bar.
 *
 * Chrome ALSO refuses to construct a Request from a URL that carries userinfo
 * (e.g. `http://:token@localhost:8081/admin/...`). When the operator navigates
 * with inline credentials to bypass the native sign-in prompt, `window.location`
 * inherits that userinfo, which then poisons every relative-URL fetch. Resolve
 * the fetch URL against a credentials-stripped clone of `window.location` so
 * both auth-entry paths (native prompt OR inline URL credentials) work.
 */
async function adminFetch(input: string, init: RequestInit = {}): Promise<Response> {
  const base = new URL(window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base).toString();
  return fetch(url, init);
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const res = await adminFetch("/admin/api/dashboard", { signal });
  if (!res.ok) {
    throw new Error(`/admin/api/dashboard ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as DashboardData;
}

export function findCsrfToken(
  tokens: CsrfToken[],
  actionId: string,
  rowKey?: string,
): string | null {
  const match = tokens.find(
    (t) => t.actionId === actionId && (t.rowKey ?? undefined) === rowKey,
  );
  return match?.token ?? null;
}

export interface ActionPostResult {
  /** Flash message extracted from the redirect's `?msg=` query param. */
  message: string;
  /** True iff the server returned 303 (action dispatched successfully). */
  ok: boolean;
  /** True iff the CSRF token was rejected as expired (page needs a reload). */
  csrfExpired: boolean;
}

/**
 * Post an admin action. Mirrors the server's existing HTML-form contract
 * (`application/x-www-form-urlencoded` body, `_csrf` field, 303 redirect to
 * `/admin?msg=...`). We read the Location header instead of following the
 * redirect so the SPA can surface the flash message inline rather than
 * navigating away.
 */
export async function postAction(
  actionId: string,
  csrfToken: string,
  values: Record<string, string> = {},
  rowKey?: string,
): Promise<ActionPostResult> {
  const path = rowKey
    ? `/admin/action/${encodeURIComponent(actionId)}/row/${encodeURIComponent(rowKey)}`
    : `/admin/action/${encodeURIComponent(actionId)}`;
  const body = new URLSearchParams({ _csrf: csrfToken, ...values }).toString();
  const res = await adminFetch(path, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
    redirect: "manual",
  });

  // The server distinguishes expired CSRF (200 + auto-refresh HTML) from
  // tampered (403) and from missing handlers (404). 303 = success.
  if (res.status === 303) {
    const location = res.headers.get("location") ?? "";
    const msg = new URL(location, "http://localhost").searchParams.get("msg") ?? "";
    return { ok: true, csrfExpired: false, message: msg };
  }
  if (res.status === 200) {
    // Expired CSRF — the server replies with a refresh page.
    const text = await res.text();
    if (text.includes("Session expired")) {
      return { ok: false, csrfExpired: true, message: "Session expired — refreshing…" };
    }
  }
  if (res.status === 403) {
    return { ok: false, csrfExpired: false, message: "Forbidden (CSRF or auth check failed)" };
  }
  if (res.status === 404) {
    return { ok: false, csrfExpired: false, message: "Action not found" };
  }
  return { ok: false, csrfExpired: false, message: `Unexpected status ${res.status}` };
}
