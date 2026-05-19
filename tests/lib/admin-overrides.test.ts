import { describe, expect, it, spyOn } from "bun:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readOverrides, writeOverrides, type AdminOverrides } from "@/lib/admin-overrides";

function makeTempAgentDir(): string {
  return mkdtempSync(join(tmpdir(), "auggy-admin-overrides-test-"));
}

function makeOverrides(partial: Partial<AdminOverrides["overrides"]> = {}): AdminOverrides {
  return {
    version: 1,
    lastModified: new Date().toISOString(),
    lastModifiedBy: "creator",
    overrides: partial,
  };
}

describe("admin-overrides — read", () => {
  it("returns null when agentDir is undefined", () => {
    expect(readOverrides(undefined)).toBeNull();
  });

  it("returns null when agentDir does not exist", () => {
    expect(readOverrides("/nonexistent/path/should/not/exist")).toBeNull();
  });

  it("returns null when admin-overrides.json does not exist", () => {
    const dir = makeTempAgentDir();
    try {
      expect(readOverrides(dir)).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads a valid overrides file", () => {
    const dir = makeTempAgentDir();
    try {
      const sample = makeOverrides({ budgets: { dailyBudgetUsd: 30 } });
      writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(sample));
      const read = readOverrides(dir);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(30);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("returns null + warns on corrupt JSON", () => {
    const dir = makeTempAgentDir();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      writeFileSync(join(dir, "admin-overrides.json"), "{not valid json");
      expect(readOverrides(dir)).toBeNull();
      expect(warn).toHaveBeenCalled();
    } finally {
      rmSync(dir, { recursive: true, force: true });
      warn.mockRestore();
    }
  });

  it("returns null + warns per-field on schema mismatch", () => {
    const dir = makeTempAgentDir();
    const warn = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const bad = {
        version: 1,
        lastModified: new Date().toISOString(),
        lastModifiedBy: "creator",
        overrides: {
          budgets: { dailyBudgetUsd: "thirty" }, // wrong type
        },
      };
      writeFileSync(join(dir, "admin-overrides.json"), JSON.stringify(bad));
      expect(readOverrides(dir)).toBeNull();
      const calls = warn.mock.calls.map((c) => String(c[0]));
      expect(calls.some((c) => c.includes("overrides.budgets.dailyBudgetUsd"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      warn.mockRestore();
    }
  });
});

describe("admin-overrides — write", () => {
  it("writes a valid overrides file", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides({ notify: { globalMaxPerHour: 10 } }));
      const path = join(dir, "admin-overrides.json");
      expect(existsSync(path)).toBe(true);
      const parsed = JSON.parse(readFileSync(path, "utf8"));
      expect(parsed.overrides.notify.globalMaxPerHour).toBe(10);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("writes with 0o600 file mode", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides());
      const path = join(dir, "admin-overrides.json");
      const mode = statSync(path).mode & 0o777;
      expect(mode).toBe(0o600);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("write then read round-trips", () => {
    const dir = makeTempAgentDir();
    try {
      const original = makeOverrides({
        webTransport: { allowAnonymous: false },
        budgets: { dailyBudgetUsd: 25.5 },
        notify: { globalMaxPerHour: 7 },
      });
      writeOverrides(dir, original);
      const read = readOverrides(dir);
      expect(read?.overrides.webTransport?.allowAnonymous).toBe(false);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(25.5);
      expect(read?.overrides.notify?.globalMaxPerHour).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("atomic rename: no .tmp file remains after a successful write", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides());
      const tmpFiles = readdirSync(dir).filter((f) => f.includes(".tmp"));
      expect(tmpFiles).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("overwrite replaces previous content", () => {
    const dir = makeTempAgentDir();
    try {
      writeOverrides(dir, makeOverrides({ budgets: { dailyBudgetUsd: 10 } }));
      writeOverrides(dir, makeOverrides({ budgets: { dailyBudgetUsd: 99 } }));
      const read = readOverrides(dir);
      expect(read?.overrides.budgets?.dailyBudgetUsd).toBe(99);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
