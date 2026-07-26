import { afterEach, describe, expect, test } from "bun:test";
import { linkSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { compareOwnedStatePaths } from "../../src/cli/owned-state-path";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("owned state path identity", () => {
  test("recognizes two existing names for the same physical file", () => {
    const root = mkdtempSync(join(tmpdir(), "owned-state-identity-"));
    roots.push(root);
    const first = join(root, "Memory.db");
    const second = join(root, "memory-alias.db");
    writeFileSync(first, "state");
    linkSync(first, second);
    expect(compareOwnedStatePaths(first, second)).toBe("same");
  });

  test("fails closed for uncreated case-only aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "owned-state-ambiguous-"));
    roots.push(root);
    expect(
      compareOwnedStatePaths(join(root, "Data", "Memory.db"), join(root, "data", "memory.db")),
    ).toBe("ambiguous");
  });

  test("fails closed for uncreated Unicode-normalization aliases", () => {
    const root = mkdtempSync(join(tmpdir(), "owned-state-unicode-ambiguous-"));
    roots.push(root);
    expect(
      compareOwnedStatePaths(join(root, "m\u00e9moire.db"), join(root, "me\u0301moire.db")),
    ).toBe("ambiguous");
  });
});
