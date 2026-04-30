import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalPidSource } from "../../src/adapters/local-pid-source";

let tempDir: string;
let mockServer: ReturnType<typeof Bun.serve> | null = null;

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-pidsrc-"));
});

afterEach(() => {
  if (mockServer) { mockServer.stop(); mockServer = null; }
  rmSync(tempDir, { recursive: true, force: true });
});

function writeManifest(name: string, m: Record<string, unknown>) {
  writeFileSync(join(tempDir, `${name}.json`), JSON.stringify(m), "utf8");
}

function bootMockAgent(port: number, card: object | null = null) {
  return Bun.serve({
    port,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/.well-known/agent-card.json") {
        if (card === null) return new Response("not found", { status: 404 });
        return new Response(JSON.stringify(card), {
          headers: { "content-type": "application/json" },
        });
      }
      return new Response("ok");
    },
  });
}

function nextPort() { return 19000 + Math.floor(Math.random() * 1000); }

describe("createLocalPidSource", () => {
  it("returns empty when no manifests exist", async () => {
    const src = createLocalPidSource({ auggyDir: tempDir });
    expect(await src.list()).toEqual([]);
  });

  it("returns one online agent for live PID + reachable port + AgentCard", async () => {
    const port = nextPort();
    mockServer = bootMockAgent(port, {
      name: "zip",
      provider: { description: "front-door" },
      skills: [{ name: "chat" }],
    });
    writeManifest("zip", {
      pid: process.pid, name: "zip", port, configPath: "/x", agentDir: "/x",
      startedAt: new Date().toISOString(), mode: "dev",
    });

    const refs = await createLocalPidSource({ auggyDir: tempDir }).list();
    expect(refs).toHaveLength(1);
    expect(refs[0]!.id).toBe("zip");
    expect(refs[0]!.status).toBe("online");
    expect(refs[0]!.description).toBe("front-door");
    expect(refs[0]!.capabilities).toEqual(["chat"]);
  });

  it("marks offline when PID is dead", async () => {
    writeManifest("dead", {
      pid: 999999, name: "dead", port: 8081, configPath: "/", agentDir: "/",
      startedAt: "", mode: "dev",
    });
    const refs = await createLocalPidSource({ auggyDir: tempDir }).list();
    expect(refs[0]!.status).toBe("offline");
  });

  it("marks offline when port is unreachable", async () => {
    writeManifest("unreachable", {
      pid: process.pid, name: "unreachable", port: 19999, configPath: "/", agentDir: "/",
      startedAt: "", mode: "dev",
    });
    const refs = await createLocalPidSource({ auggyDir: tempDir, cardFetchTimeoutMs: 200 }).list();
    expect(refs[0]!.status).toBe("offline");
  });

  it("returns multiple agents with mixed status", async () => {
    const port = nextPort();
    mockServer = bootMockAgent(port, { name: "a" });
    writeManifest("a", { pid: process.pid, name: "a", port, configPath: "/", agentDir: "/", startedAt: "", mode: "dev" });
    writeManifest("b", { pid: 999999, name: "b", port: 8082, configPath: "/", agentDir: "/", startedAt: "", mode: "dev" });

    const refs = await createLocalPidSource({ auggyDir: tempDir }).list();
    expect(refs).toHaveLength(2);
    const byId = new Map(refs.map(r => [r.id, r]));
    expect(byId.get("a")!.status).toBe("online");
    expect(byId.get("b")!.status).toBe("offline");
  });

  it("ignores non-JSON files", async () => {
    writeFileSync(join(tempDir, "notes.txt"), "junk");
    const refs = await createLocalPidSource({ auggyDir: tempDir }).list();
    expect(refs).toEqual([]);
  });

  it("tolerates malformed manifest JSON", async () => {
    writeFileSync(join(tempDir, "broken.json"), "{not json");
    const port = nextPort();
    mockServer = bootMockAgent(port, { name: "a" });
    writeManifest("a", { pid: process.pid, name: "a", port, configPath: "/", agentDir: "/", startedAt: "", mode: "dev" });

    const refs = await createLocalPidSource({ auggyDir: tempDir }).list();
    expect(refs).toHaveLength(1);
  });

  it("has label 'Local agents' and order 0", () => {
    const src = createLocalPidSource({ auggyDir: tempDir });
    expect(src.label).toBe("Local agents");
    expect(src.order).toBe(0);
  });

  it("subscribe() invokes onChange when manifest is added", async () => {
    const src = createLocalPidSource({ auggyDir: tempDir, pollIntervalMs: 50 });
    let calls = 0;
    const unsub = src.subscribe!(() => { calls++; });

    writeManifest("new", { pid: process.pid, name: "new", port: 8083, configPath: "/", agentDir: "/", startedAt: "", mode: "dev" });
    await new Promise(r => setTimeout(r, 200));
    unsub();
    expect(calls).toBeGreaterThan(0);
  });
});
