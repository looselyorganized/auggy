import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createLocalPidSource } from "./src/adapters/local-pid-source";
import { extractBearerFromEnv } from "./src/lib/bearer";
import { validateCsrf } from "./src/lib/csrf";
import type { AgentRef } from "./src/adapters/types";

/**
 * Bun.serve on macOS can silently coexist with another listener bound to a
 * different interface on the same port (e.g. blocker on 0.0.0.0, ours on
 * 127.0.0.1) under BSD-socket address-tuple rules — meaning EADDRINUSE never
 * surfaces when we'd intuitively expect it to. Detect any conflict by first
 * probe-binding to 0.0.0.0 (the wildcard); if that throws, the port is taken
 * by something. The probe is closed before we open the real server.
 */
function preflightPortCheck(port: number): void {
  let probe: ReturnType<typeof Bun.serve> | null = null;
  try {
    probe = Bun.serve({ port, hostname: "0.0.0.0", fetch: () => new Response() });
  } catch (err) {
    throw new Error(`port ${port} is already in use: ${(err as Error).message}`);
  } finally {
    if (probe) {
      try { probe.stop(true); } catch { /* noop */ }
    }
  }
}

export interface GuiServerOptions {
  port: number;
  auggyDir?: string;
  staticDir?: string;
  cardFetchTimeoutMs?: number;
}

interface BearerEntry {
  port: number;
  agentDir: string;
  bearer: string | null;
}

export function createGuiServer(opts: GuiServerOptions) {
  const auggyDir = opts.auggyDir ?? join(homedir(), ".auggy");
  const staticDir = opts.staticDir;
  const port = opts.port;

  // Pre-flight: confirm the port is free before any state (fs.watch, polling)
  // is allocated. See preflightPortCheck for the BSD-socket reasoning.
  preflightPortCheck(port);

  const source = createLocalPidSource({
    auggyDir,
    cardFetchTimeoutMs: opts.cardFetchTimeoutMs,
  });

  // Bearer cache — keyed by agent name. Refreshed on /api/chat/<id> miss + on fs.watch.
  const bearerCache = new Map<string, BearerEntry>();

  function refreshBearerCache(refs: AgentRef[]) {
    bearerCache.clear();
    for (const r of refs) {
      const md = r.metadata as { port: number | null; agentDir: string };
      if (!md.port || !md.agentDir) continue;
      bearerCache.set(r.id, {
        port: md.port,
        agentDir: md.agentDir,
        bearer: extractBearerFromEnv(md.agentDir),
      });
    }
  }

  const unsubscribe = source.subscribe?.(async () => {
    const refs = await source.list();
    refreshBearerCache(refs);
  });

  function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  }

  function serveStatic(pathname: string): Response | null {
    if (!staticDir) return null;
    const filePath = pathname === "/" ? join(staticDir, "index.html") : join(staticDir, pathname);
    // Path traversal guard
    if (!filePath.startsWith(staticDir)) return new Response("forbidden", { status: 403 });
    if (!existsSync(filePath)) return null;
    if (!statSync(filePath).isFile()) return null;
    const content = readFileSync(filePath);
    const ext = filePath.split(".").pop()?.toLowerCase() ?? "";
    const contentType = (
      ext === "html" ? "text/html; charset=utf-8" :
      ext === "js" ? "application/javascript" :
      ext === "css" ? "text/css" :
      ext === "json" ? "application/json" :
      ext === "svg" ? "image/svg+xml" :
      "application/octet-stream"
    );
    return new Response(content, { headers: { "content-type": contentType } });
  }

  async function handleAgents(req: Request): Promise<Response> {
    const csrf = validateCsrf(req, port);
    if (!csrf.ok) return new Response(JSON.stringify({ error: csrf.reason }), { status: 403 });

    const refs = await source.list();
    refreshBearerCache(refs);
    // Strip metadata that may include bearer-adjacent info
    const safe = refs.map(r => ({
      id: r.id, name: r.name, description: r.description,
      capabilities: r.capabilities, status: r.status,
      metadata: { port: (r.metadata as { port: number | null }).port, status: r.status },
    }));
    return jsonResponse({ agents: safe });
  }

  async function handleChatProxy(req: Request, agentId: string): Promise<Response> {
    const csrf = validateCsrf(req, port);
    if (!csrf.ok) return new Response(JSON.stringify({ error: csrf.reason }), { status: 403 });

    let entry = bearerCache.get(agentId);
    if (!entry) {
      // Miss — refresh and retry once
      const refs = await source.list();
      refreshBearerCache(refs);
      entry = bearerCache.get(agentId);
    }
    if (!entry) return jsonResponse({ error: "agent not found" }, 404);
    if (!entry.bearer) {
      return jsonResponse({
        error: `no WEB_BEARER_TOKEN in ${entry.agentDir}/.env`,
        hint: "Add WEB_BEARER_TOKEN to the agent's .env and reload the picker.",
      }, 412);
    }

    let body: { message: string; threadId?: string };
    try {
      body = await req.json() as { message: string; threadId?: string };
    } catch {
      return jsonResponse({ error: "invalid JSON body" }, 400);
    }

    let upstream: Response;
    try {
      upstream = await fetch(`http://localhost:${entry.port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${entry.bearer}`,
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: body.message }],
          threadId: body.threadId,
        }),
      });
    } catch (err) {
      return jsonResponse({ error: `upstream connect failed: ${(err as Error).message}` }, 502);
    }

    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": "text/event-stream" },
    });
  }

  const server = Bun.serve({
    port,
    hostname: "127.0.0.1",
    async fetch(req: Request): Promise<Response> {
      const url = new URL(req.url);

      if (url.pathname === "/api/agents" && req.method === "GET") {
        return handleAgents(req);
      }
      if (url.pathname.startsWith("/api/chat/") && req.method === "POST") {
        const agentId = decodeURIComponent(url.pathname.slice("/api/chat/".length));
        return handleChatProxy(req, agentId);
      }

      if (req.method === "GET") {
        const csrf = validateCsrf(req, port);
        if (!csrf.ok) return new Response("forbidden", { status: 403 });
        const staticRes = serveStatic(url.pathname);
        if (staticRes) return staticRes;
        if (staticDir) {
          const fallback = serveStatic("/");
          if (fallback) return fallback;
        }
      }

      return new Response("Not Found", { status: 404 });
    },
  });

  return {
    port: server.port,
    stop() {
      try { unsubscribe?.(); } catch { /* swallow */ }
      server.stop();
    },
  };
}
