import { describe, expect, it } from "bun:test";
import { generateCsrfToken, validateCsrfToken } from "@/transports/admin/admin-csrf";

const bearer = "test-bearer-token";
const agentName = "zip";

describe("admin-csrf — generate + validate roundtrip", () => {
  it("validates a freshly-generated token for the same action + bearer", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(true);
  });

  it("validates a token with a rowKey when the rowKey matches", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    expect(result.valid).toBe(true);
  });

  it("validates a targeted token only for the same augment instance", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      augmentName: "mail-west",
      actionId: "review-approve",
      rowKey: "review-1",
    });
    expect(
      await validateCsrfToken({
        token,
        bearer,
        agentName,
        augmentName: "mail-west",
        actionId: "review-approve",
        rowKey: "review-1",
      }),
    ).toEqual({ valid: true });
  });
});

describe("admin-csrf — binding enforcement (returns reason: tampered)", () => {
  it("rejects a token for a different actionId with reason=tampered", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "posture-flip",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects cross-target replay for the same action and row", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      augmentName: "mail-west",
      actionId: "review-approve",
      rowKey: "review-1",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      augmentName: "mail-east",
      actionId: "review-approve",
      rowKey: "review-1",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("does not accept a legacy token on a targeted augment action", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "review-approve",
      rowKey: "review-1",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      augmentName: "mail-west",
      actionId: "review-approve",
      rowKey: "review-1",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a token for a different bearer (after rotation)", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer: "different-bearer",
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a token for a different agentName", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName: "different-agent",
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a row-scoped token submitted with a different rowKey (M1 fix)", async () => {
    const token = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_xyz",
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a token issued without rowKey when submitted with a rowKey", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "memory-erase" });
    const result = await validateCsrfToken({
      token,
      bearer,
      agentName,
      actionId: "memory-erase",
      rowKey: "vis_abc",
    });
    expect(result.valid).toBe(false);
  });
});

describe("admin-csrf — expiry (returns reason: expired)", () => {
  it("rejects an expired token (>24 hours) with reason=expired", async () => {
    const expiredTs = Math.floor((Date.now() - 25 * 3600 * 1000) / 1000);
    const expiredToken = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: expiredTs,
    });
    const result = await validateCsrfToken({
      token: expiredToken,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("expired");
  });

  it("accepts a token issued just under 24 hours ago", async () => {
    const oldTs = Math.floor((Date.now() - 23 * 3600 * 1000) / 1000);
    const oldToken = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: oldTs,
    });
    const result = await validateCsrfToken({
      token: oldToken,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(true);
  });
});

describe("admin-csrf — tampering / malformed", () => {
  it("rejects a token with a tampered signature (reason=tampered)", async () => {
    const token = await generateCsrfToken({ bearer, agentName, actionId: "notify-test" });
    const [, ts] = token.split(".");
    const tampered = `tampered-signature-base64.${ts}`;
    const result = await validateCsrfToken({
      token: tampered,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a token with a future timestamp >60s ahead (reason=tampered)", async () => {
    const futureTs = Math.floor(Date.now() / 1000) + 1000;
    const tampered = await generateCsrfToken({
      bearer,
      agentName,
      actionId: "notify-test",
      _timestamp: futureTs,
    });
    const result = await validateCsrfToken({
      token: tampered,
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("tampered");
  });

  it("rejects a malformed token (no dot separator) with reason=malformed", async () => {
    const result = await validateCsrfToken({
      token: "just-a-string-no-dot",
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed");
  });

  it("rejects a malformed token (non-numeric timestamp) with reason=malformed", async () => {
    const result = await validateCsrfToken({
      token: "signature.not-a-number",
      bearer,
      agentName,
      actionId: "notify-test",
    });
    expect(result.valid).toBe(false);
    if (!result.valid) expect(result.reason).toBe("malformed");
  });
});
