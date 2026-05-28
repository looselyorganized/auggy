import { describe, expect, test } from "bun:test";
import { waitForHealth } from "../../../src/cli/deploy/health";

describe("waitForHealth", () => {
  test("returns healthy on the first 2xx response", async () => {
    const calls: string[] = [];
    const result = await waitForHealth("https://zip.up.railway.app", {
      fetch: async (url) => {
        calls.push(String(url));
        return new Response(null, { status: 200 });
      },
      sleep: async () => {},
      timeoutMs: 1,
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
      attempts: 3,
      status: 503,
      url: "https://zip.up.railway.app/health",
    });
  });
});
