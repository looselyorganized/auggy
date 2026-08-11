import { expect, test } from "bun:test";
import { resolve } from "node:path";

const CHILD = resolve("tests/fixtures/agent-mail-sdk-bun-websocket-child.ts");

async function runWithTimeout(
  child: ReturnType<typeof Bun.spawn>,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  if (!child.stdout || typeof child.stdout === "number") {
    throw new Error("AgentMail WebSocket contract child stdout is not readable");
  }
  if (!child.stderr || typeof child.stderr === "number") {
    throw new Error("AgentMail WebSocket contract child stderr is not readable");
  }
  let timer: ReturnType<typeof setTimeout>;
  const timedExit = Promise.race([
    child.exited,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("timed out waiting for AgentMail WebSocket contract child"));
      }, 3_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const [exitCode, stdout, stderr] = await Promise.all([
    timedExit,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("documents the pinned AgentMail SDK blob binary type failure on Bun", async () => {
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await runWithTimeout(child);

  expect(result.stdout).toContain('"event":"LOOPBACK_READY"');
  expect(result.stdout).not.toContain('"event":"SUBSCRIBED"');
  expect(result.exitCode).not.toBe(0);
  expect(result.stderr).toContain("Invalid binaryType: blob");
}, 5_000);
