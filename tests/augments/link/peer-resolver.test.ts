import { describe, expect, it } from "bun:test";

import { buildPeerConfigsFromRegistry, createPeerResolver } from "@/augments/link/peer-resolver";

const SELF_ID = "00000000-0000-4000-8000-00000000aaaa";
const PEER_A_ID = "00000000-0000-4000-8000-00000000bbbb";
const PEER_B_ID = "00000000-0000-4000-8000-00000000cccc";

function makeRegistryResponse(peers: Array<Record<string, unknown>>): Response {
  return new Response(JSON.stringify({ peers }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function makeMockFetch(handler: (url: string) => Promise<Response>): typeof fetch {
  return ((input: string | URL | Request) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    return handler(url);
  }) as typeof fetch;
}

// ---------------------------------------------------------------------------
// buildPeerConfigsFromRegistry — pure transformation
// ---------------------------------------------------------------------------

describe("buildPeerConfigsFromRegistry", () => {
  it("translates registry entries + env bearers into LinkPeerConfig map", () => {
    const env = {
      LINK_BEARER_FRONTIER: "outbound-secret",
      LINK_INBOUND_BEARER_FRONTIER: "inbound-secret",
      LINK_INBOUND_BEARER_ID_FRONTIER: "inbound-id",
    };
    const result = buildPeerConfigsFromRegistry(
      {
        peers: [
          { name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID },
        ],
      },
      SELF_ID,
      env,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peers).toEqual({
      frontier: {
        url: "https://frontier.example.org",
        bearer: "outbound-secret",
        participantId: PEER_A_ID,
        inboundBearer: "inbound-secret",
        inboundBearerId: "inbound-id",
      },
    });
  });

  it("self-filters: entry matching selfParticipantId is dropped", () => {
    const env = {
      LINK_BEARER_FRONTIER: "x",
      LINK_INBOUND_BEARER_FRONTIER: "y",
      LINK_INBOUND_BEARER_ID_FRONTIER: "z",
    };
    const result = buildPeerConfigsFromRegistry(
      {
        peers: [
          { name: "self", url: "https://self.example.org", participantId: SELF_ID },
          { name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID },
        ],
      },
      SELF_ID,
      env,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.peers)).toEqual(["frontier"]);
  });

  it("returns missing_bearer error when LINK_BEARER_<NAME> is absent", () => {
    const result = buildPeerConfigsFromRegistry(
      {
        peers: [{ name: "frontier", url: "https://x", participantId: PEER_A_ID }],
      },
      SELF_ID,
      {},
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("missing_bearer");
    if (result.error.kind !== "missing_bearer") return;
    expect(result.error.peer).toBe("frontier");
    expect(result.error.envVar).toBe("LINK_BEARER_FRONTIER");
  });

  it("returns missing_bearer error when LINK_INBOUND_BEARER_<NAME> is absent", () => {
    const result = buildPeerConfigsFromRegistry(
      {
        peers: [{ name: "frontier", url: "https://x", participantId: PEER_A_ID }],
      },
      SELF_ID,
      { LINK_BEARER_FRONTIER: "outbound" },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== "missing_bearer") return;
    expect(result.error.envVar).toBe("LINK_INBOUND_BEARER_FRONTIER");
  });

  it("returns missing_bearer error when LINK_INBOUND_BEARER_ID_<NAME> is absent", () => {
    const result = buildPeerConfigsFromRegistry(
      {
        peers: [{ name: "frontier", url: "https://x", participantId: PEER_A_ID }],
      },
      SELF_ID,
      {
        LINK_BEARER_FRONTIER: "outbound",
        LINK_INBOUND_BEARER_FRONTIER: "inbound",
      },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== "missing_bearer") return;
    expect(result.error.envVar).toBe("LINK_INBOUND_BEARER_ID_FRONTIER");
  });

  it("normalizes peer-name env-var keys (hyphens → underscores, lowercase → upper)", () => {
    const env = {
      LINK_BEARER_DATA_ANALYST: "outbound",
      LINK_INBOUND_BEARER_DATA_ANALYST: "inbound",
      LINK_INBOUND_BEARER_ID_DATA_ANALYST: "id",
    };
    const result = buildPeerConfigsFromRegistry(
      { peers: [{ name: "data-analyst", url: "https://x", participantId: PEER_A_ID }] },
      SELF_ID,
      env,
    );
    expect(result.ok).toBe(true);
  });

  it("returns an empty map when registry has only self", () => {
    const result = buildPeerConfigsFromRegistry(
      { peers: [{ name: "self", url: "https://x", participantId: SELF_ID }] },
      SELF_ID,
      {},
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.peers).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// createPeerResolver — fetch + cache + refresh
// ---------------------------------------------------------------------------

function makeFullEnv() {
  return {
    LINK_BEARER_FRONTIER: "outbound",
    LINK_INBOUND_BEARER_FRONTIER: "inbound",
    LINK_INBOUND_BEARER_ID_FRONTIER: "id",
    LINK_BEARER_ANALYST: "outbound2",
    LINK_INBOUND_BEARER_ANALYST: "inbound2",
    LINK_INBOUND_BEARER_ID_ANALYST: "id2",
  };
}

describe("createPeerResolver — happy path", () => {
  it("fetches the registry and builds the peers map", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () =>
        makeRegistryResponse([
          { name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID },
        ]),
      ),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(Object.keys(result.peers)).toEqual(["frontier"]);
  });

  it("caches the result — second call within TTL does not refetch", async () => {
    let fetchCount = 0;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 60,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        fetchCount += 1;
        return makeRegistryResponse([
          { name: "frontier", url: "https://x", participantId: PEER_A_ID },
        ]);
      }),
    });
    await resolver.getPeers();
    await resolver.getPeers();
    await resolver.getPeers();
    expect(fetchCount).toBe(1);
  });

  it("invalidate() forces the next call to refetch", async () => {
    let fetchCount = 0;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 999,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        fetchCount += 1;
        return makeRegistryResponse([
          { name: "frontier", url: "https://x", participantId: PEER_A_ID },
        ]);
      }),
    });
    await resolver.getPeers();
    resolver.invalidate();
    await resolver.getPeers();
    expect(fetchCount).toBe(2);
  });

  it("cacheAgeSeconds returns null before first fetch, then numeric", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () =>
        makeRegistryResponse([{ name: "frontier", url: "https://x", participantId: PEER_A_ID }]),
      ),
    });
    expect(resolver.cacheAgeSeconds()).toBeNull();
    await resolver.getPeers();
    const age = resolver.cacheAgeSeconds();
    expect(age).not.toBeNull();
    expect(age).toBeGreaterThanOrEqual(0);
  });

  it("forget semantics: peer removed from registry is dropped on refresh", async () => {
    let call = 0;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 999,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        call += 1;
        if (call === 1) {
          return makeRegistryResponse([
            { name: "frontier", url: "https://x", participantId: PEER_A_ID },
            { name: "analyst", url: "https://y", participantId: PEER_B_ID },
          ]);
        }
        return makeRegistryResponse([
          { name: "frontier", url: "https://x", participantId: PEER_A_ID },
        ]);
      }),
    });
    const first = await resolver.getPeers();
    expect(first.ok && Object.keys(first.peers).sort()).toEqual(["analyst", "frontier"]);
    resolver.invalidate();
    const second = await resolver.getPeers();
    expect(second.ok && Object.keys(second.peers)).toEqual(["frontier"]);
  });
});

