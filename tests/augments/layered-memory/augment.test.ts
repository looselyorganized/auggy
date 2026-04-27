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
      trustLevel: "untrusted",
    });

    const results = await spec.search("espresso", { peerId: "vis_a" });
    expect(results.length).toBe(1);
    expect(results[0]!.peerId).toBe("vis_a");
    expect(results[0]!.trustLevel).toBe("untrusted");
  });

  it("search isolates entries by peerId", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await spec.write!("ep:vis_a:1", "espresso", { peerId: "vis_a", trustLevel: "untrusted" });
    await spec.write!("ep:vis_b:1", "espresso", { peerId: "vis_b", trustLevel: "untrusted" });

    const aResults = await spec.search("espresso", { peerId: "vis_a" });
    expect(aResults.length).toBe(1);
    expect(aResults[0]!.peerId).toBe("vis_a");
  });

  it("forget deletes a peer's entries and returns count", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await spec.write!("ep:vis_a:1", "x", { peerId: "vis_a", trustLevel: "untrusted" });
    await spec.write!("ep:vis_a:2", "y", { peerId: "vis_a", trustLevel: "untrusted" });

    const count = await spec.forget!("vis_a");
    expect(count).toBe(2);

    const results = await spec.search("", { peerId: "vis_a" });
    expect(results.length).toBe(0);
  });

  it("rejects writes whose label does not match the namespace prefix", async () => {
    const spec = aug.memory as NamespaceMemoryProvider;
    await expect(
      spec.write!("other:vis_a:1", "x", { peerId: "vis_a", trustLevel: "untrusted" }),
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
});
