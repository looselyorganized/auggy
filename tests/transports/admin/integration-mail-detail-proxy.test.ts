import { describe, expect, it } from "bun:test";
import { createServer } from "node:net";
import { defineAgent } from "@/agent";
import { defineRoute } from "@/helpers";
import { webTransport } from "@/transports/web-transport";
import type { Augment } from "@/types";
import { createMockModel } from "@tests/fixtures/mock-model";
import { z } from "zod";

const BEARER = "mail-detail-integration-secret";
const REVIEW_PATH = "/agentmail/mail-west/reviews/review_1";

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

function mailDetailFixture(instanceId: string, fingerprint: string): Augment {
  return {
    name: instanceId,
    httpRoutes: [
      defineRoute.get(`/agentmail/${instanceId}/reviews/:reviewId`, {
        auth: "creator",
        params: z.object({ reviewId: z.string().min(1).max(128) }),
        handler: ({ params }) => {
          if (params.reviewId === "missing") {
            return new Response(JSON.stringify({ error: "review-not-found" }), {
              status: 404,
              headers: { "content-type": "application/json" },
            });
          }
          if (params.reviewId === "stale") {
            return new Response(JSON.stringify({ error: "review-no-longer-inspectable" }), {
              status: 410,
              headers: { "content-type": "application/json" },
            });
          }
          return new Response(
            JSON.stringify({
              kind: "review",
              instanceId,
              reviewId: params.reviewId,
              fingerprint,
            }),
            {
              headers: {
                "content-type": "application/json; charset=utf-8",
                "cache-control": "no-store",
              },
            },
          );
        },
      }),
    ],
  };
}

function proxyUrl(origin: string, path: string): string {
  return `${origin}/console/api/mail-detail?path=${encodeURIComponent(path)}`;
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  expect(setCookie).toContain("auggy_console=");
  expect(setCookie).toContain("Path=/console");
  return setCookie!.split(";", 1)[0]!;
}

describe("booted web transport Console AgentMail detail proxy", () => {
  it("supports password and CLI-ticket sessions without broadening creator auth", async () => {
    const port = await freePort();
    const web = webTransport({
      port,
      auth: { type: "bearer", token: BEARER },
    });
    const agent = defineAgent(
      {
        name: "mail-detail-proxy",
        model: "mock",
        augments: [
          mailDetailFixture("mail-west", "sha256:west"),
          mailDetailFixture("mail-east", "sha256:east"),
          web,
        ],
      },
      createMockModel(),
    );
    await agent.start();
    try {
      const origin = `http://127.0.0.1:${port}`;

      const unauthenticated = await fetch(proxyUrl(origin, REVIEW_PATH));
      expect(unauthenticated.status).toBe(401);

      const passwordLogin = await fetch(`${origin}/console/login`, {
        method: "POST",
        headers: { origin },
        body: new URLSearchParams({ password: BEARER }),
        redirect: "manual",
      });
      expect(passwordLogin.status).toBe(303);
      const passwordCookie = sessionCookie(passwordLogin);
      const passwordDetail = await fetch(proxyUrl(origin, REVIEW_PATH), {
        headers: { cookie: passwordCookie },
      });
      expect(passwordDetail.status).toBe(200);
      expect(passwordDetail.headers.get("cache-control")).toBe("no-store, must-revalidate");
      expect(passwordDetail.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(passwordDetail.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await passwordDetail.json()).toMatchObject({
        kind: "review",
        instanceId: "mail-west",
        reviewId: "review_1",
        fingerprint: "sha256:west",
      });

      // Identical row ids remain bound to their mounted AgentMail instance.
      const eastDetail = await fetch(proxyUrl(origin, "/agentmail/mail-east/reviews/review_1"), {
        headers: { cookie: passwordCookie },
      });
      expect(eastDetail.status).toBe(200);
      expect(await eastDetail.json()).toMatchObject({
        instanceId: "mail-east",
        reviewId: "review_1",
        fingerprint: "sha256:east",
      });

      const basic = Buffer.from(`auggy:${BEARER}`).toString("base64");
      const ticketIssue = await fetch(`${origin}/console/api/cli-login`, {
        method: "POST",
        headers: { authorization: `Basic ${basic}` },
      });
      expect(ticketIssue.status).toBe(200);
      const ticket = (await ticketIssue.json()) as { loginPath: string };
      const ticketLogin = await fetch(`${origin}${ticket.loginPath}`, { redirect: "manual" });
      expect(ticketLogin.status).toBe(303);
      const ticketCookie = sessionCookie(ticketLogin);
      const ticketDetail = await fetch(proxyUrl(origin, REVIEW_PATH), {
        headers: { cookie: ticketCookie },
      });
      expect(ticketDetail.status).toBe(200);

      // Even if a non-browser client manually leaks the Console cookie onto
      // /agentmail, the route's creator authority does not accept it.
      const direct = await fetch(`${origin}${REVIEW_PATH}`, {
        headers: { cookie: ticketCookie },
      });
      expect(direct.status).toBe(401);

      for (const invalidPath of [
        "https://evil.example/agentmail/mail-west/reviews/review_1",
        "/console/api/dashboard",
        "/agentmail/mail-west/reviews/../console",
        "/agentmail/mail-west/other/review_1",
      ]) {
        const invalid = await fetch(proxyUrl(origin, invalidPath), {
          headers: { cookie: passwordCookie },
        });
        expect(invalid.status, invalidPath).toBe(400);
        expect(invalid.headers.get("cache-control")).toBe("no-store, must-revalidate");
      }

      const missing = await fetch(proxyUrl(origin, "/agentmail/mail-west/reviews/missing"), {
        headers: { cookie: passwordCookie },
      });
      expect(missing.status).toBe(404);
      expect(missing.headers.get("cache-control")).toBe("no-store, must-revalidate");
      expect(missing.headers.get("x-robots-tag")).toBe("noindex, nofollow");
      expect(missing.headers.get("x-content-type-options")).toBe("nosniff");
      expect(await missing.text()).not.toContain(BEARER);

      const stale = await fetch(proxyUrl(origin, "/agentmail/mail-west/reviews/stale"), {
        headers: { cookie: passwordCookie },
      });
      expect(stale.status).toBe(410);
      expect(stale.headers.get("cache-control")).toBe("no-store, must-revalidate");
      expect(await stale.json()).toEqual({ error: "review-no-longer-inspectable" });
    } finally {
      await agent.stop();
    }
  });
});
