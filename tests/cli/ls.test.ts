import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runLs } from "../../src/cli/commands/ls";
import { addAgent } from "../../src/cli/agent-index";

let auggyDir: string;
let agentParent: string;
let logSpy: ReturnType<typeof spyOn>;
let logged: string[];

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "ls-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "ls-test-agents-"));
  logged = [];
  logSpy = spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    logged.push(args.map((a) => String(a)).join(" "));
  });
});

afterEach(() => {
  logSpy.mockRestore();
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("runLs", () => {
  test("prints message for empty index", async () => {
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toMatch(/no agents registered/i);
  });

  test("lists registered agents", async () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toContain("zip");
    expect(output).toContain(dir);
  });

  test("flags missing-dir entries", async () => {
    const dir = join(agentParent, "zip");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "agent.yaml"), "id: aug1_test\n");
    addAgent("zip", dir, { auggyDir });
    rmSync(dir, { recursive: true, force: true });
    await runLs({ auggyDir });
    const output = logged.join("\n");
    expect(output).toContain("zip");
    // Was "missing-dir" pre lifecycle hardening (2026-05-20); renamed to
    // "ghost" to match the orphan/ghost/ok vocabulary surfaced by `--all`.
    expect(output).toMatch(/ghost/i);
  });
});
