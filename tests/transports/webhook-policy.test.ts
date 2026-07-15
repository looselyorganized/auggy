import { describe, expect, it } from "bun:test";
import type { AugmentHttpRoute } from "@/types";
import {
  validateRouteWebhookPolicyConfig,
  verifyRouteWebhookPolicy,
} from "@/transports/webhook-policy";

function route(provider: string): Pick<AugmentHttpRoute, "method" | "path" | "policy"> {
  return {
    method: "POST",
    path: `/webhooks/${provider}`,
    policy: {
      kind: "webhook.signature",
      provider,
      secretEnv: "WEBHOOK_SECRET",
    },
  };
}

describe("webhook signature policy fail-closed behavior", () => {
  it("rejects unsupported providers during startup validation", () => {
    expect(validateRouteWebhookPolicyConfig(route("svix"), { WEBHOOK_SECRET: "whsec_test" })).toBe(
      'Webhook signature provider "svix" is not supported.',
    );
  });

  it("defensively rejects unsupported providers during request verification", async () => {
    const result = await verifyRouteWebhookPolicy(
      route("github"),
      new Request("https://example.test/webhooks/github", { method: "POST", body: "{}" }),
      new TextEncoder().encode("{}"),
      { WEBHOOK_SECRET: "secret" },
    );

    expect(result).toEqual({
      ok: false,
      status: 500,
      error: "webhook-policy-unsupported",
    });
  });
});
