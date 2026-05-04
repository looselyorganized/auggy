import { describe, it, expect } from "bun:test";
import { AUGMENT_CATALOG } from "../../src/cli/augment-catalog";

describe("augment catalog", () => {
  it("turnControl is registered in the catalog", () => {
    const entry = AUGMENT_CATALOG.find((e) => e.type === "turnControl");
    expect(entry).toBeDefined();
    expect(entry?.label).toMatch(/turn[- ]control/i);
    expect(entry?.required).toBe(false);
    expect(entry?.hasSkill).toBe(false);
  });

  it("turnControl uses the conventional defaultName", () => {
    const entry = AUGMENT_CATALOG.find((e) => e.type === "turnControl");
    expect(entry?.defaultName).toBe("turn-control");
  });
});
