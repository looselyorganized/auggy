import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuiServer, type GuiServerOptions } from "../server";

let tempAuggyDir: string;
let tempAgentDir: string;
let mockAgent: ReturnType<typeof Bun.serve> | null = null;
let server: { stop: () => void; port: number } | null = null;

beforeEach(() => {
  tempAuggyDir = join(tmpdir(), `auggy-srv-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  tempAgentDir = join(tmpdir(), `agent-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tempAuggyDir, { recursive: true });
  mkdirSync(tempAgentDir, { recursive: true });
});

afterEach(() => {
  if (mockAgent) { mockAgent.stop(); mockAgent = null; }
  if (server) { server.stop(); server = null; }
  rmSync(tempAuggyDir, { recursive: true, force: true });
  rmSync(tempAgentDir, { recursive: true, force: true });
});

function nextPort() { return 19000 + Math.floor(Math.random() * 1000); }

function setupAgent(port: number, bearerToken: string, opts: { card?: object; runResponse?: string } = {}) {
  writeFileSync(join(tempAgentDir, ".env"), `WEB_BEARER_TOKEN=${bearerToken}\n`);
  writeFileSync(join(tempAuggyDir, "zip.json"), JSON.stringify({
    pid: process.pid, name: "zip", port,
    configPath: "/x", agentDir: tempAgentDir,
    startedAt: new Date().toISOString(), mode: "dev",
  }));
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify(opts.card ?? { name: "zip" }), {
          headers: { "content-type": "application/json" },
        });
      }
      if (url.pathname === "/agent/run") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${bearerToken}`) return new Response("unauth", { status: 401 });
        const body = opts.runResponse ?? `data: {"type":"RUN_STARTED"}\n\ndata: {"type":"RUN_FINISHED"}\n\n`;
        return new Response(body, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
}

async function bootServer(overrides: Partial<GuiServerOptions> = {}) {
  const port = nextPort();
  const s = createGuiServer({
    port,
    auggyDir: tempAuggyDir,
    ...overrides,
  });
  server = { stop: () => s.stop(), port };
  return port;
}

describe("Local GUI server", () => {
  it("GET /api/agents returns the agent list (no bearers in response)", async () => {
    const agentPort = nextPort();
    mockAgent = setupAgent(agentPort, "abc123", {
      card: { name: "zip", provider: { description: "z" }, skills: [{ name: "chat" }] },
    });
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/agents`, {
      headers: { origin: `http://localhost:${port}` },
    });
    expect(res.status).toBe(200);
    const body = await res.json() as { agents: any[] };
    expect(body.agents).toHaveLength(1);
    expect(body.agents[0].name).toBe("zip");
    expect(JSON.stringify(body)).not.toContain("abc123");
  });

  it("POST /api/chat/<id> proxies to agent with bearer attached", async () => {
    const agentPort = nextPort();
    mockAgent = setupAgent(agentPort, "secret", {
      runResponse: `data: {"type":"RUN_STARTED"}\n\ndata: {"type":"TEXT_MESSAGE_CONTENT","delta":"hi"}\n\ndata: {"type":"RUN_FINISHED"}\n\n`,
    });
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/chat/zip`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ message: "hello" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/event-stream");
    const text = await res.text();
    expect(text).toContain("RUN_STARTED");
    expect(text).toContain(`"delta":"hi"`);
    expect(text).toContain("RUN_FINISHED");
  });

  it("POST /api/chat/<id> with unknown agent returns 404", async () => {
    const port = await bootServer();
    const res = await fetch(`http://localhost:${port}/api/chat/nonexistent`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("POST /api/chat/<id> with no bearer in agent .env returns 412", async () => {
    const agentPort = nextPort();
    mockAgent = Bun.serve({ port: agentPort, fetch: () => new Response("ok") });
    writeFileSync(join(tempAuggyDir, "noenv.json"), JSON.stringify({
      pid: process.pid, name: "noenv", port: agentPort,
      configPath: "/x", agentDir: tempAgentDir,
      startedAt: "", mode: "dev",
    }));
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/chat/noenv`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${port}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(412);
  });

  it("rejects POST with cross-origin Origin header (403)", async () => {
    const agentPort = nextPort();
    mockAgent = setupAgent(agentPort, "x");
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/chat/zip`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with non-JSON content-type", async () => {
    const agentPort = nextPort();
    mockAgent = setupAgent(agentPort, "x");
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/chat/zip`, {
      method: "POST",
      headers: { "content-type": "text/plain", origin: `http://localhost:${port}` },
      body: "hello",
    });
    expect([400, 403, 415]).toContain(res.status);
  });

  it("GET /api/agents accepts no Origin (curl-style)", async () => {
    const port = await bootServer();
    const res = await fetch(`http://localhost:${port}/api/agents`);
    expect(res.status).toBe(200);
  });

  it("refuses to start if port is in use", async () => {
    const port = nextPort();
    const blocker = Bun.serve({ port, fetch: () => new Response("blocked") });
    try {
      let threw = false;
      try {
        const s = createGuiServer({ port, auggyDir: tempAuggyDir });
        s.stop();
      } catch {
        threw = true;
      }
      expect(threw).toBe(true);
    } finally {
      blocker.stop();
    }
  });

  it("serves static files at / from a build directory if provided", async () => {
    const distDir = join(tmpdir(), `dist-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(distDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html>hi</html>", "utf8");

    const port = await bootServer({ staticDir: distDir });
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { origin: `http://localhost:${port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");

    rmSync(distDir, { recursive: true, force: true });
  });
});
