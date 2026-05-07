import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { defineAgent, fileMemory, supabaseMemory, webTransport } from "@/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createMockSupabase } from "@tests/fixtures/mock-supabase";
import { createTempDir } from "@tests/fixtures/temp-dir";
import { routeFixtureAugment } from "@tests/fixtures/route-fixture-augment";

/**
 * End-to-end smoke test that wires the public API the way a real
 * deployment would: a model, an identity fileMemory, an episodic
 * supabaseMemory, and an AG-UI webTransport — then exercises the HTTP
 * surface (agent card, health, SSE run).
 */
describe("full agent integration", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    await tmp.cleanup();
  });

  it("serves an AG-UI turn end-to-end with identity + episodic memory wired up", async () => {
    // --- identity memory (static) ---
    const soulPath = join(tmp.path, "zip.md");
    await writeFile(soulPath, "You are Zip, the LORF front-door agent. Be concise.", "utf-8");
    const identity = fileMemory({
      label: "self",
      source: soulPath,
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });

    // --- episodic memory (namespace) ---
    const supabase = createMockSupabase();
    await supabase.from("agent_memories").insert({
      label: "episode:2026-04-07-001",
      content: "visitor asked about the facility's open hours",
      created_at: "2026-04-07T09:00:00Z",
    });
    const episodic = supabaseMemory({
      namespace: "episode",
      client: supabase,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    // --- AG-UI transport ---
    const port = 18950;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: "integration-token" },
    });

    // --- model: one plain response ---
    const model = createMockModel({
      response: "Zip here. We're open.",
    });

    // --- agent ---
    const agent = defineAgent(
      {
        name: "zip",
        purpose: "LORF front-door agent",
        model: "mock",
        augments: [identity, episodic, transport],
      },
      model,
    );

    await agent.start();

    try {
      // --- agent card is served from the config ---
      const cardResp = await fetch(`http://localhost:${port}/.well-known/agent-card.json`);
      expect(cardResp.status).toBe(200);
      const card = (await cardResp.json()) as {
        provider: { name: string };
        purpose: string;
        capabilities: { transport: boolean; memory: boolean };
        skills: Array<{ name: string }>;
      };
      expect(card.provider.name).toBe("zip");
      expect(card.purpose).toBe("LORF front-door agent");
      expect(card.capabilities.transport).toBe(true);
      expect(card.capabilities.memory).toBe(true);
      // The memory bus should have mounted the 4 generic memory tools
      const toolNames = card.skills.map((s) => s.name);
      expect(toolNames).toContain("memory_read");
      expect(toolNames).toContain("memory_write");
      expect(toolNames).toContain("memory_search");
      expect(toolNames).toContain("memory_list");

      // --- health check ---
      const healthResp = await fetch(`http://localhost:${port}/health`);
      expect(healthResp.status).toBe(200);

      // --- AG-UI SSE run ---
      const runResp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer integration-token",
          "x-peer-id": "visitor-001",
          "x-peer-kind": "human",
          "x-peer-name": "Anonymous Visitor",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "are you open today?" }],
        }),
      });
      expect(runResp.status).toBe(200);
      expect(runResp.headers.get("content-type")).toContain("text/event-stream");

      const body = await runResp.text();
      const events = body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length))) as Array<{
        type: string;
        delta?: string;
        threadId?: string;
      }>;

      const types = events.map((e) => e.type);
      expect(types).toContain("RUN_STARTED");
      expect(types).toContain("TEXT_MESSAGE_START");
      expect(types).toContain("TEXT_MESSAGE_CONTENT");
      expect(types).toContain("TEXT_MESSAGE_END");
      expect(types).toContain("RUN_FINISHED");

      // Model response is delivered as the TEXT_MESSAGE_CONTENT delta
      const content = events.find((e) => e.type === "TEXT_MESSAGE_CONTENT");
      expect(content?.delta).toBe("Zip here. We're open.");

      // RUN_FINISHED must carry the threadId the transport minted
      const finished = events.find((e) => e.type === "RUN_FINISHED");
      expect(typeof finished?.threadId).toBe("string");
      expect(finished?.threadId?.length).toBeGreaterThan(0);

      // --- identity context actually reached the model ---
      expect(model.calls.length).toBeGreaterThan(0);
      const firstPrompt = model.calls[0]!;
      const systemText = firstPrompt.systemBlocks.join("\n");
      expect(systemText).toContain("You are Zip, the LORF front-door agent.");

      // --- episodic memory search ran on this turn ---
      // The mock's ILIKE is substring-only and the user's message shares
      // no tokens with the seeded row, so no results come back. We cover
      // the positive retrieval path in the next test — here we only need
      // the run to have completed without errors (which the assertions
      // above already established).
    } finally {
      await agent.stop();
    }
  });

  it("retrieves episodic memory and places it in the model's contextBlocks", async () => {
    // --- identity memory (static) ---
    const soulPath = join(tmp.path, "zip.md");
    await writeFile(soulPath, "You are Zip.", "utf-8");
    const identity = fileMemory({
      label: "self",
      source: soulPath,
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });

    // --- episodic memory seeded with a row that the user's message will
    //     substring-match against. The mock's ILIKE implementation does
    //     `content.toLowerCase().includes(query.toLowerCase())`, so we
    //     seed a row whose content contains the exact query phrase. ---
    const supabase = createMockSupabase();
    await supabase.from("agent_memories").insert({
      label: "episode:2026-04-01-001",
      content: "visitor asked about coffee brewing setup in the facility kitchen",
      created_at: "2026-04-01T09:00:00Z",
    });
    const episodic = supabaseMemory({
      namespace: "episode",
      client: supabase,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    // --- transport ---
    const port = 18951;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: "integration-token" },
    });

    const model = createMockModel({ response: "Noted." });

    const agent = defineAgent(
      {
        name: "zip",
        purpose: "LORF front-door agent",
        model: "mock",
        augments: [identity, episodic, transport],
      },
      model,
    );
    await agent.start();

    try {
      // User message is a substring of the seeded row's content.
      const runResp = await fetch(`http://localhost:${port}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: "Bearer integration-token",
          "x-peer-id": "visitor-002",
        },
        body: JSON.stringify({
          messages: [{ role: "user", content: "coffee brewing" }],
        }),
      });
      expect(runResp.status).toBe(200);
      // Drain the SSE stream so the turn completes.
      await runResp.text();

      // The end-to-end proof: the seeded episodic row's content should
      // appear in the model's contextBlocks. This only passes if the
      // whole chain holds: search() was called with the user's text,
      // returned entries, synthesizeContextFor wrapped them as
      // ContextBlocks, and the allocator routed them to contextBlocks
      // (because the provider's placement is "preamble").
      expect(model.calls.length).toBeGreaterThan(0);
      const prompt = model.calls[0]!;
      const contextText = prompt.contextBlocks.join("\n");
      expect(contextText).toContain("coffee brewing setup");
    } finally {
      await agent.stop();
    }
  });
});

describe("full-agent: augment HTTP route extension", () => {
  it("bound webTransport serves a fixture augment route end-to-end", async () => {
    const model = createMockModel();
    const port = 19500;
    const agent = defineAgent(
      {
        name: "route-test",
        model: "mock",
        augments: [
          routeFixtureAugment({ auth: "none" }),
          webTransport({ port, auth: { type: "bearer", token: "t" } }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const res = await fetch(`http://localhost:${port}/test/echo?msg=integration`);
      expect(res.status).toBe(200);
      const body = (await res.json()) as { echo: string };
      expect(body.echo).toBe("integration");
    } finally {
      await agent.stop();
    }
  });

  it("agent.start() rejects when two augments register the same route", async () => {
    const model = createMockModel();
    const port = 19501;
    const agent = defineAgent(
      {
        name: "collision",
        model: "mock",
        augments: [
          routeFixtureAugment({ name: "a", path: "/dup" }),
          routeFixtureAugment({ name: "b", path: "/dup" }),
          webTransport({ port, auth: { type: "bearer", token: "t" } }),
        ],
      },
      model,
    );

    await expect(agent.start()).rejects.toThrow(/both registered HTTP route/);

    // Verify the port did NOT bind — a follow-up agent on the same port
    // should succeed without "address in use" errors. This proves
    // collision-throw runs lifecycle.shutdown() and releases the port.
    const followup = defineAgent(
      {
        name: "ok",
        model: "mock",
        augments: [webTransport({ port, auth: { type: "bearer", token: "t" } })],
      },
      model,
    );
    await followup.start();
    await followup.stop();
  });
});
