import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertIntegrationEnvironment,
  createIntegrationBudget,
  observeIntegrationSse,
  readIntegrationFile,
  redactIntegrationDiagnostic,
  waitForIntegrationHttpReady,
  withIntegrationChild,
} from "../../scripts/release-smoke/integration-consumer";

const directories: string[] = [];
afterEach(() => {
  for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "auggy-m5-consumer-mechanics-"));
  directories.push(root);
  return root;
}

const frame = (value: unknown) => `data: ${JSON.stringify(value)}\n\n`;
const content = frame({ type: "TEXT_MESSAGE_CONTENT", delta: "synthetic-owned-marker" });
const terminal = frame({ type: "RUN_FINISHED" });

describe("M5 harness mechanics; not installed product acceptance", () => {
  test("non-cooperating operations settle and receive abort within the outer monotonic budget", async () => {
    const budget = createIntegrationBudget(45);
    let signal: AbortSignal | undefined;
    const started = performance.now();
    try {
      await expect(
        budget.run(1000, async (scoped) => {
          signal = scoped;
          return new Promise<never>(() => {});
        }),
      ).rejects.toThrow("deadline");
      expect(performance.now() - started).toBeLessThan(1000);
      expect(signal?.aborted).toBe(true);
      await expect(budget.run(1000, async () => true)).rejects.toThrow("ended");
    } finally {
      budget.dispose();
    }
  });

  test("parent interruption aborts operation and disposed scopes cannot start work", async () => {
    const parent = new AbortController();
    const budget = createIntegrationBudget(1000, parent.signal);
    const work = budget.run(1000, async () => new Promise<never>(() => {}));
    parent.abort();
    await expect(work).rejects.toThrow("interruption");
    budget.dispose();
    await expect(budget.run(100, async () => true)).rejects.toThrow("ended");
  });

  test("owned child is killed and reaped when observation ignores cancellation", async () => {
    const root = workspace();
    const result = await withIntegrationChild(
      {
        label: "hung-fixture-control",
        command: [
          process.execPath,
          "-e",
          "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);",
        ],
        cwd: root,
        env: { PATH: `${dirname(process.execPath)}:/usr/bin:/bin`, HOME: root },
        secrets: [],
        timeoutMs: 100,
      },
      async () => new Promise<never>(() => {}),
    );
    expect(result.status).toBe("failed");
    expect(result.process.cleanupConfirmed).toBe(true);
    expect(result.process.signal).toBe("SIGKILL");
    expect(result.process.durationMs).toBeLessThan(2000);
  });

  test("output overflow fails the real child and cannot leak fixture secrets", async () => {
    const root = workspace();
    const result = await withIntegrationChild(
      {
        label: "overflow-fixture-control",
        command: [
          process.execPath,
          "-e",
          "console.log(process.env.FIXTURE_SECRET); console.log('x'.repeat(4096));",
        ],
        cwd: root,
        env: {
          PATH: `${dirname(process.execPath)}:/usr/bin:/bin`,
          HOME: root,
          FIXTURE_SECRET: "tiny",
        },
        secrets: ["tiny"],
        timeoutMs: 1000,
        maxOutputBytes: 512,
      },
      async ({ child }) => {
        await child.finish();
      },
    );
    expect(result.status).toBe("failed");
    expect(result.process.exceededOutput).toBe(true);
    expect(result.process.cleanupConfirmed).toBe(true);
    expect(JSON.stringify(result)).not.toContain("tiny");
  });

  test("redacts exact short secrets, assertions, private keys and bot URL credentials", () => {
    const text = redactIntegrationDiagnostic(
      "tiny https://api.telegram.org/bot123:secret/sendMessage\nx-auggy-auth-assertion: private\n" +
        "eyJhbGciOiJIUzI1NiJ9.cGF5bG9hZA.c2lnbmF0dXJl\neyJ0eXAiOiJhdWdneS5leHRlcm5hbC1hdXRoLnYxIn0.c2lnbmF0dXJl\n-----BEGIN PRIVATE KEY-----\nprivate\n-----END PRIVATE KEY-----",
      ["tiny"],
    );
    expect(text).not.toContain("tiny");
    expect(text).not.toContain("123:secret");
    expect(text).not.toContain("private");
    expect(text).not.toContain("eyJ");
  });

  test("refuses preload inheritance and symlink escapes before use", () => {
    expect(() => assertIntegrationEnvironment({ NODE_OPTIONS: "--import=evil" })).toThrow(
      "inherited",
    );
    expect(() => assertIntegrationEnvironment({ DYLD_INSERT_LIBRARIES: "evil" })).toThrow(
      "inherited",
    );
    const root = workspace();
    mkdirSync(join(root, "outside"));
    writeFileSync(join(root, "outside", "input.json"), "{}");
    symlinkSync(join(root, "outside"), join(root, "linked"));
    expect(() => readIntegrationFile(root, "linked/input.json", 100)).toThrow("ordinary");
    expect(() => readIntegrationFile(root, "../input.json", 100)).toThrow("canonical");
  });

  test("readiness bounds a hanging response body and refuses cross-origin redirect", async () => {
    let requests = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch(request) {
        requests++;
        if (new URL(request.url).pathname === "/redirect")
          return Response.redirect("http://127.0.0.1:1/private", 302);
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode("{"));
            },
          }),
        );
      },
    });
    try {
      for (const path of ["/hang", "/redirect"]) {
        const budget = createIntegrationBudget(75);
        try {
          await expect(
            waitForIntegrationHttpReady({
              url: `http://127.0.0.1:${server.port}${path}`,
              budget,
              ready: () => true,
            }),
          ).rejects.toThrow();
        } finally {
          budget.dispose();
        }
      }
      expect(requests).toBeGreaterThanOrEqual(2);
    } finally {
      await server.stop(true);
    }
  });

  test("actual HTTP streaming distinguishes a delivered chunk from a buffered terminal", async () => {
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch() {
        return new Response(
          new ReadableStream({
            async start(controller) {
              controller.enqueue(new TextEncoder().encode(content));
              await Bun.sleep(40);
              controller.enqueue(new TextEncoder().encode(terminal));
              controller.close();
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      },
    });
    const budget = createIntegrationBudget(2000);
    try {
      const response = await fetch(`http://127.0.0.1:${server.port}`, { signal: budget.signal });
      const observed = await observeIntegrationSse({
        response,
        budget,
        expectedMarker: "owned-marker",
      });
      expect(observed.firstChunkBeforeTerminal).toBe(true);
      expect(observed.containsExpectedMarker).toBe(true);
      expect(observed.terminal).toBe("RUN_FINISHED");
      expect(JSON.stringify(observed)).not.toContain("synthetic-owned-marker");
    } finally {
      budget.dispose();
      await server.stop(true);
    }
  });

  test("buffered, wrong-marker and missing-terminal controls cannot claim streamed success", async () => {
    const budget = createIntegrationBudget(1000);
    const response = (text: string) =>
      new Response(text, { headers: { "content-type": "text/event-stream" } });
    try {
      const observed = await observeIntegrationSse({
        response: response(content + terminal),
        budget,
        expectedMarker: "wrong-marker",
      });
      expect(observed.firstChunkBeforeTerminal).toBe(false);
      expect(observed.containsExpectedMarker).toBe(false);
      await expect(observeIntegrationSse({ response: response(content), budget })).rejects.toThrow(
        "terminal",
      );
      await expect(
        observeIntegrationSse({ response: response(content + terminal + terminal), budget }),
      ).rejects.toThrow("after");
      await expect(
        observeIntegrationSse({ response: response(`${content}data:`), budget }),
      ).rejects.toThrow("framing");
    } finally {
      budget.dispose();
    }
  });

  test("a rejected turn's closing RUN_FINISHED never overwrites RUN_ERROR or permits more data", async () => {
    const budget = createIntegrationBudget(1000);
    const error = frame({ type: "RUN_ERROR", code: "AUTHORIZATION_DENIED" });
    const response = (body: string) =>
      new Response(body, { headers: { "content-type": "text/event-stream" } });
    try {
      const observed = await observeIntegrationSse({
        response: response(error + terminal),
        budget,
      });
      expect(observed.terminal).toBe("RUN_ERROR");
      expect(observed.events).toBe(2);
      expect(observed.firstChunkBeforeTerminal).toBe(false);
      for (const body of [
        error + terminal + terminal,
        error + terminal + content,
        error + content,
        error + error,
        terminal + error,
      ])
        await expect(observeIntegrationSse({ response: response(body), budget })).rejects.toThrow(
          "after",
        );
    } finally {
      budget.dispose();
    }
  });
});
