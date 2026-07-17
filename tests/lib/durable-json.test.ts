import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readDurableJson, writeDurableJson } from "../../src/lib/durable-json";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "auggy-durable-json-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("durable JSON", () => {
  test("returns null only when the file is absent", () => {
    expect(readDurableJson(join(tempRoot(), "missing.json"), "test state")).toBeNull();
  });

  test("writes, rewrites, and reads JSON with owner-only permissions", () => {
    const path = join(tempRoot(), "nested", "state.json");
    writeDurableJson(path, { version: 1, value: "first" }, "test state");
    writeDurableJson(path, { version: 1, value: "second" }, "test state");

    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(fd, "utf8"))).toEqual({ version: 1, value: "second" });
    } finally {
      closeSync(fd);
    }
    expect(readDurableJson(path, "test state")).toEqual({ version: 1, value: "second" });
  });

  test("rejects corrupt and oversized content", () => {
    const root = tempRoot();
    const corrupt = join(root, "corrupt.json");
    const oversized = join(root, "oversized.json");
    writeFileSync(corrupt, "{");
    writeFileSync(oversized, JSON.stringify({ value: "too large" }));
    expect(() => readDurableJson(corrupt, "test state")).toThrow(/failed to read/);
    expect(() => readDurableJson(oversized, "test state", 4)).toThrow(/exceeds/);
  });

  test("rejects a symlinked read target", () => {
    const root = tempRoot();
    const target = join(root, "target.json");
    const link = join(root, "state.json");
    writeFileSync(target, "{}");
    symlinkSync(target, link);
    expect(() => readDurableJson(link, "test state")).toThrow(/failed to open/);
  });

  test("rejects a symlinked state directory", () => {
    const root = tempRoot();
    const targetDir = join(root, "target");
    const stateDir = join(root, "state");
    const target = join(targetDir, "state.json");
    mkdirSync(targetDir);
    writeFileSync(target, "{}");
    symlinkSync(targetDir, stateDir);
    expect(() => readDurableJson(join(stateDir, "state.json"), "test state")).toThrow(
      /real directory/,
    );
    expect(() => writeDurableJson(join(stateDir, "state.json"), {}, "test state")).toThrow(
      /real directory/,
    );
  });

  test("replaces a symlink itself without writing through to its target", () => {
    const root = tempRoot();
    const target = join(root, "target.json");
    const path = join(root, "state.json");
    writeFileSync(target, JSON.stringify({ untouched: true }));
    symlinkSync(target, path);

    writeDurableJson(path, { replacement: true }, "test state");
    expect(JSON.parse(readFileSync(target, "utf8"))).toEqual({ untouched: true });
    expect(readDurableJson(path, "test state")).toEqual({ replacement: true });
  });

  test("leaves no temporary file after successful writes", () => {
    const root = tempRoot();
    const path = join(root, "state.json");
    writeDurableJson(path, { ok: true }, "test state");
    expect(readdirSync(root)).toEqual(["state.json"]);
  });
});
