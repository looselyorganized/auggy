import { describe, expect, test } from "bun:test";
import {
  AgentMailProvisioningApiError,
  AgentMailProvisioningResponseError,
  AgentMailProvisioningTransportError,
  buildAgentMailClientId,
  buildAgentMailRuntimeKeyPermissions,
  createAgentMailProvisioningClient,
} from "../../src/cli/agentmail-provisioning";
import { HttpTimeoutError, type HttpRequestInit, type HttpResponse } from "../../src/http";
import { isOutcomeUnknownError } from "../../src/outcome-unknown";

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

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("Expected promise to reject");
}

describe("buildAgentMailClientId", () => {
  const agentId = "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c";

  test("builds deterministic, provider-valid, resource-scoped inbox identifiers", () => {
    const clientId = buildAgentMailClientId(agentId, "agentMail");

    expect(clientId).toBe("auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.agentMail");
    expect(buildAgentMailClientId(agentId, "agentMail")).toBe(clientId);
    expect(clientId).toMatch(/^[A-Za-z0-9._~-]{1,256}$/);
  });

  test("uses distinct idempotency identities for each setup target", () => {
    expect(buildAgentMailClientId(agentId, "agentMail")).not.toBe(
      buildAgentMailClientId(agentId, "visitorAuth"),
    );
  });

  test("requires the immutable canonical agent identity", () => {
    for (const invalid of ["", "dx-agent", "agent:id", "aug1_not-a-uuid"]) {
      expect(() => buildAgentMailClientId(invalid, "agentMail")).toThrow(
        /valid immutable aug1_ UUID/,
      );
    }
  });
});

describe("buildAgentMailRuntimeKeyPermissions", () => {
  test("uses the outbound-only permission set when inbound is disabled", () => {
    expect(buildAgentMailRuntimeKeyPermissions({ inboundEnabled: false })).toEqual({
      inbox_read: true,
      message_send: true,
    });
  });

  test("adds only message_read for ordinary inbound mail", () => {
    expect(buildAgentMailRuntimeKeyPermissions({ inboundEnabled: true })).toEqual({
      inbox_read: true,
      message_send: true,
      message_read: true,
    });
  });

  test("adds label visibility only for classifications that are processed", () => {
    expect(
      buildAgentMailRuntimeKeyPermissions({
        inboundEnabled: true,
        processSpam: true,
        processBlocked: true,
      }),
    ).toEqual({
      inbox_read: true,
      message_send: true,
      message_read: true,
      label_spam_read: true,
      label_blocked_read: true,
    });
    expect(
      buildAgentMailRuntimeKeyPermissions({
        inboundEnabled: true,
        processSpam: false,
        processBlocked: true,
      }),
    ).toEqual({
      inbox_read: true,
      message_send: true,
      message_read: true,
      label_blocked_read: true,
    });
  });

  test("rejects label visibility when inbound is disabled", () => {
    expect(() =>
      buildAgentMailRuntimeKeyPermissions({ inboundEnabled: false, processSpam: true }),
    ).toThrow(/require inbound delivery/);
  });
});

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

describe("createAgentMailProvisioningClient.createInbox client_id contract", () => {
  test("rejects an invalid client_id before dispatch without exposing credentials", async () => {
    let dispatched = false;
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) => {
          dispatched = true;
          return response(url, 500, "unexpected");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const apiKey = "am_secret_parent_key";
    let message = "";
    try {
      await client.createInbox({ apiKey, username: "test-agent", clientId: "auggy:bad:id" });
    } catch (error) {
      message = (error as Error).message;
    }

    expect(dispatched).toBe(false);
    expect(message).toMatch(/AgentMail client_id must be 1-256 characters/);
    expect(message).not.toContain(apiKey);
  });

  test("accepts exact minimum and maximum lengths and rejects every invalid boundary or character", async () => {
    let dispatches = 0;
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) => {
          dispatches += 1;
          return response(url, 200, JSON.stringify({ inbox_id: "inb_x", email: "x@example.com" }));
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    for (const valid of ["a", "x".repeat(256), "letters.NUMBERS-1_2~3"]) {
      await expect(
        client.createInbox({ apiKey: "am_parent", clientId: valid }),
      ).resolves.toMatchObject({ inboxId: "inb_x" });
    }
    expect(dispatches).toBe(3);

    for (const invalid of ["", "x".repeat(257), "has:colon", "has space", "has@at", "unicode-é"]) {
      await expect(client.createInbox({ apiKey: "am_parent", clientId: invalid })).rejects.toThrow(
        /AgentMail client_id must be 1-256 characters/,
      );
    }
    expect(dispatches).toBe(3);
  });

  test("passes a valid client_id to the provider unchanged", async () => {
    let body = "";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url, opts) => {
          body = typeof opts?.body === "string" ? opts.body : "";
          return response(
            url,
            200,
            JSON.stringify({ inbox_id: "inb_x", email: "test-agent@agentmail.to" }),
          );
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });
    const clientId = buildAgentMailClientId(
      "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
      "agentMail",
    );

    await expect(
      client.createInbox({ apiKey: "am_parent", username: "test-agent", clientId }),
    ).resolves.toMatchObject({ inboxId: "inb_x" });
    expect(JSON.parse(body)).toMatchObject({ client_id: clientId });
  });

  test("rejects out-of-contract metadata before dispatch and never truncates it", async () => {
    let dispatches = 0;
    let requestBody = "";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url, opts) => {
          dispatches += 1;
          requestBody = typeof opts?.body === "string" ? opts.body : "";
          return response(url, 200, JSON.stringify({ inbox_id: "inb_x", email: "x@example.com" }));
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const boundaryValue = "v".repeat(256);
    await expect(
      client.createInbox({ apiKey: "am_parent", metadata: { ["k".repeat(256)]: boundaryValue } }),
    ).resolves.toMatchObject({ inboxId: "inb_x" });
    expect(JSON.parse(requestBody).metadata).toEqual({ ["k".repeat(256)]: boundaryValue });

    const tooMany = Object.fromEntries(
      Array.from({ length: 257 }, (_, index) => [`key-${index}`, "value"]),
    );
    for (const metadata of [
      tooMany,
      { ["k".repeat(257)]: "value" },
      { key: "v".repeat(257) },
      { key: Number.NaN },
    ]) {
      await expect(client.createInbox({ apiKey: "am_parent", metadata })).rejects.toThrow(
        /AgentMail metadata/,
      );
    }
    expect(dispatches).toBe(1);
  });
});

