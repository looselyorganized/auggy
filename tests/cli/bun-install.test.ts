import { describe, test, expect } from "bun:test";
import { runBunInstall } from "../../src/cli/bun-install";
import { createStubBunInstallSpawn, type SpawnCapture } from "../fixtures/bun-install-stub";

/**
 * Tests inject a stub spawn factory so we never run a real `bun install` —
 * keeps these hermetic + fast. The real path is exercised end-to-end at
 * Phase 9 (verification on a clean machine).
 */

describe("runBunInstall", () => {
  test("returns ok=true on exit 0", async () => {
    const result = await runBunInstall("/tmp/some-agent", createStubBunInstallSpawn());
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("invokes `bun install` in the given cwd", async () => {
    const capture: SpawnCapture[] = [];
    await runBunInstall("/tmp/agent-x", createStubBunInstallSpawn({ capture }));
    expect(capture).toHaveLength(1);
    expect(capture[0]?.cmd).toEqual(["bun", "install"]);
    expect(capture[0]?.cwd).toBe("/tmp/agent-x");
  });

  test("returns ok=false + captures stderr on non-zero exit", async () => {
    const result = await runBunInstall(
      "/tmp/agent-x",
      createStubBunInstallSpawn({ exitCode: 1, stderrText: "error: registry timeout\n" }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry timeout");
  });

  test("returns ok=true on exit 0 even when stderr has warning output", async () => {
    // bun install can emit warnings to stderr while still exiting 0.
    const result = await runBunInstall(
      "/tmp/agent-x",
      createStubBunInstallSpawn({ stderrText: "warn: peer dep mismatch\n" }),
    );
    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("peer dep mismatch");
  });
});
