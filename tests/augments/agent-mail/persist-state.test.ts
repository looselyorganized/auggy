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
        reservations: new Map(),
        accountedAttemptIds: new Map(),
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

  test("retains cooldown and dedup entries for configured windows longer than one hour", () => {
    const dir = tempRoot();
    const now = 24 * 3_600_000;
    const twoHoursAgo = now - 2 * 3_600_000;
    saveRateState(
      dir,
      {
        globalTimestamps: [twoHoursAgo],
        lastByRecipient: new Map([["durable@example.com", twoHoursAgo]]),
        subjectHashes: new Map([["daily digest", twoHoursAgo]]),
        reservations: new Map(),
        accountedAttemptIds: new Map(),
      },
      now,
    );

    const loaded = loadRateState(dir, now, {
      perRecipientCooldownMs: 24 * 3_600_000,
      dedupWindowMs: 24 * 3_600_000,
    });
    expect(loaded?.globalTimestamps).toEqual([]);
    expect(loaded?.lastByRecipient.get("durable@example.com")).toBe(twoHoursAgo);
    expect(loaded?.subjectHashes.get("daily digest")).toBe(twoHoursAgo);
  });

  test("round-trips reservations and accounted attempt ids", () => {
    const dir = tempRoot();
    saveRateState(
      dir,
      {
        globalTimestamps: [],
        lastByRecipient: new Map(),
        subjectHashes: new Map(),
        reservations: new Map([
          [
            "sending-1",
            { timestamp: 9_000_000, recipients: ["a@example.com"], subject: "Reserved" },
          ],
        ]),
        accountedAttemptIds: new Map([["sent-1", 9_000_000]]),
      },
      9_000_000,
    );
    const loaded = loadRateState(dir, 9_000_100);
    expect(loaded?.reservations.get("sending-1")).toEqual({
      timestamp: 9_000_000,
      recipients: ["a@example.com"],
      subject: "Reserved",
    });
    expect(loaded?.accountedAttemptIds.get("sent-1")).toBe(9_000_000);
  });

  test("migrates version 1 state with empty attempt journals", () => {
    const dir = tempRoot();
    writeFileSync(
      join(dir, "agent-mail-state.json"),
      JSON.stringify({
        version: 1,
        savedAt: new Date(9_000_000).toISOString(),
        globalTimestamps: [9_000_000],
        lastByRecipient: { "a@example.com": 9_000_000 },
        subjectHashes: { subject: 9_000_000 },
      }),
    );
    const loaded = loadRateState(dir, 9_000_100);
    expect(loaded?.globalTimestamps).toEqual([9_000_000]);
    expect(loaded?.reservations.size).toBe(0);
    expect(loaded?.accountedAttemptIds.size).toBe(0);
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
        {
          globalTimestamps: [1.5],
          lastByRecipient: new Map(),
          subjectHashes: new Map(),
          reservations: new Map(),
          accountedAttemptIds: new Map(),
        },
        10_000,
      ),
    ).toThrow(/invalid rate-limit state/);
    expect(() =>
      saveRateState(
        dir,
        {
          globalTimestamps: [],
          lastByRecipient: new Map(),
          subjectHashes: new Map(),
          reservations: new Map(),
          accountedAttemptIds: new Map(),
        },
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
