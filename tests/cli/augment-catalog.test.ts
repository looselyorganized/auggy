import { describe, it, expect } from "bun:test";
import { AUGMENT_CATALOG } from "../../src/cli/augment-catalog";

describe("augment catalog", () => {
  it("turnControl is registered in the catalog", () => {
    const entry = AUGMENT_CATALOG.find((e) => e.type === "turnControl");
    expect(entry).toBeDefined();
    expect(entry?.label).toMatch(/turn[- ]control/i);
    expect(entry?.required).toBe(false);
    // After ADR-025 + PR α task 2, turnControl ships a bundled skill folder.
    expect(entry?.hasSkill).toBe(true);
  });

  it("turnControl uses the conventional defaultName", () => {
    const entry = AUGMENT_CATALOG.find((e) => e.type === "turnControl");
    expect(entry?.defaultName).toBe("turn-control");
  });
});
