import { describe, it, expect } from "bun:test";
import {
  deriveSigningKey,
  createVisitorToken,
  verifyVisitorToken,
} from "../../src/transports/visitor-token";

describe("visitor-token", () => {
  const bearerToken = "test-secret-token-12345";
  const agentId = "aug1_test-agent";

  it("deriveSigningKey produces a consistent key from the same input", async () => {
    const key1 = await deriveSigningKey(bearerToken);
    const key2 = await deriveSigningKey(bearerToken);
    const exported1 = await crypto.subtle.exportKey("raw", key1);
    const exported2 = await crypto.subtle.exportKey("raw", key2);
    expect(new Uint8Array(exported1)).toEqual(new Uint8Array(exported2));
  });

  it("deriveSigningKey produces different keys for different bearer tokens", async () => {
    const key1 = await deriveSigningKey("token-a");
    const key2 = await deriveSigningKey("token-b");
    const exported1 = await crypto.subtle.exportKey("raw", key1);
    const exported2 = await crypto.subtle.exportKey("raw", key2);
    expect(new Uint8Array(exported1)).not.toEqual(new Uint8Array(exported2));
  });

  it("createVisitorToken returns a token string and payload", async () => {
    const key = await deriveSigningKey(bearerToken);
    const { token, payload } = await createVisitorToken(key, agentId, 86400);
    expect(typeof token).toBe("string");
    expect(token.split(".").length).toBe(2);
    expect(payload.visitorId).toMatch(/^vis_/);
    expect(payload.agentId).toBe(agentId);
  });

  it("verifyVisitorToken round-trips with createVisitorToken", async () => {
    const key = await deriveSigningKey(bearerToken);
    const { token } = await createVisitorToken(key, agentId, 86400);
    const payload = await verifyVisitorToken(key, token);
    expect(payload).not.toBeNull();
    expect(payload!.visitorId).toMatch(/^vis_/);
    expect(payload!.agentId).toBe(agentId);
    expect(payload!.expiresAt).toBeGreaterThan(Date.now());
  });

  it("verifyVisitorToken returns null for an expired token", async () => {
    const key = await deriveSigningKey(bearerToken);
    const { token } = await createVisitorToken(key, agentId, -1);
    const payload = await verifyVisitorToken(key, token);
    expect(payload).toBeNull();
  });

  it("verifyVisitorToken returns null for a tampered token", async () => {
    const key = await deriveSigningKey(bearerToken);
    const { token } = await createVisitorToken(key, agentId, 86400);
    const tampered = token.slice(0, -4) + "XXXX";
    const payload = await verifyVisitorToken(key, tampered);
    expect(payload).toBeNull();
  });

  it("verifyVisitorToken returns null for a token signed with a different key", async () => {
    const key1 = await deriveSigningKey("secret-1");
    const key2 = await deriveSigningKey("secret-2");
    const { token } = await createVisitorToken(key1, agentId, 86400);
    const payload = await verifyVisitorToken(key2, token);
    expect(payload).toBeNull();
  });

  it("token signed with bearer-derived key is rejected by a dedicated signing key", async () => {
    const bearerKey = await deriveSigningKey("shared-bearer-token");
    const dedicatedKey = await deriveSigningKey("dedicated-signing-secret");
    const { token } = await createVisitorToken(bearerKey, agentId, 86400);
    const payload = await verifyVisitorToken(dedicatedKey, token);
    expect(payload).toBeNull();
  });

  it("verifyVisitorToken returns null for malformed input", async () => {
    const key = await deriveSigningKey(bearerToken);
    expect(await verifyVisitorToken(key, "")).toBeNull();
    expect(await verifyVisitorToken(key, "not-a-token")).toBeNull();
    expect(await verifyVisitorToken(key, "a.b.c")).toBeNull();
  });
});
