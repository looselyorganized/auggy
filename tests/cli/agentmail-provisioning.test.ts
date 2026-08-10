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

describe("createAgentMailProvisioningClient.listInboxes", () => {
  test("lists bounded account-owned inboxes across pages with client identities", async () => {
    const urls: string[] = [];
    const auth: string[] = [];
    const client = createAgentMailProvisioningClient({
      http: {
        post: async () => {
          throw new Error("unused");
        },
        get: async (url, opts) => {
          urls.push(url);
          auth.push(opts?.headers?.authorization ?? "");
          if (urls.length === 1) {
            return response(
              url,
              200,
              JSON.stringify({
                inboxes: [
                  {
                    inbox_id: "inb_visitor",
                    email: "support@agentmail.to",
                    client_id:
                      "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
                  },
                ],
                next_page_token: "page_2",
              }),
            );
          }
          return response(
            url,
            200,
            JSON.stringify({
              inboxes: [{ inbox_id: "inb_other", email: "other@agentmail.to" }],
            }),
          );
        },
      },
    });

    await expect(client.listInboxes?.("am_account")).resolves.toEqual([
      {
        inboxId: "inb_visitor",
        email: "support@agentmail.to",
        clientId: "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.visitorAuth",
      },
      { inboxId: "inb_other", email: "other@agentmail.to" },
    ]);
    expect(urls).toEqual([
      "https://api.agentmail.to/v0/inboxes?limit=100",
      "https://api.agentmail.to/v0/inboxes?limit=100&page_token=page_2",
    ]);
    expect(auth).toEqual(["Bearer am_account", "Bearer am_account"]);
  });

  test("fails closed on malformed or looping inbox pagination", async () => {
    for (const body of [
      { inboxes: [{ inbox_id: "inb_1", email: "one@agentmail.to", client_id: "bad:id" }] },
      { inboxes: [], next_page_token: "repeat" },
    ]) {
      let calls = 0;
      const client = createAgentMailProvisioningClient({
        http: {
          post: async () => {
            throw new Error("unused");
          },
          get: async (url) => {
            calls += 1;
            return response(url, 200, JSON.stringify(body));
          },
        },
      });

      await expect(client.listInboxes?.("am_account")).rejects.toBeInstanceOf(
        AgentMailProvisioningResponseError,
      );
      expect(calls).toBe(body.next_page_token ? 2 : 1);
    }
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
        post: async (url, opts) => {
          dispatches += 1;
          const request = JSON.parse(String(opts?.body)) as { client_id?: string };
          return response(
            url,
            200,
            JSON.stringify({
              inbox_id: "inb_x",
              email: "x@example.com",
              client_id: request.client_id,
            }),
          );
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
            JSON.stringify({
              inbox_id: "inb_x",
              email: "test-agent@agentmail.to",
              client_id: (JSON.parse(body) as { client_id: string }).client_id,
            }),
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
      { "": "value" },
      { ["k".repeat(257)]: "value" },
      { "bad\u001bkey": "value" },
      { key: "" },
      { key: "v".repeat(257) },
      { key: "bad\u001bvalue" },
      { key: Number.NaN },
    ]) {
      await expect(client.createInbox({ apiKey: "am_parent", metadata })).rejects.toThrow(
        /AgentMail metadata/,
      );
    }
    expect(dispatches).toBe(1);
  });

  test("validates every provider-bound inbox and key field before transport", async () => {
    let dispatches = 0;
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url, opts) => {
          dispatches += 1;
          const body = JSON.parse(String(opts?.body)) as Record<string, unknown>;
          if (url.endsWith("/api-keys")) {
            return response(
              url,
              200,
              JSON.stringify({
                api_key_id: "key_valid",
                api_key: "am_runtime_valid",
                name: body.name,
                inbox_id: "inb_valid",
                permissions: body.permissions,
              }),
            );
          }
          return response(
            url,
            200,
            JSON.stringify({
              inbox_id: "inb_valid",
              email: `${body.username}@${body.domain ?? "agentmail.to"}`,
              client_id: body.client_id,
            }),
          );
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(
      client.createInbox({
        apiKey: "am_parent",
        username: "u".repeat(64),
        domain: "mail.example",
        displayName: "d".repeat(256),
        clientId: "valid",
      }),
    ).resolves.toMatchObject({ email: `${"u".repeat(64)}@mail.example` });
    await expect(
      client.createInboxApiKey({
        apiKey: "am_parent",
        inboxId: "inb_valid",
        name: "n".repeat(256),
        permissions: { inbox_read: true, message_send: true },
      }),
    ).resolves.toMatchObject({ apiKeyId: "key_valid" });
    expect(dispatches).toBe(2);

    const invalidInboxInputs = [
      { apiKey: "am_parent", username: "u".repeat(65) },
      { apiKey: "am_parent", username: "-leading" },
      { apiKey: "am_parent", username: "has.dot" },
      { apiKey: "am_parent", username: "valid", domain: "invalid_domain" },
      { apiKey: "am_parent", username: "valid", domain: "d".repeat(254) },
      { apiKey: "am_parent", username: "valid", displayName: "bad\u001bname" },
      { apiKey: "am_parent", username: "valid", displayName: "d".repeat(257) },
      { apiKey: "am parent", username: "valid" },
    ];
    for (const input of invalidInboxInputs) {
      await expect(client.createInbox(input)).rejects.toThrow(/AgentMail/);
    }

    const validKeyInput = {
      apiKey: "am_parent",
      inboxId: "inb_valid",
      name: "runtime key",
      permissions: { inbox_read: true, message_send: true },
    };
    for (const input of [
      { ...validKeyInput, apiKey: "am parent" },
      { ...validKeyInput, inboxId: "inb invalid" },
      { ...validKeyInput, name: "bad\u001bname" },
      { ...validKeyInput, name: "n".repeat(257) },
      { ...validKeyInput, permissions: {} },
      { ...validKeyInput, permissions: { "bad-permission": true } },
    ]) {
      await expect(
        client.createInboxApiKey(input as Parameters<typeof client.createInboxApiKey>[0]),
      ).rejects.toThrow(/AgentMail/);
    }
    expect(dispatches).toBe(2);
  });

  test("validates signup and verification fields before transport", async () => {
    let dispatches = 0;
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) => {
          dispatches += 1;
          return response(url, 500, "unexpected");
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    for (const input of [
      { humanEmail: "not-an-email", username: "valid" },
      { humanEmail: "owner@example.com", username: "u".repeat(65) },
      { humanEmail: "owner@example.com", username: "valid", source: "bad\u001bsource" },
      { humanEmail: "owner@example.com", username: "valid", referrer: "r".repeat(2_049) },
    ]) {
      await expect(client.signUp(input)).rejects.toThrow(/AgentMail/);
    }
    await expect(client.verify("am parent", "123456")).rejects.toThrow(/AgentMail/);
    await expect(client.verify("am_parent", "1 2")).rejects.toThrow(/AgentMail/);
    expect(dispatches).toBe(0);
  });

  test("accepts documented 2048-character source and referrer boundaries", async () => {
    let requestBody: Record<string, unknown> = {};
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url, opts) => {
          requestBody = JSON.parse(String(opts?.body)) as Record<string, unknown>;
          return response(
            url,
            200,
            JSON.stringify({ organization_id: "org_1", inbox_id: "inb_1", api_key: "am_key" }),
          );
        },
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    await expect(
      client.signUp({
        humanEmail: "owner@example.com",
        username: "valid",
        source: "s".repeat(2_048),
        referrer: "r".repeat(2_048),
      }),
    ).resolves.toMatchObject({ inboxId: "inb_1" });
    expect(requestBody.source).toBe("s".repeat(2_048));
    expect(requestBody.referrer).toBe("r".repeat(2_048));
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

  test("redacts provider-returned AgentMail credentials and short OTP request values", async () => {
    const providerToken = "am_new_provider_secret";
    const tokenClient = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({
              code: "provider_error",
              message: `Debug generated key ${providerToken}`,
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });
    const tokenError = await rejection(
      tokenClient.createInbox({ apiKey: "am_parent", clientId: "valid" }),
    );
    expect(String(tokenError)).not.toContain(providerToken);
    expect(tokenError).toMatchObject({ providerMessage: "Debug generated key [redacted]" });

    const otp = "123";
    const otpClient = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({ code: "invalid_otp", message: `OTP ${otp} was rejected` }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });
    const otpError = await rejection(otpClient.verify("am_parent", otp));
    expect(String(otpError)).not.toContain(otp);
    expect(otpError).toMatchObject({ providerMessage: "OTP [redacted] was rejected" });
  });

  test("drops secret-bearing structured provider identifiers and issue paths", async () => {
    const apiKey = "am_parent_structured_secret";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({
              name: `Error_${apiKey}`,
              code: `failure_${apiKey}`,
              message: "Request rejected",
              errors: [
                {
                  code: `invalid_${apiKey}`,
                  path: [apiKey],
                  message: "Invalid request",
                },
                {
                  code: "whsec_provider_generated_secret",
                  path: ["api_key"],
                  message: "Provider rejected the request",
                },
              ],
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const error = await rejection(client.createInbox({ apiKey, username: "support" }));
    expect(error).toMatchObject({
      providerName: undefined,
      providerCode: undefined,
      providerMessage: "Request rejected",
      issues: [{ path: ["api_key"], message: "Provider rejected the request" }],
    });
    expect((error as AgentMailProvisioningApiError).issues[0]).not.toHaveProperty("code");
    expect(String(error)).not.toContain(apiKey);
    expect(String(error)).not.toContain("whsec_provider_generated_secret");
    expect(JSON.stringify(error)).not.toContain(apiKey);
    expect(JSON.stringify(error)).not.toContain("whsec_provider_generated_secret");
  });

  test("redacts raw sensitive values before provider diagnostic normalization", async () => {
    const displayName = "Top  Secret";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({
              code: "validation_error",
              message: `Rejected display name ${displayName}`,
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const error = await rejection(
      client.createInbox({ apiKey: "am_parent", username: "support", displayName }),
    );
    expect(error).toMatchObject({
      providerCode: "validation_error",
      providerMessage: "Rejected display name [redacted]",
    });
    for (const serialized of [String(error), JSON.stringify(error)]) {
      expect(serialized).not.toContain(displayName);
      expect(serialized).not.toContain("Top Secret");
    }
  });

  test("redacts one-to-three-character sensitive fields from every retained error surface", async () => {
    for (const username of ["a", "id", "abc"]) {
      const client = createAgentMailProvisioningClient({
        http: {
          post: async (url) =>
            response(
              url,
              400,
              JSON.stringify({
                name: `Error_${username}`,
                code: "validation_error",
                message: `Rejected ${username}`,
                errors: [
                  {
                    code: `invalid_${username}`,
                    path: [username],
                    message: `Invalid ${username}`,
                  },
                ],
              }),
            ),
          get: async () => {
            throw new Error("unused");
          },
        },
      });

      const error = await rejection(client.createInbox({ apiKey: "am_parent", username }));
      expect(error).toMatchObject({
        providerName: undefined,
        providerCode: "validation_error",
        providerMessage: "Rejected [redacted]",
        issues: [],
      });
      for (const serialized of [String(error), JSON.stringify(error)]) {
        expect(serialized).not.toContain(`Error_${username}`);
        expect(serialized).not.toContain(`Rejected ${username}`);
        expect(serialized).not.toContain(`invalid_${username}`);
        expect(serialized).not.toContain(`Invalid ${username}`);
      }
    }
  });

  test("fully scrubs embedded am_ and whsec_ credential variants", async () => {
    const apiCredential = "am_generated+/=tail";
    const webhookCredential = "whsec_generated+/=tail";
    const client = createAgentMailProvisioningClient({
      http: {
        post: async (url) =>
          response(
            url,
            400,
            JSON.stringify({
              code: "provider_error",
              message: `generated x${apiCredential} and prefix${webhookCredential}`,
            }),
          ),
        get: async () => {
          throw new Error("unused");
        },
      },
    });

    const error = await rejection(client.createInbox({ apiKey: "am_parent", username: "safe" }));
    expect(error).toMatchObject({
      providerCode: "provider_error",
      providerMessage: "generated x[redacted] and prefix[redacted]",
    });
    for (const serialized of [String(error), JSON.stringify(error)]) {
      expect(serialized).not.toContain(apiCredential);
      expect(serialized).not.toContain(webhookCredential);
      expect(serialized).not.toContain("am_generated");
      expect(serialized).not.toContain("whsec_generated");
    }
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
