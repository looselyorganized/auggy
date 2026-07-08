import type {
  AdminActionHandler,
  AdminActionInput,
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  TransportKernel,
} from "../../types";
import {
  checkAdminAuth,
  createConsoleSessionClearCookie,
  createConsoleSessionSetCookie,
} from "./admin-auth";
import { coerceInputs } from "./admin-coerce";
import { collectAdminInfoBlocks, collectAugmentSummaries } from "./admin-collector";
import { generateCsrfToken, validateCsrfToken } from "./admin-csrf";
import { buildRequiredResponse, resolveDistDir, serveStaticFile } from "./admin-static";
import { createRouteManifest, summarizeRouteManifest } from "../../kernel/route-manifest";
import type { CollectedRoute } from "../../kernel/route-collector";
import {
  collectSkillsInfo,
  createSkill,
  installBundledSkill,
  readInstalledSkillContent,
  removeInstalledSkill,
  resetInstalledSkill,
  validateSkillFolderName,
  writeInstalledSkillContent,
} from "./admin-skills";
import { readIdentity, writeIdentity } from "./admin-identity";
import {
  deleteCredential,
  listCredentials,
  renameCredential,
  revealCredential,
  setCredential,
} from "./admin-credentials";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const AUGGY_VERSION = readPackageVersion();

/**
 * Minimal agent.yaml top-level summary surfaced to the SPA so the sidebar
 * can show the agent's identity from config (which is the operator's source
 * of truth — the agent card carries only the runtime-resolved name).
 *
 * Returns `null` when the file cannot be read / parsed; the SPA treats that
 * as a soft-fail and falls back to the agent card's provider name.
 */
interface AgentMeta {
  id?: string;
  name?: string;
  displayName?: string;
  creator?: {
    displayName?: string;
  };
  purpose?: string;
  engine?: {
    provider?: string;
    model?: string;
  };
  identityPath?: string;
}

function readAgentMeta(agentDir: string | undefined): AgentMeta | null {
  if (!agentDir) return null;
  const path = join(agentDir, "agent.yaml");
  if (!existsSync(path)) return null;
  try {
    const raw = parseYaml(readFileSync(path, "utf-8"));
    if (raw === null || typeof raw !== "object") return null;
    const r = raw as Record<string, unknown>;
    return {
      id: typeof r.id === "string" ? r.id : undefined,
      name: typeof r.name === "string" ? r.name : undefined,
      displayName: typeof r.displayName === "string" ? r.displayName : undefined,
      creator:
        r.creator && typeof r.creator === "object" && !Array.isArray(r.creator)
          ? {
              displayName:
                typeof (r.creator as Record<string, unknown>).displayName === "string"
                  ? ((r.creator as Record<string, unknown>).displayName as string)
                  : undefined,
            }
          : undefined,
      purpose: typeof r.purpose === "string" ? r.purpose : undefined,
      engine:
        r.engine && typeof r.engine === "object" && !Array.isArray(r.engine)
          ? {
              provider:
                typeof (r.engine as Record<string, unknown>).provider === "string"
                  ? ((r.engine as Record<string, unknown>).provider as string)
                  : undefined,
              model:
                typeof (r.engine as Record<string, unknown>).model === "string"
                  ? ((r.engine as Record<string, unknown>).model as string)
                  : undefined,
            }
          : undefined,
      identityPath: typeof r.identity === "string" ? r.identity : undefined,
    };
  } catch {
    return null;
  }
}

function readPackageVersion(): string {
  try {
    const pkg = JSON.parse(
      readFileSync(new URL("../../../package.json", import.meta.url), "utf-8"),
    ) as { version?: unknown };
    return typeof pkg.version === "string" && pkg.version.trim() !== "" ? pkg.version : "unknown";
  } catch {
    return "unknown";
  }
}

function parseBooleanRow(value: string | undefined): boolean | null {
  if (value === "true") return true;
  if (value === "false") return false;
  return null;
}

function parseListRow(value: string | undefined): string[] {
  if (!value || value === "(none)" || value === "(unset)") return [];
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
}

function readWebDashboardState(blocks: AdminInfoBlock[]) {
  const rows =
    blocks
      .find((block) => block.augmentName === "web" && block.title === "Posture")
      ?.sections.flatMap((section) => (section.kind === "keyValue" ? section.rows : [])) ?? [];
  const row = (label: string) => rows.find((item) => item.label === label);
  const publicFrontendUrl = row("publicFrontendUrl")?.value;
  return {
    allowAnonymous: {
      value: parseBooleanRow(row("allowAnonymous")?.value),
      source: row("allowAnonymous")?.source,
    },
    publicIntegration: {
      value: parseBooleanRow(row("publicIntegration")?.value),
      source: row("publicIntegration")?.source,
    },
    publicFrontendUrl:
      publicFrontendUrl && publicFrontendUrl !== "(unset)" ? publicFrontendUrl : undefined,
    port: row("Port")?.value,
    trustedProxies: parseListRow(row("Trusted proxies")?.value),
    corsOrigins: parseListRow(row("CORS origins")?.value),
    visitorTokensEnabled: parseBooleanRow(row("Visitor tokens")?.value),
    externalAuthEnabled: parseBooleanRow(row("External auth")?.value),
    externalAuthHeader: row("External auth header")?.value,
    externalAuthAudience: row("External auth audience")?.value,
    agentAccessEntries: row("Agent access entries")?.value,
  };
}

