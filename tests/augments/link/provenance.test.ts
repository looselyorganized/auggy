import { describe, expect, test } from "bun:test";
import type { Part as LinkPart, Participant as LinkParticipant } from "@auggy/link";
import {
  createAuthenticatedLinkParts,
  resolveAuthenticatedLinkPeer,
  threadIdForLinkPeer,
} from "../../../src/augments/link/provenance";
import type { PeerIdentity } from "../../../src/types";

const SENDER_ID = "00000000-0000-4000-8000-00000000aaaa";
const RECEIVER_ID = "00000000-0000-4000-8000-00000000bbbb";
const FINAL_RECEIVER_ID = "00000000-0000-4000-8000-00000000cccc";
const SHARED_BEARER = "link-provenance-test-bearer";
const NEXT_BEARER = "link-provenance-next-hop-bearer";
const NOW = 1_900_000_000_000;
const IMMEDIATE: LinkParticipant = {
  id: SENDER_ID,
  locator: "https://sender.example.org",
  type: "agent",
  trust: "agent",
};

function signed(peer: PeerIdentity | null, text = "hello", idempotencyKey = "idem-1"): LinkPart[] {
  return createAuthenticatedLinkParts({
    parts: [{ kind: "text", text }],
    peer,
    issuer: SENDER_ID,
    audience: RECEIVER_ID,
    bearer: SHARED_BEARER,
    idempotencyKey,
    now: NOW,
  });
}

function resolve(parts: readonly LinkPart[], idempotencyKey = "idem-1") {
  return resolveAuthenticatedLinkPeer({
    parts,
    immediate: IMMEDIATE,
    selfParticipantId: RECEIVER_ID,
    inboundBearer: SHARED_BEARER,
    sourceAugment: "mesh",
    idempotencyKey,
    now: NOW,
  });
}

