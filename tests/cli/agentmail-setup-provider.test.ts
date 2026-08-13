import { describe, expect, test } from "bun:test";
import { createAgentMailSetupProvider } from "../../src/cli/agentmail-setup-provider";

describe("AgentMail setup provider", () => {
  test("uses the signup key for verification and preserves an existing-account key", async () => {
    const requests: Array<{ path: string; authorization: string | null; body: unknown }> = [];
    const fakeFetch = (async (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request
          ? input.clone()
          : new Request(input instanceof URL ? input.toString() : input, init);
      const body = request.method === "POST" ? await request.clone().json() : undefined;
      const path = new URL(request.url).pathname;
      requests.push({ path, authorization: request.headers.get("authorization"), body });
      if (path.endsWith("/agent/sign-up")) {
        return Response.json({
          organization_id: "org_1",
          inbox_id: "new@agentmail.to",
          api_key: "am_signup_key",
        });
      }
      if (path.endsWith("/agent/verify")) return Response.json({ verified: true });
      if (path.endsWith("/inboxes")) {
        return Response.json({
          pod_id: "pod_1",
          inbox_id: "store@agentmail.to",
          email: "store@agentmail.to",
          display_name: "Store",
          client_id: "auggy.v2.inbox.agent.agentMail",
          metadata: { source: "auggy-cli" },
          created_at: "2026-08-13T00:00:00Z",
          updated_at: "2026-08-13T00:00:00Z",
        });
      }
      return new Response(null, { status: 404 });
    }) as unknown as typeof fetch;
    const provider = createAgentMailSetupProvider({
      apiBaseUrl: "http://127.0.0.1:9090",
      fetch: fakeFetch,
    });

    const signup = await provider.signUp({
      humanEmail: "owner@example.com",
      username: "new",
      source: "auggy-cli",
      referrer: "auggy agentMail setup",
    });
    await provider.verify(signup.apiKey, "123456");
    await provider.createInbox({
      apiKey: "am_exact_account_key",
      username: "store",
      displayName: "Store",
      clientId: "auggy.v2.inbox.agent.agentMail",
      metadata: { source: "auggy-cli" },
    });

    expect(requests.map(({ path }) => path)).toEqual([
      "/v0/agent/sign-up",
      "/v0/agent/verify",
      "/v0/inboxes",
    ]);
    expect(requests[0]?.authorization).toBeNull();
    expect(requests[1]?.authorization).toBe("Bearer am_signup_key");
    expect(requests[2]?.authorization).toBe("Bearer am_exact_account_key");
    expect(requests.some(({ path }) => path.includes("api-keys"))).toBe(false);
  });

  test("rejects remote plaintext before sending or receiving credentials", async () => {
    let called = false;
    const provider = createAgentMailSetupProvider({
      apiBaseUrl: "http://provider.example/v0",
      fetch: (async () => {
        called = true;
        return Response.json({});
      }) as unknown as typeof fetch,
    });
    await expect(
      provider.signUp({
        humanEmail: "owner@example.com",
        username: "new",
        source: "auggy-cli",
        referrer: "auggy agentMail setup",
      }),
    ).rejects.toThrow(/refuses to send credentials over non-loopback plaintext HTTP/);
    expect(called).toBe(false);
  });
});
