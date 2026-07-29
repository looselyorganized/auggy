import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");

function runQuietly(command: readonly string[]): void {
  const result = Bun.spawnSync([...command], {
    cwd: root,
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (result.exitCode === 0) return;

  // npm pack callers consume stdout as the tarball filename. Keep successful
  // prepack output silent; on failure, surface both child streams on stderr.
  process.stderr.write(result.stdout);
  process.stderr.write(result.stderr);
  throw new Error(`prepack command failed (${result.exitCode}): ${command.join(" ")}`);
}

runQuietly(["bun", "run", "build:admin"]);
runQuietly(["bun", "run", "verify:admin"]);
