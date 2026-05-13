import type { BunInstallSpawnFactory } from "../../src/cli/bun-install";

/**
 * Stub `BunInstallSpawnFactory` for tests. Drop-in replacement for the
 * production `Bun.spawn`-backed factory at `src/cli/bun-install.ts`. Tests
 * inject this so create / add / dev / integration flows can be exercised
 * without spawning a real `bun install`.
 *
 * Usage:
 *
 *   // simple "always succeeds" stub
 *   const spawn = createStubBunInstallSpawn();
 *
 *   // with capture (record every spawn call for assertions)
 *   const calls: SpawnCapture[] = [];
 *   const spawn = createStubBunInstallSpawn({ capture: calls });
 *
 *   // simulate failure
 *   const spawn = createStubBunInstallSpawn({
 *     exitCode: 1,
 *     stderrText: "error: network unreachable\n",
 *   });
 */

export interface SpawnCapture {
  cmd: string[];
  cwd: string;
}

export interface StubBunInstallSpawnOptions {
  /** Exit code the stubbed subprocess reports. Default 0. */
  exitCode?: number;
  /** Stderr text the stubbed subprocess emits. Default "". */
  stderrText?: string;
  /**
   * Optional array to push each spawn call into. Lets tests assert on the
   * command + cwd without instrumenting the factory closure themselves.
   */
  capture?: SpawnCapture[];
}

export function createStubBunInstallSpawn(
  opts: StubBunInstallSpawnOptions = {},
): BunInstallSpawnFactory {
  return (cmd, spawnOpts) => {
    opts.capture?.push({ cmd, cwd: spawnOpts.cwd });

    const encoder = new TextEncoder();
    const stderrBytes = encoder.encode(opts.stderrText ?? "");
    const stderr = new ReadableStream<Uint8Array>({
      start(controller) {
        if (stderrBytes.byteLength > 0) controller.enqueue(stderrBytes);
        controller.close();
      },
    });

    return {
      exited: Promise.resolve(opts.exitCode ?? 0),
      stderr,
    };
  };
}
