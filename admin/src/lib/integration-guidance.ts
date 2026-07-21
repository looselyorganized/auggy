import type { RouteManifestEntry, WebDashboardState } from "./types";

const DEFAULT_EXTERNAL_AUTH_HEADER = "x-auggy-auth-assertion";
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_EXTERNAL_AUTH_HEADERS = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
  "x-agent-id",
  "x-agent-secret",
  "x-auggy-console-internal",
  "x-org-id",
  "x-peer-id",
  "x-peer-kind",
  "x-peer-name",
  "x-visitor-token",
]);

type BrowserPosture = Pick<
  WebDashboardState,
  "allowAnonymous" | "visitorTokensEnabled" | "externalAuthEnabled" | "externalAuthHeader"
>;

export type BrowserConnectionMode =
  | "external-auth"
  | "visitor-token"
  | "anonymous"
  | "configuration-required";

export interface BrowserConnectionGuidance {
  endpoint: string;
  protocol: "AG-UI over SSE";
  mode: BrowserConnectionMode;
  ready: boolean;
  title: string;
  summary: string;
  typescript: string | null;
}

export interface ServerConnectionGuidance {
  endpoint: string;
  protocol: "AG-UI over SSE";
  title: string;
  summary: string;
  environmentVariable: "AUGGY_WEB_TOKEN";
  typescript: string;
  curl: string;
}

export type IntegrationSurface = "agent-conversation" | "app-route" | "runtime-health";

/**
 * Selects the safest browser posture the running agent currently supports.
 *
 * A visitor token is deliberately not selected when `allowAnonymous=false`:
 * `/agent/run` performs its initial access check before it reads that token.
 * External auth is the only browser-safe identity path that can cross that
 * gate without exposing the creator credential.
 */
export function selectBrowserConnection(
  origin: string,
  web: BrowserPosture,
): BrowserConnectionGuidance {
  const endpoint = endpointUrl(origin, "/agent/run");

  if (web.externalAuthEnabled === true) {
    const header = resolveExternalAuthHeader(web.externalAuthHeader);
    if (!header) {
      return {
        endpoint,
        protocol: "AG-UI over SSE",
        mode: "configuration-required",
        ready: false,
        title: "External auth header needs attention",
        summary:
          "The configured external-auth header is invalid or conflicts with another Auggy credential. Fix webTransport.config.externalAuth.header before connecting a browser application.",
        typescript: null,
      };
    }
    return {
      endpoint,
      protocol: "AG-UI over SSE",
      mode: "external-auth",
      ready: true,
      title: "Application identity",
      summary: `Send a short-lived assertion minted by your application server in ${header}.`,
      typescript: browserSnippet(endpoint, {
        kind: "external-auth",
        header,
      }),
    };
  }

  if (web.allowAnonymous.value === true && web.visitorTokensEnabled === true) {
    return {
      endpoint,
      protocol: "AG-UI over SSE",
      mode: "visitor-token",
      ready: true,
      title: "Persistent visitor identity",
      summary:
        "Start anonymously, then retain the rotated visitor token returned by the agent for later requests.",
      typescript: browserSnippet(endpoint, { kind: "visitor-token" }),
    };
  }

  if (web.allowAnonymous.value === true) {
    return {
      endpoint,
      protocol: "AG-UI over SSE",
      mode: "anonymous",
      ready: true,
      title: "Anonymous browser access",
      summary: "The browser can start a conversation, but it will not retain a verified identity.",
      typescript: browserSnippet(endpoint, { kind: "anonymous" }),
    };
  }

  return {
    endpoint,
    protocol: "AG-UI over SSE",
    mode: "configuration-required",
    ready: false,
    title: "Browser connection not configured",
    summary:
      web.visitorTokensEnabled === true
        ? "Visitor tokens cannot open /agent/run while anonymous access is disabled. Configure external auth for a browser application."
        : "Configure external auth, or explicitly enable anonymous access and visitor tokens, before connecting a browser application.",
    typescript: null,
  };
}

/** Builds the server-only contract. The secret is read at runtime, never embedded. */
export function selectServerConnection(origin: string): ServerConnectionGuidance {
  const endpoint = endpointUrl(origin, "/agent/run");
  return {
    endpoint,
    protocol: "AG-UI over SSE",
    title: "Trusted server connection",
    summary:
      "Call the conversation endpoint from trusted server code and keep the creator credential in the server environment.",
    environmentVariable: "AUGGY_WEB_TOKEN",
    typescript: serverSnippet(endpoint),
    curl: serverCurl(endpoint),
  };
}

/** Keeps generated app-route clients conceptually separate from AG-UI chat. */
export function classifyIntegrationPath(path: string): IntegrationSurface {
  if (path === "/agent/run") return "agent-conversation";
  if (path === "/health") return "runtime-health";
  return "app-route";
}

/** Custom routes safe to call directly from a browser under the current posture. */
export function isBrowserCallableAppRoute(
  route: Pick<RouteManifestEntry, "path" | "auth" | "policy">,
  web: BrowserPosture,
): boolean {
  if (classifyIntegrationPath(route.path) !== "app-route") return false;
  if (route.policy?.kind === "webhook.signature") return false;
  if (route.auth === "none" || route.auth === "visitor.optional") return true;
  if (route.auth === "visitor.required") {
    return web.visitorTokensEnabled === true || web.externalAuthEnabled === true;
  }
  return false;
}

