import { describe, expect, it } from "bun:test";
import { Webhook } from "svix";
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
  it("accepts a configured Svix verifier during startup validation", () => {
    expect(validateRouteWebhookPolicyConfig(route("svix"), { WEBHOOK_SECRET: secret })).toBe(
      undefined,
    );
  });

  it("rejects invalid Svix secrets and replay windows over five minutes", () => {
    expect(
      validateRouteWebhookPolicyConfig(route("svix"), { WEBHOOK_SECRET: "whsec_not-base64!" }),
    ).toContain("is invalid");

    const excessiveTolerance = route("svix");
    excessiveTolerance.policy!.timestampToleranceSeconds = 301;
    expect(validateRouteWebhookPolicyConfig(excessiveTolerance, { WEBHOOK_SECRET: secret })).toBe(
      "Svix webhook timestampToleranceSeconds cannot exceed 300 seconds.",
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

  it("verifies the exact raw Svix payload and exposes retry identity", async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const timestamp = new Date(nowMs);
    const payload = JSON.stringify({ event_type: "message.received", event_id: "evt_1" });
    const deliveryId = "msg_delivery_1";
    const signature = new Webhook(secret).sign(deliveryId, timestamp, payload);

    const result = await verifyRouteWebhookPolicy(
      route("svix"),
      svixRequest(payload, deliveryId, timestamp, signature),
      new TextEncoder().encode(payload),
      { WEBHOOK_SECRET: secret },
      nowMs,
    );

    expect(result).toEqual({
      ok: true,
      context: {
        kind: "webhook.signature",
        provider: "svix",
        event: { event_type: "message.received", event_id: "evt_1" },
        deliveryId,
        timestamp: nowMs / 1000,
        receivedAt: nowMs,
      },
    });
  });

  it("rejects missing, tampered, stale, and non-JSON Svix deliveries", async () => {
    const nowMs = Math.floor(Date.now() / 1000) * 1000;
    const timestamp = new Date(nowMs);
    const payload = '{"event_id":"evt_1"}';
    const signature = new Webhook(secret).sign("msg_1", timestamp, payload);
    const env = { WEBHOOK_SECRET: secret };
    const raw = new TextEncoder().encode(payload);

    expect(
      await verifyRouteWebhookPolicy(
        route("svix"),
        new Request("https://example.test/webhooks/svix", { method: "POST", body: payload }),
        raw,
        env,
        nowMs,
      ),
    ).toEqual({ ok: false, status: 401, error: "webhook-signature-required" });

    expect(
      await verifyRouteWebhookPolicy(
        route("svix"),
        svixRequest(`${payload} `, "msg_1", timestamp, signature),
        new TextEncoder().encode(`${payload} `),
        env,
        nowMs,
      ),
    ).toEqual({ ok: false, status: 401, error: "webhook-signature-invalid" });

    const narrowWindow = route("svix");
    narrowWindow.policy!.timestampToleranceSeconds = 1;
    expect(
      await verifyRouteWebhookPolicy(
        narrowWindow,
        svixRequest(payload, "msg_1", timestamp, signature),
        raw,
        env,
        nowMs + 2_000,
      ),
    ).toEqual({ ok: false, status: 401, error: "webhook-signature-invalid" });

    const invalidJson = "{";
    const invalidSignature = new Webhook(secret).sign("msg_bad_json", timestamp, invalidJson);
    expect(
      await verifyRouteWebhookPolicy(
        route("svix"),
        svixRequest(invalidJson, "msg_bad_json", timestamp, invalidSignature),
        new TextEncoder().encode(invalidJson),
        env,
        nowMs,
      ),
    ).toEqual({ ok: false, status: 400, error: "webhook-payload-invalid" });
  });
});

// Construct a valid synthetic Svix fixture without committing a token-shaped
// literal that secret scanners cannot distinguish from a live signing secret.
const secret = ["whsec", Buffer.from("synthetic-webhook-key-material").toString("base64")].join(
  "_",
);

function svixRequest(
  payload: string,
  deliveryId: string,
  timestamp: Date,
  signature: string,
): Request {
  return new Request("https://example.test/webhooks/svix", {
    method: "POST",
    headers: {
      "svix-id": deliveryId,
      "svix-timestamp": String(Math.floor(timestamp.getTime() / 1000)),
      "svix-signature": signature,
    },
    body: payload,
  });
}
