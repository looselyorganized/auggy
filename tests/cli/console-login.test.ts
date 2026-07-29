import { describe, expect, mock, test } from "bun:test";
import {
  normalizeConsoleBaseUrl,
  openConsoleWithSignIn,
  requestConsoleLoginUrl,
} from "../../src/cli/console-login";

const TICKET = "A".repeat(43);

describe("Console CLI browser sign-in", () => {
  test("exchanges the bearer without putting it in the browser URL", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = mock(async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({ url: String(input), init });
      return Response.json({
        loginPath: `/console/cli-login/${TICKET}`,
        expiresInSeconds: 30,
      });
    }) as unknown as typeof fetch;

    const loginUrl = await requestConsoleLoginUrl({
      baseUrl: "https://agent.example/console",
      bearer: "permanent-secret",
      fetch: fetchImpl,
    });

    expect(loginUrl).toBe(`https://agent.example/console/cli-login/${TICKET}`);
    expect(loginUrl).not.toContain("permanent-secret");
    expect(requests[0]?.url).toBe("https://agent.example/console/api/cli-login");
    expect(requests[0]?.init?.redirect).toBe("error");
    expect(new Headers(requests[0]?.init?.headers).has("origin")).toBe(false);
    expect(new Headers(requests[0]?.init?.headers).get("authorization")).toBe(
      `Basic ${Buffer.from("auggy:permanent-secret").toString("base64")}`,
    );
  });

  test("allows local HTTP but refuses to send credentials over remote HTTP", async () => {
    expect(normalizeConsoleBaseUrl("http://localhost:8080/console")).toBe("http://localhost:8080");
    expect(normalizeConsoleBaseUrl("http://127.0.0.2:8080")).toBe("http://127.0.0.2:8080");
    expect(() => normalizeConsoleBaseUrl("http://agent.example")).toThrow("requires HTTPS");

    const fetchImpl = mock(async () => Response.json({})) as unknown as typeof fetch;
    await expect(
      requestConsoleLoginUrl({
        baseUrl: "http://agent.example",
        bearer: "secret",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("requires HTTPS");
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  test("rejects malformed ticket responses", async () => {
    const fetchImpl = mock(async () =>
      Response.json({
        loginPath: "/console/cli-login/not-valid",
        expiresInSeconds: 30,
      }),
    ) as unknown as typeof fetch;

    await expect(
      requestConsoleLoginUrl({
        baseUrl: "https://agent.example",
        bearer: "secret",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("invalid automatic sign-in response");
  });

  test("stops reading an oversized ticket response", async () => {
    const fetchImpl = mock(
      async () =>
        new Response("x".repeat(5000), {
          headers: { "content-type": "application/json" },
        }),
    ) as unknown as typeof fetch;

    await expect(
      requestConsoleLoginUrl({
        baseUrl: "https://agent.example",
        bearer: "secret",
        fetch: fetchImpl,
      }),
    ).rejects.toThrow("invalid automatic sign-in response");
  });

  test("falls back to the manual login screen without exposing response details", async () => {
    const opened: string[] = [];
    const result = await openConsoleWithSignIn({
      baseUrl: "https://agent.example",
      bearer: "secret",
      fetch: mock(async () => new Response("upstream secret details", { status: 500 })) as never,
      open: (url) => {
        opened.push(url);
        return { ok: true, command: "test-open" };
      },
    });

    expect(result).toEqual({
      opened: true,
      automaticSignIn: false,
      consoleUrl: "https://agent.example/console",
      reason: "automatic sign-in was unavailable",
    });
    expect(opened).toEqual(["https://agent.example/console/login"]);
    expect(JSON.stringify(result)).not.toContain("upstream secret details");
  });
});
