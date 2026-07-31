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
  hasValidConsoleBasicAuth,
} from "./admin-auth";
import {
  createConsoleAuthFailureLimiter,
  type ConsoleAuthFailureLimiter,
} from "./admin-auth-rate-limiter";
import {
  CONSOLE_CLI_LOGIN_TICKET_PATH_PREFIX,
  type ConsoleCliLoginTicketStore,
} from "./cli-login-tickets";
import { loadConsoleLoginArtifacts, type ConsoleLoginVariant } from "./login-artifacts";
import { coerceInputs } from "./admin-coerce";
import {
  collectAdminInfoBlocks,
  collectAugmentSummaries,
  collectToolSummaries,
} from "./admin-collector";
import { generateCsrfToken, validateCsrfToken } from "./admin-csrf";
import {
  buildRequiredResponse,
  resolveDistDir,
  serveStaticFile,
  staticFailureResponse,
} from "./admin-static";
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
import { readFileSync } from "node:fs";
import { isIP } from "node:net";
import { parse as parseYaml } from "yaml";
import { readManagedText } from "./admin-managed-files";
import type {
  ConsoleChatModelSnapshot,
  ConsoleChatStore,
  ConsoleChatThread,
  ConsoleChatThreadSummary,
} from "./console-chat-store";
import {
  cloneRequestWithBoundedBody,
  InvalidRequestBodyError,
  readRequestBodyText,
  RequestBodyTooLargeError,
} from "../request-body";
import { handleMailDetailProxy } from "./mail-detail-proxy";

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
  const file = readManagedText(agentDir, "agent.yaml", 1024 * 1024);
  if ("error" in file || "missing" in file) return null;
  try {
    const raw = parseYaml(file.content);
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
 * Build CSRF tokens, one per (augmentName, actionId, rowKey?) tuple present
 * in the collected admin blocks. The SPA reads `/console/api/dashboard`
 * to fetch blocks + tokens together; each form posts with the token
 * matching its target tuple. Page-shared tokens fail validation because the
 * dispatcher binds the check to the POSTed augment, action, and row.
 */
interface TargetedAdminCsrfToken {
  augmentName: string;
  actionId: string;
  rowKey?: string;
  token: string;
}

async function buildCsrfTokenMap(
  blocks: AdminInfoBlock[],
  bearer: string,
  agentName: string,
): Promise<TargetedAdminCsrfToken[]> {
  const tokens = new Map<string, TargetedAdminCsrfToken>();
  const mintIfMissing = async (
    augmentName: string,
    actionId: string,
    rowKey?: string,
  ): Promise<void> => {
    const key = adminActionTargetKey(augmentName, actionId, rowKey);
    if (tokens.has(key)) return;
    tokens.set(key, {
      augmentName,
      actionId,
      rowKey,
      token: await generateCsrfToken({ bearer, agentName, augmentName, actionId, rowKey }),
    });
  };

  for (const block of blocks) {
    for (const action of block.actions ?? []) {
      await mintIfMissing(block.augmentName, action.id);
    }
    for (const section of block.sections) {
      if (section.kind === "keyValue") {
        for (const row of section.rows) {
          if (row.resetAction) {
            await mintIfMissing(block.augmentName, row.resetAction.id);
          }
        }
      }
      if (section.kind === "table" && section.rowActions) {
        for (const rowAction of section.rowActions) {
          for (const row of section.rows) {
            const rowKey = row[rowAction.rowKeyColumn];
            if (rowKey) {
              await mintIfMissing(block.augmentName, rowAction.id, rowKey);
            }
          }
        }
      }
    }
  }

  return Array.from(tokens.values());
}

async function buildLegacyActionCsrfTokens(
  targetedTokens: TargetedAdminCsrfToken[],
  actionRegistry: AdminActionRegistry,
  bearer: string,
  agentName: string,
): Promise<Array<{ actionId: string; rowKey?: string; token: string }>> {
  const tokens = new Map<string, { actionId: string; rowKey?: string; token: string }>();
  for (const targeted of targetedTokens) {
    if (adminActionOwners(actionRegistry, targeted.actionId).length !== 1) continue;
    const key = JSON.stringify([targeted.actionId, targeted.rowKey ?? null]);
    if (tokens.has(key)) continue;
    tokens.set(key, {
      actionId: targeted.actionId,
      rowKey: targeted.rowKey,
      token: await generateCsrfToken({
        bearer,
        agentName,
        actionId: targeted.actionId,
        rowKey: targeted.rowKey,
      }),
    });
  }
  return Array.from(tokens.values());
}

function adminActionTargetKey(augmentName: string, actionId: string, rowKey?: string): string {
  return JSON.stringify([augmentName, actionId, rowKey ?? null]);
}

function exposeAdminActionTargets(blocks: AdminInfoBlock[]): AdminInfoBlock[] {
  return blocks.map((block) => ({
    ...block,
    actions: block.actions?.map((action) => ({
      ...action,
      augmentName: block.augmentName,
    })),
    sections: block.sections.map((section) => {
      if (section.kind === "keyValue") {
        return {
          ...section,
          rows: section.rows.map((row) => ({
            ...row,
            resetAction: row.resetAction
              ? { ...row.resetAction, augmentName: block.augmentName }
              : undefined,
          })),
        };
      }
      if (section.kind === "table") {
        return {
          ...section,
          rowActions: section.rowActions?.map((action) => ({
            ...action,
            augmentName: block.augmentName,
          })),
        };
      }
      return section;
    }),
  }));
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
  actionId: string;
  handler: AdminActionHandler;
  inputs: AdminActionInput[];
  /** True for row-scoped actions (table rowActions). Affects URL parsing. */
  isRowAction: boolean;
}

export type AdminActionRegistry = ReadonlyMap<string, AdminActionRegistryEntry>;

/** Collision-free key for a target-aware action-registry entry. */
export function adminActionRegistryKey(augmentName: string, actionId: string): string {
  return JSON.stringify([augmentName, actionId]);
}

export interface AdminRouteContext {
  kernel: TransportKernel;
  bearer: string;
  agentDir: string | undefined;
  callerIp: string;
  /** Process-local failed-authentication limiter keyed by the effective caller IP. */
  authFailureLimiter?: ConsoleAuthFailureLimiter;
  /** Effective scheme after the transport validates the immediate proxy and forwarding chain. */
  secureRequest?: boolean;
  /** Exact effective origin after Host, scheme, and proxy validation. */
  requestOrigin?: string;
  /** Process-local, bounded tickets used by the CLI to establish a browser session. */
  cliLoginTickets?: ConsoleCliLoginTicketStore;
  /** True only for a direct loopback socket with no forwarding boundary. */
  allowInsecureLoopback?: boolean;
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
  /** Durable console transcript storage. Omitted when console chat persistence is disabled. */
  consoleChat?: ConsoleChatStore;
  /** Unpredictable process-local marker authorizing console persistence on the self-fetch. */
  consoleChatInternalMarker?: string;
  /** Resolve a browser-held visitor credential without exposing its stable internal id. */
  resolveConsoleVisitorIdentity?: (visitorToken: string) => Promise<{
    status: "verified";
    email: string;
    expiresAt: number;
  } | null>;
}

const TARGETED_ACTION_ROUTE_RE = /^\/console\/action\/([^/]+)\/([^/]+)(?:\/row\/([^/]+))?$/;
const LEGACY_ACTION_ROUTE_RE = /^\/console\/action\/([^/]+)(?:\/row\/([^/]+))?$/;

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
const CONSOLE_LOGOUT_ACTION = "console-logout";
const CONSOLE_CHAT_THREAD_ROUTE_RE = /^\/console\/api\/chat\/threads\/([^/]+)$/;
const CONSOLE_CHAT_THREAD_ACTION_ROUTE_RE =
  /^\/console\/api\/chat\/threads\/([^/]+)\/(rename|read-state|delete)$/;
const CONSOLE_CHAT_THREAD_ID_RE = /^[A-Za-z0-9](?:[A-Za-z0-9._:-]{0,255})$/;
const CHAT_PREVIEW_MODES = new Set(["creator", "anonymous", "visitor"]);
type ChatPreviewMode = "creator" | "anonymous" | "visitor";

const CONSOLE_LOGIN_ASSET_PATH = "/console/login-assets";
const CONSOLE_LOGIN_ASSET_PATH_PREFIX = `${CONSOLE_LOGIN_ASSET_PATH}/`;
const CONSOLE_LOGIN_CSP =
  "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'";
const fallbackAuthFailureLimiter = createConsoleAuthFailureLimiter();

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
  return withConsoleSecurityHeaders(await dispatchAdminRoute(req, ctx));
}

