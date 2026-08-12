import { afterEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { AgentMailProvider } from "../../src/augments/agentMail/provider";
import { runAgentMailProviderCanary } from "../../scripts/agentmail-provider-canary";

const API_KEY = "am_canary_exact_test_key";
const INBOX_ID = "canary@agentmail.to";

const originalLog = console.log;

afterEach(() => {
  console.log = originalLog;
});

function provider(overrides: Partial<AgentMailProvider> = {}): AgentMailProvider {
  return {
    verifyAccess: async () => ({
      scopeType: "inbox",
      scopeId: INBOX_ID,
      organizationId: "org_test",
      inboxId: INBOX_ID,
      configuredInboxId: INBOX_ID,
      emailAddress: INBOX_ID,
    }),
    listMessages: async () => ({ messages: [] }),
    getMessage: async () => {
      throw new Error("not used");
    },
    getThread: async () => {
      throw new Error("not used");
    },
    listDrafts: async () => ({ drafts: [] }),
    createReplyDraft: async () => {
      throw new Error("mutation must not run");
    },
    getDraft: async () => {
      throw new Error("not used");
    },
    updateDraft: async () => {
      throw new Error("mutation must not run");
    },
    sendDraft: async () => {
      throw new Error("mutation must not run");
    },
    sendMessage: async () => {
      throw new Error("mutation must not run");
    },
    connect: async () => ({ close() {} }),
    ...overrides,
  };
}

describe("AgentMail provider canary contract", () => {
  test("uses the exact pre-provisioned inbox key for read-only runtime probes", async () => {
    const calls: string[] = [];
    let closed = false;
    const createProvider = mock((input: { apiKey: string; inboxId: string }) => {
      expect(input).toEqual({ apiKey: API_KEY, inboxId: INBOX_ID });
      return provider({
        verifyAccess: async () => {
          calls.push("verify");
          return {
            scopeType: "inbox",
            scopeId: INBOX_ID,
            organizationId: "org_test",
            inboxId: INBOX_ID,
            configuredInboxId: INBOX_ID,
            emailAddress: INBOX_ID,
          };
        },
        listMessages: async (input) => {
          calls.push(`messages:${input?.limit}`);
          return { messages: [] };
        },
        listDrafts: async (input) => {
          calls.push(`drafts:${input?.limit}`);
          return { drafts: [] };
        },
        connect: async () => {
          calls.push("connect");
          return {
            close() {
              closed = true;
            },
          };
        },
      });
    });
    const output: string[] = [];
    console.log = (...args: unknown[]) => output.push(args.map(String).join(" "));

    await runAgentMailProviderCanary({
      apiKey: API_KEY,
      inboxId: INBOX_ID,
      inboxEmail: INBOX_ID,
      createProvider,
      observeLiveMs: 0,
    });

    expect(createProvider).toHaveBeenCalledTimes(1);
    expect(calls).toEqual(["verify", "messages:1", "drafts:1", "connect"]);
    expect(closed).toBe(true);
    expect(output.join("\n")).toContain(
      "No AgentMail resource was created, changed, sent, or deleted",
    );
    expect(output.join("\n")).not.toContain(API_KEY);
    expect(output.join("\n")).not.toContain(INBOX_ID);
  });

  test("fails closed when AgentMail resolves a different inbox identity", async () => {
    let connected = false;
    await expect(
      runAgentMailProviderCanary({
        apiKey: API_KEY,
        inboxId: INBOX_ID,
        inboxEmail: INBOX_ID,
        createProvider: () =>
          provider({
            verifyAccess: async () => ({
              scopeType: "inbox",
              scopeId: "other@agentmail.to",
              organizationId: "org_test",
              inboxId: "other@agentmail.to",
              configuredInboxId: "other@agentmail.to",
              emailAddress: "other@agentmail.to",
            }),
            connect: async () => {
              connected = true;
              return { close() {} };
            },
          }),
        observeLiveMs: 0,
      }),
    ).rejects.toThrow(/does not match the protected canary configuration/);
    expect(connected).toBe(false);
  });

  test("aborts timed-out provider work and closes a late WebSocket result", async () => {
    let connectSignal: AbortSignal | undefined;
    let resolveConnect!: (subscription: { close(): void }) => void;
    let closed = false;
    const lateConnection = new Promise<{ close(): void }>((resolve) => {
      resolveConnect = resolve;
    });

    const result = runAgentMailProviderCanary({
      apiKey: API_KEY,
      inboxId: INBOX_ID,
      inboxEmail: INBOX_ID,
      createProvider: () =>
        provider({
          connect: async (_handlers, signal) => {
            connectSignal = signal;
            return lateConnection;
          },
        }),
      observeLiveMs: 0,
      operationTimeoutMs: 1,
    });

    await expect(result).rejects.toThrow(
      /Timed out waiting for WebSocket connection and inbox subscription/,
    );
    expect(connectSignal?.aborted).toBe(true);

    resolveConnect({
      close() {
        closed = true;
      },
    });
    await Bun.sleep(0);
    expect(closed).toBe(true);
  });

  test("workflow exposes only the protected exact-key, inbox-existing contract", () => {
    const workflow = readFileSync(
      join(import.meta.dir, "../../.github/workflows/agentmail-provider-canary.yml"),
      "utf8",
    );
    expect(workflow).toContain("secrets.AGENTMAIL_CANARY_RUNTIME_API_KEY");
    expect(workflow).toContain("vars.AGENTMAIL_CANARY_INBOX_ID");
    expect(workflow).toContain("vars.AGENTMAIL_CANARY_INBOX_EMAIL");
    expect(workflow).toContain("bun scripts/agentmail-provider-canary.ts");
    expect(workflow).not.toContain("AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY");
    expect(workflow).not.toMatch(/create(?:s)? one persistent canary inbox/i);
  });
});
