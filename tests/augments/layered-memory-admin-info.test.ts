import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { layeredMemory } from "@/augments/layered-memory";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-3-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

async function makeMemoryAugment(): Promise<Augment> {
  return await layeredMemory({
    backend: "sqlite",
    namespace: "ep",
    dbPath: join(tempDir, "memory.db"),
    autoSave: { enabled: false },
  });
}

describe("layered-memory adminInfo — shape", () => {
  it("returns a Memory block with KV (counts) + table (entries) + rowAction memory-erase", async () => {
    const aug = await makeMemoryAugment();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Memory");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      const table = info?.sections.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      if (table?.kind === "table") {
        expect(table.rowActions?.map((r) => r.id)).toContain("memory-erase");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("KV section reports retention-class counts", async () => {
    const aug = await makeMemoryAugment();
    try {
      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const labels = kv.rows.map((r) => r.label);
        expect(labels).toContain("Total entries");
        expect(labels).toContain("Operational");
        expect(labels).toContain("Lesson");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("layered-memory adminActions — memory-erase", () => {
  it("calls forget(peerId) and reports the count", async () => {
    const aug = await makeMemoryAugment();
    try {
      const result = await aug.adminActions?.["memory-erase"]?.({
        rowKey: "vis_test_peer",
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toMatch(/erased/i);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when rowKey is missing", async () => {
    const aug = await makeMemoryAugment();
    try {
      const result = await aug.adminActions?.["memory-erase"]?.({});
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
