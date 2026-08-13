import { expect, test } from "bun:test";
import { join } from "node:path";

test("the pinned AgentMail SDK WebSocket opens on Bun without blob binaryType", async () => {
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "../../fixtures/agent-mail-provider-websocket-child.ts"),
    ],
    { cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe" },
  );
  const timeout = setTimeout(() => child.kill(), 5_000);
  try {
    const [exitCode, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(exitCode, `${stdout}\n${stderr}`).toBe(0);
    expect(stdout.includes("subscribed") || stdout.includes("skipped-local-network")).toBe(true);
    expect(stderr).not.toContain("Invalid binaryType");
  } finally {
    clearTimeout(timeout);
  }
});
