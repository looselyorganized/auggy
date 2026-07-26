import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfigPath } from "../../src/cli/resolve-config";

let auggyDir: string;
let agentParent: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "resolve-config-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "resolve-config-test-agents-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("resolveConfigPath", () => {
  test("explicit --config wins", () => {
    const cfg = join(agentParent, "custom.yaml");
    writeFileSync(cfg, "id: aug1_test\n");
    expect(resolveConfigPath("zip", cfg, { auggyDir })).toBe(cfg);
  });

  test("explicit --config to nonexistent path throws", () => {
    expect(() => resolveConfigPath("zip", "/nonexistent/agent.yaml", { auggyDir })).toThrow(
      /not found/i,
    );
  });

  test("agent name resolves to ./<name>/agent.yaml from cwd", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir);
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_zip\nname: zip\n");
    expect(resolveConfigPath("zip", undefined, { auggyDir, cwd: agentParent })).toBe(
      join(dir, "agent.yaml"),
    );
  });

  test("a named target never silently resolves to a different cwd agent", () => {
    const childDir = join(agentParent, "zip");
    mkdirSync(childDir);
    writeFileSync(join(childDir, "agent.yaml"), "id: aug1_zip\nname: zip\n");
    const projectDir = mkdtempSync(join(agentParent, "project-"));
    const projectConfig = join(projectDir, "agent.yaml");
    writeFileSync(projectConfig, "id: aug1_project\nname: project\n");
    expect(() => resolveConfigPath("zip", undefined, { auggyDir, cwd: projectDir })).toThrow(
      /names "project".*requested "zip"/i,
    );
  });

  test("project-local agent.yaml can resolve without an agent name", () => {
    const projectDir = mkdtempSync(join(agentParent, "project-"));
    const projectConfig = join(projectDir, "agent.yaml");
    writeFileSync(projectConfig, "id: aug1_project\nname: project\n");

    expect(resolveConfigPath(undefined, undefined, { auggyDir, cwd: projectDir })).toBe(
      projectConfig,
    );
  });

  test("agent dir exists but agent.yaml missing surfaces a clear error", () => {
    mkdirSync(join(agentParent, "zip"));
    expect(() => resolveConfigPath("zip", undefined, { auggyDir, cwd: agentParent })).toThrow(
      /not found|auggy create/i,
    );
  });

  test("missing agent name throws clear error", () => {
    expect(() => resolveConfigPath("ghost", undefined, { auggyDir, cwd: agentParent })).toThrow(
      /not found|auggy create/i,
    );
  });

  test("missing unnamed project throws clear error", () => {
    expect(() => resolveConfigPath(undefined, undefined, { auggyDir, cwd: agentParent })).toThrow(
      /No agent specified/,
    );
  });

  test("rejects path aliases in the agent name before filesystem lookup", () => {
    for (const name of ["..", "../zip", "a/b", "a\\b", ".hidden", "zip.json"]) {
      expect(() => resolveConfigPath(name, undefined, { cwd: agentParent })).toThrow(
        /invalid agent name/i,
      );
    }
  });
});
