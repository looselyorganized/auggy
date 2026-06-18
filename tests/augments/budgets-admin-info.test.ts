import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgets } from "@/augments/budgets";
import type { Augment } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-2-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeBudgetsAugment(): Augment {
  return budgets({
    dbPath: join(tempDir, "budgets.db"),
    agentDir: tempDir,
    caps: {
      agent: { maxUsdPerDay: 50 },
      public: {
        anonymous: { maxTurnsPerThread: 5, maxUsdPerDay: 10 },
        recognized: { maxUsdPerDay: 25 },
      },
    },
    dailyBudgetUsd: 100,
  });
}

describe("budgets adminInfo — shape", () => {
  it("returns a Budgets block with KV section showing daily cap + today's spend", async () => {
    const aug = makeBudgetsAugment();
    try {
      const info = await aug.adminInfo?.();
      expect(info).toBeDefined();
      expect(info?.title).toBe("Budgets");
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      expect(kv).toBeDefined();
      if (kv?.kind === "keyValue") {
        const labels = kv.rows.map((r) => r.label);
        expect(labels).toContain("Status");
        expect(labels).toContain("Guardrail model");
        expect(labels).toContain("USD enforcement");
        expect(labels).toContain("Storage");
        expect(labels).toContain("Retention");
        expect(labels).toContain("Daily budget cap");
        expect(labels).toContain("Today's spend");
        expect(JSON.stringify(kv.rows)).toContain("preview");
        expect(JSON.stringify(kv.rows)).toContain("runtime spend guardrails");
        expect(JSON.stringify(kv.rows)).toContain("provider-side hard caps still required");
        expect(JSON.stringify(kv.rows)).toContain("single-process");
        expect(JSON.stringify(kv.rows)).toContain("no built-in purge policy");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("declares budget-cap-adjust + budget-cap-reset actions/handlers", async () => {
    const aug = makeBudgetsAugment();
    try {
      const info = await aug.adminInfo?.();
      const actionIds = (info?.actions ?? []).map((a) => a.id);
      expect(actionIds).toContain("budget-cap-adjust");
      expect(aug.adminActions?.["budget-cap-adjust"]).toBeDefined();
      expect(aug.adminActions?.["budget-cap-reset"]).toBeDefined();
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("budgets adminActions — budget-cap-adjust", () => {
  it("persists dailyBudgetUsd override and updates closure", async () => {
    const aug = makeBudgetsAugment();
    try {
      const result = await aug.adminActions?.["budget-cap-adjust"]?.({ value: "200" });
      expect(result?.ok).toBe(true);
      const overrideFile = join(tempDir, "admin-overrides.json");
      expect(existsSync(overrideFile)).toBe(true);
      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.budgets.dailyBudgetUsd).toBe(200);

      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const dailyCap = kv.rows.find((r) => r.label === "Daily budget cap");
        expect(dailyCap?.value).toContain("200");
        expect(dailyCap?.source).toContain("override");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when value is not a positive number", async () => {
    const aug = makeBudgetsAugment();
    try {
      const result = await aug.adminActions?.["budget-cap-adjust"]?.({ value: "-50" });
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("budgets adminActions — budget-cap-reset", () => {
  it("clears the override + restores yaml value", async () => {
    const aug = makeBudgetsAugment();
    try {
      await aug.adminActions?.["budget-cap-adjust"]?.({ value: "200" });
      const overrideFile = join(tempDir, "admin-overrides.json");
      expect(JSON.parse(readFileSync(overrideFile, "utf8")).overrides.budgets.dailyBudgetUsd).toBe(
        200,
      );

      const result = await aug.adminActions?.["budget-cap-reset"]?.({});
      expect(result?.ok).toBe(true);

      const parsed = JSON.parse(readFileSync(overrideFile, "utf8"));
      expect(parsed.overrides.budgets?.dailyBudgetUsd).toBeUndefined();

      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind === "keyValue") {
        const dailyCap = kv.rows.find((r) => r.label === "Daily budget cap");
        expect(dailyCap?.value).toContain("100");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });
});