/**
 * Build a map of CSRF tokens, one per (actionId, rowKey?) tuple present
 * in the collected admin blocks. The SPA reads `/console/api/dashboard`
 * to fetch blocks + tokens together; each form posts with the token
 * matching its (id, rowKey) pair. Page-shared tokens fail validation
 * because the dispatcher binds the check to the POSTed actionId.
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
  /** True when the transport has validated that X-Forwarded-Proto came from a trusted proxy. */
  trustForwardedProto?: boolean;
  /** S8 — built once at boot by `buildAdminActionRegistry`. */
  actionRegistry: AdminActionRegistry;
  /**
   * Static dist directory for the admin SPA. Resolved at boot via
   * {@link resolveDistDir}; left `undefined` in tests that don't exercise
   * the SPA path. When unset at request time, GET /console returns the
   * "build required" notice instead.
   */
  staticDir?: string;
  /**
   * The webTransport's bound port. The Chat tab proxies messages to
   * `127.0.0.1:<selfPort>/agent/run` — the agent's same-process AG-UI
   * surface. Optional so tests can omit it; chat endpoint returns 503
   * when unset.
   */
  selfPort?: number;
}

const ACTION_ROUTE_RE = /^\/console\/action\/([^/]+)(?:\/row\/([^/]+))?$/;

/**
 * Skills CSRF actions — mint a token per (action, folder) pair so the SPA's
 * skill mutation buttons can validate against the same bearer-bound HMAC
 * machinery as the admin-action buttons. Keep this list and the route
 * handler below in sync.
 */
const SKILL_CSRF_ACTIONS = ["skill-edit", "skill-remove", "skill-reset", "skill-install"] as const;

/**
 * Folder-less skill action — minted once per session, no rowKey, used by the
 * "New skill" button to validate the create POST. Kept separate from the
 * per-folder skill actions because the folder doesn't exist yet at submit
 * time.
 */
const SKILL_CREATE_ACTION = "skill-create";

const IDENTITY_SAVE_ACTION = "identity-save";

const CRED_REVEAL_ACTION = "cred-reveal";
const CRED_SET_ACTION = "cred-set";
const CRED_DELETE_ACTION = "cred-delete";
const CRED_RENAME_ACTION = "cred-rename";

const CONSOLE_CHAT_ACTION = "console-chat";
const CHAT_PREVIEW_MODES = new Set(["creator", "anonymous", "visitor"]);
type ChatPreviewMode = "creator" | "anonymous" | "visitor";

const LOGIN_RATE_LIMIT_WINDOW_MS = 60_000;
const LOGIN_RATE_LIMIT_MAX = 10;
const loginAttempts = new Map<string, number[]>();

const EXPIRED_CSRF_HTML = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Session expired — redirecting</title>
  <meta http-equiv="refresh" content="0; url=/console">
</head>
<body>
  <p>Session expired — refreshing the page now…</p>
  <p>If you are not redirected automatically, <a href="/console">click here</a>.</p>
