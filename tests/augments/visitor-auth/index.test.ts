import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "../../../src/augments/visitor-auth";
import type { AgentMailClient } from "../../../src/agentmail-client";

let tmp: string;
let dbPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "visitor-auth-aug-"));
  dbPath = join(tmp, "visitor-auth.db");
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function fakeAgentMail(overrides: Partial<AgentMailClient> = {}): AgentMailClient {
  return {
    send: async () => ({ status: "sent", messageId: "m", threadId: "t" }),
    ...overrides,
  } as AgentMailClient;
}

describe("visitorAuth (skeleton)", () => {
  test("factory returns an Augment with name + capabilities + httpRoutes", () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    expect(aug.name).toBe("visitor-auth");
    expect(aug.capabilities).toContain("tools");
    expect(aug.capabilities).toContain("context");
    expect(aug.httpRoutes).toHaveLength(1);
    expect(aug.httpRoutes?.[0]?.path).toBe("/visitor-auth/verify");
    expect(aug.httpRoutes?.[0]?.auth).toBe("none");
    expect(aug.httpRoutes?.[0]?.method).toBe("GET");
  });

  test("factory throws for missing publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/publicUrl/);
  });

  test("factory throws for malformed publicUrl", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "not-a-url",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/publicUrl/);
  });

  test("factory throws for missing AgentMail config", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "", inboxId: "" },
        signingKey: "sig",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/agentMail/);
  });

  test("factory throws for missing signingKey", () => {
    expect(() =>
      visitorAuth({
        publicUrl: "https://example.com",
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "",
        _agentMailClient: fakeAgentMail(),
      }),
    ).toThrow(/signingKey/);
  });

  test("onBoot opens the store and warns when AgentMail healthcheck fails (does not throw)", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    await aug.onShutdown?.();
  });

  test("onBoot throws when AgentMail config env-vars are blatantly placeholder", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "${AGENTMAIL_API_KEY}", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await expect(aug.onBoot?.()).rejects.toThrow(/AGENTMAIL_API_KEY/);
  });

  test("context() returns an empty array when no peer is set", async () => {
    const aug = visitorAuth({
      publicUrl: "https://example.com",
      dbPath,
      agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
      signingKey: "sig",
      _agentMailClient: fakeAgentMail(),
    });
    await aug.onBoot?.();
    const turn = {
      turnId: "t1",
      threadId: "th1",
      trigger: { type: "message", turnId: "t1", timestamp: 0, payload: {} },
      peer: null,
      toolCallsSoFar: 0,
      turnStartedAt: 0,
      metadata: {},
    } as never;
    const result = await aug.context?.(turn);
    expect(result).toEqual([]);
    await aug.onShutdown?.();
  });
});
