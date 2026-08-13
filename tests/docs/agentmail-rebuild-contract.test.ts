import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const contract = readFileSync(
  join(import.meta.dir, "../../docs/plans/agentmail-provider-native-rebuild-2026-08-12.md"),
  "utf8",
);

describe("AgentMail replacement architecture contract", () => {
  test("keeps provider state, Auggy orchestration, and shared delivery consumers separate", () => {
    expect(contract).toContain("AgentMail is the system of record");
    expect(contract).toContain("waking a turn, crash recovery, peer identity");
    expect(contract).toContain("keeps `visitorAuth` AgentMail delivery");
    expect(contract).toMatch(/Unsupported local state is detected and\s+reported/);
    expect(contract).toMatch(/never read, migrated, or deleted automatically/);
  });
});
