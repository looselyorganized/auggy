import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  APPLICATION_BOUNDS,
  applicationHash,
  startApplicationChild,
} from "../../scripts/release-smoke/application-consumer";

let workspace: string;
beforeEach(() => {
  workspace = mkdtempSync(join(tmpdir(), "auggy-command-input-"));
});
afterEach(() => {
  rmSync(workspace, { recursive: true, force: true });
});

function command(script: string, input: Uint8Array, timeoutMs = 2_000) {
  return owned(
    [process.execPath, "--no-env-file", "--no-install", "--config=/dev/null", "-e", script],
    input,
    timeoutMs,
  );
}

function owned(argv: string[], input: Uint8Array, timeoutMs = 2_000) {
  return startApplicationChild({
    command: argv,
    cwd: workspace,
    env: { PATH: "/usr/bin:/bin", LANG: "C.UTF-8" },
    secrets: ["private-input-canary"],
    input,
    timeoutMs,
  });
}

test("owned command sends immutable bounded input without copying it into evidence", async () => {
  const input = Buffer.from("private-input-canary".repeat(8_000));
  const expected = applicationHash(input);
  const child = command(
    `import { createHash } from "node:crypto";
     const input = await Bun.stdin.arrayBuffer();
     console.log(createHash("sha256").update(new Uint8Array(input)).digest("hex"));`,
    input,
  );
  input.fill(0);
  const result = await child.finish();
  expect(result.exitCode).toBe(0);
  expect(result.inputComplete).toBe(true);
  expect(result.inputFailed).toBe(false);
  expect(result.cleanupConfirmed).toBe(true);
  expect(result.stdout.trim()).toBe(expected);
  expect(JSON.stringify(result)).not.toContain("private-input-canary");
});

test("closed input pipe fails and reaps the owned command", async () => {
  const result = await owned(
    ["/bin/sh", "-c", "exec 0<&-; exec /bin/sleep 10"],
    Buffer.alloc(APPLICATION_BOUNDS.outputBytes),
  ).finish();
  expect(result.inputFailed).toBe(true);
  expect(result.inputComplete).toBe(false);
  expect(result.cleanupConfirmed).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  expect(result.timedOut).toBe(false);
});

test("a non-reading command with bounded input still reaches its deadline and reaps", async () => {
  const result = await owned(
    ["/bin/sleep", "10"],
    Buffer.alloc(APPLICATION_BOUNDS.outputBytes),
    500,
  ).finish();
  expect(result.timedOut).toBe(true);
  expect(result.cleanupConfirmed).toBe(true);
  expect(result.signal).toBe("SIGKILL");
  expect(result.stdout).toBe("");
});

test("oversized command input refuses before spawning", () => {
  expect(() =>
    command("process.exit(0);", Buffer.alloc(APPLICATION_BOUNDS.outputBytes + 1)),
  ).toThrow("input bound");
});