</body>
</html>`;

export async function handleAdminRoute(req: Request, ctx: AdminRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const agentCard = ctx.kernel.getAgentCard();
  const agentName = agentCard.provider.name || "auggy";

  const secureRequest = isSecureConsoleRequest(req, ctx);
  if (url.pathname === "/console/login") {
    if (!isLoopbackIp(ctx.callerIp) && !secureRequest) return consoleHttpsRequiredResponse(url);
    if (req.method === "GET") return loginPageResponse(undefined, url.search);
    if (req.method === "POST") return handleLoginPost(req, ctx, secureRequest);
    return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
  }
  if (url.pathname === "/console/logout") {
    if (!isLoopbackIp(ctx.callerIp) && !secureRequest) return consoleHttpsRequiredResponse(url);
    if (req.method !== "GET" && req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "GET, POST" } });
    }
    return new Response(null, {
      status: 303,
      headers: {
        location: "/console/login",
        "set-cookie": createConsoleSessionClearCookie(secureRequest),
        "cache-control": "no-store",
      },
    });
  }

  // Auth + HTTPS gate
  const auth = checkAdminAuth({
    req,
    bearer: ctx.bearer,
    agentName,
    callerIp: ctx.callerIp,
    trustForwardedProto: ctx.trustForwardedProto,
  });
  if (auth.kind === "https-required") return auth.response;
  if (auth.kind === "unauthorized") return auth.response;

  // POST /console/action/<id>[/row/<rowKey>] — dispatch action handlers
  const actionMatch = url.pathname.match(ACTION_ROUTE_RE);
  if (req.method === "POST" && actionMatch) {
    // Decode rowKey — the SPA URL-encodes it so values like email addresses
    // (`foo@example.com` → `foo%40example.com`) round-trip.
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

  // GET /console/api/dashboard — JSON payload for the SPA
  if (req.method === "GET" && url.pathname === "/console/api/dashboard") {
    return handleDashboardJson(ctx, agentName);
  }

  // Identity API ----------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/console/api/identity") {
    return handleIdentityRead(ctx);
  }
  if (req.method === "POST" && url.pathname === "/console/api/identity") {
    return handleIdentityWrite(req, ctx, agentName);
  }

  // Chat SSE proxy --------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/console/api/chat") {
    return handleChatProxy(req, ctx, agentName);
  }

  // Credentials API -------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/console/api/credentials") {
    return handleCredentialsList(ctx);
  }
  if (req.method === "POST" && url.pathname === "/console/api/credentials/reveal") {
    return handleCredentialReveal(req, ctx, agentName);
  }
  if (req.method === "POST" && url.pathname === "/console/api/credentials/set") {
    return handleCredentialSet(req, ctx, agentName);
  }
  if (req.method === "POST" && url.pathname === "/console/api/credentials/delete") {
    return handleCredentialDelete(req, ctx, agentName);
  }
  if (req.method === "POST" && url.pathname === "/console/api/credentials/rename") {
    return handleCredentialRename(req, ctx, agentName);
  }

  // Skills API ------------------------------------------------------------
  if (req.method === "GET" && url.pathname === "/console/api/skills") {
    return handleSkillsList(ctx);
  }
  if (req.method === "POST" && url.pathname === "/console/api/skills/create") {
    return handleSkillCreate(req, ctx, agentName);
  }
  const skillContentMatch = url.pathname.match(/^\/console\/api\/skills\/([^/]+)\/content$/);
  if (req.method === "GET" && skillContentMatch) {
    return handleSkillContentRead(ctx, decodeURIComponent(skillContentMatch[1]!));
  }
  const skillEditMatch = url.pathname.match(/^\/console\/api\/skills\/([^/]+)\/edit$/);
  if (req.method === "POST" && skillEditMatch) {
    return handleSkillEdit(req, ctx, agentName, decodeURIComponent(skillEditMatch[1]!));
  }
  const skillRemoveMatch = url.pathname.match(/^\/console\/api\/skills\/([^/]+)\/remove$/);
  if (req.method === "POST" && skillRemoveMatch) {
    return handleSkillSimple(
      req,
      ctx,
      agentName,
      "skill-remove",
      decodeURIComponent(skillRemoveMatch[1]!),
      removeInstalledSkill,
    );
  }
  const skillResetMatch = url.pathname.match(/^\/console\/api\/skills\/([^/]+)\/reset$/);
  if (req.method === "POST" && skillResetMatch) {
    return handleSkillSimple(
      req,
      ctx,
      agentName,
      "skill-reset",
      decodeURIComponent(skillResetMatch[1]!),
      resetInstalledSkill,
    );
  }
  const skillInstallMatch = url.pathname.match(/^\/console\/api\/skills\/([^/]+)\/install$/);
  if (req.method === "POST" && skillInstallMatch) {
    return handleSkillSimple(
      req,
      ctx,
      agentName,
      "skill-install",
      decodeURIComponent(skillInstallMatch[1]!),
      installBundledSkill,
    );
  }

  // GET /console and the SPA's client-side routes — serve
  // the SPA shell. /console/assets/* serves bundled JS/CSS from dist/.
  if (
    req.method === "GET" &&
    (url.pathname === "/console" || url.pathname.startsWith("/console/"))
  ) {
    return handleStaticOrSpa(ctx, url.pathname);
  }

  return new Response(null, { status: 404 });
}

async function handleLoginPost(
  req: Request,
  ctx: AdminRouteContext,
  secureRequest: boolean,
): Promise<Response> {
  const loginLimit = checkLoginRateLimit(ctx.callerIp);
  if (!loginLimit.allowed) {
    return new Response("Too many attempts. Try again shortly.", {
      status: 429,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "retry-after": String(loginLimit.retryAfterSec),
        "cache-control": "no-store",
      },
    });
  }

  let form: URLSearchParams;
  try {
    form = new URLSearchParams(await req.text());
  } catch {
    return loginPageResponse("Invalid console password.", new URL(req.url).search);
  }

  const password = form.get("password") ?? "";
  if (!timingSafeStringEqual(password, ctx.bearer)) {
    return loginPageResponse("Invalid console password.", new URL(req.url).search);
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: safeConsoleNextPath(new URL(req.url).searchParams.get("next")),
      "set-cookie": createConsoleSessionSetCookie({ bearer: ctx.bearer, secure: secureRequest }),
      "cache-control": "no-store",
    },
  });
}

function loginPageResponse(error?: string, search = ""): Response {
  const escapedError = error ? escapeHtml(error) : "";
  const action = `/console/login${search}`;
  return new Response(
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Console sign-in</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    body { min-height: 100vh; margin: 0; display: grid; place-items: center; background: #0f172a; color: #f8fafc; }
    main { width: min(360px, calc(100vw - 32px)); }
    h1 { font-size: 24px; font-weight: 650; margin: 0 0 8px; }
    p { color: #cbd5e1; margin: 0 0 20px; line-height: 1.45; }
    label { display: block; font-size: 13px; font-weight: 600; margin-bottom: 8px; color: #e2e8f0; }
    input { box-sizing: border-box; width: 100%; height: 44px; border: 1px solid #334155; border-radius: 6px; padding: 0 12px; background: #020617; color: #f8fafc; font-size: 16px; }
    button { width: 100%; height: 42px; margin-top: 14px; border: 0; border-radius: 6px; background: #f8fafc; color: #020617; font-weight: 700; cursor: pointer; }
    .error { margin-bottom: 14px; color: #fecaca; }
  </style>
</head>
<body>
  <main>
    <h1>Console sign-in</h1>
    <p>Enter your console password.</p>
    ${escapedError ? `<p class="error">${escapedError}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}">
      <label for="password">Console password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" autofocus required>
      <button type="submit">Sign in</button>
    </form>
  </main>
