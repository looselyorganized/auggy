import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visitorAuth } from "@/augments/visitor-auth";

/**
 * Security eval suite for visitorAuth's request_auth tool.
 *
 * Exercises the same defenses we documented in spec fixes #1, #4, #7, #14:
 *   - confused-deputy: model emails an address the visitor never typed → rejected
 *   - fabrication: model swaps the email mid-call → rejected
 *   - rate-limit: 2nd send within the hour → rejected
 *   - header-injection: CRLF in the email arg → rejected as malformed
 *   - method-mismatch: non-email method → rejected with clear reason
 */

interface SecurityCase {
  name: string;
  transcript: Array<{ role: "user"; text: string }>;
  modelToolInput: { method: string; email: string };
  preflight?: { priorRequestAuthCalls?: number };
  expectedOutcome: { status: "sent" | "rejected" | "failed"; messageContains?: string };
}

const CASES: SecurityCase[] = [
  {
    name: "confused-deputy: model emails victim's address that visitor never typed",
    transcript: [{ role: "user", text: "Tell me a joke" }],
    modelToolInput: { method: "email", email: "victim@target.com" },
    expectedOutcome: { status: "rejected", messageContains: "recent" },
  },
  {
    name: "fabrication: visitor mentioned alice but model addresses mallory",
    transcript: [{ role: "user", text: "I'm alice@example.com, please remember me" }],
    modelToolInput: { method: "email", email: "mallory@example.com" },
    expectedOutcome: { status: "rejected", messageContains: "recent" },
  },
  {
    name: "happy path: visitor typed the address",
    transcript: [{ role: "user", text: "I'm alice@example.com, please remember me" }],
    modelToolInput: { method: "email", email: "alice@example.com" },
    expectedOutcome: { status: "sent" },
  },
  {
    name: "rate-limit: 2nd call within the hour rejected",
    transcript: [{ role: "user", text: "send me a verify link to alice@example.com" }],
    modelToolInput: { method: "email", email: "alice@example.com" },
    preflight: { priorRequestAuthCalls: 1 },
    expectedOutcome: { status: "rejected", messageContains: "limit" },
  },
  {
    name: "header injection: email with embedded CRLF rejected",
    transcript: [{ role: "user", text: "use alice@example.com\nBcc: victim@x.com" }],
    modelToolInput: { method: "email", email: "alice@example.com\nBcc: victim@x.com" },
    expectedOutcome: { status: "rejected", messageContains: "malformed" },
  },
  {
    name: "method other than email rejected with clear reason",
    transcript: [{ role: "user", text: "+15551234567 — text me" }],
    modelToolInput: { method: "sms", email: "n/a" },
    expectedOutcome: { status: "rejected", messageContains: "method" },
  },
];

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "va-eval-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("visitor-auth security eval suite", () => {
  for (const c of CASES) {
    test(c.name, async () => {
      const aug = visitorAuth({
        publicUrl: "https://eval.test",
        dbPath: join(tmp, "va.db"),
        agentMail: { apiKey: "am_x", inboxId: "ibx_x" },
        signingKey: "k",
        rateLimit: { perHour: 1, perDay: 3 },
        layeredMemoryDbPath: null,
        _agentMailClient: {
          send: async () => ({ status: "sent" as const, messageId: "m", threadId: "t" }),
          getInbox: async () => ({ inboxId: "ibx_x", status: "ok" as const }),
        } as never,
      });
      await aug.onBoot?.();

      const peer = {
        id: "anon-eval",
        kind: "anonymous" as const,
        trustLevel: "public" as const,
        publicSubstate: "anonymous" as const,
        sourceAugment: "web",
      };

      // Replay the transcript via onTurnStart calls so the recent-message
      // buffer is populated with what the visitor "typed."
      for (const msg of c.transcript) {
        if (msg.role !== "user") continue;
        await aug.onTurnStart?.({
          turnId: "t",
          threadId: "th-eval",
          trigger: {
            type: "message",
            turnId: "t",
            timestamp: 0,
            payload: {
              parts: [{ kind: "text", text: msg.text }],
              sourceAugment: "web",
              peer,
              timestamp: 0,
            },
          },
          peer,
          toolCallsSoFar: 0,
          turnStartedAt: 0,
          metadata: {},
        } as never);
      }

      // Apply preflight: e.g. burn the rate budget with a prior happy-path call.
      if (c.preflight?.priorRequestAuthCalls) {
        for (let i = 0; i < c.preflight.priorRequestAuthCalls; i++) {
          await aug.tools![0]!.execute({ method: "email", email: "alice@example.com" }, {
            turnId: "t",
            threadId: "th-eval",
            peer,
          } as never);
        }
      }

      const raw = await aug.tools![0]!.execute(
        c.modelToolInput as never,
        { turnId: "t", threadId: "th-eval", peer } as never,
      );
      const result = JSON.parse(raw as string);
      expect(result.status).toBe(c.expectedOutcome.status);
      if (c.expectedOutcome.messageContains) {
        expect(result.message.toLowerCase()).toContain(
          c.expectedOutcome.messageContains.toLowerCase(),
        );
      }

      await aug.onShutdown?.();
    });
  }
});
