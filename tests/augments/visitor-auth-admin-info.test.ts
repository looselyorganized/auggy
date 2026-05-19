import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "@/augments/visitor-auth";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-5-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeVisitorAuthAugment(): Augment {
  return visitorAuth({
    publicUrl: "http://127.0.0.1:1",
    dbPath: join(tempDir, "visitor-auth.db"),
    agentMail: { transport: "console" },
    signingKey: "test-signing-key-must-be-long-enough",
    agentBinding: "test-agent",
    layeredMemoryDbPath: null,
  });
}

describe("visitor-auth adminInfo — shape", () => {
  it("returns a Visitors block with KV + status + table + rowAction visitor-revoke", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Visitors");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      const table = info?.sections.find((s) => s.kind === "table");
      expect(table).toBeDefined();
      if (table?.kind === "table") {
        expect(table.rowActions?.map((r) => r.id)).toContain("visitor-revoke");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("status section surfaces the mail transport", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const info = await aug.adminInfo?.();
      const status = info?.sections.find((s) => s.kind === "status");
      expect(status?.kind).toBe("status");
      if (status?.kind === "status") {
        expect(status.message.toLowerCase()).toContain("console");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("visitor-auth adminActions — visitor-revoke", () => {
  it("returns ok=false when rowKey is missing", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["visitor-revoke"]?.({});
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when the visitor email is unknown", async () => {
    const aug = makeVisitorAuthAugment();
    await aug.onBoot?.();
    try {
      const result = await aug.adminActions?.["visitor-revoke"]?.({
        rowKey: "ghost@example.com",
      });
      expect(result?.ok).toBe(false);
      expect(result?.message).toMatch(/not found|already revoked/i);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