</body>
</html>`,
    {
      status: error ? 401 : 200,
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}

async function handleDashboardJson(ctx: AdminRouteContext, agentName: string): Promise<Response> {
  const blocks = await collectAdminInfoBlocks(ctx.kernel);
  const tokenMap = await buildCsrfTokenMap(blocks, ctx.bearer, agentName);
  // Serialize the token map as a flat array so the SPA can index it without
  // reproducing the `\x00`-delimited key encoding.
  const csrfTokens = Array.from(tokenMap.entries()).map(([key, token]) => {
    const [actionId, rowKey] = key.split("\x00");
    return { actionId, rowKey: rowKey || undefined, token };
  });
  const augments = collectAugmentSummaries(ctx.kernel);
  const agentMeta = readAgentMeta(ctx.agentDir);
  const routeManifest = createRouteManifest(
    ctx.kernel.getAugmentRoutes() as readonly CollectedRoute[],
  );
  const routes = {
    summary: summarizeRouteManifest(routeManifest),
    entries: routeManifest,
  };
  const web = readWebDashboardState(blocks);

  // Mint a CSRF token per (skill-action, folder) tuple so console skill APIs
  // can validate writes against the same bearer-bound HMAC scheme as the
  // admin-action buttons. The set of folders is dynamic (depends on what's
  // installed + what's available); load skills once and emit tokens for both.
  // Filter "available" to skills whose augment is actually mounted — a
  // bundled skill teaching tools that don't exist would mislead the model.
  const mountedTypes = new Set(augments.map((a) => a.type));
  const skills = collectSkillsInfo(ctx.agentDir, mountedTypes);
  const skillFolders = new Set<string>();
  for (const s of skills.installed) skillFolders.add(s.folder);
  for (const s of skills.available) skillFolders.add(s.folder);
  for (const folder of skillFolders) {
    for (const action of SKILL_CSRF_ACTIONS) {
      const token = await generateCsrfToken({
        bearer: ctx.bearer,
        agentName,
        actionId: action,
        rowKey: folder,
      });
      csrfTokens.push({ actionId: action, rowKey: folder, token });
    }
  }

  // Folder-less create token — one per session, no rowKey.
  const createToken = await generateCsrfToken({
    bearer: ctx.bearer,
    agentName,
    actionId: SKILL_CREATE_ACTION,
  });
  csrfTokens.push({ actionId: SKILL_CREATE_ACTION, rowKey: undefined, token: createToken });

  // Identity save token — one per session, no rowKey.
  const identityToken = await generateCsrfToken({
    bearer: ctx.bearer,
    agentName,
    actionId: IDENTITY_SAVE_ACTION,
  });
  csrfTokens.push({ actionId: IDENTITY_SAVE_ACTION, rowKey: undefined, token: identityToken });

  // Credential action tokens — one per action, no rowKey. The key travels
  // in the JSON body; CSRF just gates the action class (reveal/set/delete/rename).
  for (const credAction of [
    CRED_REVEAL_ACTION,
    CRED_SET_ACTION,
    CRED_DELETE_ACTION,
    CRED_RENAME_ACTION,
  ]) {
    const token = await generateCsrfToken({ bearer: ctx.bearer, agentName, actionId: credAction });
    csrfTokens.push({ actionId: credAction, rowKey: undefined, token });
  }

  // Chat proxy token — one per session, no rowKey. The chat endpoint forwards
  // to /agent/run with the server-side bearer, so without CSRF a third-party
  // page could drive the operator's already-authenticated browser to inject
  // prompts with full tool side effects (codex adversarial-review High-1).
  const chatToken = await generateCsrfToken({
    bearer: ctx.bearer,
    agentName,
    actionId: CONSOLE_CHAT_ACTION,
  });
  csrfTokens.push({ actionId: CONSOLE_CHAT_ACTION, rowKey: undefined, token: chatToken });

  return new Response(
    JSON.stringify({
      card: ctx.kernel.getAgentCard(),
      auggyVersion: AUGGY_VERSION,
      agentMeta,
      augments,
      routes,
      web,
      blocks,
      csrfTokens,
      skills,
    }),
    {
      status: 200,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store, must-revalidate",
        "x-robots-tag": "noindex, nofollow",
      },
    },
  );
}

function handleStaticOrSpa(ctx: AdminRouteContext, pathname: string): Response {
  if (!ctx.staticDir) return buildRequiredResponse();

  // /console/assets/* → file from dist/assets/. Anything else under /console
  // falls back to index.html so the React Router can handle the route.
  if (pathname.startsWith("/console/assets/")) {
    const rel = pathname.slice("/console/".length); // assets/index-...js
    const file = serveStaticFile(ctx.staticDir, rel);
    return file ?? new Response(null, { status: 404 });
  }

  // Other static files Vite emits at the root (e.g. /console/vite.svg, source
  // maps). Try the literal path first; if missing, fall through to index.html
  // so client-side routes work.
  if (pathname !== "/console" && pathname !== "/console/") {
    const rel = pathname.slice("/console/".length);
    if (rel.length > 0 && rel.includes(".")) {
      const file = serveStaticFile(ctx.staticDir, rel);
      if (file) return file;
    }
  }

  const index = serveStaticFile(ctx.staticDir, "index.html");
  return index ?? buildRequiredResponse();
}

async function handleActionPost(
  req: Request,
  ctx: AdminRouteContext,
  actionId: string,
  rowKey: string | undefined,
  agentName: string,
): Promise<Response> {
  const wantsJson = req.headers.get("accept")?.includes("application/json") === true;
  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return wantsJson
      ? actionJson({ ok: false, message: "invalid form body", csrfExpired: false }, 400)
      : new Response(null, { status: 400 });
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
      if (wantsJson) {
        return actionJson(
          { ok: false, message: "Session expired — refreshing…", csrfExpired: true },
          419,
        );
      }
      return new Response(EXPIRED_CSRF_HTML, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    }
    return wantsJson
      ? actionJson(
          { ok: false, message: "Forbidden (CSRF or auth check failed)", csrfExpired: false },
          403,
        )
      : new Response(null, { status: 403 });
  }

  // S8 — registry lookup replaces (a) the iterate-augments-for-handler
  // search and (b) the second adminInfo() call to retrieve input declarations.
  const entry = ctx.actionRegistry.get(actionId);
  if (!entry) {
    return wantsJson
      ? actionJson({ ok: false, message: "Action not found", csrfExpired: false }, 404)
      : new Response(null, { status: 404 });
  }

  // Coerce inputs using the registered declaration
  const rawInputs: Record<string, string | undefined> = {};
  for (const [k, v] of form.entries()) {
    if (k !== "_csrf") rawInputs[k] = v;
  }
  const coerce = coerceInputs(entry.inputs, rawInputs);
  if (!coerce.ok) {
    const message = `invalid ${coerce.field}: ${coerce.reason}`;
    return wantsJson
      ? actionJson({ ok: false, message, csrfExpired: false })
      : flashRedirect(message);
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

  return wantsJson
    ? actionJson({ ok: result.ok, message: result.message, csrfExpired: false })
    : flashRedirect(result.message);
}

function flashRedirect(message: string): Response {
  return new Response(null, {
    status: 303,
    headers: { location: `/console?msg=${encodeURIComponent(message)}` },
  });
}

function actionJson(
  body: { ok: boolean; message: string; csrfExpired: boolean },
  status = 200,
): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
    },
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

// ===========================================================================
// Chat SSE proxy
// ===========================================================================

/**
 * Proxies a chat message to the agent's own `/agent/run` SSE endpoint on
 * the same port. The browser never sees the bearer. The console can preview
 * three real runtime identities:
 *   - creator: forwards bearer only
 *   - anonymous: forwards no auth identity headers
 *   - visitor: forwards a verified visitor token only
 *
 * CSRF: required. Even though HTTP Basic creds make the operator's browser
 * pre-authenticated, the chat endpoint is just as privileged as any other
 * mutation — a third-party page could otherwise drive a simple-request POST
 * (text/plain JSON, no preflight) to inject prompts and trigger tool calls
 * with full creator side effects. CSRF binds the request to the issued
 * token and rejects cross-site forgeries.
 */
async function handleChatProxy(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  if (!ctx.selfPort) {
    return jsonResponse(
      { error: "Chat proxy unavailable — agent port not exposed to admin route." },
      503,
    );
  }
  let body: {
    csrf?: unknown;
    message?: unknown;
    threadId?: unknown;
    chatMode?: unknown;
    visitorToken?: unknown;
  };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.csrf !== "string" || body.csrf.length === 0) {
    return jsonResponse({ error: "missing csrf" }, 400);
  }
  const csrfResult = await validateCsrfToken({
    token: body.csrf,
    bearer: ctx.bearer,
    agentName,
    actionId: CONSOLE_CHAT_ACTION,
  });
  if (!csrfResult.valid) {
    if (csrfResult.reason === "expired") {
      return jsonResponse({ error: "Session expired — reload the page." }, 419);
    }
    return jsonResponse({ error: "CSRF check failed." }, 403);
  }
  if (typeof body.message !== "string" || body.message.length === 0) {
    return jsonResponse({ error: "missing message" }, 400);
  }
  const chatMode = parseChatPreviewMode(body.chatMode, body.visitorToken);
  if (!chatMode) {
    return jsonResponse({ error: "invalid chat preview mode" }, 400);
  }
  const threadId = typeof body.threadId === "string" ? body.threadId : undefined;
  let visitorToken: string | undefined;
  if (typeof body.visitorToken === "string" && body.visitorToken.trim() !== "") {
    if (body.visitorToken.length > 4096 || /[\r\n]/.test(body.visitorToken)) {
      return jsonResponse({ error: "invalid visitor token" }, 400);
    }
    visitorToken = body.visitorToken;
  }
  if (body.chatMode !== undefined && chatMode !== "visitor" && visitorToken) {
    return jsonResponse({ error: "visitor token is only valid in visitor preview mode" }, 400);
  }
  if (chatMode === "visitor" && !visitorToken) {
    return jsonResponse({ error: "visitor preview mode requires a visitor token" }, 400);
  }

  let upstream: Response;
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (chatMode === "creator") {
    headers.authorization = `Bearer ${ctx.bearer}`;
  } else if (chatMode === "visitor") {
    headers["x-visitor-token"] = visitorToken!;
  }
  try {
    upstream = await fetch(`http://127.0.0.1:${ctx.selfPort}/agent/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: body.message }],
        threadId,
      }),
      signal: req.signal,
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") {
      return new Response(null, { status: 499 });
    }
    return jsonResponse({ error: `upstream connect failed: ${(err as Error).message}` }, 502);
  }

  return new Response(upstream.body, {
    status: upstream.status,
    headers: { "content-type": "text/event-stream" },
  });
}

