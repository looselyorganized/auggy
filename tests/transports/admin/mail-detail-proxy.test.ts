import { describe, expect, it } from "bun:test";
import {
  handleMailDetailProxy,
  type MailDetailProxyFetch,
} from "@/transports/admin/mail-detail-proxy";

const detailPath = "/agentmail/mail-west/reviews/review_1";

function proxyRequest(path = detailPath, method = "GET"): Request {
  return new Request(
    `https://agent.example/console/api/mail-detail?path=${encodeURIComponent(path)}`,
    { method },
  );
}

describe("Console AgentMail detail proxy", () => {
  it("self-fetches only the canonical loopback path with the bearer kept server-side", async () => {
    let captured:
      | { url: string; authorization: string | null; redirect: RequestInit["redirect"] }
      | undefined;
    const response = await handleMailDetailProxy(proxyRequest(), {
      bearer: "permanent-secret",
      selfPort: 8080,
      fetchImpl: async (input, init) => {
        captured = {
          url: String(input),
          authorization: new Headers(init?.headers).get("authorization"),
          redirect: init?.redirect,
        };
        return new Response(JSON.stringify({ reviewId: "review_1" }), {
          headers: {
            "content-type": "application/json; charset=utf-8",
            "set-cookie": "must-not-cross=1",
            location: "https://evil.example",
          },
        });
      },
    });

    expect(captured).toEqual({
      url: "http://127.0.0.1:8080/agentmail/mail-west/reviews/review_1",
      authorization: "Bearer permanent-secret",
      redirect: "manual",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    expect(response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("location")).toBeNull();
    expect(await response.text()).not.toContain("permanent-secret");
  });

  it("rejects invalid, cross-origin, duplicate, and extra-query targets before fetch", async () => {
    let calls = 0;
    const fetchImpl: MailDetailProxyFetch = async () => {
      calls += 1;
      return new Response("unexpected");
    };
    const requests = [
      proxyRequest("https://evil.example/agentmail/reviews/review_1"),
      proxyRequest("/console/api/dashboard"),
      proxyRequest("/agentmail/mail-west/reviews/../console"),
      new Request(
        `https://agent.example/console/api/mail-detail?path=${encodeURIComponent(detailPath)}&path=${encodeURIComponent(detailPath)}`,
      ),
      new Request(
        `https://agent.example/console/api/mail-detail?path=${encodeURIComponent(detailPath)}&next=evil`,
      ),
    ];

    for (const request of requests) {
      const response = await handleMailDetailProxy(request, {
        bearer: "secret",
        selfPort: 8080,
        fetchImpl,
      });
      expect(response.status).toBe(400);
      expect(response.headers.get("cache-control")).toBe("no-store, must-revalidate");
    }
    expect(calls).toBe(0);
  });

  it("preserves upstream status and content type without forwarding redirect authority", async () => {
    const stale = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
      selfPort: 8080,
      fetchImpl: async () =>
        new Response(JSON.stringify({ error: "stale" }), {
          status: 410,
          headers: { "content-type": "application/problem+json" },
        }),
    });
    expect(stale.status).toBe(410);
    expect(stale.headers.get("content-type")).toBe("application/problem+json");
    expect(stale.headers.get("cache-control")).toBe("no-store, must-revalidate");

    const redirect = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
      selfPort: 8080,
      fetchImpl: async () =>
        new Response(null, {
          status: 302,
          headers: { location: "https://evil.example/stolen" },
        }),
    });
    expect(redirect.status).toBe(302);
    expect(redirect.headers.get("location")).toBeNull();
  });

  it("fails privately when unavailable and rejects non-GET methods", async () => {
    const unavailable = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toEqual({ error: "mail detail proxy unavailable" });

    const failed = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
      selfPort: 8080,
      fetchImpl: async () => {
        throw new Error("contains sensitive upstream internals");
      },
    });
    expect(failed.status).toBe(502);
    expect(await failed.text()).not.toContain("sensitive upstream internals");

    const method = await handleMailDetailProxy(proxyRequest(detailPath, "POST"), {
      bearer: "secret",
      selfPort: 8080,
    });
    expect(method.status).toBe(405);
    expect(method.headers.get("allow")).toBe("GET");
    expect(method.headers.get("cache-control")).toBe("no-store, must-revalidate");
  });

  it("rejects declared and streamed upstream bodies beyond the private detail cap", async () => {
    const declared = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
      selfPort: 8080,
      fetchImpl: async () =>
        new Response("small", {
          headers: { "content-length": String(17 * 1024 * 1024 + 1) },
        }),
    });
    expect(declared.status).toBe(502);
    expect(await declared.json()).toEqual({
      error: "mail detail upstream response was invalid",
    });

    const streamed = await handleMailDetailProxy(proxyRequest(), {
      bearer: "secret",
      selfPort: 8080,
      fetchImpl: async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array(17 * 1024 * 1024));
              controller.enqueue(new Uint8Array(1));
              controller.close();
            },
          }),
        ),
    });
    expect(streamed.status).toBe(502);
    expect(streamed.headers.get("cache-control")).toBe("no-store, must-revalidate");
  });
});
