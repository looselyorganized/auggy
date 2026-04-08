import type {
  Augment,
  PeerIdentity,
  TransportSpec,
  TransportKernel,
  TrustLevel,
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

export interface WebTransportOptions {
  port: number;
  auth: { type: "bearer"; token: string };
  cors?: { origins: string[] };
  maxMessageLength?: number;
  trustLevel?: TrustLevel;
  concurrency?: number;
  maxQueueDepth?: number;
  rateLimitPerPeer?: { maxPerMinute: number };
}

interface AGUIRunRequestBody {
  messages: Array<{ role: string; content: string }>;
  threadId?: string;
  contextId?: string;
  taskId?: string;
}

/**
 * AG-UI-compatible HTTP transport.
 *
 * Endpoints:
 *  - POST /agent/run                   — AG-UI SSE endpoint
 *  - GET  /health                      — liveness check
 *  - GET  /.well-known/agent-card.json — Agent Card (via kernel.getAgentCard)
 *
 * The transport emits AG-UI events (RUN_STARTED, TEXT_MESSAGE_*,
 * TOOL_CALL_*, RUN_FINISHED, RUN_ERROR) as the kernel progresses
 * through the turn. Events are written to a ReadableStream as they
 * arrive from the kernel's onEvent callback — clients receive each
 * frame with real kernel latency, not after the whole turn finishes.
 *
 * Rejected turns (rate limit, queue depth) never produce kernel
 * events, so this transport synthesizes a RUN_ERROR + RUN_FINISHED
 * pair from the returned TurnResult.status === "rejected" so clients
 * always see a terminal event.
 *
 * V1 limitations:
 *  - No token-level streaming (text messages arrive as one chunk)
 *  - No state sync, reasoning, activity, or generative UI events
 *  - Simplified request body (not full AG-UI RunAgentInput)
 *  - No cancellation handling from the client side yet
 */
export function webTransport(opts: WebTransportOptions): Augment {
  let server: ReturnType<typeof Bun.serve> | null = null;
  let kernel: TransportKernel | null = null;

  const maxMessageLength = opts.maxMessageLength ?? 4000;

  const identify = (raw: unknown): PeerIdentity | null => {
    const req = raw as { headers: Record<string, string> };
    const peerId = req.headers["x-peer-id"];
    if (!peerId) return null;
    const kind =
      (req.headers["x-peer-kind"] as PeerIdentity["kind"]) ?? "human";
    return {
      id: peerId,
      kind,
      trustLevel: opts.trustLevel ?? "authenticated",
      sourceAugment: "web",
      displayName: req.headers["x-peer-name"],
      orgId: req.headers["x-org-id"],
    };
  };

  const transport: TransportSpec = {
    async register(k: TransportKernel) {
      kernel = k;
    },
    identify,
    concurrency: opts.concurrency ?? 1,
    maxQueueDepth: opts.maxQueueDepth ?? 50,
    rateLimitPerPeer: opts.rateLimitPerPeer,
  };

  async function handleAgentRun(req: Request): Promise<Response> {
    const authHeader = req.headers.get("authorization") ?? "";
    if (authHeader !== `Bearer ${opts.auth.token}`) {
      return json({ error: "unauthorized" }, 401);
    }

    const headers: Record<string, string> = {};
    req.headers.forEach((v, k) => {
      headers[k.toLowerCase()] = v;
    });
    const peer = identify({ headers });
    if (!peer) {
      return json({ error: "missing peer identity" }, 400);
    }

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
      return json(
        { error: "message too long", limit: maxMessageLength },
        413,
      );
    }

    if (!kernel) {
      return json({ error: "transport not registered" }, 500);
    }

    const threadId = body.threadId ?? body.contextId ?? crypto.randomUUID();
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
      turnId: crypto.randomUUID(),
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
        const patchThreadId = (e: AGUIEvent): AGUIEvent => {
          // Kernel emits RUN_FINISHED with an empty threadId — the
          // transport layer is authoritative for threadId, so patch
          // it here before sending to the client.
          if (e.type === "RUN_FINISHED" && !e.threadId) {
            return runFinished({ threadId, runId: trigger.turnId });
          }
          return e;
        };

        const writeEvent = (e: AGUIEvent) => {
          controller.enqueue(encoder.encode(serializeSSE(patchThreadId(e))));
        };

        const onEvent = (kernelEvent: KernelEvent) => {
          for (const e of translateKernelEvent(kernelEvent)) {
            writeEvent(e);
          }
        };

        // Run the kernel and stream events as they arrive. Any exception
        // or queue-rejected status becomes a synthetic RUN_ERROR +
        // RUN_FINISHED pair so the client always sees a terminal event.
        (async () => {
          try {
            const result = await k.handleInbound(trigger, { onEvent });
            if (result.status === "rejected") {
              writeEvent(
                runError({
                  message:
                    result.errorResponse ?? "request rejected by transport",
                  code: "REJECTED",
                }),
              );
              writeEvent(
                runFinished({ threadId, runId: trigger.turnId }),
              );
            }
          } catch (err) {
            writeEvent(
              runError({ message: String(err), code: "INTERNAL" }),
            );
            writeEvent(runFinished({ threadId, runId: trigger.turnId }));
          } finally {
            controller.close();
          }
        })();
      },
    });

    const sseHeaders: Record<string, string> = {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      connection: "keep-alive",
    };
    if (opts.cors) {
      sseHeaders["access-control-allow-origin"] = opts.cors.origins.join(",");
    }
    return new Response(stream, { status: 200, headers: sseHeaders });
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
      server = Bun.serve({
        port: opts.port,
        async fetch(req) {
          const url = new URL(req.url);
          if (req.method === "POST" && url.pathname === "/agent/run") {
            return handleAgentRun(req);
          }
          if (req.method === "GET" && url.pathname === "/health") {
            return handleHealth();
          }
          if (
            req.method === "GET" &&
            url.pathname === "/.well-known/agent-card.json"
          ) {
            return handleAgentCard();
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
