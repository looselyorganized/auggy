import type {
  Augment,
  PeerIdentity,
  TransportSpec,
  TransportKernel,
  TurnTrigger,
  InboundMessage,
  KernelEvent,
  Part,
} from "../types";
import {
  translateKernelEvent,
  serializeSSE,
  runFinished,
  runError,
  type AGUIEvent,
} from "./ag-ui-events";
import {
  deriveSigningKey,
  createVisitorToken,
  verifyVisitorToken,
  type VisitorTokenPayload,
} from "./visitor-token";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentAccessEntry {
  id: string;
  sharedSecret: string;
}

export interface WebTransportOptions {
  port: number;
  auth: { type: "bearer"; token: string };
  cors?: { origins: string[] };
  maxMessageLength?: number;
  /**
   * Admitted agent list. Each entry has an `id` (sent as `x-agent-id` header)
   * and a `sharedSecret` (sent as `x-agent-secret` header). The transport
   * does a timing-safe comparison before minting agent trust.
   */
  access?: { agents?: AgentAccessEntry[] };
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
  visitorTokens?: { enabled?: boolean; ttlSeconds?: number; signingKey?: string };
  /**
   * Optional URL to redirect GET / to. When set, `GET /` returns 302 to this URL.
   * When unset, `GET /` returns 404. All other routes are unaffected.
   *
   * Used by operators to point visitors arriving at the agent's bare URL toward
   * a polished frontend (LORF platform/chat, future spine visitor chat, custom).
   */
  publicFrontendUrl?: string;
}

interface AGUIRunRequestBody {
  messages: Array<{ role: string; content: string }>;
  threadId?: string;
  contextId?: string;
  taskId?: string;
}

// ---------------------------------------------------------------------------
// Idempotency-Key validation
// ---------------------------------------------------------------------------

const IDEMPOTENCY_KEY_RE = /^[A-Za-z0-9_-]{1,128}$/;

function validateIdempotencyKey(value: string): boolean {
  return IDEMPOTENCY_KEY_RE.test(value);
}

// ---------------------------------------------------------------------------
// Timing-safe string comparison (constant-time)
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();

/**
 * Timing-safe equality check for two strings. Returns true iff they are
 * byte-for-byte identical. Both inputs are encoded before comparison so
 * the comparison always runs over the full longer length.
 */
function timingSafeEqual(a: string, b: string): boolean {
  const ab = textEncoder.encode(a);
  const bb = textEncoder.encode(b);
  // If lengths differ, we still walk the full longer length so timing
  // doesn't leak whether the prefix matched.
  const len = Math.max(ab.length, bb.length);
  let diff = ab.length ^ bb.length; // non-zero if lengths differ
  for (let i = 0; i < len; i++) {
    diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  }
  return diff === 0;
}

/**
 * AG-UI-compatible HTTP transport.
 *
 * Endpoints:
 *  - POST /agent/run                   — AG-UI SSE endpoint
 *  - GET  /health                      — liveness check
 *  - GET  /.well-known/agent-card.json — Agent Card (via kernel.getAgentCard)
 *
 * ## Identity resolution — four paths (evaluated in order)
 *
 * Path 1 — Creator: bearer token matches `auth.token` AND no agent/visitor
 *   headers. Mints `{ trustLevel: "creator" }`.
 *
 * Path 2 — Agent: `x-agent-id` + `x-agent-secret` headers present. Looks
 *   up the agent in `opts.access.agents`; if the secret matches (timing-safe)
 *   mints `{ trustLevel: "agent" }`. Wrong secret → 401 (no silent downgrade).
 *
 * Path 3 — Public recognized: `x-visitor-token` with valid HMAC. Mints
 *   `{ trustLevel: "public", publicSubstate: "recognized" }`.
 *
 * Path 4 — Public anonymous: default. Mints
 *   `{ trustLevel: "public", publicSubstate: "anonymous" }`.
 *
 * ## Idempotency-Key
 *
 * When `Idempotency-Key` header is present, validated (1-128 chars,
 * `[A-Za-z0-9_-]`) and used as `turnId`. Absent → fresh UUID.
 * Malformed → HTTP 400.
 *
 * ## Rejected turns
 *
 * When the kernel rejects a turn with `errorClass: "cap-denied"`,
 * the SSE payload carries `code: "CAP_DENIED"`. For
 * `errorClass: "admission-state-failed"`, code is `"ADMISSION_FAILED"`.
 * HTTP status remains 200 for the SSE response in T4 — T5 will add the
 * synchronous gate-decision API that allows choosing 429/503 before
 * opening the stream.
 */
