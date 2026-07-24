import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  removeManagedTree,
  supportsManagedFileIsolation,
} from "@/transports/admin/admin-managed-files";

describe("admin managed tree removal bounds", () => {
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "auggy-managed-remove-"));
  });

  afterEach(() => {
    rmSync(agentDir, { recursive: true, force: true });
  });

  it("keeps unsupported platforms fail-closed without disabling the console runtime", () => {
    expect(supportsManagedFileIsolation("win32")).toBe(false);
    expect(supportsManagedFileIsolation("linux")).toBe(true);
    expect(supportsManagedFileIsolation("darwin")).toBe(true);
  });

  it("applies one aggregate node budget across all directories", () => {
    const tree = join(agentDir, "skills", "broad");
    mkdirSync(tree, { recursive: true });
    for (const name of ["a.txt", "b.txt", "c.txt"]) {
      writeFileSync(join(tree, name), name);
    }

    expect(removeManagedTree(agentDir, "skills/broad", { maxNodes: 3 })).toEqual({
      error: "managed file rejected: tree exceeds the safe removal node or depth limit",
    });
    expect(existsSync(tree)).toBe(true);
    expect(existsSync(join(tree, "a.txt"))).toBe(true);
  });

  it("fails closed before descending beyond the configured depth", () => {
    const tree = join(agentDir, "skills", "deep");
    mkdirSync(join(tree, "nested"), { recursive: true });
    writeFileSync(join(tree, "nested", "value.txt"), "value");

    expect(removeManagedTree(agentDir, "skills/deep", { maxDepth: 1 })).toEqual({
      error: "managed file rejected: tree exceeds the safe removal node or depth limit",
    });
    expect(existsSync(join(tree, "nested", "value.txt"))).toBe(true);
  });

  it("removes a tree that stays within both limits", () => {
    const tree = join(agentDir, "skills", "bounded");
    mkdirSync(join(tree, "nested"), { recursive: true });
    writeFileSync(join(tree, "nested", "value.txt"), "value");

    expect(
      removeManagedTree(agentDir, "skills/bounded", {
        maxNodes: 3,
        maxDepth: 2,
      }),
    ).toMatchObject({ removed: true });
    expect(existsSync(tree)).toBe(false);
  });
});
