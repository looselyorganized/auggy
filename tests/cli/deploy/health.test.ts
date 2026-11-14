import { describe, expect, test } from "bun:test";
import { HEALTH_TIMEOUT_ERROR, waitForHealth } from "../../../src/cli/deploy/health";

describe("waitForHealth", () => {
  test("returns healthy on the first 2xx response", async () => {
    const calls: string[] = [];
    const result = await waitForHealth("https://zip.up.railway.app", {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
      timeoutMs: 100,
      intervalMs: 1,
    });

    expect(result).toMatchObject({
      ok: true,
      url: "https://zip.up.railway.app/health",
      attempts: 1,
      status: 200,
    });
    expect(calls).toEqual(["https://zip.up.railway.app/health"]);
  });

  test("retries non-2xx responses until healthy", async () => {
    let attempts = 0;
    let now = 0;
    const result = await waitForHealth("https://zip.up.railway.app/", {
      fetch: async () => {
        attempts++;
        return new Response(null, { status: attempts === 3 ? 204 : 503 });
      },
      sleep: async () => {
        now += 10;
      },
      now: () => now,
      timeoutMs: 100,
      intervalMs: 10,
    });

    expect(result).toMatchObject({
      ok: true,
      attempts: 3,
      status: 204,
    });
  });

  test("returns timeout details without throwing", async () => {
    let now = 0;
    const result = await waitForHealth("https://zip.up.railway.app", {
      fetch: async () => new Response(null, { status: 503 }),
      sleep: async () => {
        now += 10;
      },
      now: () => now,
      timeoutMs: 20,
      intervalMs: 10,
    });

    expect(result).toMatchObject({
      ok: false,
      attempts: 2,
      status: 503,
      url: "https://zip.up.railway.app/health",
    });
  });

  test.each([0, -1, NaN, Infinity, 2 ** 31])(
    "rejects invalid durations before fetching: %s",
    async (value) => {
      for (const field of ["timeoutMs", "requestTimeoutMs", "intervalMs"]) {
        let fetched = false;
        await expect(
          waitForHealth("https://agent.example", {
            [field]: value,
            fetch: async () => {
              fetched = true;
              return new Response();
            },
          }),
        ).rejects.toThrow(/durations/);
        expect(fetched).toBe(false);
      }
    },
  );

  test.each(["//other.example/ready", "/health?token=secret", "/%0a", "/bad%5cpath"])(
    "rejects unsafe health paths: %s",
    async (healthPath) => {
      await expect(waitForHealth("https://agent.example", { healthPath })).rejects.toThrow();
    },
  );

  test("bounds an ignored abort, cancels a late response body and redacts fetch errors", async () => {
    let signal: AbortSignal | undefined;
    let resolveResponse!: (response: Response) => void;
    let cancelled = false;
    let now = 0;
    const start = performance.now();
    const result = await waitForHealth("https://agent.example", {
      now: () => now,
      timeoutMs: 40,
      requestTimeoutMs: 15,
      intervalMs: 30,
      fetch: async (_, init) => {
        signal = init?.signal ?? undefined;
        // The real request timer still aborts ignored I/O. Advance the injected
        // overall clock on that abort so scheduler rounding cannot start a retry.
        signal?.addEventListener(
          "abort",
          () => {
            now = 40;
          },
          { once: true },
        );
        return new Promise<Response>((resolve) => {
          resolveResponse = resolve;
        });
      },
    });
    expect(performance.now() - start).toBeLessThan(500);
    expect(result).toMatchObject({ ok: false, attempts: 1, error: HEALTH_TIMEOUT_ERROR });
    expect(signal?.aborted).toBe(true);
    resolveResponse(
      new Response(
        new ReadableStream({
          cancel() {
            cancelled = true;
          },
        }),
      ),
    );
    await Bun.sleep(1);
    expect(cancelled).toBe(true);
    const redacted = await waitForHealth("https://agent.example", {
      timeoutMs: 10,
      intervalMs: 10,
      fetch: async () => {
        throw new Error("SECRET_RESPONSE_TOKEN");
      },
    });
    expect(JSON.stringify(redacted)).not.toContain("SECRET_RESPONSE_TOKEN");
  });

  test("manual redirects never follow a target or report it healthy", async () => {
    let redirectedRequests = 0;
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        if (new URL(request.url).pathname === "/target") {
          redirectedRequests++;
          return new Response("ready");
        }
        return new Response(null, { status: 302, headers: { location: "/target" } });
      },
    });
    try {
      const result = await waitForHealth(server.url.origin, {
        timeoutMs: 40,
        intervalMs: 40,
        requestTimeoutMs: 30,
      });
      expect(result).toMatchObject({ ok: false, status: 302 });
      expect(redirectedRequests).toBe(0);
    } finally {
      server.stop(true);
    }
  });

  test("delayed real response headers abort within the total deadline", async () => {
    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      async fetch() {
        await Bun.sleep(100);
        return new Response("late");
      },
    });
    try {
      const start = performance.now();
      const result = await waitForHealth(server.url.origin, {
        timeoutMs: 35,
        intervalMs: 35,
        requestTimeoutMs: 15,
      });
      expect(result.ok).toBe(false);
      expect(performance.now() - start).toBeLessThan(500);
    } finally {
      server.stop(true);
    }
  });

  test("bounds a never-settling response cancellation and a never-settling sleep", async () => {
    const response = new Response(
      new ReadableStream({ cancel: () => new Promise<void>(() => {}) }),
    );
    const result = await waitForHealth("https://agent.example", {
      timeoutMs: 40,
      requestTimeoutMs: 15,
      fetch: async () => response,
    });
    expect(result).toMatchObject({ ok: false, error: HEALTH_TIMEOUT_ERROR });
    const sleepResult = await waitForHealth("https://agent.example", {
      timeoutMs: 25,
      fetch: async () => new Response(null, { status: 503 }),
      sleep: () => new Promise<void>(() => {}),
    });
    expect(sleepResult).toMatchObject({ ok: false, attempts: 1, error: HEALTH_TIMEOUT_ERROR });
  });

  test("cleanup rejection is controlled and not a ready response", async () => {
    const response = new Response(
      new ReadableStream({
        cancel() {
          throw new Error("PRIVATE_BODY");
        },
      }),
    );
    const result = await waitForHealth("https://agent.example", { fetch: async () => response });
    expect(result).toMatchObject({ ok: false, error: "Health response cleanup failed." });
    expect(JSON.stringify(result)).not.toContain("PRIVATE_BODY");
  });

  test("rejects a backwards clock and aborts/cancels the acquired response", async () => {
    let clock = 10;
    let cancelled = false;
    let signal: AbortSignal | undefined;
    await expect(
      waitForHealth("https://agent.example", {
        now: () => clock,
        fetch: async (_, init) => {
          signal = init?.signal ?? undefined;
          clock = 9;
          return new Response(
            new ReadableStream({
              cancel() {
                cancelled = true;
              },
            }),
          );
        },
      }),
    ).rejects.toThrow(/monotonic/);
    await Bun.sleep(1);
    expect(signal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
  });

  test("rejects an invalid initial clock and success after the deadline", async () => {
    await expect(waitForHealth("https://agent.example", { now: () => NaN })).rejects.toThrow(
      /clock/,
    );
    let now = 0;
    const result = await waitForHealth("https://agent.example", {
      now: () => now,
      timeoutMs: 20,
      fetch: async () => {
        now = 21;
        return new Response();
      },
    });
    expect(result.ok).toBe(false);
  });
});
