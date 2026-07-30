import { describe, expect, test } from "bun:test";
import { createAgentMailProvisioningClient } from "../../src/cli/agentmail-provisioning";
import type { HttpRequestInit, HttpResponse } from "../../src/http";

function response(url: string, status: number, body: string): HttpResponse {
  return {
    finalUrl: url,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    contentType: "application/json",
    headers: new Headers({ "content-type": "application/json" }),
    body,
  };
}

describe("createAgentMailProvisioningClient transport policy", () => {
  test("rejects non-loopback plaintext before provisioning can issue credentials", () => {
    expect(() =>
      createAgentMailProvisioningClient({
        apiBaseUrl: "http://provider.example.test/v0",
        http: {
          post: async () => {
            throw new Error("must not dispatch");
          },
          get: async () => {
            throw new Error("must not dispatch");
          },
        },
      }),
    ).toThrow(/plaintext HTTP/);
  });

  test("permits an explicit development-only override", () => {
    const previous = process.env.NODE_ENV;
    process.env.NODE_ENV = "development";
    try {
      expect(() =>
        createAgentMailProvisioningClient({
          apiBaseUrl: "http://provider.example.test/v0",
          allowInsecureHttpWithCredentials: true,
          http: {
            post: async () => {
              throw new Error("unused");
            },
            get: async () => {
              throw new Error("unused");
            },
          },
        }),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previous;
    }
  });
});

describe("createAgentMailProvisioningClient.getInbox", () => {
  test("gets and validates canonical inbox identity with bearer auth", async () => {
    let capturedUrl = "";
    let capturedAuth = "";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async () => {
          throw new Error("unused");
        },
        get: async (url: string, opts?: Omit<HttpRequestInit, "method">): Promise<HttpResponse> => {
          capturedUrl = url;
          capturedAuth = opts?.headers?.authorization ?? "";
          return response(
            url,
            200,
            JSON.stringify({
              inbox_id: "inb_x",
              email: "support@example.com",
              display_name: "Support",
            }),
          );
        },
      },
    });

    await expect(client.getInbox("am_test", "inb_x")).resolves.toEqual({
      inboxId: "inb_x",
      email: "support@example.com",
      displayName: "Support",
    });
    expect(capturedUrl).toBe("https://api.agentmail.to/v0/inboxes/inb_x");
    expect(capturedAuth).toBe("Bearer am_test");
  });

  test("accepts an omitted display name", async () => {
    const client = createAgentMailProvisioningClient({
      http: {
        post: async () => {
          throw new Error("unused");
        },
        get: async (url) =>
          response(url, 200, JSON.stringify({ inbox_id: "inb_x", email: "support@example.com" })),
      },
    });

    await expect(client.getInbox("am_test", "inb_x")).resolves.toEqual({
      inboxId: "inb_x",
      email: "support@example.com",
    });
  });

  test("rejects identity mismatches and malformed successful responses", async () => {
    const bodies = [
      JSON.stringify({ inbox_id: "inb_other", email: "support@example.com" }),
      JSON.stringify({ inbox_id: "inb_x" }),
      JSON.stringify({ inbox_id: "inb_x", email: "not-an-email" }),
      JSON.stringify({ inbox_id: "inb_x", email: "support@example.com", display_name: 42 }),
      "not-json",
    ];
    for (const body of bodies) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async () => {
            throw new Error("unused");
          },
          get: async (url) => response(url, 200, body),
        },
      });
      await expect(client.getInbox("am_test", "inb_x")).rejects.toThrow(/AgentMail/);
    }
  });

  test("rejects non-successful responses", async () => {
    const client = createAgentMailProvisioningClient({
      http: {
        post: async () => {
          throw new Error("unused");
        },
        get: async (url) => response(url, 403, "forbidden"),
      },
    });

    await expect(client.getInbox("am_test", "inb_x")).rejects.toThrow(
      "AgentMail /inboxes/inb_x failed (403)",
    );
  });
});