function parseChatPreviewMode(mode: unknown, visitorToken: unknown): ChatPreviewMode | null {
  if (mode === undefined) {
    // Backward compatibility for older console bundles: previous versions
    // always sent the visitor token when one existed, otherwise creator.
    return typeof visitorToken === "string" && visitorToken.trim() !== "" ? "visitor" : "creator";
  }
  if (typeof mode !== "string" || !CHAT_PREVIEW_MODES.has(mode)) return null;
  return mode as ChatPreviewMode;
}

// ===========================================================================
// Identity API handlers
// ===========================================================================

function handleIdentityRead(ctx: AdminRouteContext): Response {
  const agentMeta = readAgentMeta(ctx.agentDir);
  const result = readIdentity(ctx.agentDir, agentMeta?.identityPath);
  if ("error" in result) return jsonResponse({ error: result.error }, 400);
  return jsonResponse(result);
}

async function handleIdentityWrite(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  let body: { csrf?: unknown; content?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.csrf !== "string") return jsonResponse({ error: "missing csrf" }, 400);
  if (typeof body.content !== "string") return jsonResponse({ error: "missing content" }, 400);

  const csrfResult = await validateCsrfToken({
    token: body.csrf,
    bearer: ctx.bearer,
    agentName,
    actionId: IDENTITY_SAVE_ACTION,
  });
  if (!csrfResult.valid) {
    if (csrfResult.reason === "expired") {
      return jsonResponse({ error: "Session expired — reload the page." }, 419);
    }
    return jsonResponse({ error: "CSRF check failed." }, 403);
  }

  const agentMeta = readAgentMeta(ctx.agentDir);
  const result = writeIdentity(ctx.agentDir, agentMeta?.identityPath, body.content);
  return jsonResponse(result, result.ok ? 200 : 400);
}

