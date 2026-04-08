import { describe, it, expect } from "bun:test";
import { supabaseMemory } from "@/augments/supabase-memory";
import { createMockSupabase } from "@tests/fixtures/mock-supabase";
import type { NamespaceMemoryProvider } from "@/types";

describe("supabaseMemory", () => {
  it("declares namespace ownership with configured prefix", () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    expect(aug.memory!.owns).toEqual({
      kind: "namespace",
      prefix: "episode:",
    });
  });

  it("search() returns entries with label matching the query", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      label: "episode:2026-04-08-001",
      content: "visitor asked about coffee",
      created_at: "2026-04-08T10:00:00Z",
    });
    await client.from("agent_memories").insert({
      label: "episode:2026-04-08-002",
      content: "visitor asked about weather",
      created_at: "2026-04-08T11:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("coffee");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("coffee");
  });

  it("search() does not leak rows from other namespaces that share the table", async () => {
    const client = createMockSupabase();
    // Seed rows from two different namespaces, both mentioning "coffee"
    await client.from("agent_memories").insert({
      label: "episode:2026-04-08-001",
      content: "visitor mentioned coffee",
      created_at: "2026-04-08T10:00:00Z",
    });
    await client.from("agent_memories").insert({
      label: "other:999",
      content: "different namespace also mentions coffee",
      created_at: "2026-04-08T11:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("coffee");
    // Must only return the episode: row, never the other: row.
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("episode:2026-04-08-001");
  });

  it("write() inserts a new row with the correct label", async () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    await aug.memory!.write!("episode:test-1", "new memory");

    const stored = client._rows.get("agent_memories")!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.label).toBe("episode:test-1");
    expect(stored[0]!.content).toBe("new memory");
  });

  it("omits write when mutable: false", () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    expect(aug.memory!.write).toBeUndefined();
  });

  it("read() returns an entry by exact label", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      label: "episode:abc",
      content: "specific memory",
      created_at: "2026-04-08T10:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const entry = await aug.memory!.read!("episode:abc");
    expect(entry?.content).toBe("specific memory");
  });

  it("sets defaults from configuration", () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    expect(aug.memory!.defaults).toEqual({
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
      ttl: "session",
    });
  });
});
