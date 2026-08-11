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
      }, 15_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const [exitCode, stdout, stderr] = await Promise.all([
    timedExit,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

test("certifies the pinned AgentMail SDK WebSocket path on Bun", async () => {
  const child = Bun.spawn([process.execPath, CHILD], {
    cwd: process.cwd(),
    env: { PATH: process.env.PATH ?? "" },
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = await runWithTimeout(child);

  expect(result.exitCode).toBe(0);
  expect(result.stderr).toBe("");
  expect(result.stderr).not.toContain("Invalid binaryType: blob");
  expect(result.stderr).not.toContain("UnhandledPromiseRejection");

  const ready = result.stdout.indexOf('"event":"LOOPBACK_READY"');
  const firstSubscribe = result.stdout.indexOf('"event":"SERVER_SUBSCRIBE","generation":1');
  const initialAck = result.stdout.indexOf('"event":"SUBSCRIBED","reconnected":false');
  const firstEvent = result.stdout.indexOf('"event":"EVENT_RECEIVED","messageId":"message_1"');
  const secondSubscribe = result.stdout.indexOf('"event":"SERVER_SUBSCRIBE","generation":2');
  const reconnectAck = result.stdout.indexOf('"event":"SUBSCRIBED","reconnected":true');
  const secondEvent = result.stdout.indexOf('"event":"EVENT_RECEIVED","messageId":"message_2"');
  const closed = result.stdout.indexOf('"event":"CLOSED"');

  expect(ready).toBeGreaterThanOrEqual(0);
  expect(firstSubscribe).toBeGreaterThan(ready);
  expect(initialAck).toBeGreaterThan(firstSubscribe);
  expect(firstEvent).toBeGreaterThan(initialAck);
  expect(secondSubscribe).toBeGreaterThan(initialAck);
  expect(reconnectAck).toBeGreaterThan(secondSubscribe);
  expect(secondEvent).toBeGreaterThan(reconnectAck);
  expect(closed).toBeGreaterThan(Math.max(reconnectAck, secondEvent));
}, 20_000);
