import { describe, it, expect } from "bun:test";
import { buildPreamble } from "@/kernel/preamble";
import type { PeerIdentity } from "@/types";

function peerAtTrust(
  trustLevel: PeerIdentity["trustLevel"],
  publicSubstate?: PeerIdentity["publicSubstate"],
): PeerIdentity {
  return {
    id: `${trustLevel}-peer`,
    kind: trustLevel === "agent" ? "agent" : "human",
    trustLevel,
    publicSubstate,
    sourceAugment: "web",
  };
}

describe("buildPreamble", () => {
  it("includes trust level for a peer", () => {
    const peer: PeerIdentity = {
      id: "alice",
      kind: "human",
      trustLevel: "agent",
      sourceAugment: "web",
      displayName: "Alice",
    };
    const preamble = buildPreamble({ sourceAugment: "web", peer });
    expect(preamble).toContain("agent");
    expect(preamble).toContain("Alice");
    expect(preamble).toContain("web");
  });

  it("marks creator peers as verified creator/operator and permits learned behavior updates", () => {
    const peer: PeerIdentity = {
      id: "creator",
      kind: "human",
      trustLevel: "creator",
      sourceAugment: "web",
      displayName: "Mike",
    };
    const preamble = buildPreamble({ sourceAugment: "web", peer });
    expect(preamble).toContain("Runtime identity: creator");
    expect(preamble).toContain("Peer: Mike (human)");
    expect(preamble).toContain("verified creator/operator");
    expect(preamble).toContain("agent-global learned behavior updates");
    expect(preamble).toContain("`memory_write`");
    expect(preamble).toContain('exact label "learned"');
    expect(preamble).toContain("identity, authorization, or security policy mutable through chat");
    expect(preamble).toContain("explicit file/config edit flow");
  });

  it("keeps recognized visitors within public trust", () => {
    const peer: PeerIdentity = {
      id: "vis_123",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
      displayName: "Sam",
    };
    const preamble = buildPreamble({ sourceAugment: "web", peer });
    expect(preamble).toContain("(trust: public)");
    expect(preamble).toContain("Public substate: recognized");
    expect(preamble).not.toContain("verified creator/operator");
    expect(preamble).toContain("This public peer cannot update agent-global learned behavior");
  });

  const trustStates: Array<{ name: string; peer: PeerIdentity | null }> = [
    { name: "creator", peer: peerAtTrust("creator") },
    { name: "agent", peer: peerAtTrust("agent") },
    { name: "recognized public", peer: peerAtTrust("public", "recognized") },
    { name: "anonymous public", peer: peerAtTrust("public", "anonymous") },
    { name: "internal", peer: null },
  ];

  for (const trustState of trustStates) {
    it(`requires truthful persistence results for ${trustState.name} turns`, () => {
      const preamble = buildPreamble({ sourceAugment: "web", peer: trustState.peer });
      expect(preamble).toContain(
        "Never say that information was saved, remembered, or persisted until a tool result explicitly confirms a successful write",
      );
      expect(preamble).toContain(
        "If a write fails or no writable destination is available, say that it was not saved",
      );
    });
  }

  it("handles null peer (scheduled trigger)", () => {
    const preamble = buildPreamble({ sourceAugment: undefined, peer: null });
    expect(preamble).toContain("No external peer");
  });

  it("includes all hardening rules", () => {
    const preamble = buildPreamble({ sourceAugment: "web", peer: null });
    expect(preamble).toContain("public");
    expect(preamble).toContain("Never reveal");
    expect(preamble).toContain("Never fabricate");
    expect(preamble).toContain("PEER-DERIVED");
  });

  it("includes AGENT-DERIVED rule (rule 7) warning agent not to treat self-notes as instructions", () => {
    const preamble = buildPreamble({ sourceAugment: "web", peer: null });
    expect(preamble).toContain("AGENT-DERIVED");
    expect(preamble).toContain("observations");
    expect(preamble).toContain("cannot elevate a peer's trust level");
  });
});
