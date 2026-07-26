import { describe, it, expect } from "bun:test";
import { supabaseMemory } from "@/augments/supabaseMemory";
import { canonicalMemoryNamespace } from "@/augments/memory-namespace";
import { createMockSupabase } from "@tests/fixtures/mock-supabase";
import type { NamespaceMemoryProvider } from "@/types";

const EPISODE_KEY = canonicalMemoryNamespace("episode").key;

describe("supabaseMemory", () => {
  it("fails closed when scope is omitted at runtime", () => {
    expect(() =>
      supabaseMemory({
        namespace: "episode",
        client: createMockSupabase(),
        table: "memories",
        mutable: false,
        origin: "peer-derived",
        priority: "normal",
        placement: "preamble",
        eviction: "drop",
      } as unknown as Parameters<typeof supabaseMemory>[0]),
    ).toThrow(/scope must be explicitly set/);
  });

  it("rejects shared peer-derived memory", () => {
    expect(() =>
      supabaseMemory({
        namespace: "episode",
        scope: "shared",
        client: createMockSupabase(),
        table: "memories",
        mutable: false,
        origin: "peer-derived",
        priority: "normal",
        placement: "preamble",
        eviction: "drop",
      }),
    ).toThrow(/shared.*peer-derived/);
  });

  it("snapshots peer scope so caller mutation cannot reopen shared reads", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert([
      {
        namespace_key: EPISODE_KEY,
        label: "episode:victim:secret",
        content: "victim-only memory",
        peer_id: "victim",
        created_at: "2026-04-08T11:00:00Z",
      },
      {
        namespace_key: EPISODE_KEY,
        label: "episode:attacker:public",
        content: "attacker memory",
        peer_id: "attacker",
        created_at: "2026-04-08T10:00:00Z",
      },
    ]);
    const options = {
      namespace: "episode",
      scope: "peer" as "peer" | "shared",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived" as const,
      priority: "normal" as const,
      placement: "preamble" as const,
      eviction: "drop" as const,
    };
    const aug = supabaseMemory(options);

    options.scope = "shared";

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("memory", { peerId: "attacker" });
    expect(results.map((entry) => entry.peerId)).toEqual(["attacker"]);
    expect(results.map((entry) => entry.content)).not.toContain("victim-only memory");
    await expect(
      spec.write!("episode:victim:forged", "forged", {
        peerId: "attacker",
        trustLevel: "public",
      }),
    ).rejects.toThrow(/not structurally bound/);
  });

  it("rejects unsafe peer-column identifiers", () => {
    expect(() =>
      supabaseMemory({
        namespace: "episode",
        scope: "peer",
        client: createMockSupabase(),
        table: "memories",
        peerColumn: "peer_id, content",
        mutable: false,
        origin: "peer-derived",
        priority: "normal",
        placement: "preamble",
        eviction: "drop",
      }),
    ).toThrow(/simple SQL identifier/);
  });

  it("declares namespace ownership with configured prefix", () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
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
      namespace_key: EPISODE_KEY,
      label: "episode:2026-04-08-001",
      content: "visitor asked about coffee",
      peer_id: "visitor-1",
      created_at: "2026-04-08T10:00:00Z",
    });
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:2026-04-08-002",
      content: "visitor asked about weather",
      peer_id: "visitor-1",
      created_at: "2026-04-08T11:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("coffee", { peerId: "visitor-1" });
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.content).toContain("coffee");
  });

  it("search() does not leak rows from other namespaces that share the table", async () => {
    const client = createMockSupabase();
    // Seed rows from two different namespaces, both mentioning "coffee"
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:2026-04-08-001",
      content: "visitor mentioned coffee",
      peer_id: "visitor-1",
      created_at: "2026-04-08T10:00:00Z",
    });
    await client.from("agent_memories").insert({
      namespace_key: canonicalMemoryNamespace("other").key,
      label: "other:999",
      content: "different namespace also mentions coffee",
      peer_id: "visitor-1",
      created_at: "2026-04-08T11:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("coffee", { peerId: "visitor-1" });
    // Must only return the episode: row, never the other: row.
    expect(results).toHaveLength(1);
    expect(results[0]!.label).toBe("episode:2026-04-08-001");
  });

  it("write() inserts a new row with the correct label", async () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    await aug.memory!.write!("episode:visitor-1:test-1", "new memory", {
      peerId: "visitor-1",
      trustLevel: "public",
    });

    const stored = client._rows.get("agent_memories")!;
    expect(stored).toHaveLength(1);
    expect(stored[0]!.label).toBe("episode:visitor-1:test-1");
    expect(stored[0]!.content).toBe("new memory");
    expect(stored[0]!.peer_id).toBe("visitor-1");
    expect(stored[0]!.namespace_key).toBe(EPISODE_KEY);
  });

  it("omits write when mutable: false", () => {
    const client = createMockSupabase();
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
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

  it("shared read() returns the newest entry by exact label", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:abc",
      content: "specific memory",
      created_at: "2026-04-08T10:00:00Z",
    });

    const aug = supabaseMemory({
      namespace: "episode",
      scope: "shared",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "operator",
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
      scope: "peer",
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

  it("filters peer rows before applying the search limit", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert([
      {
        namespace_key: EPISODE_KEY,
        label: "episode:visitor-a:coffee",
        content: "visitor A likes coffee",
        peer_id: "visitor-a",
        created_at: "2026-04-08T10:00:00Z",
      },
      {
        namespace_key: EPISODE_KEY,
        label: "episode:visitor-b:coffee",
        content: "visitor B likes coffee",
        peer_id: "visitor-b",
        created_at: "2026-04-08T11:00:00Z",
      },
    ]);

    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
      searchLimit: 1,
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("coffee", { peerId: "visitor-a" });
    expect(results).toHaveLength(1);
    expect(results[0]?.peerId).toBe("visitor-a");
    expect(results[0]?.content).toContain("visitor A");
  });

  it("filters namespace case exactly before applying the search limit", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert([
      {
        namespace_key: canonicalMemoryNamespace("Foo").key,
        label: "Foo:visitor:fact",
        content: "case sentinel upper",
        peer_id: "visitor",
        created_at: "2026-04-08T10:00:00Z",
      },
      {
        namespace_key: canonicalMemoryNamespace("foo").key,
        label: "foo:visitor:fact",
        content: "case sentinel lower",
        peer_id: "visitor",
        created_at: "2026-04-08T11:00:00Z",
      },
    ]);
    const aug = supabaseMemory({
      namespace: "Foo",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
      searchLimit: 1,
    });
    const results = await (aug.memory as NamespaceMemoryProvider).search("case sentinel", {
      peerId: "visitor",
    });
    expect(results.map((entry) => entry.label)).toEqual(["Foo:visitor:fact"]);
  });

  it("preserves authenticated peer IDs exactly instead of normalizing aliases", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:victim:coffee",
      content: "victim likes coffee",
      peer_id: "victim",
      created_at: "2026-04-08T10:00:00Z",
    });
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    expect(await spec.search("coffee", { peerId: " victim " })).toEqual([]);
  });

  it("denies peer-scoped search without identity and omits unsafe exact reads", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:visitor-b:secret",
      content: "visitor B secret",
      peer_id: "visitor-b",
      created_at: "2026-04-08T10:00:00Z",
    });
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "peer",
      client,
      table: "agent_memories",
      mutable: true,
      origin: "peer-derived",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    await expect(spec.search("secret")).rejects.toThrow(/peer identity/i);
    expect(spec.read).toBeUndefined();
  });

  it("keeps intentionally shared stores scoped to an exact namespace owner", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      namespace_key: EPISODE_KEY,
      label: "episode:shared",
      content: "shared operator memory",
      created_at: "2026-04-08T10:00:00Z",
    });
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "shared",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "operator",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });

    const spec = aug.memory as NamespaceMemoryProvider;
    const results = await spec.search("operator");
    expect(results).toHaveLength(1);
    expect(results[0]?.label).toBe("episode:shared");
  });

  it("does not silently adopt legacy rows without an exact namespace owner", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert({
      label: "episode:legacy",
      content: "legacy row without namespace owner",
      created_at: "2026-04-08T10:00:00Z",
    });
    const aug = supabaseMemory({
      namespace: "episode",
      scope: "shared",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "operator",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    expect(await (aug.memory as NamespaceMemoryProvider).search("legacy")).toEqual([]);
    expect(await aug.memory!.read!("episode:legacy")).toBeNull();
  });

  it("uses exact owner keys when namespaces are nested", async () => {
    const client = createMockSupabase();
    await client.from("agent_memories").insert([
      {
        namespace_key: canonicalMemoryNamespace("Foo").key,
        label: "Foo:bar:shared",
        content: "parent-owned",
        created_at: "2026-04-08T10:00:00Z",
      },
      {
        namespace_key: canonicalMemoryNamespace("Foo:bar").key,
        label: "Foo:bar:shared",
        content: "child-owned",
        created_at: "2026-04-08T11:00:00Z",
      },
    ]);
    const parent = supabaseMemory({
      namespace: "Foo",
      scope: "shared",
      client,
      table: "agent_memories",
      mutable: false,
      origin: "operator",
      priority: "normal",
      placement: "preamble",
      eviction: "drop",
    });
    expect(
      (await (parent.memory as NamespaceMemoryProvider).search("owned")).map(
        (entry) => entry.content,
      ),
    ).toEqual(["parent-owned"]);
    expect((await parent.memory!.read!("Foo:bar:shared"))?.content).toBe("parent-owned");
  });
});
