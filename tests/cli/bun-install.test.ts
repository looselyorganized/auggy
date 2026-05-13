import { describe, test, expect } from "bun:test";
import { runBunInstall, type BunInstallSpawnFactory } from "../../src/cli/bun-install";

/**
 * Tests inject a stub spawn factory so we never run a real `bun install` —
 * keeps these hermetic + fast. The real path is exercised end-to-end at
 * Phase 9 (verification on a clean machine).
 */

function stubSpawn(opts: {
  exitCode: number;
  stderrText?: string;
  capture?: { cmd?: string[]; cwd?: string };
}): BunInstallSpawnFactory {
  return (cmd, spawnOpts) => {
    if (opts.capture) {
      opts.capture.cmd = cmd;
      opts.capture.cwd = spawnOpts.cwd;
    }
    const encoder = new TextEncoder();
    const stderrBytes = encoder.encode(opts.stderrText ?? "");
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderrBytes.byteLength > 0) controller.enqueue(stderrBytes);
        controller.close();
      },
    });
    return {
      exited: Promise.resolve(opts.exitCode),
      stderr,
    };
  };
}

describe("runBunInstall", () => {
  test("returns ok=true on exit 0", async () => {
    const captured: { cmd?: string[]; cwd?: string } = {};
    const result = await runBunInstall(
      "/tmp/some-agent",
      stubSpawn({ exitCode: 0, capture: captured }),
    );
    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
  });

  test("invokes `bun install` in the given cwd", async () => {
    const captured: { cmd?: string[]; cwd?: string } = {};
    await runBunInstall("/tmp/agent-x", stubSpawn({ exitCode: 0, capture: captured }));
    expect(captured.cmd).toEqual(["bun", "install"]);
    expect(captured.cwd).toBe("/tmp/agent-x");
  });

  test("returns ok=false + captures stderr on non-zero exit", async () => {
    const result = await runBunInstall(
      "/tmp/agent-x",
      stubSpawn({ exitCode: 1, stderrText: "error: registry timeout\n" }),
    );
    expect(result.ok).toBe(false);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("registry timeout");
  });

  test("returns ok=true on exit 0 even when stderr has warning output", async () => {
    // bun install can emit warnings to stderr while still exiting 0.
    const result = await runBunInstall(
      "/tmp/agent-x",
      stubSpawn({ exitCode: 0, stderrText: "warn: peer dep mismatch\n" }),
    );
    expect(result.ok).toBe(true);
    expect(result.stderr).toContain("peer dep mismatch");
  });
});