export function webTransport(opts: WebTransportOptions): Augment {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let kernel: TransportKernel | null = null;

  // PR γ.1 — augment-registered routes captured at register() time.
  // Empty until register fires; once populated, immutable for the server's lifetime.
  // Type matches TransportKernel.getAugmentRoutes(); runtime values are CollectedRoute
  // (which extends AugmentHttpRoute with augmentName) — we cast where needed.
  let augmentRoutes: readonly import("../types").AugmentHttpRoute[] = [];
  let augmentRouteMap: Map<string, import("../types").AugmentHttpRoute> = new Map();

  const maxMessageLength = opts.maxMessageLength ?? 4000;
  const visitorTokensEnabled = opts.visitorTokens?.enabled !== false;
  const visitorTokenTtl = opts.visitorTokens?.ttlSeconds ?? 30 * 24 * 3600;
  let signingKey: CryptoKey | null = null;

  // ---------------------------------------------------------------------------
  // Identity resolver — four paths
  // ---------------------------------------------------------------------------

  const identify = (raw: unknown): PeerIdentity | null => {
    const req = raw as {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __threadId?: string;
    };
    const headers = req.headers;
    const kind = (headers["x-peer-kind"] as PeerIdentity["kind"]) ?? "human";

    const agentId = headers["x-agent-id"];
    const agentSecret = headers["x-agent-secret"];
    const hasAgentHeaders = typeof agentId === "string" && typeof agentSecret === "string";

    // PATH 2: Agent credentials — present regardless of bearer auth.
    // If x-agent-id / x-agent-secret are both set, this is a deliberate
    // agent authentication attempt. A wrong secret MUST return null (→ 401),
    // not silently fall through to public.
    if (hasAgentHeaders) {
      const admittedAgents = opts.access?.agents ?? [];
      const entry = admittedAgents.find((a) => a.id === agentId);
      if (!entry || !timingSafeEqual(agentSecret, entry.sharedSecret)) {
        // Signal failed agent auth — the HTTP handler checks this sentinel.
        return null;
      }
      return {
        id: `agent:${agentId}`,
        kind: "agent",
        trustLevel: "agent",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 1: Creator — bearer-only request (no visitor token either).
    // The bearer token is already validated by the HTTP handler before identify()
    // is called. If there's no visitor token, this is a direct creator call.
    if (!req.__visitorPayload && !headers["x-visitor-token"]) {
      return {
        id: "creator",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 3: Public recognized — visitor token was verified before identify() is called.
    if (req.__visitorPayload) {
      return {
        id: req.__visitorPayload.visitorId,
        kind,
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
        displayName: headers["x-peer-name"],
        orgId: headers["x-org-id"],
      };
    }

    // PATH 4: Public anonymous — no agent headers, no verified visitor token.
    // Use the threadId from the request body (injected as __threadId) for the peer ID.
    const threadId = req.__threadId ?? crypto.randomUUID();
    return {
      id: `anon-${threadId}`,
      kind,
      trustLevel: "public",
      publicSubstate: "anonymous",
      sourceAugment: "web",
      displayName: headers["x-peer-name"],
      orgId: headers["x-org-id"],
    };
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel, _augmentName: string) {
      kernel = k;
      augmentRoutes = k.getAugmentRoutes();
      augmentRouteMap = new Map();
      for (const r of augmentRoutes) {
        augmentRouteMap.set(`${r.method} ${r.path}`, r);
        // Operator-visible audit: log every auth: "none" route so an operator
        // grepping the boot log can spot unauthenticated surfaces.
        // Runtime values are CollectedRoute (extends AugmentHttpRoute with augmentName).
        if (r.auth === "none") {
          const augmentName = (r as { augmentName?: string }).augmentName ?? "(unknown)";
          console.warn(
            `[web-transport] augment "${augmentName}" registered ${r.method} ${r.path} with auth: "none" — public, unauthenticated.`,
          );
        }
      }
    },
    identify,
    concurrency: opts.concurrency ?? 1,
    maxQueueDepth: opts.maxQueueDepth ?? 50,
    rateLimitPerPeer: opts.rateLimitPerPeer,
  };

  function isValidAuth(header: string): boolean {
    const expected = `Bearer ${opts.auth.token}`;
    // Use timing-safe comparison to prevent token extraction via timing side-channel.
    return timingSafeEqual(header, expected);
  }

  async function handleAgentRun(req: Request): Promise<Response> {
    const authHeader = req.headers.get("authorization") ?? "";
    if (!isValidAuth(authHeader)) {
      return json({ error: "unauthorized" }, 401);
    }

    // --- Idempotency-Key ---
    let turnId: string;
    const idempotencyKey = req.headers.get("idempotency-key");
    if (idempotencyKey !== null) {
      if (!validateIdempotencyKey(idempotencyKey)) {
        return json(
          {
            error: "invalid_idempotency_key",
            reason: "Idempotency-Key must be 1–128 characters matching [A-Za-z0-9_-]",
          },
          400,
        );
      }
      turnId = idempotencyKey;
    } else {
      turnId = crypto.randomUUID();
    }

    // --- Visitor token handling ---
    let visitorPayload: VisitorTokenPayload | null = null;
    let newToken: string | null = null;

    if (visitorTokensEnabled && signingKey) {
      const tokenHeader = req.headers.get("x-visitor-token");
      if (tokenHeader) {
        visitorPayload = await verifyVisitorToken(signingKey, tokenHeader);
      }
      if (!visitorPayload) {
        // Check if this looks like an agent auth attempt — don't issue visitor
        // tokens to agent-credential requests (they'll be resolved as agent/creator).
        const agentId = req.headers.get("x-agent-id");
        const agentSecret = req.headers.get("x-agent-secret");
        const hasAgentHeaders = agentId !== null && agentSecret !== null;
        const hasVisitorTokenAttempt = tokenHeader !== null;

        if (hasVisitorTokenAttempt && !hasAgentHeaders) {
          // Had a visitor token header but it was invalid or missing — mint a fresh
          // token to send in the response so the recipient has a valid token for their
          // NEXT request. Do NOT assign issued.payload to visitorPayload here: the
          // current request presented either no token or a bad one, so it stays
          // public:anonymous. The freshly-issued token is for future requests only.
          const agentName = kernel?.getAgentCard()?.provider?.name ?? "auggy";
          const issued = await createVisitorToken(signingKey, agentName, visitorTokenTtl);
          newToken = issued.token;
          // visitorPayload intentionally left null — this request is anonymous.
        }
        // hasAgentHeaders case: no visitor token for agent requests.
      }
    }

    // --- Build headers map ---
    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });

    // --- Parse body (needed for threadId for anonymous peer ID) ---
    let body: AGUIRunRequestBody;
    try {
      body = (await req.json()) as AGUIRunRequestBody;
    } catch {
      return json({ error: "invalid JSON body" }, 400);
    }
    if (!Array.isArray(body.messages) || body.messages.length === 0) {
      return json({ error: "messages array is required" }, 400);
    }

    const lastMessage = body.messages[body.messages.length - 1]!;
    const text = lastMessage.content ?? "";
    if (text.length > maxMessageLength) {
      return json({ error: "message too long", limit: maxMessageLength }, 413);
    }

    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }

    // Derive threadId — needed before identify() so anonymous peer IDs are stable.
    const threadId = body.threadId ?? body.contextId ?? crypto.randomUUID();

    // Build identify argument. Inject __threadId so the anonymous path can use it.
    const identifyArg: {
      headers: Record<string, string>;
      __visitorPayload?: VisitorTokenPayload;
      __threadId: string;
    } = { headers, __threadId: threadId };
    if (visitorPayload) {
      identifyArg.__visitorPayload = visitorPayload;
    }

    // --- Check agent auth failure explicitly ---
    // If x-agent-id + x-agent-secret are present, identify() returns null on bad secret.
    const agentIdHeader = req.headers.get("x-agent-id");
    const agentSecretHeader = req.headers.get("x-agent-secret");
    const isAgentAttempt = agentIdHeader !== null && agentSecretHeader !== null;

    const peer = identify(identifyArg);
    if (!peer) {
      if (isAgentAttempt) {
        // Explicit agent auth attempt with wrong credentials.
        return json({ error: "invalid agent credentials" }, 401);
      }
      // Fallback (should not happen with the four-path design, but guard).
      return json({ error: "missing peer identity" }, 400);
    }

    const parts: Part[] = [{ kind: "text", text }];
    const inbound: InboundMessage = {
      parts,
      sourceAugment: "web",
      peer,
      timestamp: Date.now(),
      contextId: body.contextId,
      taskId: body.taskId,
    };
    const trigger: TurnTrigger = {
      type: "message",
      turnId,
      threadId,
      contextId: body.contextId,
      taskId: body.taskId,
      timestamp: Date.now(),
      source: "web",
      peer,
      payload: inbound,
    };

    const k = kernel;
    const encoder = new TextEncoder();

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        let streamClosed = false;

        const patchThreadId = (e: AGUIEvent): AGUIEvent => {
          if (e.type === "RUN_FINISHED" && !e.threadId) {
            // Spread to preserve `result` (and any future fields) the
            // translator attaches; only the threadId needs patching.
            return { ...e, threadId };
          }
          return e;
        };

        const writeEvent = (e: AGUIEvent) => {
          if (streamClosed) return; // guard against enqueue after close
          try {
            controller.enqueue(encoder.encode(serializeSSE(patchThreadId(e))));
          } catch {
            // Stream already closed (client disconnect) — swallow
            streamClosed = true;
          }
        };

        const onEvent = (kernelEvent: KernelEvent) => {
          for (const e of translateKernelEvent(kernelEvent)) {
            writeEvent(e);
          }
        };

        (async () => {
          try {
            const result = await k.handleInbound(trigger, { onEvent });
            if (result.status === "rejected") {
              // Map errorClass to a structured code for SSE consumers.
              // T5 will refine this to return 429/503 HTTP status before
              // opening the stream (requires a synchronous gate-decision API).
              let code: string;
              if (result.errorClass === "cap-denied") {
                code = "CAP_DENIED";
              } else if (result.errorClass === "admission-state-failed") {
                code = "ADMISSION_FAILED";
              } else {
                code = "REJECTED";
              }
              writeEvent(
                runError({
                  message: result.errorResponse ?? "request rejected by transport",
                  code,
                }),
              );
              writeEvent(runFinished({ threadId, runId: trigger.turnId, status: result.status }));
            }
          } catch (err) {
            writeEvent(runError({ message: String(err), code: "INTERNAL" }));
            writeEvent(runFinished({ threadId, runId: trigger.turnId, status: "failed" }));
          } finally {
            streamClosed = true;
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          }
        })();
      },
    });

    const sseHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (newToken) {
      sseHeaders["x-visitor-token"] = newToken;
    }
    if (opts.cors) {
      sseHeaders["access-control-allow-origin"] = opts.cors.origins.join(",");
      sseHeaders["access-control-expose-headers"] = "x-visitor-token, idempotency-key";
    }
    return new Response(stream, { status: 200, headers: sseHeaders });
  }

  function handleCorsPreFlight(): Response {
    const headers: Record<string, string> = {
      "access-control-allow-methods": "GET, POST, OPTIONS",
      "access-control-allow-headers":
        "content-type, authorization, x-peer-id, x-peer-kind, x-peer-name, x-org-id, x-visitor-token, x-agent-id, x-agent-secret, idempotency-key",
      "access-control-expose-headers": "x-visitor-token, idempotency-key",
      "access-control-max-age": "86400",
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = opts.cors.origins.join(",");
    }
    return new Response(null, { status: 204, headers });
  }

  function handleHealth(): Response {
    return json({ status: "healthy" }, 200);
  }

  function handleAgentCard(): Response {
    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }
    return json(kernel.getAgentCard(), 200);
  }

  function json(body: unknown, status: number): Response {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (opts.cors) {
      headers["access-control-allow-origin"] = opts.cors.origins.join(",");
    }
    return new Response(JSON.stringify(body), { status, headers });
  }

  return {
    name: "web",
    capabilities: ["transport"],
    transport,
    async onBoot() {
      if (visitorTokensEnabled) {
        const keySource = opts.visitorTokens?.signingKey;
        if (keySource) {
          signingKey = await deriveSigningKey(keySource);
        } else {
          const ephemeral = crypto.randomUUID() + crypto.randomUUID();
          signingKey = await deriveSigningKey(ephemeral);
          console.warn(
            "[web-transport] No VISITOR_SIGNING_KEY configured — using ephemeral key. Visitor tokens will not survive agent restart. Set VISITOR_SIGNING_KEY in .env for persistent visitor identity.",
          );
        }
      }
      server = Bun.serve({
        port: opts.port,
        idleTimeout: 120, // 120s — covers long model calls + tool chains
        async fetch(req) {
          const url = new URL(req.url);

          // CORS preflight — required for browser-based AG-UI clients
          if (req.method === "OPTIONS") {
            return handleCorsPreFlight();
          }

          // GET / — optional redirect to operator-configured publicFrontendUrl
          if (req.method === "GET" && url.pathname === "/") {
            if (opts.publicFrontendUrl) {
              return Response.redirect(opts.publicFrontendUrl, 302);
            }
            return new Response("Not Found", { status: 404 });
          }

          if (req.method === "POST" && url.pathname === "/agent/run") {
            return handleAgentRun(req);
          }
          if (req.method === "GET" && url.pathname === "/health") {
            return handleHealth();
          }
          if (req.method === "GET" && url.pathname === "/.well-known/agent-card.json") {
            return handleAgentCard();
          }

          // PR γ.1 — augment-registered routes. Dispatched by exact (method, path).
          const augmentRoute = augmentRouteMap.get(`${req.method} ${url.pathname}`);
          if (augmentRoute) {
            if (augmentRoute.auth === "bearer") {
              const authHeader = req.headers.get("authorization") ?? "";
              if (!isValidAuth(authHeader)) {
                return new Response(JSON.stringify({ error: "unauthorized" }), {
                  status: 401,
                  headers: { "content-type": "application/json" },
                });
              }
            }
            // auth: "none" — no check; fall through to handler

            try {
              return await augmentRoute.handler(req);
            } catch (err) {
              const augmentName = (augmentRoute as { augmentName?: string }).augmentName ?? "unknown";
              console.error(
                `[web-transport] augment "${augmentName}" handler ${augmentRoute.method} ${augmentRoute.path} threw: ${(err as Error).message}`,
              );
              return new Response(JSON.stringify({ error: "internal" }), {
                status: 500,
                headers: { "content-type": "application/json" },
              });
            }
          }

          // Method-mismatch detection: if any registered augment route matches
          // the path but a different method, return 405 with Allow header.
          for (const r of augmentRoutes) {
            if (r.path === url.pathname && r.method !== req.method) {
              return new Response("Method Not Allowed", {
                status: 405,
                headers: { allow: r.method },
              });
            }
          }

          return new Response("Not Found", { status: 404 });
        },
      });
    },
    async onShutdown() {
      if (server) {
        server.stop();
        server = null;
      }
    },
  };
}
