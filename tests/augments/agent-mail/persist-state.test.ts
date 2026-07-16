import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRateState, saveRateState } from "../../../src/augments/agentMail/persist-state";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-mail-rate-state-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("AgentMail persisted rate state", () => {
  test("returns null only for absent state", () => {
    expect(loadRateState(tempRoot(), 10_000)).toBeNull();
    expect(loadRateState(undefined, 10_000)).toBeNull();
  });

  test("round-trips current entries and prunes expired entries", () => {
    const dir = tempRoot();
    saveRateState(
      dir,
      {
        globalTimestamps: [1, 9_000_000],
        lastByRecipient: new Map([
          ["old@example.com", 1],
          ["new@example.com", 9_000_000],
        ]),
        subjectHashes: new Map([
          ["old", 1],
          ["new", 9_000_000],
        ]),
      },
      9_000_000,
    );

    const loaded = loadRateState(dir, 9_000_000);
    expect(loaded?.globalTimestamps).toEqual([9_000_000]);
    expect(Object.fromEntries(loaded?.lastByRecipient ?? [])).toEqual({
      "new@example.com": 9_000_000,
    });
    expect(Object.fromEntries(loaded?.subjectHashes ?? [])).toEqual({ new: 9_000_000 });
  });

  test("fails closed on corrupt JSON", () => {
    const dir = tempRoot();
    writeFileSync(join(dir, "agent-mail-state.json"), "{");
    expect(() => loadRateState(dir, 10_000)).toThrow(/failed to read/);
  });

  test("fails closed on unknown versions and invalid timestamps", () => {
    const dir = tempRoot();
    const path = join(dir, "agent-mail-state.json");
    writeFileSync(
      path,
      JSON.stringify({
        version: 2,
        savedAt: new Date(0).toISOString(),
        globalTimestamps: [],
        lastByRecipient: {},
        subjectHashes: {},
      }),
    );
    expect(() => loadRateState(dir, 10_000)).toThrow(/refusing to reset limits/);

    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        savedAt: new Date(0).toISOString(),
        globalTimestamps: [-1],
        lastByRecipient: {},
        subjectHashes: {},
      }),
    );
    expect(() => loadRateState(dir, 10_000)).toThrow(/refusing to reset limits/);
  });

  test("rejects invalid clocks and refuses to persist invalid state", () => {
    const dir = tempRoot();
    expect(() => loadRateState(dir, -1)).toThrow(/clock/);
    expect(() =>
      saveRateState(
        dir,
        { globalTimestamps: [1.5], lastByRecipient: new Map(), subjectHashes: new Map() },
        10_000,
      ),
    ).toThrow(/invalid rate-limit state/);
    expect(() =>
      saveRateState(
        dir,
        { globalTimestamps: [], lastByRecipient: new Map(), subjectHashes: new Map() },
        Number.MAX_SAFE_INTEGER + 1,
      ),
    ).toThrow(/clock/);
  });

  test("rejects a symlinked state file", () => {
    const dir = tempRoot();
    const target = join(dir, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "agent-mail-state.json"));
    expect(() => loadRateState(dir, 10_000)).toThrow(/failed to open/);
  });
});
