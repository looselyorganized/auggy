import type {
  AdminActionHandler,
  AdminActionInput,
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  TransportKernel,
} from "../../types";
import { checkAdminAuth } from "./admin-auth";
import { coerceInputs } from "./admin-coerce";
import { collectAdminInfoBlocks } from "./admin-collector";
import { generateCsrfToken, validateCsrfToken } from "./admin-csrf";
import { renderAdminPage } from "./admin-renderer";

/**
 * Build a map of CSRF tokens, one per (actionId, rowKey?) tuple present
 * in the collected admin blocks. The renderer looks up the right token
 * for each form via the `getCsrfToken` callback. The previous shared
 * `__page` token failed validation because the dispatcher's CSRF check
 * binds to the actual actionId being POSTed, not to a generic page-load
 * marker.
 */
async function buildCsrfTokenMap(
  blocks: AdminInfoBlock[],
  bearer: string,
  agentName: string,
): Promise<Map<string, string>> {
  const tokens = new Map<string, string>();
  const mintIfMissing = async (actionId: string, rowKey?: string): Promise<void> => {
    const key = csrfMapKey(actionId, rowKey);
    if (tokens.has(key)) return;
    tokens.set(key, await generateCsrfToken({ bearer, agentName, actionId, rowKey }));
  };

  for (const block of blocks) {
    for (const action of block.actions ?? []) {
      await mintIfMissing(action.id);
    }
    for (const section of block.sections) {
      if (section.kind === "keyValue") {
        for (const row of section.rows) {
          if (row.resetAction) await mintIfMissing(row.resetAction.id);
        }
      }
      if (section.kind === "table" && section.rowActions) {
        for (const rowAction of section.rowActions) {
          for (const row of section.rows) {
            const rowKey = row[rowAction.rowKeyColumn];
            if (rowKey) await mintIfMissing(rowAction.id, rowKey);
          }
        }
      }
    }
  }

  return tokens;
}

function csrfMapKey(actionId: string, rowKey?: string): string {
  return `${actionId}\x00${rowKey ?? ""}`;
}

/**
 * S8 — action declaration registry. Built at boot time by
 * `buildAdminActionRegistry`. Replaces the runtime-bomb pattern (declared
 * actions could lack handlers and only fail at first POST) AND the
 * double-adminInfo-call cost (where handleActionPost would invoke
 * adminInfo() again just to look up input coercion declarations).
 */
export interface AdminActionRegistryEntry {
  augmentName: string;
  handler: AdminActionHandler;
  inputs: AdminActionInput[];
  /** True for row-scoped actions (table rowActions). Affects URL parsing. */
  isRowAction: boolean;
}

export type AdminActionRegistry = ReadonlyMap<string, AdminActionRegistryEntry>;

export interface AdminRouteContext {
  kernel: TransportKernel;
  bearer: string;
  agentDir: string | undefined;
  callerIp: string;
  /** S8 — built once at boot by `buildAdminActionRegistry`. */
  actionRegistry: AdminActionRegistry;
}

const ACTION_ROUTE_RE = /^\/admin\/action\/([^/]+)(?:\/row\/([^/]+))?$/;

const EXPIRED_CSRF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session expired — redirecting</title>
  <meta http-equiv="refresh" content="0; url=/admin">
</head>
<body>
  <p>Session expired — refreshing the page now…</p>
  <p>If you are not redirected automatically, <a href="/admin">click here</a>.</p>
