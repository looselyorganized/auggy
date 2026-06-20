import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { budgets } from "@/augments/budgets";
import type { Augment, PeerIdentity, TurnTrigger } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-2-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

function makeBudgetsAugment(overrides: Partial<Parameters<typeof budgets>[0]> = {}): Augment {
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
    ...overrides,
  });
}

function makePeer(overrides: Partial<PeerIdentity> = {}): PeerIdentity {
  return {
    id: "peer-1",
    kind: "human",
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment: "web-transport",
    ...overrides,
  };
}

function makeTrigger(peer: PeerIdentity): TurnTrigger {
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    threadId: "thread-1",
    timestamp: Date.now(),
    payload: { parts: [], sourceAugment: "web-transport", peer, timestamp: Date.now() },
  };
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
        expect(labels).toContain("Pricing confidence");
        expect(JSON.stringify(kv.rows)).toContain("preview");
        expect(JSON.stringify(kv.rows)).toContain("runtime spend guardrails");
        expect(JSON.stringify(kv.rows)).toContain("provider-side hard caps still required");
        expect(JSON.stringify(kv.rows)).toContain("single-process");
        expect(kv.rows.find((r) => r.label === "Retention")?.value).toBe("off");
        expect(kv.rows.find((r) => r.label === "Pricing confidence")?.value).toBe("priced");
      }
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("surfaces degraded pricing confidence and per-peer unpriced turns to operators", async () => {
    const aug = makeBudgetsAugment();
    try {
      const peer = makePeer({ id: "peer-unpriced" });
      const turnGate = aug.turnGate;
      if (!turnGate) throw new Error("expected budgets turnGate");
      const ticket = await turnGate.prepare({
        turnId: "turn-unpriced",
        peer,
        threadId: "thread-1",
        trigger: makeTrigger(peer),
      });
      expect(ticket.decision.allow).toBe(true);
      await ticket.confirm();
      if (!turnGate.commit) throw new Error("expected budgets commit hook");
      await turnGate.commit({
        turnId: "turn-unpriced",
        peer,
        threadId: "thread-1",
        cost: { priced: false, reason: "unknown model" },
      });

      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind !== "keyValue") throw new Error("expected keyValue section");
      expect(kv.rows.find((r) => r.label === "Pricing confidence")?.value).toBe(
        "degraded (1 unpriced turn today)",
      );

      const table = info?.sections.find((s) => s.kind === "table");
      if (table?.kind !== "table") throw new Error("expected table section");
      expect(table.rows).toContainEqual(["peer-unpriced", "$0.00", "1"]);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("shows configured retention policy", async () => {
    const aug = makeBudgetsAugment({ retentionDays: 30 });
    try {
      const info = await aug.adminInfo?.();
      const kv = info?.sections.find((s) => s.kind === "keyValue");
      if (kv?.kind !== "keyValue") throw new Error("expected keyValue section");
      expect(kv.rows.find((r) => r.label === "Retention")?.value).toBe("30 day(s)");
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
