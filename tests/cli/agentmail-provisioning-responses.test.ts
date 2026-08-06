import { describe, expect, test } from "bun:test";
import {
  AgentMailProvisioningResponseError,
  createAgentMailProvisioningClient,
} from "../../src/cli/agentmail-provisioning";
import type { HttpResponse } from "../../src/http";

function response(url: string, body: unknown): HttpResponse {
  return {
    finalUrl: url,
    status: 200,
    statusText: "OK",
    contentType: "application/json",
    headers: new Headers({ "content-type": "application/json" }),
    body: JSON.stringify(body),
  };
}

function clientFor(body: unknown) {
  return createAgentMailProvisioningClient({
    http: {
      post: async (url) => response(url, body),
      get: async () => {
        throw new Error("unused");
      },
    },
  });
}

async function rejected(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AgentMailProvisioningResponseError);
    return error as Error;
  }
  throw new Error("Expected promise to reject");
}

describe("AgentMail provisioning success-response contracts", () => {
  test("signUp rejects every malformed success envelope without exposing returned secrets", async () => {
    const valid = {
      organization_id: "org_valid",
      inbox_id: "inb_valid",
      api_key: "am_valid",
    };
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...valid, organization_id: undefined },
      { ...valid, inbox_id: undefined },
      { ...valid, api_key: undefined },
      { ...valid, organization_id: "org\ninvalid" },
      { ...valid, inbox_id: "inb\u001binvalid" },
      { ...valid, api_key: "am_raw_secret\ninvalid" },
      { ...valid, organization_id: "o".repeat(257) },
      { ...valid, inbox_id: "i".repeat(257) },
      { ...valid, api_key: "a".repeat(4097) },
    ];

    for (const body of malformed) {
      const error = await rejected(
        clientFor(body).signUp({ humanEmail: "owner@example.com", username: "test-agent" }),
      );
      expect(error.message).toMatch(/AgentMail \/agent\/sign-up returned an invalid response/i);
      expect(error.message).not.toContain("am_raw_secret");
      expect(error).not.toHaveProperty("body");
    }
  });

  test("verify accepts exact booleans and rejects missing or non-boolean values", async () => {
    await expect(clientFor({ verified: true }).verify("am_parent", "123456")).resolves.toEqual({
      verified: true,
    });
    await expect(clientFor({ verified: false }).verify("am_parent", "123456")).resolves.toEqual({
      verified: false,
    });

    for (const body of [null, [], {}, { verified: "true" }, { verified: 1 }, { verified: null }]) {
      const error = await rejected(clientFor(body).verify("am_parent", "123456"));
      expect(error.message).toMatch(/AgentMail \/agent\/verify returned an invalid response/i);
      expect(error).not.toHaveProperty("body");
    }
  });

  test("createInbox rejects invalid identity, email, and display fields", async () => {
    const valid = {
      inbox_id: "inb_valid",
      email: "test-agent@agentmail.to",
      display_name: "Test Agent",
    };
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...valid, inbox_id: undefined },
      { ...valid, email: undefined },
      { ...valid, inbox_id: "inb\ninvalid" },
      { ...valid, inbox_id: "i".repeat(257) },
      { ...valid, email: "not-an-email" },
      { ...valid, email: "test\nagent@agentmail.to" },
      { ...valid, email: `${"a".repeat(65)}@agentmail.to` },
      { ...valid, display_name: "Test\u001bAgent" },
      { ...valid, display_name: "d".repeat(257) },
    ];

    for (const body of malformed) {
      const error = await rejected(
        clientFor(body).createInbox({ apiKey: "am_parent", username: "test-agent" }),
      );
      expect(error.message).toMatch(/AgentMail \/inboxes returned an invalid response/i);
      expect(error).not.toHaveProperty("body");
    }
  });

  test("createInbox rejects a mismatched returned idempotency identity", async () => {
    const client = clientFor({
      inbox_id: "inb_1",
      email: "agent@agentmail.to",
      client_id: "another.logical.resource",
    });

    await expect(
      client.createInbox({
        apiKey: "am_parent",
        clientId: "auggy.v1.inbox.aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c.agentMail",
      }),
    ).rejects.toThrow(/client_id did not match the requested idempotency identity/);
  });

  test("createInboxApiKey rejects missing, control-bearing, and oversized credentials", async () => {
    const valid = { api_key_id: "key_valid", api_key: "am_runtime_valid" };
    const malformed: unknown[] = [
      null,
      [],
      {},
      { ...valid, api_key_id: undefined },
      { ...valid, api_key: undefined },
      { ...valid, api_key_id: "key\ninvalid" },
      { ...valid, api_key_id: "k".repeat(257) },
      { ...valid, api_key: "am_raw_secret\u001binvalid" },
      { ...valid, api_key: "a".repeat(4097) },
    ];

    for (const body of malformed) {
      const error = await rejected(
        clientFor(body).createInboxApiKey({
          apiKey: "am_parent",
          inboxId: "inb_valid",
          name: "test-agent agentMail",
          permissions: { inbox_read: true, message_send: true },
        }),
      );
      expect(error.message).toMatch(
        /AgentMail \/inboxes\/inb_valid\/api-keys returned an invalid response/i,
      );
      expect(error.message).not.toContain("am_raw_secret");
      expect(error).not.toHaveProperty("body");
    }
  });
});