describe("createAgentMailProvisioningClient provider failures", () => {
  test("preserves safe validation details while redacting request credentials", async () => {
    const apiKey = "am_secret_parent_key";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({
              name: "ValidationError",
              code: "validation_error",
              message: `Request validation failed for ${apiKey}`,
              errors: [
                {
                  code: "invalid_format",
                  path: ["client_id"],
                  message: `Client ID must match the provider format; token=${apiKey}`,
                },
              ],
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const error = await rejection(client.createInbox({ apiKey, username: "test-agent" }));
    expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
    expect(error).toMatchObject({
      name: "AgentMailProvisioningApiError",
      status: 400,
      operation: "/inboxes",
      providerName: "ValidationError",
      providerCode: "validation_error",
      providerMessage: "Request validation failed for [redacted]",
      issues: [
        {
          code: "invalid_format",
          path: ["client_id"],
          message: "Client ID must match the provider format; token=[redacted]",
        },
      ],
    });
    expect(String(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(error).not.toHaveProperty("body");
  });

  test("exposes AlreadyExists as structured status and provider identity", async () => {
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            403,
            JSON.stringify({
              name: "AlreadyExistsError",
              code: "already_exists",
              message: "User already exists",
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(
      rejection(client.signUp({ humanEmail: "owner@example.com", username: "agent" })),
    ).resolves.toMatchObject({
      status: 403,
      providerName: "AlreadyExistsError",
      providerCode: "already_exists",
      providerMessage: "User already exists",
    });
  });

  test("keeps 401, 409, and 429 failures distinct and never retries mutations", async () => {
    for (const status of [401, 409, 429]) {
      let dispatches = 0;
      const client = createAgentMailProvisioningClient({
        http: {
          post: async (url) => {
            dispatches += 1;
            return response(
              url,
              status,
              JSON.stringify({ name: "ProviderError", code: `status_${status}` }),
            );
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(
        client.createInbox({ apiKey: "am_parent", username: "test-agent" }),
      );
      expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
      expect(error).toMatchObject({ status, providerCode: `status_${status}` });
      expect(isOutcomeUnknownError(error)).toBe(false);
      expect(dispatches).toBe(1);
    }
  });

  test("marks ambiguous mutation HTTP responses as unknown outcomes", async () => {
    for (const status of [408, 500, 503]) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async (url) => response(url, status, JSON.stringify({ code: "provider_failure" })),
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(client.createInbox({ apiKey: "am_parent" }));
      expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
      expect(error).toMatchObject({ status, outcomeUnknown: true });
      expect(isOutcomeUnknownError(error)).toBe(true);
    }
  });

  test("does not retain malformed or non-object error response bodies", async () => {
    for (const body of ["<!doctype html>am_secret", '["am_secret"]', "null"]) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async (url) => response(url, 401, body),
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(client.createInbox({ apiKey: "am_secret" }));
      expect(error).toBeInstanceOf(AgentMailProvisioningApiError);
      expect(error).toMatchObject({ status: 401, issues: [] });
      expect(String(error)).not.toContain("am_secret");
      expect(error).not.toHaveProperty("body");
    }
  });

  test("marks timeout and network failures as unknown outcomes without leaking causes", async () => {
    for (const failure of [
      new HttpTimeoutError(25),
      new Error("socket failed while sending am_secret_parent"),
    ]) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async () => {
            throw failure;
          },
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(
        client.createInbox({ apiKey: "am_secret_parent", username: "test-agent" }),
      );
      expect(error).toBeInstanceOf(AgentMailProvisioningTransportError);
      expect(isOutcomeUnknownError(error)).toBe(true);
      expect(error).toMatchObject({
        outcomeUnknown: true,
        kind: failure instanceof HttpTimeoutError ? "timeout" : "network",
      });
      expect(String(error)).not.toContain("am_secret_parent");
      expect(error).not.toHaveProperty("cause");
    }
  });

  test("classifies read-only transport failures as retryable without outcome ambiguity", async () => {
    const client = createAgentMailProvisioningClient({
      http: {
        post: async () => {
          throw new Error("unused");
        },
        get: async () => {
          throw new HttpTimeoutError(25);
        },
      },
    });

    const error = await rejection(client.getInbox("am_secret", "inb_x"));
    expect(error).toBeInstanceOf(AgentMailProvisioningTransportError);
    expect(error).toMatchObject({ kind: "timeout", retryable: true });
    expect(isOutcomeUnknownError(error)).toBe(false);
  });

  test("rejects malformed success responses with a typed, body-free contract error", async () => {
    for (const body of ["not-json", JSON.stringify({ inbox_id: "inb_x" })]) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async (url) => response(url, 200, body),
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(
        client.createInbox({ apiKey: "am_secret", username: "test-agent" }),
      );
      expect(error).toBeInstanceOf(AgentMailProvisioningResponseError);
      expect(isOutcomeUnknownError(error)).toBe(true);
      expect(String(error)).not.toContain(body);
      expect(error).not.toHaveProperty("body");
    }
  });
});
