/**
 * End-to-end integration test for the visitorAuth full flow:
 *
 *   anonymous → request_auth tool call → magic-link email → verify route
 *   → vis_<uuid> token → recognized peer on next /agent/run
 *
 * This test wires a real defineAgent + real webTransport on a free port
 * with a stubbed AgentMail client. It exercises:
 *
 *  1. Anonymous visitor sends "hi I'm alice@example.com" via /agent/run.
 *  2. Mock model calls request_auth({ method: "email", email: "alice@example.com" }).
 *  3. visitorAuth issues a token, the stub records the magic-link URL.
 *  4. Test GETs the verify URL; asserts 200.
 *  5. Test extracts the vis_<uuid> token from the success-page HTML.
 *  6. Test sends a 2nd /agent/run with x-visitor-token: <vis_token>.
 *  7. Assertion: webTransport Path 3 verifies the token → peer becomes
 *     recognized. Observable as: no x-visitor-token header in the SSE
 *     response (issued only for anonymous/invalid-token requests) AND
 *     visitorAuth context block appears in the model's systemBlocks
 *     (confirmed via model.calls[N].contextBlocks containing the email).
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { webTransport } from "@/transports/web-transport";
import { visitorAuth } from "../../src/augments/visitor-auth/index";
import { createMockModel } from "@tests/fixtures/mock-model";
import { createTempDir } from "@tests/fixtures/temp-dir";
import type { AgentHandle } from "@/types";
import type { AgentMailClient } from "../../src/agentmail-client";

// Port chosen to avoid collisions with all other integration/transport tests.
// Existing allocations top out at 19501 (full-agent.test.ts). 19847 is clear.
const PORT = 19847;
const SIGNING_KEY = "shared-signing-key-integration-test";
const BEARER = "integration-bearer-token";

describe("integration: visitorAuth full flow — anon → verify → recognized", () => {
  let tmp: { path: string; cleanup: () => Promise<void> };
  let agent: AgentHandle | undefined;

  beforeEach(async () => {
    tmp = await createTempDir();
  });

  afterEach(async () => {
    try {
      await agent?.stop();
    } catch {
      // ignore — may already be stopped or never started
    }
    agent = undefined;
    await tmp.cleanup();
  });

  it(
    "anonymous visitor verifies email and is recognized on next request",
    async () => {
      // -----------------------------------------------------------------------
      // Stub AgentMail — records send() calls so we can extract the verify URL.
      // -----------------------------------------------------------------------
      const sends: { to: string[]; text: string; subject: string }[] = [];
      const stubAgentMail: AgentMailClient = {
        send: async (input) => {
          sends.push({ to: input.to, text: input.text, subject: input.subject });
          return { status: "sent", messageId: "msg-1", threadId: "thr-1" };
        },
        getInbox: async () => ({ inboxId: "ibx_test", status: "ok" }),
      };

      // -----------------------------------------------------------------------
      // Mock model — script the conversation:
      //   Call 0: emit request_auth tool call (visitor's first message).
      //   Call 1: return text after tool result (still turn 1; kernel loops
      //           back after resolving the tool).
      //   Call 2+: plain text for the 2nd /agent/run request.
      // -----------------------------------------------------------------------
      const model = createMockModel({ response: "You are now verified." });
      // Turn 1, pass 1: tool call
      model.pushResponse({
        content: "",
        toolCalls: [
          { name: "request_auth", arguments: { method: "email", email: "alice@example.com" } },
        ],
        finishReason: "tool_use",
      });
      // Turn 1, pass 2: text response after tool result
      model.pushResponse({
        content: "Verification email sent — check your inbox.",
        finishReason: "end_turn",
      });
      // Turn 2 (2nd /agent/run): recognized visitor's reply handled by fallback
      // in createMockModel (opts.response = "You are now verified.").

      // -----------------------------------------------------------------------
      // Build augments:
      //   - webTransport (visitorTokens enabled, shared signing key)
      //   - visitorAuth (shared signing key, stub agentMail)
      // -----------------------------------------------------------------------
      const dbPath = join(tmp.path, "visitor-auth.db");

      const transport = webTransport({
        port: PORT,
        auth: { type: "bearer", token: BEARER },
        visitorTokens: {
          enabled: true,
          signingKey: SIGNING_KEY,
          ttlSeconds: 7_776_000, // 90 days
        },
      });

      const auth = visitorAuth({
        publicUrl: `http://localhost:${PORT}`,
        dbPath,
        agentMail: { apiKey: "am_x", inboxId: "ibx_test" },
        signingKey: SIGNING_KEY,
        layeredMemoryDbPath: null, // no layeredMemory in this test
        _agentMailClient: stubAgentMail,
      });

      // -----------------------------------------------------------------------
      // Boot agent
      // -----------------------------------------------------------------------
      agent = defineAgent(
        {
          name: "zip-auth-test",
          purpose: "test agent for visitorAuth integration",
          model: "mock",
          augments: [transport, auth],
        },
        model,
      );

      await agent.start();

      // -----------------------------------------------------------------------
      // Turn 1: Anonymous visitor sends "hi I'm alice@example.com".
      //
      // We use an invalid x-visitor-token header so webTransport assigns the
      // anonymous path (anon-<threadId>).  A fresh anon token is issued in the
      // response header — we ignore it here because we'll get a long-lived
      // vis_<uuid> token from the verify route instead.
      // -----------------------------------------------------------------------
      const threadId = crypto.randomUUID();
      const run1Resp = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BEARER}`,
          // Stale / invalid visitor token → anon path → new anon token issued
          "x-visitor-token": "this.is.stale",
        },
        body: JSON.stringify({
          threadId,
          messages: [
            {
              role: "user",
              content: "hi I'm alice@example.com",
            },
          ],
        }),
      });

      expect(run1Resp.status).toBe(200);
      expect(run1Resp.headers.get("content-type")).toContain("text/event-stream");

      // Drain the SSE stream and assert RUN_FINISHED.
      const run1Body = await run1Resp.text();
      const run1Events = run1Body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length)) as { type: string });

      const run1Types = run1Events.map((e) => e.type);
      expect(run1Types).toContain("RUN_STARTED");
      expect(run1Types).toContain("RUN_FINISHED");

      // -----------------------------------------------------------------------
      // Step 3: Extract the verify URL from the stubbed send() call.
      // -----------------------------------------------------------------------
      expect(sends.length).toBeGreaterThan(0);
      const emailText = sends[0]!.text;
      const verifyUrlMatch = emailText.match(/(http:\/\/[^\s]+)/);
      expect(verifyUrlMatch).not.toBeNull();
      const verifyUrl = verifyUrlMatch![1]!;
      expect(verifyUrl).toContain("/visitor-auth/verify");
      expect(verifyUrl).toContain("token=");

      // -----------------------------------------------------------------------
      // Step 4: GET the verify URL — must return 200 and the success page.
      // -----------------------------------------------------------------------
      const verifyResp = await fetch(verifyUrl);
      expect(verifyResp.status).toBe(200);
      const verifyHtml = await verifyResp.text();
      expect(verifyHtml.toLowerCase()).toContain("verified");

      // -----------------------------------------------------------------------
      // Step 5: Extract the vis_<uuid> visitor token from the HTML.
      //
      // The success page embeds:
      //   var token = "<JSON-stringified token>";
      // We parse it back to a raw string using JSON.parse.
      // -----------------------------------------------------------------------
      const tokenJsonMatch = verifyHtml.match(/var token = ("(?:\\.|[^"\\])*");/);
      expect(tokenJsonMatch).not.toBeNull();
      const visToken = JSON.parse(tokenJsonMatch![1]!) as string;
      expect(visToken).toContain("."); // payload.signature format
      expect(visToken.length).toBeGreaterThan(20);

      // -----------------------------------------------------------------------
      // Step 6: 2nd /agent/run with the vis_ token in x-visitor-token header.
      //
      // webTransport Path 3: valid HMAC → peer.id = vis_<uuid>, recognized.
      // -----------------------------------------------------------------------
      model.pushResponse({
        content: "Welcome back, verified visitor!",
        finishReason: "end_turn",
      });

      const run2Resp = await fetch(`http://localhost:${PORT}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${BEARER}`,
          "x-visitor-token": visToken,
        },
        body: JSON.stringify({
          threadId: crypto.randomUUID(), // new conversation thread
          messages: [{ role: "user", content: "hi again" }],
        }),
      });

      expect(run2Resp.status).toBe(200);
      expect(run2Resp.headers.get("content-type")).toContain("text/event-stream");

      // -----------------------------------------------------------------------
      // Step 7: Assert Path 3 recognition:
      //
      //   (a) x-visitor-token response header is ABSENT — webTransport only
      //       sets this header when it issues a NEW anon token (Path 4 /
      //       invalid-token path). A recognized visitor (valid token) doesn't
      //       get a new token.
      //
      //   (b) RUN_FINISHED is present — turn completed successfully.
      //
      //   (c) visitorAuth context block carrying the verified email appears in
      //       the model's context for this call (contextBlocks from model.calls).
      // -----------------------------------------------------------------------
      const run2Body = await run2Resp.text();
      const run2Events = run2Body
        .split("\n")
        .filter((l) => l.startsWith("data: "))
        .map((l) => JSON.parse(l.slice("data: ".length)) as { type: string });

      // (a) No new visitor token issued for recognized visitor.
      expect(run2Resp.headers.get("x-visitor-token")).toBeNull();

      // (b) Run completed.
      const run2Types = run2Events.map((e) => e.type);
      expect(run2Types).toContain("RUN_STARTED");
      expect(run2Types).toContain("RUN_FINISHED");

      // (c) visitorAuth context block with alice@example.com present.
      //     The model receives contextBlocks after the 2nd /agent/run; this is
      //     the 3rd call (0: tool_use, 1: text-after-tool, 2: recognized turn).
      const lastCall = model.calls[model.calls.length - 1];
      expect(lastCall).toBeDefined();
      const allContext = [
        ...(lastCall!.systemBlocks ?? []),
        ...(lastCall!.contextBlocks ?? []),
      ].join("\n");
      expect(allContext).toContain("alice@example.com");
    },
    30_000,
  );
});
