import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join, basename } from "node:path";
import { tmpdir } from "node:os";
import { createConnection } from "node:net";
import { createGuiServer, type GuiServerOptions } from "../server";

let tempAuggyDir: string;
let tempAgentDir: string;
let mockAgent: ReturnType<typeof Bun.serve> | null = null;
let server: { stop: () => void; port: number } | null = null;

beforeEach(() => {
  // mkdtempSync — kernel-generated suffix; writes inside are not flagged by
  // CodeQL js/insecure-temporary-file.
  tempAuggyDir = mkdtempSync(join(tmpdir(), "auggy-srv-"));
  tempAgentDir = mkdtempSync(join(tmpdir(), "agent-"));
});

afterEach(() => {
  if (mockAgent) { mockAgent.stop(); mockAgent = null; }
  if (server) { server.stop(); server = null; }
  rmSync(tempAuggyDir, { recursive: true, force: true });
  rmSync(tempAgentDir, { recursive: true, force: true });
});

// Port allocation: use port: 0 (OS-assigned) for all helpers and read the
// bound port back. Avoids the random-port-collision flake. The deliberate
// "refuses to start if port is in use" test below allocates a fixed-port
// blocker via port: 0 + readback to coordinate the conflict reliably.

function setupAgent(bearerToken: string, opts: { card?: object; runResponse?: string } = {}) {
  writeFileSync(join(tempAgentDir, ".env"), `AUGGY_WEB_TOKEN=${bearerToken}\n`);
  const handle = Bun.serve({
    port: 0,
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
  // Write manifest with the OS-assigned port AFTER bind succeeds.
  writeFileSync(join(tempAuggyDir, "zip.json"), JSON.stringify({
    pid: process.pid, name: "zip", port: handle.port,
    configPath: "/x", agentDir: tempAgentDir,
    startedAt: new Date().toISOString(), mode: "dev",
  }));
  return handle;
}

async function bootServer(overrides: Partial<GuiServerOptions> = {}) {
  const s = createGuiServer({
    port: 0,
    auggyDir: tempAuggyDir,
    ...overrides,
  });
  server = { stop: () => s.stop(), port: s.port };
  return s.port;
}

describe("Local GUI server", () => {
  it("GET /api/agents returns the agent list (no bearers in response)", async () => {
    mockAgent = setupAgent("abc123", {
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
    mockAgent = setupAgent("secret", {
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
    mockAgent = Bun.serve({ port: 0, fetch: () => new Response("ok") });
    writeFileSync(join(tempAuggyDir, "noenv.json"), JSON.stringify({
      pid: process.pid, name: "noenv", port: mockAgent.port,
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
    mockAgent = setupAgent("x");
    const port = await bootServer();

    const res = await fetch(`http://localhost:${port}/api/chat/zip`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://evil.example.com" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("rejects POST with non-JSON content-type", async () => {
    mockAgent = setupAgent("x");
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
    // Allocate the blocker on an OS-assigned port so we get a guaranteed-bound
    // port to deliberately collide on (no random-port flake).
    const blocker = Bun.serve({ port: 0, fetch: () => new Response("blocked") });
    const conflictPort = blocker.port;
    if (conflictPort === undefined) throw new Error("blocker did not bind a port");
    try {
      let threw = false;
      try {
        const s = createGuiServer({ port: conflictPort, auggyDir: tempAuggyDir });
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
    const distDir = mkdtempSync(join(tmpdir(), "dist-"));
    writeFileSync(join(distDir, "index.html"), "<html>hi</html>", "utf8");

    const port = await bootServer({ staticDir: distDir });
    const res = await fetch(`http://localhost:${port}/`, {
      headers: { origin: `http://localhost:${port}` },
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("hi");

    rmSync(distDir, { recursive: true, force: true });
  });

  it("does not leak files from a sibling directory whose name string-prefixes staticDir", async () => {
    // End-to-end safety property: with staticDir = "/tmp/dist-<id>" and a
    // sibling = "/tmp/dist-<id>-evil", a request that tries to escape the
    // staticDir boundary must NEVER return the sibling's contents.
    //
    // Defense in depth comes from two layers: (1) Bun.serve normalizes "/.."
    // and "%2e%2e" in URL pathnames before our handler sees them, so the
    // attack can't reach serveStatic via HTTP; (2) our serveStatic guard
    // appends the platform separator to staticDir before the prefix check,
    // so even if a future code path passed a non-normalized pathname through,
    // the sibling-prefix collision (sibling absolute path string-starts-with
    // staticDir but isn't actually inside it) wouldn't pass.
    //
    // We exercise (1) here via raw TCP (fetch() also normalizes URLs client
    // side, so we can't even put "/.." on the wire with fetch). Both encoded
    // and dot-segment forms are tried.
    // Allocate an unpredictable holder under tmpdir, then create the two
    // siblings inside it — sibling-prefix relationship preserved (basename of
    // evilDir starts with basename of distDir) but the parent is randomly
    // named, so writes inside the holder don't trip CodeQL.
    const holder = mkdtempSync(join(tmpdir(), "trav-"));
    const distDir = join(holder, "dist");
    const evilDir = join(holder, "dist-evil");
    mkdirSync(distDir, { recursive: true });
    mkdirSync(evilDir, { recursive: true });
    writeFileSync(join(distDir, "index.html"), "<html>safe</html>", "utf8");
    writeFileSync(join(evilDir, "leak.txt"), "SECRET-MARKER-9F2A", "utf8");

    const port = await bootServer({ staticDir: distDir });

    async function rawGet(path: string): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        const sock = createConnection({ host: "127.0.0.1", port }, () => {
          sock.write(
            `GET ${path} HTTP/1.1\r\n` +
            `Host: localhost:${port}\r\n` +
            `Origin: http://localhost:${port}\r\n` +
            `Connection: close\r\n\r\n`,
          );
        });
        const chunks: Buffer[] = [];
        sock.on("data", c => chunks.push(c as Buffer));
        sock.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
        sock.on("error", reject);
      });
    }

    const sibling = basename(evilDir);
    const probes = [
      `/../${sibling}/leak.txt`,
      `/%2e%2e/${sibling}/leak.txt`,
      `/foo/../../${sibling}/leak.txt`,
    ];

    for (const probe of probes) {
      const body = await rawGet(probe);
      expect(body).not.toContain("SECRET-MARKER-9F2A");
    }

    rmSync(holder, { recursive: true, force: true });
  });
});
