import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfigPath } from "../../src/cli/resolve-config";
import { seedAgentForTest } from "../../src/cli/agent-index";

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

  test("registered agent name resolves to canonical agent.yaml path", () => {
    const dir = seedAgentForTest("zip", { auggyDir });
    expect(resolveConfigPath("zip", undefined, { auggyDir })).toBe(join(dir, "agent.yaml"));
  });

  test("project-local agent.yaml wins before registered agent lookup", () => {
    seedAgentForTest("zip", { auggyDir });
    const projectDir = mkdtempSync(join(agentParent, "project-"));
    const projectConfig = join(projectDir, "agent.yaml");
    writeFileSync(projectConfig, "id: aug1_project\nname: project\n");
    expect(resolveConfigPath("zip", undefined, { auggyDir, cwd: projectDir })).toBe(
      projectConfig,
    );
  });

  test("agent dir exists but agent.yaml missing surfaces a clear error", () => {
    const dir = seedAgentForTest("zip", { auggyDir });
    unlinkSync(join(dir, "agent.yaml"));
    expect(() => resolveConfigPath("zip", undefined, { auggyDir })).toThrow(
      /not found|auggy create/i,
    );
  });

  test("missing agent name throws clear error", () => {
    expect(() => resolveConfigPath("ghost", undefined, { auggyDir })).toThrow(
      /not found|auggy create/i,
    );
  });
});
