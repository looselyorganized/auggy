import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { layeredMemory } from "@/augments/layered-memory";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { Augment, NamespaceMemoryProvider } from "@/types";

describe("layeredMemory", () => {
  let aug: Augment;
  let cleanup: () => Promise<void>;

  beforeEach(async () => {
    const dir = await createTempDir();
    cleanup = dir.cleanup;
    aug = await layeredMemory({
      backend: "sqlite",
      dbPath: join(dir.path, "memory.db"),
      namespace: "ep",
      retentionDays: 90,
    });
  });

  afterEach(async () => {
    await aug.onShutdown?.();
    await cleanup();
  });

  it("registers as a NamespaceMemoryProvider with prefix 'ep:'", () => {
    expect(aug.memory!.owns).toEqual({ kind: "namespace", prefix: "ep:" });
  });

  it("declares origin 'peer-derived' so untrusted peers can write", () => {
    expect(aug.memory!.defaults.origin).toBe("peer-derived");
  });

  it("write tags entries with peerId from opts", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await spec.write!("ep:vis_a:1", "loved espresso", {
      peerId: "vis_a",
      trustLevel: "public",
    });

    const results = await spec.search("espresso", { peerId: "vis_a" });
    expect(results.length).toBe(1);
    expect(results[0]!.peerId).toBe("vis_a");
    expect(results[0]!.trustLevel).toBe("public");
  });

  it("search isolates entries by peerId", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await spec.write!("ep:vis_a:1", "espresso", { peerId: "vis_a", trustLevel: "public" });
    await spec.write!("ep:vis_b:1", "espresso", { peerId: "vis_b", trustLevel: "public" });

    const aResults = await spec.search("espresso", { peerId: "vis_a" });
    expect(aResults.length).toBe(1);
    expect(aResults[0]!.peerId).toBe("vis_a");
  });

  it("forget deletes a peer's entries and returns count", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await spec.write!("ep:vis_a:1", "x", { peerId: "vis_a", trustLevel: "public" });
    await spec.write!("ep:vis_a:2", "y", { peerId: "vis_a", trustLevel: "public" });

    const count = await spec.forget!("vis_a");
    expect(count).toBe(2);

    const results = await spec.search("", { peerId: "vis_a" });
    expect(results.length).toBe(0);
  });

  it("rejects writes whose label does not match the namespace prefix", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await expect(
      spec.write!("other:vis_a:1", "x", { peerId: "vis_a", trustLevel: "public" }),
    ).rejects.toThrow();
  });

  it("namespace can be customized", async () => {
    const dir = await createTempDir();
    const custom = await layeredMemory({
      backend: "sqlite",
      dbPath: join(dir.path, "m.db"),
      namespace: "episode",
      retentionDays: 90,
    });
    expect(custom.memory!.owns).toEqual({ kind: "namespace", prefix: "episode:" });
    await custom.onShutdown?.();
    await dir.cleanup();
  });

  describe("peer isolation", () => {
    it("does NOT expose read() — peer-derived data is search-only", () => {
      const spec = aug.memory as NamespaceMemoryProvider;
      expect(spec.read).toBeUndefined();
    });

    it("rejects writes where the label is not scoped to the caller's peerId", async () => {
      const spec = aug.memory as NamespaceMemoryProvider;
      // Peer A trying to write to a label that claims to belong to peer B
      await expect(
        spec.write!("ep:vis_b:1", "poison", {
          peerId: "vis_a",
          trustLevel: "public",
        }),
      ).rejects.toThrow(/cannot write to label/);
    });

    it("accepts writes whose label starts with the caller's peer-scoped prefix", async () => {
      const spec = aug.memory as NamespaceMemoryProvider;
      await spec.write!("ep:vis_a:1", "fine", {
        peerId: "vis_a",
        trustLevel: "public",
      });
      await spec.write!("ep:vis_a", "also fine", {
        peerId: "vis_a",
        trustLevel: "public",
      });

      const results = await spec.search("fine", { peerId: "vis_a" });
      expect(results.length).toBe(2);
    });

    it("does not let prefix-only-match bypass binding (vis_a vs vis_aa)", async () => {
      const spec = aug.memory as NamespaceMemoryProvider;
      // vis_a tries to write to a label that starts with vis_a but actually
      // belongs to vis_aa. The check must use full-segment match.
      await expect(
        spec.write!("ep:vis_aa:1", "subtle", {
          peerId: "vis_a",
          trustLevel: "public",
        }),
      ).rejects.toThrow(/cannot write to label/);
    });

    it("allows writes without peerId (operator/system internal triggers)", async () => {
      const spec = aug.memory as NamespaceMemoryProvider;
      // No peerId in opts → no binding enforced. This is the operator/null-peer
      // path — operator can write to any well-formed label.
      await spec.write!("ep:system:note", "operator note");
      // The row is stored with peer_id=null. It won't surface in any peer's
      // search (which filters by peer_id), but operator workflows can still
      // see it via memory_search without peerId scoping.
    });
  });
});
