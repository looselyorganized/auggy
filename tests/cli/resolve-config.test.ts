import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveConfigPath } from "../../src/cli/resolve-config";
import { addAgent } from "../../src/cli/agent-index";

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
    expect(() =>
      resolveConfigPath("zip", "/nonexistent/agent.yaml", { auggyDir }),
    ).toThrow(/not found/i);
  });

  test("index hit returns indexed agent.yaml path", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });
    expect(resolveConfigPath("zip", undefined, { auggyDir })).toBe(
      join(dir, "agent.yaml"),
    );
  });

  test("index hit but agent.yaml missing throws helpful error", () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    addAgent("zip", dir, { auggyDir });
    // no agent.yaml in dir
    expect(() => resolveConfigPath("zip", undefined, { auggyDir })).toThrow(
      /missing|not found.*agent\.yaml|agent\.yaml.*missing/i,
    );
  });

  test("index miss throws clear 'not registered' error", () => {
    expect(() => resolveConfigPath("ghost", undefined, { auggyDir })).toThrow(
      /not registered|aug1 create/i,
    );
  });
});