/** Custom routes a trusted server can call with the configured creator credential. */
export function isServerCallableAppRoute(
  route: Pick<RouteManifestEntry, "path" | "auth" | "policy">,
): boolean {
  if (classifyIntegrationPath(route.path) !== "app-route") return false;
  if (route.policy?.kind === "webhook.signature") return false;
  return route.auth === "none" || route.auth === "bearer" || route.auth === "creator";
}

function endpointUrl(origin: string, path: string): string {
  const normalized = origin.trim().replace(/\/+$/, "");
  return normalized ? `${normalized}${path}` : path;
}

function resolveExternalAuthHeader(header: string | undefined): string | null {
  if (header === undefined) return DEFAULT_EXTERNAL_AUTH_HEADER;
  const normalized = header.trim().toLowerCase();
  if (!normalized || !HEADER_NAME.test(normalized)) return null;
  if (!normalized.startsWith("x-") || RESERVED_EXTERNAL_AUTH_HEADERS.has(normalized)) return null;
  return normalized;
}

type BrowserSnippetAuth =
  | { kind: "external-auth"; header: string }
  | { kind: "visitor-token" }
  | { kind: "anonymous" };

function browserSnippet(endpoint: string, auth: BrowserSnippetAuth): string {
  const setup =
    auth.kind === "external-auth"
      ? `  const assertion = await getAuggyAuthAssertion();\n  const headers: Record<string, string> = {\n    "content-type": "application/json",\n    ${JSON.stringify(auth.header)}: assertion,\n  };`
      : auth.kind === "visitor-token"
        ? `  const visitorToken = localStorage.getItem("auggy:visitor-token") ?? "bootstrap";\n  const headers: Record<string, string> = {\n    "content-type": "application/json",\n    "x-visitor-token": visitorToken,\n  };`
        : `  const headers: Record<string, string> = { "content-type": "application/json" };`;
  const rotate =
    auth.kind === "visitor-token"
      ? `\n  const rotatedToken = response.headers.get("x-visitor-token");\n  if (rotatedToken) localStorage.setItem("auggy:visitor-token", rotatedToken);`
      : "";

  return `${sseReaderSource()}

async function* streamAgentMessage(
  threadId: string,
  turnId: string,
  message: string,
  signal?: AbortSignal,
) {
${setup}
  headers["idempotency-key"] = turnId;
  const response = await fetch(${JSON.stringify(endpoint)}, {
    method: "POST",
    headers,
    body: JSON.stringify({ threadId, messages: [{ role: "user", content: message }] }),
    signal,
  });
  if (!response.ok) throw new Error(\`Agent request failed: \${response.status}\`);${rotate}
  yield* readAgentEvents(response);
}`;
}

function serverSnippet(endpoint: string): string {
  return `${sseReaderSource()}

async function* streamAgentMessage(
  threadId: string,
  turnId: string,
  message: string,
  signal?: AbortSignal,
) {
  const token = process.env.AUGGY_WEB_TOKEN;
  if (!token) throw new Error("AUGGY_WEB_TOKEN is not configured");
  const response = await fetch(${JSON.stringify(endpoint)}, {
    method: "POST",
    headers: {
      authorization: \`Bearer \${token}\`,
      "content-type": "application/json",
      "idempotency-key": turnId,
    },
    body: JSON.stringify({ threadId, messages: [{ role: "user", content: message }] }),
    signal,
  });
  if (!response.ok) throw new Error(\`Agent request failed: \${response.status}\`);
  yield* readAgentEvents(response);
}`;
}

function serverCurl(endpoint: string): string {
  return `: "\${AUGGY_WEB_TOKEN:?Set AUGGY_WEB_TOKEN in the server environment}"
curl --fail-with-body --silent --show-error -N ${shellSingleQuote(endpoint)} \\
  -H "Authorization: Bearer $AUGGY_WEB_TOKEN" \\
  -H 'Content-Type: application/json' \\
  -H 'Idempotency-Key: support-turn-123' \\
  --data '{"threadId":"support-123","messages":[{"role":"user","content":"What can you help with?"}]}'`;
}

function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function sseReaderSource(): string {
  return `async function* readAgentEvents(response: Response) {
  if (!response.body) throw new Error("Agent response has no stream");
  const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
  if (!contentType.includes("text/event-stream")) {
    throw new Error(\`Expected an event stream, received \${contentType || "no content type"}\`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
  let buffer = "";
  let runError: Error | null = null;
  try {
    while (true) {
      const { value = "", done } = await reader.read();
      buffer += value;
      let boundary = buffer.search(/\\r?\\n\\r?\\n/);
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        const separator = buffer.slice(boundary).match(/^\\r?\\n\\r?\\n/)?.[0] ?? "\\n\\n";
        buffer = buffer.slice(boundary + separator.length);
        const event = frame.match(/^event:\\s*(.*)$/m)?.[1] ?? "message";
        const data = frame
          .split(/\\r?\\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trimStart())
          .join("\\n");
        if (data) {
          const payload = JSON.parse(data);
          if (payload.type === "RUN_ERROR") {
            runError = new Error(payload.message || "Agent run failed");
          }
          yield { event, data: payload };
          if (payload.type === "RUN_FINISHED") {
            if (runError) throw runError;
            return;
          }
        }
        boundary = buffer.search(/\\r?\\n\\r?\\n/);
      }
      if (done) break;
    }
    if (runError) throw runError;
    throw new Error("Agent stream ended before RUN_FINISHED");
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}`;
}
