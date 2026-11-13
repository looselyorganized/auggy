import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { selectInspectionDocument } from "../../src/cli/authoring/inspection-selection";
import { resolveConfigPath } from "../../src/cli/resolve-config";

let root: string;
beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "inspect-selection-")));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
test("passive selection matches explicit, local and named-child precedence", () => {
  const local = join(root, "agent.yaml");
  const explicit = join(root, "other.yaml");
  const child = join(root, "child", "agent.yaml");
  mkdirSync(join(root, "child"));
  writeFileSync(child, "name: child\n");
  writeFileSync(explicit, "name: explicit\n");
  for (const [name, flag] of [
    ["child", undefined],
    ["../ignored", explicit],
  ] as const) {
    expect(selectInspectionDocument(name, flag, { cwd: root }).configPath).toBe(
      resolveConfigPath(name, flag, { cwd: root }),
    );
  }
  writeFileSync(local, "name: local\n");
  for (const name of [undefined, "local"])
    expect(selectInspectionDocument(name, undefined, { cwd: root }).configPath).toBe(
      resolveConfigPath(name, undefined, { cwd: root }),
    );
  expect(() => selectInspectionDocument("child", undefined, { cwd: root })).toThrow(
    "different agent",
  );
  expect(() => resolveConfigPath("child", undefined, { cwd: root })).toThrow("requested");
});
test("invalid names, missing configs, and malformed named lookup fail without values", () => {
  for (const name of [undefined, "missing", "../escape", "a/b", "a\\b", ".hidden"])
    expect(() => selectInspectionDocument(name, undefined, { cwd: root })).toThrow();
  writeFileSync(join(root, "agent.yaml"), "name: [broken\nsecret: private-canary\n");
  try {
    selectInspectionDocument("sample", undefined, { cwd: root });
    throw new Error("expected rejection");
  } catch (error) {
    expect(String(error)).not.toContain("private-canary");
  }
});
test("bounded lookup rejects oversized input and symlinked config", () => {
  const path = join(root, "agent.yaml");
  writeFileSync(path, `name: sample\n#${"a".repeat(AUTHORING_LIMITS.documentBytes)}`);
  expect(() => selectInspectionDocument("sample", undefined, { cwd: root })).toThrow("byte limit");
  rmSync(path);
  writeFileSync(join(root, "target.yaml"), "name: sample\n");
  symlinkSync(join(root, "target.yaml"), path);
  expect(() => selectInspectionDocument("sample", undefined, { cwd: root })).toThrow(
    "safe regular file",
  );
});
test("a named-project FIFO is rejected without blocking", () => {
  const path = join(root, "agent.yaml");
  expect(Bun.spawnSync(["mkfifo", path]).exitCode).toBe(0);
  const started = performance.now();
  expect(() => selectInspectionDocument("sample", undefined, { cwd: root })).toThrow(
    "regular file",
  );
  expect(performance.now() - started).toBeLessThan(1_000);
});
