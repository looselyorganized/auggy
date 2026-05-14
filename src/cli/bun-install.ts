/**
 * Wrapper around `bun install` invoked inside an agent dir.
 *
 * Mirrors the testable-subprocess pattern from `deploy/railway-cli.ts` —
 * the factory defaults to `Bun.spawn` and tests inject a stub so the create
 * + add flows can be exercised without actually touching the network or
 * the host filesystem.
 *
 * stdout is streamed straight through to the parent (operators want to see
 * `bun install`'s progress live). stderr is captured AND streamed so the
 * caller can include it in the failure message when the install fails.
 */

import { readAllTextTeed } from "./_shared/stream";

export interface BunInstallResult {
  /** True when `bun install` exited 0. */
  ok: boolean;
  /** Exit code (0 on success, non-zero on failure). */
  code: number;
  /** Captured stderr text. Useful for the fail-soft error message. */
  stderr: string;
}

/**
 * Subprocess factory — narrow shape so tests can stub it. Matches the
 * `RailwaySpawnFactory` contract style (`{ exited, stdout, stderr }`)
 * minus the inheriting-stdout convenience the default factory provides.
 */
export type BunInstallSpawnFactory = (
  cmd: string[],
  opts: { cwd: string },
) => {
  exited: Promise<number>;
  /** Stream to drain stderr into a captured buffer. */
  stderr: ReadableStream<Uint8Array>;
};

const defaultSpawn: BunInstallSpawnFactory = (cmd, opts) => {
  const proc = Bun.spawn(cmd, {
    cwd: opts.cwd,
    // stdout is inherited so the operator sees progress live. stderr is
    // piped so we can capture for the failure message AND echo it.
    stdout: "inherit",
    stderr: "pipe",
  });
  return {
    exited: proc.exited,
    stderr: proc.stderr,
  };
};

/**
 * Run `bun install` in the given agent directory. Streams stdout, captures
 * stderr.  Returns the result so the caller can decide how to surface
 * failures (we never throw — fail-soft is the create/add contract).
 */
export async function runBunInstall(
  agentDir: string,
  spawn: BunInstallSpawnFactory = defaultSpawn,
): Promise<BunInstallResult> {
  const proc = spawn(["bun", "install"], { cwd: agentDir });

  // Drain stderr into a buffer AND echo each chunk live so the operator
  // sees errors as they happen (matches what they'd see from a direct
  // `bun install` invocation).
  const stderrTask = readAllTextTeed(proc.stderr, (chunk) => {
    process.stderr.write(chunk);
  });

  const code = await proc.exited;
  const stderr = await stderrTask;

  return { ok: code === 0, code, stderr };
}
