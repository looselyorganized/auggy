import type { DashboardData, CsrfToken } from "./types";

/**
 * Same-origin fetch. Modern browsers send HTTP Basic creds automatically on
 * same-origin requests once the user has authenticated to the origin (via the
 * native auth prompt). We deliberately do NOT set `credentials: "include"` —
 * that mode rejects URLs containing user:password in the address bar.
 *
 * Chrome ALSO refuses to construct a Request from a URL that carries userinfo
 * (e.g. `http://:token@localhost:8081/console/...`). When the operator navigates
 * with inline credentials to bypass the native sign-in prompt, `window.location`
 * inherits that userinfo, which then poisons every relative-URL fetch. Resolve
 * the fetch URL against a credentials-stripped clone of `window.location` so
 * both auth-entry paths (native prompt OR inline URL credentials) work.
 */
export interface AdminFetchDependencies {
  fetchImpl?: AdminFetch;
  locationHref?: string;
}

export type AdminFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export async function adminFetch(
  input: string,
  init: RequestInit = {},
  dependencies: AdminFetchDependencies = {},
): Promise<Response> {
  const base = new URL(dependencies.locationHref ?? window.location.href);
  base.username = "";
  base.password = "";
  const url = new URL(input, base);
  if (url.origin !== base.origin) {
    throw new Error("Admin API requests must remain same-origin.");
  }
  url.username = "";
  url.password = "";
  return (dependencies.fetchImpl ?? fetch)(url.toString(), init);
}

export async function fetchDashboard(signal?: AbortSignal): Promise<DashboardData> {
  const res = await adminFetch("/console/api/dashboard", { signal });
  if (!res.ok) {
    throw new Error(`/console/api/dashboard ${res.status} ${res.statusText}`);
  }
  return (await res.json()) as DashboardData;
}

export function findCsrfToken(
  tokens: CsrfToken[],
  actionId: string,
  rowKey?: string,
  augmentName?: string,
): string | null {
  const match = tokens.find(
    (t) =>
      (t.augmentName ?? undefined) === augmentName &&
      t.actionId === actionId &&
      (t.rowKey ?? undefined) === rowKey,
  );
  return match?.token ?? null;
}

export function findUniqueActionAugment(
  tokens: CsrfToken[],
  actionId: string,
  rowKey?: string,
): string | undefined {
  const names = new Set(
    tokens
      .filter((token) => token.actionId === actionId && token.rowKey === rowKey)
      .map((token) => token.augmentName)
      .filter((name): name is string => typeof name === "string"),
  );
  return names.size === 1 ? [...names][0] : undefined;
}

export interface ActionPostResult {
  message: string;
  ok: boolean;
  csrfExpired: boolean;
  /** HTTP conflict, distinct from a domain-level stale result returned as 200. */
  conflict?: boolean;
  status?: number;
}

/**
 * Post a console action. The SPA asks for JSON so browsers do not hide the
 * server's 303 form redirect behind an opaque `status: 0` response.
 */
export async function postAction(
  actionId: string,
  csrfToken: string,
  values: Record<string, string> = {},
  rowKey?: string,
  augmentName?: string,
  dependencies: AdminFetchDependencies = {},
): Promise<ActionPostResult> {
  const actionPath = augmentName
    ? `/console/action/${encodeURIComponent(augmentName)}/${encodeURIComponent(actionId)}`
    : `/console/action/${encodeURIComponent(actionId)}`;
  const path = rowKey
    ? `${actionPath}/row/${encodeURIComponent(rowKey)}`
    : actionPath;
  const body = new URLSearchParams({ _csrf: csrfToken, ...values }).toString();
  const res = await adminFetch(
    path,
    {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/x-www-form-urlencoded",
      },
      body,
    },
    dependencies,
  );

  if (res.headers.get("content-type")?.includes("application/json")) {
    const result = (await res.json()) as ActionPostResult;
    return {
      ...result,
      status: res.status,
      conflict: res.status === 409,
    };
  }

  if (res.status === 403) {
    return { ok: false, csrfExpired: false, message: "Forbidden (CSRF or auth check failed)" };
  }
  if (res.status === 404) {
    return { ok: false, csrfExpired: false, message: "Action not found" };
  }
  return { ok: false, csrfExpired: false, message: `Unexpected status ${res.status}` };
}
