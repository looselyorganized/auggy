import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notify } from "@/augments/notify";
import type { AdminSection, Augment, NotifyAdapter } from "@/types";

let tempDir: string;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-g36-p3-4-"));
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

const fakeAdapter: NotifyAdapter = {
  async deliver() {
    return { status: "sent" };
  },
};

type AdminTableSection = Extract<AdminSection, { kind: "table" }>;

function isAdminTableSection(section: AdminSection): section is AdminTableSection {
  return section.kind === "table";
}

function makeNotifyAugment(): Augment {
  return notify({
    destinations: [
      {
        name: "test-webhook",
        transport: "webhook",
        url: "http://127.0.0.1:1/test",
        allowedTrustLevels: ["creator", "agent"],
        publicPolicy: "escalation-only",
      },
    ],
    rateLimit: { globalMaxPerHour: 5 },
    agentDir: tempDir,
    adapters: { webhook: fakeAdapter },
  });
}

describe("notify adminInfo — shape", () => {
  it("returns a Notify block with KV + table + 2 top-level actions; notify-cap-reset present as handler", async () => {
    const aug = makeNotifyAugment();
    try {
      const info = await aug.adminInfo?.();
      expect(info?.title).toBe("Notify");
      const actionIds = (info?.actions ?? []).map((a) => a.id);
      expect(actionIds).toContain("notify-test");
      expect(actionIds).toContain("notify-cap-adjust");
      expect(aug.adminActions?.["notify-cap-reset"]).toBeDefined();
      const destinationTable = info?.sections.find(
        (section): section is AdminTableSection =>
          isAdminTableSection(section) &&
          section.columns.includes("Allowed trust") &&
          section.columns.includes("Public policy"),
      );
      expect(destinationTable?.rows[0]).toContain("creator, agent");
      expect(destinationTable?.rows[0]).toContain("escalation-only");
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("notify adminActions — notify-test", () => {
  it("dispatches a test notification via adapter", async () => {
    const aug = makeNotifyAugment();
    try {
      const result = await aug.adminActions?.["notify-test"]?.({
        destination: "test-webhook",
        message: "from test suite",
      });
      expect(result?.ok).toBe(true);
      expect(result?.message).toMatch(/sent/i);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("returns ok=false when destination is unknown", async () => {
    const aug = makeNotifyAugment();
    try {
      const result = await aug.adminActions?.["notify-test"]?.({
        destination: "nonexistent",
        message: "x",
      });
      expect(result?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});

describe("notify adminActions — notify-cap-adjust + reset", () => {
  it("persists globalMaxPerHour", async () => {
    const aug = makeNotifyAugment();
    try {
      const result = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "10" });
      expect(result?.ok).toBe(true);
      const parsed = JSON.parse(readFileSync(join(tempDir, "admin-overrides.json"), "utf8"));
      expect(parsed.overrides.notify.globalMaxPerHour).toBe(10);
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("notify-cap-reset clears the override", async () => {
    const aug = makeNotifyAugment();
    try {
      await aug.adminActions?.["notify-cap-adjust"]?.({ value: "10" });
      const result = await aug.adminActions?.["notify-cap-reset"]?.({});
      expect(result?.ok).toBe(true);
      const parsed = JSON.parse(readFileSync(join(tempDir, "admin-overrides.json"), "utf8"));
      expect(parsed.overrides.notify?.globalMaxPerHour).toBeUndefined();
    } finally {
      await aug.onShutdown?.();
    }
  });

  it("rejects negative or zero values", async () => {
    const aug = makeNotifyAugment();
    try {
      const negative = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "-1" });
      expect(negative?.ok).toBe(false);
      const zero = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "0" });
      expect(zero?.ok).toBe(false);
      const nonInt = await aug.adminActions?.["notify-cap-adjust"]?.({ value: "1.5" });
      expect(nonInt?.ok).toBe(false);
    } finally {
      await aug.onShutdown?.();
    }
  });
});
