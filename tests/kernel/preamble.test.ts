import { describe, it, expect } from "vitest";
import { buildPreamble } from "@/kernel/preamble";
import type { PeerIdentity } from "@/types";

describe("buildPreamble", () => {
  it("includes trust level for a peer", () => {
    const peer: PeerIdentity = {
      id: "alice",
      kind: "human",
      trustLevel: "authenticated",
      sourceAugment: "web",
      displayName: "Alice",
    };
    const preamble = buildPreamble({ sourceAugment: "web", peer });
    expect(preamble).toContain("authenticated");
    expect(preamble).toContain("Alice");
    expect(preamble).toContain("web");
  });

  it("handles null peer (scheduled trigger)", () => {
    const preamble = buildPreamble({ sourceAugment: undefined, peer: null });
    expect(preamble).toContain("No external peer");
  });

  it("includes all hardening rules", () => {
    const preamble = buildPreamble({ sourceAugment: "web", peer: null });
    expect(preamble).toContain("untrusted");
    expect(preamble).toContain("Never reveal");
    expect(preamble).toContain("Never fabricate");
    expect(preamble).toContain("PEER-DERIVED");
  });
});
