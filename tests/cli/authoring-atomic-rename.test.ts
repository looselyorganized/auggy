import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openAbsoluteDirectoryNoFollow, renameAtNoReplace } from "../../src/lib/posix-at";

let directory: string;
let source: number;
let target: number;
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "auggy-atomic-rename-")));
  mkdirSync(join(directory, "stage"));
  mkdirSync(join(directory, "target"));
  source = openAbsoluteDirectoryNoFollow(join(directory, "stage"));
  target = openAbsoluteDirectoryNoFollow(join(directory, "target"));
  writeFileSync(join(directory, "stage/config"), "complete configuration\n", { mode: 0o640 });
});
afterEach(() => {
  closeSync(source);
  closeSync(target);
  rmSync(directory, { recursive: true, force: true });
});

describe("atomic exclusive authoring publication", () => {
  test("moves the already complete inode with its final mode", () => {
    const before = statSync(join(directory, "stage/config"));
    expect(renameAtNoReplace(source, "config", target, "agent.yaml")).toBe(true);
    const after = statSync(join(directory, "target/agent.yaml"));
    expect(after.ino).toBe(before.ino);
    expect(after.mode & 0o777).toBe(0o640);
    expect(readFileSync(join(directory, "target/agent.yaml"), "utf8")).toBe(
      "complete configuration\n",
    );
    expect(existsSync(join(directory, "stage/config"))).toBe(false);
  });

  test.each(["file", "directory", "symlink"])("preserves a concurrently created %s", (kind) => {
    const destination = join(directory, "target/agent.yaml");
    if (kind === "file") writeFileSync(destination, "operator content");
    else if (kind === "directory") mkdirSync(destination);
    else symlinkSync(join(directory, "stage/config"), destination);
    expect(renameAtNoReplace(source, "config", target, "agent.yaml")).toBe(false);
    expect(readFileSync(join(directory, "stage/config"), "utf8")).toBe("complete configuration\n");
    if (kind === "file") expect(readFileSync(destination, "utf8")).toBe("operator content");
  });

  test("rejects traversal and fails closed without a source", () => {
    expect(() => renameAtNoReplace(source, "../config", target, "agent.yaml")).toThrow();
    expect(renameAtNoReplace(source, "missing", target, "agent.yaml")).toBe(false);
    expect(existsSync(join(directory, "target/agent.yaml"))).toBe(false);
  });
});