</body>
</html>`;

export async function handleAdminRoute(req: Request, ctx: AdminRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const agentCard = ctx.kernel.getAgentCard();
  const agentName = agentCard.provider.name || "auggy";

  // Auth + HTTPS gate
  const auth = checkAdminAuth({
    req,
    bearer: ctx.bearer,
    agentName,
    callerIp: ctx.callerIp,
  });
  if (auth.kind === "https-required") return auth.response;
  if (auth.kind === "unauthorized") return auth.response;

  // GET /admin — render the dashboard
  if (req.method === "GET" && url.pathname === "/admin") {
    const blocks = await collectAdminInfoBlocks(ctx.kernel);
    const csrfTokens = await buildCsrfTokenMap(blocks, ctx.bearer, agentName);
    const flashMessage = url.searchParams.get("msg") ?? undefined;
    const html = renderAdminPage({
      card: agentCard,
      blocks,
      getCsrfToken: (actionId, rowKey) => csrfTokens.get(csrfMapKey(actionId, rowKey)) ?? "",
      flashMessage,
    });
    return new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store, must-revalidate",
        "x-robots-tag": "noindex, nofollow",
      },
    });
  }

  // POST /admin/action/<id>[/row/<rowKey>] — dispatch
  const actionMatch = url.pathname.match(ACTION_ROUTE_RE);
  if (req.method === "POST" && actionMatch) {
    // Decode rowKey — the renderer URL-encodes it so values like email
    // addresses (`foo@example.com` → `foo%40example.com`) round-trip.
    let rowKey: string | undefined;
    if (actionMatch[2]) {
      try {
        rowKey = decodeURIComponent(actionMatch[2]);
      } catch {
        return new Response(null, { status: 400 });
      }
    }
    return handleActionPost(req, ctx, actionMatch[1]!, rowKey, agentName);
  }

  return new Response(null, { status: 404 });
}

async function handleActionPost(
  req: Request,
  ctx: AdminRouteContext,
  actionId: string,
  rowKey: string | undefined,
  agentName: string,
): Promise<Response> {
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return new Response(null, { status: 400 });
  }

  // S7 fix — CSRF validation distinguishes expired (graceful refresh) from
  // tampered/malformed (403).
  const csrfToken = form.get("_csrf") ?? "";
  const csrfResult = await validateCsrfToken({
    token: csrfToken,
    bearer: ctx.bearer,
    agentName,
    actionId,
    rowKey,
  });
  if (!csrfResult.valid) {
    if (csrfResult.reason === "expired") {
      return new Response(EXPIRED_CSRF_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return new Response(null, { status: 403 });
  }

  // S8 — registry lookup replaces (a) the iterate-augments-for-handler
  // search and (b) the second adminInfo() call to retrieve input declarations.
  const entry = ctx.actionRegistry.get(actionId);
  if (!entry) return new Response(null, { status: 404 });

  // Coerce inputs using the registered declaration
  const rawInputs: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (k !== "_csrf") rawInputs[k] = v;
  }
  const coerce = coerceInputs(entry.inputs, rawInputs);
  if (!coerce.ok) {
    return flashRedirect(`invalid ${coerce.field}: ${coerce.reason}`);
  }

  // Invoke handler, wrap in try/catch
  const params: Record<string, string> = { ...coerce.values };
  if (rowKey !== undefined) params.rowKey = rowKey;

  let result: AdminActionResult;
  try {
    result = await entry.handler(params);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] action ${actionId} threw: ${message}`);
    result = { ok: false, message: "internal error" };
  }

  // Audit log
  console.log(
    `[admin] actor=creator action=${actionId} rowKey=${rowKey ?? "-"} result=${
      result.ok ? "ok" : "fail"
    } message=${JSON.stringify(result.message)}`,
  );

  return flashRedirect(result.message);
}

function flashRedirect(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/admin?msg=${encodeURIComponent(message)}` },
  });
}

/**
 * S8 — Build the action-declaration registry at boot. Combines:
 *   1. Validation that every declared action has a matching handler
 *   2. Action-id uniqueness check across augments
 *   3. Registry construction so the request-time dispatcher doesn't need
 *      to re-call adminInfo() to find input declarations
 */
export async function buildAdminActionRegistry(
  augments: readonly Augment[],
): Promise<AdminActionRegistry> {
  const registry = new Map<string, AdminActionRegistryEntry>();

  function register(
    augName: string,
    augActions: Record<string, AdminActionHandler> | undefined,
    actionId: string,
    inputs: AdminActionInput[],
    isRowAction: boolean,
  ): void {
    if (!augActions?.[actionId]) {
      throw new Error(
        `[admin] augment "${augName}" declares action "${actionId}" but does not provide an adminActions handler`,
      );
    }
    if (registry.has(actionId)) {
      const existing = registry.get(actionId)!;
      throw new Error(
        `[admin] action id "${actionId}" declared by multiple augments ("${existing.augmentName}" and "${augName}"); action ids must be globally unique`,
      );
    }
    registry.set(actionId, {
      augmentName: augName,
      handler: augActions[actionId],
      inputs,
      isRowAction,
    });
  }

  for (const aug of augments) {
    if (!aug.adminInfo) continue;
    let block: Awaited<ReturnType<NonNullable<Augment["adminInfo"]>>> | undefined;
    try {
      block = await aug.adminInfo();
    } catch (err) {
      console.warn(
        `[admin] augment "${aug.name}" adminInfo() threw during boot validation: ${
          err instanceof Error ? err.message : String(err)
        }. Skipping its action registration.`,
      );
      continue;
    }
    if (!block) continue;

    // Augment-level actions
    if (block.actions) {
      for (const a of block.actions) {
        register(aug.name, aug.adminActions, a.id, a.inputs ?? [], false);
      }
    }

    // Row actions from table sections + reset actions from keyValue sections
    for (const section of block.sections) {
      if (section.kind === "table" && section.rowActions) {
        for (const ra of section.rowActions) {
          register(aug.name, aug.adminActions, ra.id, [], true);
        }
      }
      if (section.kind === "keyValue") {
        for (const row of section.rows) {
          if (row.resetAction && !registry.has(row.resetAction.id)) {
            register(aug.name, aug.adminActions, row.resetAction.id, [], false);
          }
        }
      }
    }
  }

  return registry;
}