// ===========================================================================
// Credentials API handlers
// ===========================================================================

function handleCredentialsList(ctx: AdminRouteContext): Response {
  const result = listCredentials(ctx.agentDir);
  if ("error" in result) return jsonResponse({ error: result.error }, 400);
  return jsonResponse(result);
}

async function readCredentialBody(
  req: Request,
): Promise<{ csrf?: string; key?: string; value?: string } | null> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    return {
      csrf: typeof body.csrf === "string" ? body.csrf : undefined,
      key: typeof body.key === "string" ? body.key : undefined,
      value: typeof body.value === "string" ? body.value : undefined,
    };
  } catch {
    return null;
  }
}

async function validateCredCsrf(
  ctx: AdminRouteContext,
  agentName: string,
  actionId: string,
  token: string | undefined,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (!token) return { ok: false, status: 400, message: "missing csrf" };
  const r = await validateCsrfToken({ token, bearer: ctx.bearer, agentName, actionId });
  if (r.valid) return { ok: true };
  if (r.reason === "expired") {
    return { ok: false, status: 419, message: "Session expired — reload the page." };
  }
  return { ok: false, status: 403, message: "CSRF check failed." };
}

async function handleCredentialReveal(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  const body = await readCredentialBody(req);
  if (!body?.key) return jsonResponse({ error: "missing key" }, 400);
  const csrf = await validateCredCsrf(ctx, agentName, CRED_REVEAL_ACTION, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = revealCredential(ctx.agentDir, body.key);
  if ("error" in result) return jsonResponse({ error: result.error }, 404);
  return jsonResponse(result);
}

async function handleCredentialSet(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  const body = await readCredentialBody(req);
  if (!body?.key) return jsonResponse({ error: "missing key" }, 400);
  if (body.value === undefined) return jsonResponse({ error: "missing value" }, 400);
  const csrf = await validateCredCsrf(ctx, agentName, CRED_SET_ACTION, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = setCredential(ctx.agentDir, body.key, body.value);
  return jsonResponse(result, result.ok ? 200 : 400);
}

async function handleCredentialDelete(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  const body = await readCredentialBody(req);
  if (!body?.key) return jsonResponse({ error: "missing key" }, 400);
  const csrf = await validateCredCsrf(ctx, agentName, CRED_DELETE_ACTION, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = deleteCredential(ctx.agentDir, body.key);
  return jsonResponse(result, result.ok ? 200 : 400);
}

/**
 * Atomic rename — replaces the previous client-side delete-then-set flow
 * which could permanently drop the secret if the set step failed (codex
 * adversarial-review Medium-1). One server-side read/modify/write, no
 * intermediate "secret is missing" state on disk.
 */
async function handleCredentialRename(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  let body: { csrf?: unknown; oldKey?: unknown; newKey?: unknown; value?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.oldKey !== "string" || body.oldKey.length === 0) {
    return jsonResponse({ error: "missing oldKey" }, 400);
  }
  if (typeof body.newKey !== "string" || body.newKey.length === 0) {
    return jsonResponse({ error: "missing newKey" }, 400);
  }
  if (typeof body.value !== "string") return jsonResponse({ error: "missing value" }, 400);
  const csrf = await validateCredCsrf(
    ctx,
    agentName,
    CRED_RENAME_ACTION,
    typeof body.csrf === "string" ? body.csrf : undefined,
  );
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = renameCredential(ctx.agentDir, body.oldKey, body.newKey, body.value);
  return jsonResponse(result, result.ok ? 200 : 400);
}

// ===========================================================================
// Skills API handlers
// ===========================================================================

function handleSkillsList(ctx: AdminRouteContext): Response {
  const skills = collectSkillsInfo(ctx.agentDir);
  return jsonResponse(skills);
}

function handleSkillContentRead(ctx: AdminRouteContext, folder: string): Response {
  const safe = validateSkillFolderName(folder);
  if (!safe) return jsonResponse({ error: "invalid skill folder" }, 400);
  const result = readInstalledSkillContent(ctx.agentDir, safe);
  if ("error" in result) return jsonResponse({ error: result.error }, 404);
  return jsonResponse({ content: result.content });
}

interface SkillCsrfBody {
  csrf: string;
  content?: string;
}

async function readSkillPostBody(req: Request): Promise<SkillCsrfBody | null> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    if (typeof body.csrf !== "string") return null;
    return {
      csrf: body.csrf,
      content: typeof body.content === "string" ? body.content : undefined,
    };
  } catch {
    return null;
  }
}

async function validateSkillCsrf(
  ctx: AdminRouteContext,
  agentName: string,
  actionId: string,
  folder: string,
  token: string,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  const csrfResult = await validateCsrfToken({
    token,
    bearer: ctx.bearer,
    agentName,
    actionId,
    rowKey: folder,
  });
  if (csrfResult.valid) return { ok: true };
  if (csrfResult.reason === "expired") {
    return { ok: false, status: 419, message: "Session expired — reload the page." };
  }
  return { ok: false, status: 403, message: "CSRF check failed." };
}

async function handleSkillEdit(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
  folder: string,
): Promise<Response> {
  const safe = validateSkillFolderName(folder);
  if (!safe) return jsonResponse({ error: "invalid skill folder" }, 400);
  const body = await readSkillPostBody(req);
  if (!body) return jsonResponse({ error: "invalid JSON body" }, 400);
  if (body.content === undefined) return jsonResponse({ error: "missing content" }, 400);
  const csrf = await validateSkillCsrf(ctx, agentName, "skill-edit", safe, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = writeInstalledSkillContent(ctx.agentDir, safe, body.content);
  return jsonResponse(result, result.ok ? 200 : 400);
}

async function handleSkillCreate(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  let body: { csrf?: unknown; folder?: unknown; content?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return jsonResponse({ error: "invalid JSON body" }, 400);
  }
  if (typeof body.csrf !== "string") return jsonResponse({ error: "missing csrf" }, 400);
  if (typeof body.folder !== "string") return jsonResponse({ error: "missing folder" }, 400);

  const csrfResult = await validateCsrfToken({
    token: body.csrf,
    bearer: ctx.bearer,
    agentName,
    actionId: SKILL_CREATE_ACTION,
  });
  if (!csrfResult.valid) {
    if (csrfResult.reason === "expired") {
      return jsonResponse({ error: "Session expired — reload the page." }, 419);
    }
    return jsonResponse({ error: "CSRF check failed." }, 403);
  }

  const result = createSkill(
    ctx.agentDir,
    body.folder,
    typeof body.content === "string" ? body.content : undefined,
  );
  return jsonResponse(result, result.ok ? 200 : 400);
}

async function handleSkillSimple(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
  actionId: string,
  folder: string,
  mutator: (agentDir: string | undefined, folder: string) => { ok: boolean; message: string },
): Promise<Response> {
  const safe = validateSkillFolderName(folder);
  if (!safe) return jsonResponse({ error: "invalid skill folder" }, 400);
  const body = await readSkillPostBody(req);
  if (!body) return jsonResponse({ error: "invalid JSON body" }, 400);
  const csrf = await validateSkillCsrf(ctx, agentName, actionId, safe, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);
  const result = mutator(ctx.agentDir, safe);
  return jsonResponse(result, result.ok ? 200 : 400);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function isSecureConsoleRequest(req: Request, ctx: AdminRouteContext): boolean {
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return (
    url.protocol === "https:" || (ctx.trustForwardedProto === true && forwardedProto === "https")
  );
}

function consoleHttpsRequiredResponse(url: URL): Response {
  const port = url.port || "8080";
  const guidance = [
    `/console requires HTTPS on non-loopback addresses.`,
    ``,
    `Options:`,
    `  1. Configure HTTPS termination in front of this agent.`,
    `  2. Access via http://127.0.0.1:${port}/console from the agent host.`,
    `  3. SSH tunnel: ssh -L ${port}:127.0.0.1:${port} user@host`,
  ].join("\n");
  return new Response(guidance, {
    status: 426,
    headers: {
      upgrade: "TLS/1.2",
      connection: "Upgrade",
      "content-type": "text/plain; charset=utf-8",
    },
  });
}

function isLoopbackIp(ip: string): boolean {
  return ip === "::1" || ip.startsWith("127.") || ip.startsWith("::ffff:127.");
}

function safeConsoleNextPath(next: string | null): string {
  if (!next) return "/console";
  try {
    const decoded = decodeURIComponent(next);
    if (decoded === "/console" || decoded.startsWith("/console/")) return decoded;
  } catch {
    // Fall through to the safe default.
  }
  return "/console";
}

function checkLoginRateLimit(
  callerIp: string,
): { allowed: true } | { allowed: false; retryAfterSec: number } {
  const now = Date.now();
  const cutoff = now - LOGIN_RATE_LIMIT_WINDOW_MS;
  const hits = (loginAttempts.get(callerIp) ?? []).filter((ts) => ts > cutoff);
  if (hits.length >= LOGIN_RATE_LIMIT_MAX) {
    const retryAfterSec = Math.max(
      1,
      Math.ceil((hits[0]! + LOGIN_RATE_LIMIT_WINDOW_MS - now) / 1000),
    );
    loginAttempts.set(callerIp, hits);
    return { allowed: false, retryAfterSec };
  }
  hits.push(now);
  loginAttempts.set(callerIp, hits);
  return { allowed: true };
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const enc = new TextEncoder();
  const aa = enc.encode(a);
  const bb = enc.encode(b);
  const len = Math.max(aa.length, bb.length);
  let diff = aa.length ^ bb.length;
  for (let i = 0; i < len; i++) {
    diff |= (aa[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => {
    switch (ch) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

// Re-export for callers (web-transport) that need to resolve dist on boot.
export { resolveDistDir } from "./admin-static";
