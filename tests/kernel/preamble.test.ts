import { describe, it, expect } from "bun:test";
import { buildPreamble } from "@/kernel/preamble";
import type { PeerIdentity } from "@/types";

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
    expect(preamble).toContain("learned-behavior updates");
    expect(preamble).toContain("identity, authorization, or security rules");
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
  });

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
