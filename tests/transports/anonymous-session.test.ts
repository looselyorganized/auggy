import { describe, expect, it } from "bun:test";
import { createAnonymousSessionManager } from "@/transports/anonymous-session";

describe("anonymous session capabilities", () => {
  it("issues and verifies a server-minted capability for one audience", () => {
    let now = 1_000;
    const manager = createAnonymousSessionManager({
      audience: "agent-a",
      secret: new Uint8Array(32).fill(7),
      now: () => now,
    });

    const issued = manager.issue();
    expect(issued.payload.peerId).toStartWith("anon_session_");
    expect(manager.verify(issued.token)).toEqual(issued.payload);

    now = issued.payload.expiresAt;
    expect(manager.verify(issued.token)).toBeNull();
  });

  it("rejects tampering, malformed payloads, and cross-agent replay", () => {
    const secret = new Uint8Array(32).fill(9);
    const first = createAnonymousSessionManager({ audience: "agent-a", secret });
    const second = createAnonymousSessionManager({ audience: "agent-b", secret });
    const issued = first.issue();
    const tampered = `${issued.token.slice(0, -1)}${issued.token.endsWith("a") ? "b" : "a"}`;

    expect(first.verify(tampered)).toBeNull();
    expect(first.verify("not-a-token")).toBeNull();
    expect(second.verify(issued.token)).toBeNull();
  });

  it("can link a visitor thread scope without granting the visitor memory subject", () => {
    const manager = createAnonymousSessionManager({
      audience: "agent-a",
      secret: new Uint8Array(32).fill(3),
    });
    const peerId = "vis_00000000-0000-4000-8000-000000000001";
    const issued = manager.issue({ threadScopeId: peerId });
    expect(issued.payload.peerId).toStartWith("anon_session_");
    expect(issued.payload.peerId).not.toBe(peerId);
    expect(issued.payload.threadScopeId).toBe(peerId);
  });
});