// ---------------------------------------------------------------------------
// createPeerResolver — failure paths
// ---------------------------------------------------------------------------

describe("createPeerResolver — failure paths", () => {
  it("returns fetch_failed when fetch throws", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        throw new Error("ECONNREFUSED");
      }),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("fetch_failed");
    if (result.error.kind !== "fetch_failed") return;
    expect(result.error.message).toContain("ECONNREFUSED");
  });

  it("returns fetch_failed with status when registry returns 4xx", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(
        async () =>
          new Response("not found", {
            status: 404,
            headers: { "content-type": "text/plain" },
          }),
      ),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    if (result.error.kind !== "fetch_failed") return;
    expect(result.error.status).toBe(404);
  });

  it("returns parse_failed on invalid JSON", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(
        async () =>
          new Response("not json at all", {
            status: 200,
            headers: { "content-type": "application/json" },
          }),
      ),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse_failed");
  });

  it("returns parse_failed on JSON that doesn't match the contract", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () =>
        // Missing required `participantId`.
        makeRegistryResponse([{ name: "frontier", url: "https://x" }]),
      ),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse_failed");
  });

  it("returns parse_failed on non-HTTPS URL in the response", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () =>
        makeRegistryResponse([{ name: "frontier", url: "ftp://nope", participantId: PEER_A_ID }]),
      ),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("parse_failed");
  });

  it("last-good fallback: refresh failure preserves cached peers", async () => {
    let call = 0;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 999,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        call += 1;
        if (call === 1) {
          return makeRegistryResponse([
            { name: "frontier", url: "https://x", participantId: PEER_A_ID },
          ]);
        }
        throw new Error("network died");
      }),
    });
    const first = await resolver.getPeers();
    expect(first.ok).toBe(true);
    resolver.invalidate();
    const second = await resolver.getPeers();
    // Refresh failed → cache preserved → call STILL returns ok with last-good peers.
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Object.keys(second.peers)).toEqual(["frontier"]);
  });

  it("first-fetch failure with no cache returns the error", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => {
        throw new Error("dead from the start");
      }),
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
  });
});
