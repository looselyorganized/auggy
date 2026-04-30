import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createGuiServer } from "../../server";

let tempAuggyDir: string;
let tempAgentDir: string;
let mockAgent: ReturnType<typeof Bun.serve> | null = null;
let server: { stop: () => void; port: number } | null = null;

beforeEach(() => {
  tempAuggyDir = mkdtempSync(join(tmpdir(), "auggy-int-"));
  tempAgentDir = mkdtempSync(join(tmpdir(), "agent-"));
});

afterEach(() => {
  if (mockAgent) { mockAgent.stop(); mockAgent = null; }
  if (server) { server.stop(); server = null; }
  rmSync(tempAuggyDir, { recursive: true, force: true });
  rmSync(tempAgentDir, { recursive: true, force: true });
});

function nextPort() { return 19500 + Math.floor(Math.random() * 500); }

function setupMockAgent(port: number, bearer: string) {
  writeFileSync(join(tempAgentDir, ".env"), `WEB_BEARER_TOKEN=${bearer}\n`);
  writeFileSync(join(tempAuggyDir, "tester.json"), JSON.stringify({
    pid: process.pid, name: "tester", port,
    configPath: "/x", agentDir: tempAgentDir,
    startedAt: new Date().toISOString(), mode: "dev",
  }));
  return Bun.serve({
    port,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/agent-card.json") {
        return new Response(JSON.stringify({
          name: "tester",
          provider: { description: "integration mock" },
          skills: [{ name: "chat" }],
        }), { headers: { "content-type": "application/json" } });
      }
      if (url.pathname === "/agent/run") {
        const auth = req.headers.get("authorization");
        if (auth !== `Bearer ${bearer}`) return new Response("unauth", { status: 401 });
        const sse =
          `data: {"type":"RUN_STARTED","threadId":"thr-1","runId":"run-1"}\n\n` +
          `data: {"type":"TEXT_MESSAGE_CONTENT","delta":"Hello"}\n\n` +
          `data: {"type":"TEXT_MESSAGE_CONTENT","delta":" world"}\n\n` +
          `data: {"type":"RUN_FINISHED","threadId":"thr-1","runId":"run-1"}\n\n`;
        return new Response(sse, { headers: { "content-type": "text/event-stream" } });
      }
      return new Response("nope", { status: 404 });
    },
  });
}

async function bootGui() {
  const port = nextPort();
  const s = createGuiServer({ port, auggyDir: tempAuggyDir });
  server = { stop: () => s.stop(), port };
  return port;
}

describe("Full chat flow integration", () => {
  it("end-to-end: discovery → agents list → chat → SSE events received", async () => {
    const agentPort = nextPort();
    mockAgent = setupMockAgent(agentPort, "secret-bearer");
    const guiPort = await bootGui();

    const agentsRes = await fetch(`http://localhost:${guiPort}/api/agents`, {
      headers: { origin: `http://localhost:${guiPort}` },
    });
    expect(agentsRes.status).toBe(200);
    const agentsBody = await agentsRes.json() as { agents: { id: string; name: string; status: string; description?: string }[] };
    expect(agentsBody.agents).toHaveLength(1);
    expect(agentsBody.agents[0]!.name).toBe("tester");
    expect(agentsBody.agents[0]!.status).toBe("online");

    const chatRes = await fetch(`http://localhost:${guiPort}/api/chat/tester`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${guiPort}` },
      body: JSON.stringify({ message: "ping", threadId: "thr-1" }),
    });
    expect(chatRes.status).toBe(200);
    expect(chatRes.headers.get("content-type")).toContain("text/event-stream");

    const text = await chatRes.text();
    expect(text).toContain(`"type":"RUN_STARTED"`);
    expect(text).toContain(`"delta":"Hello"`);
    expect(text).toContain(`"delta":" world"`);
    expect(text).toContain(`"type":"RUN_FINISHED"`);
  });

  it("rejects POST /api/chat with cross-origin Origin (CSRF guard)", async () => {
    const agentPort = nextPort();
    mockAgent = setupMockAgent(agentPort, "x");
    const guiPort = await bootGui();

    const res = await fetch(`http://localhost:${guiPort}/api/chat/tester`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "http://attacker.example.com" },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(403);
  });

  it("returns 404 when agent name is unknown", async () => {
    const guiPort = await bootGui();
    const res = await fetch(`http://localhost:${guiPort}/api/chat/ghost`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${guiPort}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 412 when agent has no bearer in .env", async () => {
    const agentPort = nextPort();
    writeFileSync(join(tempAuggyDir, "noenv.json"), JSON.stringify({
      pid: process.pid, name: "noenv", port: agentPort,
      configPath: "/x", agentDir: tempAgentDir,
      startedAt: "", mode: "dev",
    }));
    mockAgent = Bun.serve({ port: agentPort, fetch: () => new Response("ok") });
    const guiPort = await bootGui();

    const res = await fetch(`http://localhost:${guiPort}/api/chat/noenv`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: `http://localhost:${guiPort}` },
      body: JSON.stringify({ message: "x" }),
    });
    expect(res.status).toBe(412);
  });
});
