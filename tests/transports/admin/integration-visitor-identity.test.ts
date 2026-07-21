import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { defineAgent } from "@/agent";
import { generateCsrfToken } from "@/transports/admin/admin-csrf";
import { webTransport } from "@/transports/web-transport";
import { createVisitorToken, deriveSigningKey } from "@/transports/visitor-token";
import { createMockModel } from "@tests/fixtures/mock-model";

const bearer = "visitor-summary-integration-bearer";
const agentName = "visitor-summary-integration";
const agentBinding = "visitor-summary-agent";
const signingSecret = "visitor-summary-signing-secret";

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const address = probe.address();
  if (!address || typeof address === "string") throw new Error("failed to allocate test port");
  await new Promise<void>((resolve, reject) =>
    probe.close((error) => (error ? reject(error) : resolve())),
  );
  return address.port;
}

function basicHeader(): string {
  return `Basic ${Buffer.from(`:${bearer}`).toString("base64")}`;
}

async function summaryRequest(port: number, visitorToken: string): Promise<Response> {
  const csrf = await generateCsrfToken({ bearer, agentName, actionId: "console-chat" });
  return fetch(`http://127.0.0.1:${port}/console/api/visitor-identity`, {
    method: "POST",
    headers: {
      authorization: basicHeader(),
      "content-type": "application/json",
    },
    body: JSON.stringify({ csrf, visitorToken }),
  });
}

describe("webTransport console visitor identity summary", () => {
  it("validates signature, expiry, agent binding, revocation, and identity lookup", async () => {
    const port = await freePort();
    const visitorId = "vis_summary_verified";
    const revoked = new Set<string>();
    let revocationUnavailable = false;
    const transport = webTransport({
      port,
      auth: { type: "bearer", token: bearer },
      visitorTokens: {
        enabled: true,
        signingKey: signingSecret,
        agentBinding,
        revocationCheck: (candidate) => {
          if (revocationUnavailable) throw new Error("revocation store unavailable");
          return revoked.has(candidate);
        },
        identityLookup: (candidate) =>
          candidate === visitorId
            ? {
                visitorId,
                email: "verified@example.com",
                verifiedAt: 1_700_000_000_000,
                reverifyDueAt: 1_800_000_000_000,
              }
            : null,
      },
    });
    const agent = defineAgent(
      { name: agentName, model: "mock", augments: [transport] },
      createMockModel(),
    );
    await agent.start();

    try {
      const key = await deriveSigningKey(signingSecret);
      const valid = await createVisitorToken(key, agentBinding, 3_600, visitorId);
      const unauthorized = await fetch(`http://127.0.0.1:${port}/console/api/visitor-identity`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ csrf: "untrusted", visitorToken: valid.token }),
      });
      expect([401, 403]).toContain(unauthorized.status);

      const accepted = await summaryRequest(port, valid.token);
      expect(accepted.status).toBe(200);
      expect(accepted.headers.get("cache-control")).toContain("no-store");
      const acceptedText = await accepted.text();
      expect(acceptedText).not.toContain(valid.token);
      expect(acceptedText).not.toContain(visitorId);
      expect(JSON.parse(acceptedText)).toEqual({
        identity: {
          status: "verified",
          email: "verified@example.com",
          expiresAt: valid.payload.expiresAt,
        },
      });

      const crossAgent = await createVisitorToken(key, "another-agent", 3_600, visitorId);
      expect((await summaryRequest(port, crossAgent.token)).status).toBe(401);

      expect((await summaryRequest(port, "not-a-visitor-token")).status).toBe(401);

      const unknown = await createVisitorToken(key, agentBinding, 3_600, "vis_unknown");
      expect((await summaryRequest(port, unknown.token)).status).toBe(401);

      const expired = await createVisitorToken(key, agentBinding, -1, visitorId);
      expect((await summaryRequest(port, expired.token)).status).toBe(401);

      revocationUnavailable = true;
      const unavailable = await summaryRequest(port, valid.token);
      expect(unavailable.status).toBe(503);
      expect(((await unavailable.json()) as { code: string }).code).toBe(
        "visitor_identity_unavailable",
      );
      revocationUnavailable = false;

      revoked.add(visitorId);
      const revokedResponse = await summaryRequest(port, valid.token);
      expect(revokedResponse.status).toBe(401);
      expect(await revokedResponse.json()).toEqual({
        error: "Visitor credential is invalid, expired, or revoked.",
        code: "visitor_credential_rejected",
      });
    } finally {
      await agent.stop();
    }
  });
});