async function dispatchAdminRoute(req: Request, ctx: AdminRouteContext): Promise<Response> {
  const url = new URL(req.url);
  const agentCard = ctx.kernel.getAgentCard();
  const agentName = agentCard.provider.name || "auggy";

  const secureRequest = isSecureConsoleRequest(req, ctx);
  if (
    url.pathname === CONSOLE_LOGIN_ASSET_PATH ||
    url.pathname.startsWith(CONSOLE_LOGIN_ASSET_PATH_PREFIX)
  ) {
    if (!isInsecureLoopbackAllowed(ctx) && !secureRequest) return consoleHttpsRequiredResponse(url);
    if (req.method !== "GET" && req.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return handleLoginAsset(ctx, url.pathname, req.method);
  }

  if (url.pathname === "/console/login") {
    if (!isInsecureLoopbackAllowed(ctx) && !secureRequest) return consoleHttpsRequiredResponse(url);
    if (req.method === "GET") return loginPageResponse(ctx, "default");
    if (req.method === "POST") return handleLoginPost(req, ctx, secureRequest);
    return methodNotAllowed("GET, POST");
  }

  if (url.pathname.startsWith(CONSOLE_CLI_LOGIN_TICKET_PATH_PREFIX)) {
    if (!isInsecureLoopbackAllowed(ctx) && !secureRequest) return consoleHttpsRequiredResponse(url);
    if (req.method !== "GET") return methodNotAllowed("GET");
    return handleCliLoginTicket(req, ctx, secureRequest);
  }

  // Auth + HTTPS gate
  const auth = checkAdminAuth({
    req,
    bearer: ctx.bearer,
    agentName,
    callerIp: ctx.callerIp,
    secureRequest: ctx.secureRequest,
    allowInsecureLoopback: ctx.allowInsecureLoopback,
    trustForwardedProto: ctx.trustForwardedProto,
  });
  if (auth.kind === "https-required") return auth.response;
  if (auth.kind === "unauthorized") {
    if (auth.failure === "missing") return auth.response;
    // A stale or rotated signed session is not a password attempt. Clear it
    // immediately so dashboard polling and multiple tabs cannot poison the
    // password/Basic-auth budget or prevent navigation back to sign-in.
    if (auth.failure === "invalid-session") return auth.response;
    const limited = checkAuthenticationLimit(ctx);
    if (limited) {
      return limited;
    }
    recordAuthenticationFailure(ctx);
    return auth.response;
  }
  if (auth.method === "basic") {
    const limited = checkAuthenticationLimit(ctx);
    if (limited) return limited;
  }

  if (url.pathname === "/console/api/cli-login") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    return handleCliLoginTicketIssue(req, ctx);
  }

  if (url.pathname === "/console/logout") {
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { allow: "POST" } });
    }
    return handleLogoutPost(req, ctx, agentName, secureRequest);
  }

  if (req.method === "POST") {
    const bounded = await boundAuthenticatedAdminRequest(req, url.pathname);
    if (bounded instanceof Response) return bounded;
    req = bounded;
  }

  // Target-aware augment action endpoint. Both target segments are decoded
  // exactly once and validated before registry lookup; encoded slashes and
  // traversal-like names are never accepted as target aliases.
  const targetedActionMatch = url.pathname.match(TARGETED_ACTION_ROUTE_RE);
  if (req.method === "POST" && targetedActionMatch) {
    const augmentName = decodeAdminActionTargetSegment(targetedActionMatch[1]!);
    const actionId = decodeAdminActionTargetSegment(targetedActionMatch[2]!);
    if (augmentName === null || actionId === null) {
      return new Response(null, { status: 400 });
    }
    const rowKey = decodeAdminActionRowKey(targetedActionMatch[3]);
    if (rowKey === null) return new Response(null, { status: 400 });
    return handleActionPost(req, ctx, actionId, rowKey, agentName, augmentName);
  }

  // Compatibility endpoint. It dispatches only when the action id has one
  // registry owner; duplicate ids get a deterministic 409 rather than an
  // order-dependent first match.
  const legacyActionMatch = url.pathname.match(LEGACY_ACTION_ROUTE_RE);
  if (req.method === "POST" && legacyActionMatch) {
    const actionId = decodeAdminActionTargetSegment(legacyActionMatch[1]!);
    if (actionId === null) return new Response(null, { status: 400 });
    const rowKey = decodeAdminActionRowKey(legacyActionMatch[2]);
    if (rowKey === null) return new Response(null, { status: 400 });
    return handleActionPost(req, ctx, actionId, rowKey, agentName);
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

  // Visitor identity summary ---------------------------------------------
  if (url.pathname === "/console/api/visitor-identity") {
    if (req.method !== "POST") return methodNotAllowed("POST");
    return handleConsoleVisitorIdentity(req, ctx, agentName);
  }

  // Creator-authenticated AgentMail detail proxy -------------------------
  // Console sessions are intentionally scoped to /console. Resolve the
  // narrow, canonical AgentMail detail surface through a loopback bearer
  // fetch so the browser never receives the permanent credential.
  if (url.pathname === "/console/api/mail-detail") {
    return handleMailDetailProxy(req, ctx);
  }

  // Chat SSE proxy --------------------------------------------------------
  if (req.method === "POST" && url.pathname === "/console/api/chat") {
    return handleChatProxy(req, ctx, agentName);
  }

  // Persisted console threads --------------------------------------------
  if (url.pathname === "/console/api/chat/threads") {
    if (req.method !== "GET") return methodNotAllowed("GET");
    return handleConsoleThreadList(ctx);
  }
  const consoleThreadActionMatch = url.pathname.match(CONSOLE_CHAT_THREAD_ACTION_ROUTE_RE);
  if (consoleThreadActionMatch) {
    if (req.method !== "POST") return methodNotAllowed("POST");
    const threadId = decodeConsoleThreadId(consoleThreadActionMatch[1]!);
    if (!threadId) return jsonResponse({ error: "invalid thread id" }, 400);
    return handleConsoleThreadAction(
      req,
      ctx,
      agentName,
      threadId,
      consoleThreadActionMatch[2] as "rename" | "read-state" | "delete",
    );
  }
  const consoleThreadMatch = url.pathname.match(CONSOLE_CHAT_THREAD_ROUTE_RE);
  if (consoleThreadMatch) {
    if (req.method !== "GET") return methodNotAllowed("GET");
    const threadId = decodeConsoleThreadId(consoleThreadMatch[1]!);
    if (!threadId) return jsonResponse({ error: "invalid thread id" }, 400);
    return handleConsoleThreadRead(ctx, threadId);
  }
  if (url.pathname.startsWith("/console/api/chat/threads/")) {
    return jsonResponse({ error: "not found" }, 404);
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

async function handleLogoutPost(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
  secureRequest: boolean,
): Promise<Response> {
  const origin = req.headers.get("origin");
  const expectedOrigin = ctx.requestOrigin ?? new URL(req.url).origin;
  if (!origin || origin !== expectedOrigin) {
    return jsonResponse({ error: "same-origin request required" }, 403);
  }

  const contentLength = req.headers.get("content-length");
  if (contentLength && (!/^\d+$/.test(contentLength) || Number(contentLength) > 4096)) {
    return jsonResponse({ error: "invalid request body" }, 400);
  }

  let csrf: string | null = null;
  try {
    const body = await readRequestBodyText(req, 4096);
    const form = new URLSearchParams(body);
    const values = form.getAll("csrf");
    if (values.length !== 1 || Array.from(form.keys()).some((key) => key !== "csrf")) {
      return jsonResponse({ error: "invalid request body" }, 400);
    }
    csrf = values[0] ?? null;
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: "payload too large" }, 413);
    }
    return jsonResponse({ error: "invalid request body" }, 400);
  }
  if (!csrf) return jsonResponse({ error: "missing csrf" }, 400);

  const result = await validateCsrfToken({
    token: csrf,
    bearer: ctx.bearer,
    agentName,
    actionId: CONSOLE_LOGOUT_ACTION,
  });
  if (!result.valid) {
    return jsonResponse(
      {
        error:
          result.reason === "expired" ? "Session expired — reload the page." : "CSRF check failed.",
      },
      result.reason === "expired" ? 419 : 403,
    );
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

function adminBodyLimit(pathname: string): number {
  if (pathname === "/console/logout") return 4 * 1024;
  if (pathname.startsWith("/console/action/")) {
    const segments = pathname.split("/");
    // A valid 1 MiB UTF-8 revision may expand to roughly 3 MiB when form
    // encoded. Keep the larger authenticated bound specific to this action;
    // every other admin action retains the tighter generic limit.
    if (segments[3] === "agentmail-review-revise" || segments[4] === "agentmail-review-revise") {
      return 4 * 1024 * 1024;
    }
    return 64 * 1024;
  }
  if (pathname === "/console/api/chat") return 17 * 1024 * 1024;
  if (pathname.startsWith("/console/api/credentials/")) return 1100 * 1024;
  if (pathname === "/console/api/identity" || pathname.startsWith("/console/api/skills/")) {
    return 300 * 1024;
  }
  return 64 * 1024;
}

async function boundAuthenticatedAdminRequest(
  request: Request,
  pathname: string,
): Promise<Request | Response> {
  try {
    return await cloneRequestWithBoundedBody(request, adminBodyLimit(pathname));
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return jsonResponse({ error: "payload too large" }, 413);
    }
    if (!(error instanceof InvalidRequestBodyError)) {
      console.warn("[console] request body read failed");
    }
    return jsonResponse({ error: "invalid request body" }, 400);
  }
}

function withConsoleSecurityHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  if (!headers.has("content-security-policy")) {
    headers.set("content-security-policy", "frame-ancestors 'none'");
  }
  headers.set("x-frame-options", "DENY");
  headers.set("referrer-policy", "no-referrer");
  headers.set("x-content-type-options", "nosniff");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

async function handleLoginPost(
  req: Request,
  ctx: AdminRouteContext,
  secureRequest: boolean,
): Promise<Response> {
  if (!hasUrlEncodedContentType(req.headers.get("content-type"))) {
    return loginRequestFailureResponse(400, "Invalid login request.");
  }

  let body: string;
  try {
    body = await readRequestBodyText(req, 4096);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      return loginRequestFailureResponse(413, "Request body too large.");
    }
    return loginRequestFailureResponse(400, "Invalid login request.");
  }

  if (!isWellFormedUrlEncodedBody(body)) {
    return loginRequestFailureResponse(400, "Invalid login request.");
  }

  const form = new URLSearchParams(body);
  const passwordValues = form.getAll("password");
  const keys = Array.from(form.keys());
  if (passwordValues.length > 1 || keys.some((key) => key !== "password")) {
    return loginRequestFailureResponse(400, "Invalid login request.");
  }

  const password = passwordValues[0] ?? "";
  // Keep admission, comparison, and failure recording in one synchronous
  // section after the bounded async body read so parallel POSTs cannot all
  // pass an earlier empty-bucket check before any failure is recorded.
  const limited = checkAuthenticationLimit(ctx);
  if (limited) return limited;
  if (!timingSafeStringEqual(password, ctx.bearer)) {
    recordAuthenticationFailure(ctx);
    return loginPageResponse(ctx, "invalid-password");
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

function hasUrlEncodedContentType(value: string | null): boolean {
  if (!value) return false;
  const [mediaType, ...parameters] = value.split(";").map((part) => part.trim());
  if (mediaType?.toLowerCase() !== "application/x-www-form-urlencoded") return false;
  if (parameters.length === 0) return true;
  return parameters.length === 1 && /^charset\s*=\s*(?:utf-8|"utf-8")$/i.test(parameters[0] ?? "");
}

function isWellFormedUrlEncodedBody(body: string): boolean {
  try {
    decodeURIComponent(body.replace(/\+/g, " "));
    return true;
  } catch {
    return false;
  }
}

function loginRequestFailureResponse(status: 400 | 413, message: string): Response {
  return new Response(message, {
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function handleCliLoginTicketIssue(req: Request, ctx: AdminRouteContext): Response {
  if (!ctx.cliLoginTickets)
    return jsonResponse({ error: "Console CLI sign-in is unavailable" }, 503);
  if (req.headers.has("origin") || !hasValidConsoleBasicAuth(req, ctx.bearer)) {
    return jsonResponse({ error: "unauthorized" }, 401);
  }
  if (req.body !== null) return jsonResponse({ error: "request body is not allowed" }, 400);

  const origin = effectiveConsoleOrigin(req, ctx);
  try {
    const ticket = ctx.cliLoginTickets.issue({ bearer: ctx.bearer, origin });
    return jsonResponse({
      loginPath: `${CONSOLE_CLI_LOGIN_TICKET_PATH_PREFIX}${ticket.token}`,
      expiresInSeconds: ticket.expiresInSeconds,
    });
  } catch {
    return jsonResponse({ error: "Console CLI sign-in is temporarily unavailable" }, 503);
  }
}

async function handleCliLoginTicket(
  req: Request,
  ctx: AdminRouteContext,
  secureRequest: boolean,
): Promise<Response> {
  const url = new URL(req.url);
  const token = url.pathname.slice(CONSOLE_CLI_LOGIN_TICKET_PATH_PREFIX.length);
  const result = ctx.cliLoginTickets?.consume({
    token,
    bearer: ctx.bearer,
    origin: effectiveConsoleOrigin(req, ctx),
  });
  if (!result?.ok) {
    return loginPageResponse(ctx, "invalid-ticket");
  }

  return new Response(null, {
    status: 303,
    headers: {
      location: result.nextPath,
      "set-cookie": createConsoleSessionSetCookie({ bearer: ctx.bearer, secure: secureRequest }),
      "cache-control": "no-store",
    },
  });
}

async function handleLoginAsset(
  ctx: AdminRouteContext,
  pathname: string,
  method: "GET" | "HEAD",
): Promise<Response> {
  const relativePath = pathname.slice(CONSOLE_LOGIN_ASSET_PATH_PREFIX.length);
  if (!relativePath || pathname === CONSOLE_LOGIN_ASSET_PATH) return staticFailureResponse(404);

  const artifacts = await loadConsoleLoginArtifacts(ctx.staticDir);
  if (!artifacts || relativePath !== artifacts.stylesheet.path) {
    return staticFailureResponse(404);
  }

  return new Response(method === "HEAD" ? null : artifacts.stylesheet.bytes, {
    status: 200,
    headers: {
      "content-type": "text/css; charset=utf-8",
      "cache-control": "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

async function loginPageResponse(
  ctx: AdminRouteContext,
  variant: ConsoleLoginVariant,
): Promise<Response> {
  const artifacts = await loadConsoleLoginArtifacts(ctx.staticDir);
  const body = artifacts?.variants[variant] ?? fallbackLoginDocument(variant);

  return new Response(body, {
    status: variant === "default" ? 200 : 401,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
      "content-security-policy": CONSOLE_LOGIN_CSP,
    },
  });
}

function fallbackLoginDocument(variant: ConsoleLoginVariant): string {
  const error =
    variant === "invalid-password"
      ? "Invalid console password."
      : variant === "invalid-ticket"
        ? "This automatic sign-in link is invalid or expired."
        : undefined;
  const errorMarkup = error ? `<p id="login-error" role="alert">${error}</p>` : "";
  const inputErrorAttributes = error ? ' aria-invalid="true" aria-describedby="login-error"' : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>Sign in — Auggy Console</title>
</head>
<body data-auggy-login-source="fallback" data-auggy-login-variant="${variant}">
  <main>
    <header>
      <p>Auggy</p>
      <p>Creator Console</p>
      <h1>Welcome back.</h1>
      <p>Enter <code>AUGGY_WEB_TOKEN</code> from this agent's <code>.env</code> file or deployment secrets.</p>
    </header>
    ${errorMarkup}
    <form method="post">
      <p>
        <label for="password">Console password</label><br>
        <input id="password" name="password" type="password" autocomplete="current-password" autofocus required${inputErrorAttributes}>
      </p>
      <button type="submit">Open Console</button>
    </form>
    <p>From your terminal, <code>auggy console &lt;agent&gt;</code> opens an automatic one-time sign-in.</p>
  </main>
</body>
</html>
`;
}

async function handleDashboardJson(ctx: AdminRouteContext, agentName: string): Promise<Response> {
  const blocks = await collectAdminInfoBlocks(ctx.kernel);
  const targetedCsrfTokens = await buildCsrfTokenMap(blocks, ctx.bearer, agentName);
  // Keep legacy tokens first so a cached pre-targeting SPA that keys only by
  // actionId continues to work for uniquely owned actions. Ambiguous action
  // ids intentionally receive no action-only token.
  const csrfTokens: Array<
    TargetedAdminCsrfToken | { actionId: string; rowKey?: string; token: string }
  > = [
    ...(await buildLegacyActionCsrfTokens(
      targetedCsrfTokens,
      ctx.actionRegistry,
      ctx.bearer,
      agentName,
    )),
    ...targetedCsrfTokens,
  ];
  const targetedBlocks = exposeAdminActionTargets(blocks);
  const augments = collectAugmentSummaries(ctx.kernel);
  const tools = collectToolSummaries(ctx.kernel);
  const agentMeta = readAgentMeta(ctx.agentDir);
  const routeManifest = createRouteManifest(
    ctx.kernel.getAugmentRoutes() as readonly CollectedRoute[],
  );
  const routes = {
    summary: summarizeRouteManifest(routeManifest),
    entries: routeManifest,
  };
  const web = {
    ...readWebDashboardState(blocks),
    // Token verification and operator-facing identity resolution are separate
    // capabilities. The Console must not probe this endpoint merely because
    // visitor tokens are enabled for public routes.
    visitorIdentityEnabled: Boolean(ctx.resolveConsoleVisitorIdentity),
  };

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

  const logoutToken = await generateCsrfToken({
    bearer: ctx.bearer,
    agentName,
    actionId: CONSOLE_LOGOUT_ACTION,
  });
  csrfTokens.push({ actionId: CONSOLE_LOGOUT_ACTION, rowKey: undefined, token: logoutToken });

  return new Response(
    JSON.stringify({
      card: ctx.kernel.getAgentCard(),
      runtime: ctx.kernel.getOperationalSnapshot?.() ?? null,
      auggyVersion: AUGGY_VERSION,
      agentMeta,
      augments,
      tools,
      routes,
      web,
      blocks: targetedBlocks,
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
  // Published static namespaces must fail closed. Returning the SPA shell for
  // a missing script, stylesheet, or brand image hides incomplete packages
  // behind a misleading 200 HTML response.
  const publishedStaticPath = classifyPublishedStaticPath(pathname);
  if (publishedStaticPath.kind === "invalid") return staticFailureResponse(404);
  if (publishedStaticPath.kind === "file") {
    if (!ctx.staticDir) return staticFailureResponse(503);
    const file = serveStaticFile(ctx.staticDir, publishedStaticPath.relativePath);
    return file ?? staticFailureResponse(404);
  }

  if (!ctx.staticDir) return buildRequiredResponse();

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

type PublishedStaticPath =
  | { kind: "not-static" }
  | { kind: "invalid" }
  | { kind: "file"; relativePath: string };

function classifyPublishedStaticPath(pathname: string): PublishedStaticPath {
  const consolePrefix = "/console/";
  if (!pathname.startsWith(consolePrefix)) return { kind: "not-static" };

  const encodedSegments = pathname.slice(consolePrefix.length).split("/");
  let namespace: string;
  try {
    namespace = decodeURIComponent(encodedSegments[0] ?? "");
  } catch {
    return { kind: "invalid" };
  }
  if (hasUnsafeStaticSegment(namespace)) return { kind: "invalid" };
  if (namespace !== "assets" && namespace !== "brand") return { kind: "not-static" };

  const decodedSegments: string[] = [];
  for (const [index, encodedSegment] of encodedSegments.entries()) {
    let segment: string;
    try {
      segment = decodeURIComponent(encodedSegment);
    } catch {
      return { kind: "invalid" };
    }
    const isEmptyInteriorSegment = segment === "" && index < encodedSegments.length - 1;
    if (isEmptyInteriorSegment || hasUnsafeStaticSegment(segment)) {
      return { kind: "invalid" };
    }
    decodedSegments.push(segment);
  }
  return { kind: "file", relativePath: decodedSegments.join("/") };
}

function hasUnsafeStaticSegment(segment: string): boolean {
  const hasControlCharacter = Array.from(segment).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  return (
    segment === "." ||
    segment === ".." ||
    segment.includes("/") ||
    segment.includes("\\") ||
    hasControlCharacter
  );
}

function decodeAdminActionTargetSegment(encoded: string): string | null {
  try {
    const decoded = decodeURIComponent(encoded);
    if (decoded.length === 0 || decoded.length > 256 || hasUnsafeStaticSegment(decoded)) {
      return null;
    }
    return decoded;
  } catch {
    return null;
  }
}

function decodeAdminActionRowKey(encoded: string | undefined): string | undefined | null {
  if (encoded === undefined) return undefined;
  try {
    const decoded = decodeURIComponent(encoded);
    const hasControlCharacter = Array.from(decoded).some((character) => {
      const codePoint = character.codePointAt(0) ?? 0;
      return codePoint <= 0x1f || codePoint === 0x7f;
    });
    if (decoded.length === 0 || decoded.length > 1024 || hasControlCharacter) return null;
    return decoded;
  } catch {
    return null;
  }
}

function adminActionOwners(
  registry: AdminActionRegistry,
  actionId: string,
): AdminActionRegistryEntry[] {
  return Array.from(registry.values()).filter((entry) => entry.actionId === actionId);
}

async function handleActionPost(
  req: Request,
  ctx: AdminRouteContext,
  actionId: string,
  rowKey: string | undefined,
  agentName: string,
  augmentName?: string,
): Promise<Response> {
  const wantsJson = req.headers.get("accept")?.includes("application/json") === true;
  let entry: AdminActionRegistryEntry | undefined;
  if (augmentName !== undefined) {
    entry = ctx.actionRegistry.get(adminActionRegistryKey(augmentName, actionId));
  } else {
    const owners = adminActionOwners(ctx.actionRegistry, actionId);
    if (owners.length > 1) {
      return wantsJson
        ? actionJson(
            {
              ok: false,
              message: "Action target is ambiguous; refresh and retry the targeted action.",
              csrfExpired: false,
            },
            409,
          )
        : new Response(null, { status: 409 });
    }
    entry = owners[0];
  }
  if (!entry) {
    return wantsJson
      ? actionJson({ ok: false, message: "Action not found", csrfExpired: false }, 404)
      : new Response(null, { status: 404 });
  }
  if (entry.isRowAction !== (rowKey !== undefined)) {
    return wantsJson
      ? actionJson(
          {
            ok: false,
            message: entry.isRowAction
              ? "Row-scoped action requires a row target."
              : "Action does not accept a row target.",
            csrfExpired: false,
          },
          400,
        )
      : new Response(null, { status: 400 });
  }

  let form: URLSearchParams;
  try {
    const text = await req.text();
    form = new URLSearchParams(text);
  } catch {
    return wantsJson
      ? actionJson({ ok: false, message: "invalid form body", csrfExpired: false }, 400)
      : new Response(null, { status: 400 });
  }
  const keys = [...form.keys()];
  if (new Set(keys).size !== keys.length) {
    return wantsJson
      ? actionJson({ ok: false, message: "duplicate form field", csrfExpired: false }, 400)
      : new Response(null, { status: 400 });
  }

  // S7 fix — CSRF validation distinguishes expired (graceful refresh) from
  // tampered/malformed (403).
  const csrfToken = form.get("_csrf") ?? "";
  const csrfResult = await validateCsrfToken({
    token: csrfToken,
    bearer: ctx.bearer,
    agentName,
    augmentName,
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
    if (result.ok && result.recoverThreadId) {
      ctx.kernel.recoverThread(result.recoverThreadId);
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[admin] augment=${entry.augmentName} action=${actionId} threw: ${message}`);
    result = { ok: false, message: "internal error" };
  }

  // Audit log
  console.log(
    `[admin] actor=creator augment=${entry.augmentName} action=${actionId} rowKey=${rowKey ?? "-"} result=${
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
 *   2. Target-aware (augmentName, actionId) identity
 *   3. Registry construction so the request-time dispatcher doesn't need
 *      to re-call adminInfo() to find input declarations
 */
export async function buildAdminActionRegistry(
  augments: readonly Augment[],
): Promise<AdminActionRegistry> {
  const registry = new Map<string, AdminActionRegistryEntry>();
  const mountedNames = new Set<string>();
  for (const aug of augments) {
    if (mountedNames.has(aug.name)) {
      throw new Error(`[admin] duplicate mounted augment name "${aug.name}"`);
    }
    mountedNames.add(aug.name);
  }

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
    const key = adminActionRegistryKey(augName, actionId);
    const existing = registry.get(key);
    if (existing) {
      if (
        existing.isRowAction !== isRowAction ||
        JSON.stringify(existing.inputs) !== JSON.stringify(inputs)
      ) {
        throw new Error(
          `[admin] augment "${augName}" declares action "${actionId}" more than once with incompatible metadata`,
        );
      }
      return;
    }
    registry.set(key, {
      augmentName: augName,
      actionId,
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
          register(aug.name, aug.adminActions, ra.id, ra.inputs ?? [], true);
        }
      }
      if (section.kind === "keyValue") {
        for (const row of section.rows) {
          if (
            row.resetAction &&
            !registry.has(adminActionRegistryKey(aug.name, row.resetAction.id))
          ) {
            register(aug.name, aug.adminActions, row.resetAction.id, [], false);
          }
        }
      }
    }
  }

  return registry;
}

// ===========================================================================
// Persisted console threads + chat SSE proxy
// ===========================================================================

interface ConsoleChatThreadDto {
  id: string;
  title: string;
  previewMode: ChatPreviewMode;
  model: {
    id: string;
    displayName: string;
    provider?: string;
  } | null;
  createdAt: string;
  updatedAt: string;
  lastReadAt: string | null;
  unread: boolean;
  runStatus: ConsoleChatThreadSummary["runStatus"];
  messages?: Array<{
    id: string;
    role: "user" | "assistant";
    content: string;
    toolCalls?: NonNullable<ConsoleChatThread["messages"][number]["toolCalls"]>;
    error?: string;
    createdAt: string;
    updatedAt: string;
  }>;
}

function handleConsoleThreadList(ctx: AdminRouteContext): Response {
  if (!ctx.consoleChat) return consoleChatUnavailableResponse();
  try {
    return jsonResponse({ threads: ctx.consoleChat.listThreads().map(consoleThreadDto) });
  } catch {
    return jsonResponse({ error: "Unable to read console chats." }, 500);
  }
}

function handleConsoleThreadRead(ctx: AdminRouteContext, threadId: string): Response {
  if (!ctx.consoleChat) return consoleChatUnavailableResponse();
  try {
    const thread = ctx.consoleChat.getThread(threadId);
    if (!thread) return consoleThreadMissingResponse(ctx.consoleChat, threadId);
    return jsonResponse({ thread: consoleThreadDto(thread) });
  } catch {
    return jsonResponse({ error: "Unable to read console chat." }, 500);
  }
}

async function handleConsoleThreadAction(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
  threadId: string,
  action: "rename" | "read-state" | "delete",
): Promise<Response> {
  if (!ctx.consoleChat) return consoleChatUnavailableResponse();

  const body = await readStrictJsonObject(req);
  if (!body) return jsonResponse({ error: "invalid JSON body" }, 400);
  const expectedKeys =
    action === "rename"
      ? new Set(["csrf", "title"])
      : action === "read-state"
        ? new Set(["csrf", "unread"])
        : new Set(["csrf"]);
  if (Object.keys(body).some((key) => !expectedKeys.has(key))) {
    return jsonResponse({ error: "unexpected field" }, 400);
  }
  const csrf = await validateConsoleChatCsrf(ctx, agentName, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message }, csrf.status);

  try {
    if (action === "delete") {
      ctx.consoleChat.deleteThread(threadId);
      ctx.kernel.forgetThreadHistory?.(threadId);
      return jsonResponse({ ok: true });
    }

    const existing = ctx.consoleChat.getThread(threadId);
    if (!existing) return consoleThreadMissingResponse(ctx.consoleChat, threadId);

    if (action === "rename") {
      const title = validateConsoleThreadTitle(body.title);
      if (!title) return jsonResponse({ error: "invalid title" }, 400);
      const thread = ctx.consoleChat.renameThread(threadId, title, Date.now());
      return thread
        ? jsonResponse({ thread: consoleThreadDto(thread) })
        : consoleThreadMissingResponse(ctx.consoleChat, threadId);
    }

    if (typeof body.unread !== "boolean") {
      return jsonResponse({ error: "unread must be a boolean" }, 400);
    }
    const thread = ctx.consoleChat.setThreadReadState(threadId, body.unread, Date.now());
    return thread
      ? jsonResponse({ thread: consoleThreadDto(thread) })
      : consoleThreadMissingResponse(ctx.consoleChat, threadId);
  } catch {
    // deleteThread owns the transactional streaming check. Classify a storage
    // rejection from current state without coupling the API to error text.
    if (action === "delete") {
      try {
        if (ctx.consoleChat.getThread(threadId)?.runStatus === "streaming") {
          return jsonResponse({ error: "Cannot delete a chat while it is streaming." }, 409);
        }
      } catch {
        // Preserve the generic failure below if the follow-up read also fails.
      }
    }
    return jsonResponse({ error: "Unable to update console chat." }, 500);
  }
}

function consoleThreadMissingResponse(store: ConsoleChatStore, threadId: string): Response {
  return store.isThreadDeleted(threadId)
    ? jsonResponse({ error: "thread was deleted" }, 410)
    : jsonResponse({ error: "thread not found" }, 404);
}

function consoleThreadDto(
  thread: ConsoleChatThreadSummary | ConsoleChatThread,
): ConsoleChatThreadDto {
  const dto: ConsoleChatThreadDto = {
    id: thread.id,
    title: thread.title,
    previewMode: thread.previewMode,
    model: consoleModelDto(thread.model),
    createdAt: new Date(thread.createdAt).toISOString(),
    updatedAt: new Date(thread.updatedAt).toISOString(),
    lastReadAt: thread.lastReadAt === null ? null : new Date(thread.lastReadAt).toISOString(),
    unread: thread.unread,
    runStatus: thread.runStatus,
  };
  if ("messages" in thread) {
    dto.messages = thread.messages.map((message) => ({
      id: message.id,
      role: message.role,
      content: message.content,
      ...(message.toolCalls ? { toolCalls: message.toolCalls } : {}),
      ...(message.error ? { error: message.error } : {}),
      createdAt: new Date(message.createdAt).toISOString(),
      updatedAt: new Date(message.updatedAt).toISOString(),
    }));
  }
  return dto;
}

function consoleModelDto(model: ConsoleChatModelSnapshot | null): ConsoleChatThreadDto["model"] {
  if (!model) return null;
  return {
    id: model.id,
    displayName: model.displayName,
    ...(model.provider ? { provider: model.provider } : {}),
  };
}

function decodeConsoleThreadId(segment: string): string | null {
  let value: string;
  try {
    value = decodeURIComponent(segment);
  } catch {
    return null;
  }
  return CONSOLE_CHAT_THREAD_ID_RE.test(value) ? value : null;
}

function validateConsoleThreadTitle(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const title = value.trim();
  if (!title || Array.from(title).length > 80 || hasControlCharacters(title)) return null;
  return title;
}

async function readStrictJsonObject(req: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await req.json();
    if (typeof body !== "object" || body === null || Array.isArray(body)) return null;
    return body as Record<string, unknown>;
  } catch {
    return null;
  }
}

async function validateConsoleChatCsrf(
  ctx: AdminRouteContext,
  agentName: string,
  token: unknown,
): Promise<{ ok: true } | { ok: false; status: number; message: string }> {
  if (typeof token !== "string" || token.length === 0) {
    return { ok: false, status: 400, message: "missing csrf" };
  }
  const result = await validateCsrfToken({
    token,
    bearer: ctx.bearer,
    agentName,
    actionId: CONSOLE_CHAT_ACTION,
  });
  if (result.valid) return { ok: true };
  if (result.reason === "expired") {
    return { ok: false, status: 419, message: "Session expired — reload the page." };
  }
  return { ok: false, status: 403, message: "CSRF check failed." };
}

async function handleConsoleVisitorIdentity(
  req: Request,
  ctx: AdminRouteContext,
  agentName: string,
): Promise<Response> {
  const body = await readStrictJsonObject(req);
  if (
    !body ||
    Object.keys(body).some((key) => key !== "csrf" && key !== "visitorToken") ||
    typeof body.visitorToken !== "string" ||
    body.visitorToken.length === 0 ||
    body.visitorToken.length > 4096 ||
    /[\r\n]/.test(body.visitorToken)
  ) {
    return jsonResponse({ error: "invalid request", code: "invalid_request" }, 400);
  }

  const csrf = await validateConsoleChatCsrf(ctx, agentName, body.csrf);
  if (!csrf.ok) return jsonResponse({ error: csrf.message, code: "csrf_rejected" }, csrf.status);

  if (!ctx.resolveConsoleVisitorIdentity) {
    return jsonResponse(
      {
        error: "Visitor identity resolution is not configured.",
        code: "visitor_identity_not_configured",
      },
      501,
    );
  }

  let identity: Awaited<ReturnType<NonNullable<typeof ctx.resolveConsoleVisitorIdentity>>>;
  try {
    identity = await ctx.resolveConsoleVisitorIdentity(body.visitorToken);
  } catch {
    return jsonResponse(
      {
        error: "Visitor identity resolution is temporarily unavailable.",
        code: "visitor_identity_unavailable",
      },
      503,
    );
  }
  if (!identity) {
    return jsonResponse(
      {
        error: "Visitor credential is invalid, expired, or revoked.",
        code: "visitor_credential_rejected",
      },
      401,
    );
  }
  return jsonResponse({ identity });
}

function consoleChatUnavailableResponse(): Response {
  return jsonResponse({ error: "Console chat persistence is unavailable." }, 503);
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: {
      allow,
      "content-type": "application/json",
      "cache-control": "no-store, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

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
    title?: unknown;
    model?: unknown;
    runId?: unknown;
    userMessageId?: unknown;
    assistantMessageId?: unknown;
  };
  const parsedBody = await readStrictJsonObject(req);
  if (!parsedBody) return jsonResponse({ error: "invalid JSON body" }, 400);
  body = parsedBody;
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
  if (body.message.length > 16 * 1024 * 1024) {
    return jsonResponse({ error: "message is too long" }, 400);
  }
  const chatMode = parseChatPreviewMode(body.chatMode, body.visitorToken);
  if (!chatMode) {
    return jsonResponse({ error: "invalid chat preview mode" }, 400);
  }
  let threadId: string | undefined;
  if (body.threadId !== undefined) {
    threadId =
      typeof body.threadId === "string"
        ? (decodeConsoleThreadId(body.threadId) ?? undefined)
        : undefined;
    if (!threadId) return jsonResponse({ error: "invalid thread id" }, 400);
  }
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

  let consoleMetadata:
    | {
        previewMode: ChatPreviewMode;
        title?: string;
        model?: ConsoleChatModelSnapshot;
        unreadOnFinish: true;
        runId?: string;
        userMessageId?: string;
        assistantMessageId?: string;
      }
    | undefined;
  if (ctx.consoleChat) {
    if (!ctx.consoleChatInternalMarker || !threadId) {
      return consoleChatUnavailableResponse();
    }
    const title = body.title === undefined ? undefined : validateConsoleThreadTitle(body.title);
    if (body.title !== undefined && !title) return jsonResponse({ error: "invalid title" }, 400);
    const requestedModel = validateConsoleChatModel(body.model);
    if (body.model !== undefined && !requestedModel) {
      return jsonResponse({ error: "invalid model" }, 400);
    }
    // Existing clients hydrate the thread's historical model snapshot. The
    // server is authoritative for the model actually running now, otherwise a
    // conversation continued after an engine change would remain mislabeled.
    const model = configuredConsoleChatModel(ctx.agentDir) ?? requestedModel;
    const runId = validateOptionalConsoleMessageId(body.runId);
    if (body.runId !== undefined && !runId) {
      return jsonResponse({ error: "invalid run id" }, 400);
    }
    const userMessageId = validateOptionalConsoleMessageId(body.userMessageId);
    if (body.userMessageId !== undefined && !userMessageId) {
      return jsonResponse({ error: "invalid user message id" }, 400);
    }
    const assistantMessageId = validateOptionalConsoleMessageId(body.assistantMessageId);
    if (body.assistantMessageId !== undefined && !assistantMessageId) {
      return jsonResponse({ error: "invalid assistant message id" }, 400);
    }
    consoleMetadata = {
      previewMode: chatMode,
      ...(title ? { title } : {}),
      ...(model ? { model } : {}),
      unreadOnFinish: true,
      ...(runId ? { runId } : {}),
      ...(userMessageId ? { userMessageId } : {}),
      ...(assistantMessageId ? { assistantMessageId } : {}),
    };
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
  if (consoleMetadata) {
    headers["x-auggy-console-internal"] = ctx.consoleChatInternalMarker!;
  }
  try {
    upstream = await fetch(`http://127.0.0.1:${ctx.selfPort}/agent/run`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        messages: [{ role: "user", content: body.message }],
        threadId,
        ...(consoleMetadata ? { __console: consoleMetadata } : {}),
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
    headers: {
      "content-type": upstream.headers.get("content-type") ?? "application/octet-stream",
      "cache-control": "no-store, must-revalidate",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function validateOptionalConsoleMessageId(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !CONSOLE_CHAT_THREAD_ID_RE.test(value)) return undefined;
  return value;
}

function validateConsoleChatModel(value: unknown): ConsoleChatModelSnapshot | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "object" || Array.isArray(value)) return undefined;
  const model = value as Record<string, unknown>;
  if (
    Object.keys(model).some((key) => key !== "id" && key !== "displayName" && key !== "provider")
  ) {
    return undefined;
  }
  if (!isBoundedNonemptyString(model.id, 512) || !isBoundedNonemptyString(model.displayName, 512)) {
    return undefined;
  }
  if (
    model.provider !== undefined &&
    model.provider !== null &&
    !isBoundedNonemptyString(model.provider, 512)
  ) {
    return undefined;
  }
  return {
    id: model.id,
    displayName: model.displayName,
    provider: typeof model.provider === "string" ? model.provider : null,
  };
}

function configuredConsoleChatModel(
  agentDir: string | undefined,
): ConsoleChatModelSnapshot | undefined {
  const engine = readAgentMeta(agentDir)?.engine;
  const provider = engine?.provider?.trim();
  const model = engine?.model?.trim();
  if (
    (provider !== undefined && !isBoundedNonemptyString(provider, 512)) ||
    (model !== undefined && !isBoundedNonemptyString(model, 512))
  ) {
    return undefined;
  }
  if (!provider && !model) return undefined;
  const id = model ?? provider!;
  return { id, displayName: id, provider: provider ?? null };
}

function isBoundedNonemptyString(value: unknown, maxLength: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maxLength &&
    !hasControlCharacters(value)
  );
}

function hasControlCharacters(value: string): boolean {
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (codePoint <= 0x1f || codePoint === 0x7f) return true;
  }
  return false;
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
  if (ctx.secureRequest !== undefined) return ctx.secureRequest;
  const url = new URL(req.url);
  const forwardedProto = req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim().toLowerCase();
  return (
    url.protocol === "https:" || (ctx.trustForwardedProto === true && forwardedProto === "https")
  );
}

function effectiveConsoleOrigin(req: Request, ctx: AdminRouteContext): string {
  return ctx.requestOrigin ?? new URL(req.url).origin;
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
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
}

function isLoopbackIp(ip: string): boolean {
  const mapped = ip.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/i)?.[1] ?? ip;
  if (isIP(mapped) === 6) return mapped === "::1";
  return isIP(mapped) === 4 && mapped.split(".")[0] === "127";
}

function isInsecureLoopbackAllowed(ctx: AdminRouteContext): boolean {
  return ctx.allowInsecureLoopback ?? isLoopbackIp(ctx.callerIp);
}

function safeConsoleNextPath(next: string | null): string {
  if (!next) return "/console";
  try {
    if (
      next.includes("%") ||
      next.includes("\\") ||
      next.includes("?") ||
      next.includes("#") ||
      Array.from(next).some((character) => {
        const codePoint = character.codePointAt(0) ?? 0;
        return codePoint <= 0x1f || codePoint === 0x7f;
      })
    ) {
      return "/console";
    }
    const parsed = new URL(next, "https://console.auggy.invalid");
    if (parsed.origin !== "https://console.auggy.invalid" || parsed.pathname !== next) {
      return "/console";
    }
    if (next === "/console" || next.startsWith("/console/")) return next;
  } catch {
    // Fall through to the safe default.
  }
  return "/console";
}

function checkAuthenticationLimit(ctx: AdminRouteContext): Response | null {
  const limiter = ctx.authFailureLimiter ?? fallbackAuthFailureLimiter;
  const result = limiter.check(ctx.callerIp);
  return result.allowed ? null : authenticationRateLimitResponse(result.retryAfterSec);
}

function recordAuthenticationFailure(ctx: AdminRouteContext): void {
  const limiter = ctx.authFailureLimiter ?? fallbackAuthFailureLimiter;
  limiter.recordFailure(ctx.callerIp);
}

function authenticationRateLimitResponse(retryAfterSec = 1): Response {
  return new Response(JSON.stringify({ error: "too many authentication attempts" }), {
    status: 429,
    headers: {
      "content-type": "application/json",
      "retry-after": String(retryAfterSec),
      "cache-control": "no-store",
      "x-robots-tag": "noindex, nofollow",
    },
  });
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

// Re-export for callers (web-transport) that need to resolve dist on boot.
export { resolveDistDir } from "./admin-static";