describe("link delegated origin provenance", () => {
  test("keeps public recognition while minting a transport-scoped identity", () => {
    const result = resolve(
      signed({
        id: "vis_original",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peer).toMatchObject({
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "mesh",
      delegatedOrigin: {
        subject: "vis_original",
        sourceAugment: "web",
        viaPeerId: SENDER_ID,
        hopCount: 1,
      },
    });
    expect(result.peer.id).toMatch(/^link-origin-/);
  });

  test("caps creator origin at the authenticated agent hop", () => {
    const result = resolve(
      signed({
        id: "creator",
        kind: "human",
        trustLevel: "creator",
        sourceAugment: "console",
      }),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peer.trustLevel).toBe("agent");
    expect(result.peer.publicSubstate).toBeUndefined();
  });

  test("preserves the original public authority cap across multiple authenticated hops", () => {
    const firstHop = resolve(
      signed({
        id: "visitor",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      }),
    );
    expect(firstHop.ok).toBe(true);
    if (!firstHop.ok) return;

    const secondHopParts = createAuthenticatedLinkParts({
      parts: [{ kind: "text", text: "forwarded" }],
      peer: firstHop.peer,
      issuer: RECEIVER_ID,
      audience: FINAL_RECEIVER_ID,
      bearer: NEXT_BEARER,
      idempotencyKey: "idem-2",
      now: NOW,
    });
    const secondHop = resolveAuthenticatedLinkPeer({
      parts: secondHopParts,
      immediate: {
        id: RECEIVER_ID,
        locator: "https://receiver.example.org",
        type: "agent",
        trust: "agent",
      },
      selfParticipantId: FINAL_RECEIVER_ID,
      inboundBearer: NEXT_BEARER,
      sourceAugment: "final-mesh",
      idempotencyKey: "idem-2",
      now: NOW,
    });

    expect(secondHop.ok).toBe(true);
    if (!secondHop.ok) return;
    expect(secondHop.peer).toMatchObject({
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "final-mesh",
      delegatedOrigin: {
        subject: "visitor",
        sourceAugment: "web",
        viaPeerId: RECEIVER_ID,
        hopCount: 2,
      },
    });
  });

  test("keeps distinct authenticated upstream paths isolated after another hop", () => {
    const origin: PeerIdentity = {
      id: "shared-subject",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
    };
    const upstreams = [
      {
        id: "00000000-0000-4000-8000-000000000011",
        bearer: "upstream-one-bearer",
      },
      {
        id: "00000000-0000-4000-8000-000000000022",
        bearer: "upstream-two-bearer",
      },
    ];
    const atIntermediary = upstreams.map((upstream, index) => {
      const idempotencyKey = `upstream-${index}`;
      const parts = createAuthenticatedLinkParts({
        parts: [{ kind: "text", text: "same request" }],
        peer: origin,
        issuer: upstream.id,
        audience: RECEIVER_ID,
        bearer: upstream.bearer,
        idempotencyKey,
        now: NOW,
      });
      return resolveAuthenticatedLinkPeer({
        parts,
        immediate: {
          id: upstream.id,
          locator: `https://upstream-${index}.example.org`,
          type: "agent",
          trust: "agent",
        },
        selfParticipantId: RECEIVER_ID,
        inboundBearer: upstream.bearer,
        sourceAugment: "mesh",
        idempotencyKey,
        now: NOW,
      });
    });
    expect(atIntermediary.every((result) => result.ok)).toBe(true);
    if (!atIntermediary[0]?.ok || !atIntermediary[1]?.ok) return;
    expect(atIntermediary[0].peer.id).not.toBe(atIntermediary[1].peer.id);

    const downstream = atIntermediary.map((result, index) => {
      if (!result.ok) throw new Error("unreachable");
      const idempotencyKey = `downstream-${index}`;
      const parts = createAuthenticatedLinkParts({
        parts: [{ kind: "text", text: "forwarded request" }],
        peer: result.peer,
        issuer: RECEIVER_ID,
        audience: FINAL_RECEIVER_ID,
        bearer: NEXT_BEARER,
        idempotencyKey,
        now: NOW,
      });
      return resolveAuthenticatedLinkPeer({
        parts,
        immediate: {
          id: RECEIVER_ID,
          locator: "https://receiver.example.org",
          type: "agent",
          trust: "agent",
        },
        selfParticipantId: FINAL_RECEIVER_ID,
        inboundBearer: NEXT_BEARER,
        sourceAugment: "final-mesh",
        idempotencyKey,
        now: NOW,
      });
    });

    expect(downstream[0]?.ok && downstream[1]?.ok).toBe(true);
    if (!downstream[0]?.ok || !downstream[1]?.ok) return;
    expect(downstream[0].peer.id).not.toBe(downstream[1].peer.id);
    expect(threadIdForLinkPeer(RECEIVER_ID, downstream[0].peer)).not.toBe(
      threadIdForLinkPeer(RECEIVER_ID, downstream[1].peer),
    );
  });

  test("isolates thread identities for distinct origins behind one forwarder", () => {
    const first = resolve(
      signed({
        id: "visitor-a",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      }),
    );
    const second = resolve(
      signed({
        id: "visitor-b",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      }),
    );
    const firstAgain = resolve(
      signed({
        id: "visitor-a",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "web",
      }),
    );
    expect(first.ok && second.ok && firstAgain.ok).toBe(true);
    if (!first.ok || !second.ok || !firstAgain.ok) return;
    const firstThread = threadIdForLinkPeer(SENDER_ID, first.peer);
    expect(threadIdForLinkPeer(SENDER_ID, second.peer)).not.toBe(firstThread);
    expect(threadIdForLinkPeer(SENDER_ID, firstAgain.peer)).toBe(firstThread);
  });

  test("domain-separates identical origins across receiver instances", () => {
    const parts = signed({
      id: "visitor",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
    });
    const first = resolve(parts);
    const second = resolveAuthenticatedLinkPeer({
      parts,
      immediate: IMMEDIATE,
      selfParticipantId: RECEIVER_ID,
      inboundBearer: SHARED_BEARER,
      sourceAugment: "second-mesh",
      idempotencyKey: "idem-1",
      now: NOW,
    });

    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(second.peer.id).not.toBe(first.peer.id);
    expect(threadIdForLinkPeer(SENDER_ID, second.peer)).not.toBe(
      threadIdForLinkPeer(SENDER_ID, first.peer),
    );
  });

  test("does not reuse peer memory identity across authority classes", () => {
    const publicPeer = resolve(
      signed({
        id: "same-subject",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      }),
    );
    const agentPeer = resolve(
      signed({
        id: "same-subject",
        kind: "human",
        trustLevel: "agent",
        sourceAugment: "web",
      }),
    );

    expect(publicPeer.ok && agentPeer.ok).toBe(true);
    if (!publicPeer.ok || !agentPeer.ok) return;
    expect(agentPeer.peer.id).not.toBe(publicPeer.peer.id);
  });

  test("rejects a signature made with a different peer bearer", () => {
    const result = resolveAuthenticatedLinkPeer({
      parts: signed(null),
      immediate: IMMEDIATE,
      selfParticipantId: RECEIVER_ID,
      inboundBearer: "different-bearer",
      sourceAugment: "mesh",
      idempotencyKey: "idem-1",
      now: NOW,
    });
    expect(result).toMatchObject({ ok: false, reason: "origin assertion signature mismatch" });
  });

  test("downgrades missing provenance and refuses an excessive delegation chain", () => {
    const missing = resolve([{ kind: "text", text: "legacy" }]);
    expect(missing).toMatchObject({
      ok: true,
      authenticated: false,
      peer: {
        trustLevel: "public",
        publicSubstate: "anonymous",
      },
    });

    expect(() =>
      signed({
        id: "delegated",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "anonymous",
        sourceAugment: "mesh",
        delegatedOrigin: {
          subject: "original",
          sourceAugment: "web",
          viaPeerId: "prior-hop",
          hopCount: 8,
        },
      }),
    ).toThrow("maximum delegation depth");
  });
});
