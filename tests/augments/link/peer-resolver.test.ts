import { describe, expect, it } from "bun:test";

import {
  buildPeerConfigsFromRegistry,
  createPeerResolver,
  parseRegistryResponse,
} from "@/augments/link/peer-resolver";

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

function parse(peers: Array<Record<string, unknown>>, allowPlaintext = false) {
  const result = parseRegistryResponse({ peers }, allowPlaintext);
  if (!result.ok) throw new Error(`unexpected parse failure: ${result.message}`);
  return result.parsed;
}

// ---------------------------------------------------------------------------
// parseRegistryResponse — per-entry validation, skip-not-fail
// ---------------------------------------------------------------------------

describe("parseRegistryResponse", () => {
  it("accepts valid https entries", () => {
    const result = parseRegistryResponse(
      {
        peers: [
          { name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID },
        ],
      },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.entries).toHaveLength(1);
    expect(result.parsed.parseSkipped).toEqual([]);
  });

  it("returns whole-response failure when `peers` is missing", () => {
    const result = parseRegistryResponse({ wrong: "shape" }, false);
    expect(result.ok).toBe(false);
  });

  it("rejects http:// entries by default (insecure_url skipped)", () => {
    const result = parseRegistryResponse(
      {
        peers: [{ name: "frontier", url: "http://frontier.example.org", participantId: PEER_A_ID }],
      },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.entries).toEqual([]);
    expect(result.parsed.parseSkipped).toHaveLength(1);
    expect(result.parsed.parseSkipped[0]?.reason.kind).toBe("insecure_url");
  });

  it("accepts http:// entries when allowPlaintext is true", () => {
    const result = parseRegistryResponse(
      {
        peers: [{ name: "frontier", url: "http://frontier.example.org", participantId: PEER_A_ID }],
      },
      true,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.entries).toHaveLength(1);
    expect(result.parsed.parseSkipped).toEqual([]);
  });

  it("skips entries with malformed participantId", () => {
    const result = parseRegistryResponse(
      { peers: [{ name: "x", url: "https://x.example", participantId: "not-a-uuid" }] },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.entries).toEqual([]);
    expect(result.parsed.parseSkipped[0]?.reason.kind).toBe("invalid_entry");
  });

  it("skips entries with non-http scheme (ftp etc.)", () => {
    const result = parseRegistryResponse(
      { peers: [{ name: "x", url: "ftp://x.example", participantId: PEER_A_ID }] },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.parseSkipped[0]?.reason.kind).toBe("invalid_entry");
  });

  it("processes good entries even when others are skipped", () => {
    const result = parseRegistryResponse(
      {
        peers: [
          { name: "good", url: "https://good.example", participantId: PEER_A_ID },
          { name: "bad", url: "http://bad.example", participantId: PEER_B_ID },
        ],
      },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.entries).toHaveLength(1);
    expect(result.parsed.entries[0]?.entry.name).toBe("good");
    expect(result.parsed.parseSkipped).toHaveLength(1);
  });

  it("skips entries with insecure agentCardUrl", () => {
    const result = parseRegistryResponse(
      {
        peers: [
          {
            name: "x",
            url: "https://x.example",
            participantId: PEER_A_ID,
            agentCardUrl: "http://x.example/.well-known/agent.json",
          },
        ],
      },
      false,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.parsed.parseSkipped[0]?.reason.kind).toBe("insecure_url");
  });
});

// ---------------------------------------------------------------------------
// buildPeerConfigsFromRegistry — per-peer error handling, no all-or-nothing
// ---------------------------------------------------------------------------

describe("buildPeerConfigsFromRegistry", () => {
  it("translates parsed entries + env bearers into LinkPeerConfig map", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([{ name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID }]),
      SELF_ID,
      {
        LINK_BEARER_FRONTIER: "outbound-secret",
        LINK_INBOUND_BEARER_FRONTIER: "inbound-secret",
        LINK_INBOUND_BEARER_ID_FRONTIER: "inbound-id",
      },
    );
    expect(result.peers).toEqual({
      frontier: {
        url: "https://frontier.example.org",
        bearer: "outbound-secret",
        participantId: PEER_A_ID,
        inboundBearer: "inbound-secret",
        inboundBearerId: "inbound-id",
      },
    });
    expect(result.skipped).toEqual([]);
  });

  it("self-filters: entry matching selfParticipantId is dropped", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([
        { name: "self", url: "https://self.example.org", participantId: SELF_ID },
        { name: "frontier", url: "https://frontier.example.org", participantId: PEER_A_ID },
      ]),
      SELF_ID,
      {
        LINK_BEARER_FRONTIER: "x",
        LINK_INBOUND_BEARER_FRONTIER: "y",
        LINK_INBOUND_BEARER_ID_FRONTIER: "z",
      },
    );
    expect(Object.keys(result.peers)).toEqual(["frontier"]);
    expect(result.skipped).toEqual([]);
  });

  it("skips (not aborts) when LINK_BEARER_<NAME> is absent", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([{ name: "frontier", url: "https://x.example", participantId: PEER_A_ID }]),
      SELF_ID,
      {},
    );
    expect(result.peers).toEqual({});
    expect(result.skipped).toHaveLength(1);
    const reason = result.skipped[0]?.reason;
    expect(reason?.kind).toBe("missing_bearer");
    if (reason?.kind !== "missing_bearer") return;
    expect(reason.envVar).toBe("LINK_BEARER_FRONTIER");
  });

  it("Codex finding #2: one bad entry doesn't block valid peers from applying", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([
        { name: "good", url: "https://good.example", participantId: PEER_A_ID },
        { name: "bad-new-peer", url: "https://bad.example", participantId: PEER_B_ID },
      ]),
      SELF_ID,
      {
        // `good` has all bearers
        LINK_BEARER_GOOD: "g-out",
        LINK_INBOUND_BEARER_GOOD: "g-in",
        LINK_INBOUND_BEARER_ID_GOOD: "g-id",
        // `bad-new-peer` is missing bearers (operator forgot to provision)
      },
    );
    expect(Object.keys(result.peers)).toEqual(["good"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["bad-new-peer"]);
  });

  it("normalizes peer-name env-var keys (hyphens → underscores, lowercase → upper)", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([{ name: "data-analyst", url: "https://x.example", participantId: PEER_A_ID }]),
      SELF_ID,
      {
        LINK_BEARER_DATA_ANALYST: "outbound",
        LINK_INBOUND_BEARER_DATA_ANALYST: "inbound",
        LINK_INBOUND_BEARER_ID_DATA_ANALYST: "id",
      },
    );
    expect(Object.keys(result.peers)).toEqual(["data-analyst"]);
  });

  it("returns empty peers when registry has only self", () => {
    const result = buildPeerConfigsFromRegistry(
      parse([{ name: "self", url: "https://x.example", participantId: SELF_ID }]),
      SELF_ID,
      {},
    );
    expect(result.peers).toEqual({});
    expect(result.skipped).toEqual([]);
  });

  it("forwards parse-skipped entries into the resolved skipped list", () => {
    // parseRegistryResponse skips http: + valid one stays
    const parsed = parseRegistryResponse(
      {
        peers: [
          { name: "secure", url: "https://x.example", participantId: PEER_A_ID },
          { name: "insecure", url: "http://y.example", participantId: PEER_B_ID },
        ],
      },
      false,
    );
    if (!parsed.ok) throw new Error("parse should succeed");
    const result = buildPeerConfigsFromRegistry(parsed.parsed, SELF_ID, {
      LINK_BEARER_SECURE: "a",
      LINK_INBOUND_BEARER_SECURE: "b",
      LINK_INBOUND_BEARER_ID_SECURE: "c",
    });
    expect(Object.keys(result.peers)).toEqual(["secure"]);
    expect(result.skipped.map((s) => s.name)).toEqual(["insecure"]);
    expect(result.skipped[0]?.reason.kind).toBe("insecure_url");
  });
});

// ---------------------------------------------------------------------------
// createPeerResolver — happy path
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
    expect(Object.keys(result.resolved.peers)).toEqual(["frontier"]);
    expect(result.resolved.skipped).toEqual([]);
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
          { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
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
          { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
        ]);
      }),
    });
    await resolver.getPeers();
    resolver.invalidate();
    await resolver.getPeers();
    expect(fetchCount).toBe(2);
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
            { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
            { name: "analyst", url: "https://y.example", participantId: PEER_B_ID },
          ]);
        }
        return makeRegistryResponse([
          { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
        ]);
      }),
    });
    const first = await resolver.getPeers();
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(Object.keys(first.resolved.peers).sort()).toEqual(["analyst", "frontier"]);

    resolver.invalidate();
    const second = await resolver.getPeers();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Object.keys(second.resolved.peers)).toEqual(["frontier"]);
  });

  it("Codex finding #2 (resolver level): revocation propagates even when new peer is misconfigured", async () => {
    let call = 0;
    const env = {
      LINK_BEARER_A: "a-out",
      LINK_INBOUND_BEARER_A: "a-in",
      LINK_INBOUND_BEARER_ID_A: "a-id",
      // B's bearers are intentionally missing
    };
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 999,
      env,
      fetchImpl: makeMockFetch(async () => {
        call += 1;
        if (call === 1) {
          // First fetch: peer A trusted
          return makeRegistryResponse([
            { name: "a", url: "https://a.example", participantId: PEER_A_ID },
          ]);
        }
        // Second fetch: A revoked, new peer B added but bearers missing
        return makeRegistryResponse([
          { name: "b", url: "https://b.example", participantId: PEER_B_ID },
        ]);
      }),
    });
    const first = await resolver.getPeers();
    if (!first.ok) throw new Error("first fetch should succeed");
    expect(Object.keys(first.resolved.peers)).toEqual(["a"]);

    resolver.invalidate();
    const second = await resolver.getPeers();
    if (!second.ok) throw new Error("second fetch should succeed");
    // A is FORGOTTEN even though B is misconfigured.
    expect(Object.keys(second.resolved.peers)).toEqual([]);
    expect(second.resolved.skipped.map((s) => s.name)).toEqual(["b"]);
  });
});

// ---------------------------------------------------------------------------
// createPeerResolver — failure paths
// ---------------------------------------------------------------------------

describe("createPeerResolver — failure paths", () => {
  it("throws at construction when source URL is http:// without override", () => {
    expect(() =>
      createPeerResolver({
        url: "http://registry.example.org/peers.json",
        selfParticipantId: SELF_ID,
        env: makeFullEnv(),
        fetchImpl: makeMockFetch(async () => new Response("")),
      }),
    ).toThrow(/must use https/);
  });

  it("permits http:// source URL when allowPlaintext is true", () => {
    expect(() =>
      createPeerResolver({
        url: "http://localhost:8080/peers.json",
        selfParticipantId: SELF_ID,
        allowPlaintext: true,
        env: makeFullEnv(),
        fetchImpl: makeMockFetch(async () => new Response("")),
      }),
    ).not.toThrow();
  });

  it("throws at construction when source URL is malformed", () => {
    expect(() =>
      createPeerResolver({
        url: "not-a-url",
        selfParticipantId: SELF_ID,
        env: makeFullEnv(),
        fetchImpl: makeMockFetch(async () => new Response("")),
      }),
    ).toThrow();
  });

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
  });

  it("returns fetch_failed with status when registry returns 4xx", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl: makeMockFetch(async () => new Response("not found", { status: 404 })),
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
          new Response("not json", {
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
            { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
          ]);
        }
        throw new Error("network died");
      }),
    });
    const first = await resolver.getPeers();
    expect(first.ok).toBe(true);
    resolver.invalidate();
    const second = await resolver.getPeers();
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    expect(Object.keys(second.resolved.peers)).toEqual(["frontier"]);
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

// ---------------------------------------------------------------------------
// Codex finding #3: fetch timeout + single-flight
// ---------------------------------------------------------------------------

describe("createPeerResolver — timeout (Codex finding #3a)", () => {
  it("returns timeout error when fetch exceeds requestTimeoutMs", async () => {
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      requestTimeoutMs: 50,
      env: makeFullEnv(),
      fetchImpl: ((_input: string | URL | Request, init?: RequestInit) =>
        new Promise<Response>((_, reject) => {
          const signal = init?.signal as AbortSignal | undefined;
          signal?.addEventListener("abort", () => {
            const err = new Error("aborted");
            err.name = "AbortError";
            reject(err);
          });
        })) as typeof fetch,
    });
    const result = await resolver.getPeers();
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error.kind).toBe("timeout");
  });
});

describe("createPeerResolver — single-flight (Codex finding #3b)", () => {
  it("concurrent getPeers calls share one in-flight fetch", async () => {
    let fetchStarted = 0;
    let resolveFetch: (r: Response) => void = () => {};
    const fetchImpl = (() => {
      fetchStarted += 1;
      return new Promise<Response>((resolve) => {
        resolveFetch = resolve;
      });
    }) as unknown as typeof fetch;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      env: makeFullEnv(),
      fetchImpl,
    });

    // Kick off 3 concurrent calls.
    const p1 = resolver.getPeers();
    const p2 = resolver.getPeers();
    const p3 = resolver.getPeers();

    // Resolve the single in-flight fetch.
    resolveFetch(
      makeRegistryResponse([
        { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
      ]),
    );

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(fetchStarted).toBe(1);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(r3.ok).toBe(true);
  });

  it("invalidate + concurrent calls after a completed fetch still single-flight", async () => {
    let fetchStarted = 0;
    const pendingHolder: { resolve: ((r: Response) => void) | null } = { resolve: null };
    const fetchImpl = (() => {
      fetchStarted += 1;
      return new Promise<Response>((resolve) => {
        pendingHolder.resolve = resolve;
      });
    }) as unknown as typeof fetch;
    const resolver = createPeerResolver({
      url: "https://registry.example.org/peers.json",
      selfParticipantId: SELF_ID,
      cacheSeconds: 999,
      env: makeFullEnv(),
      fetchImpl,
    });

    // First fetch: kick off + complete it.
    const first = resolver.getPeers();
    pendingHolder.resolve?.(
      makeRegistryResponse([
        { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
      ]),
    );
    await first;
    expect(fetchStarted).toBe(1);

    // Invalidate + fire 3 concurrent refreshes. They should all share ONE new fetch.
    resolver.invalidate();
    const p1 = resolver.getPeers();
    const p2 = resolver.getPeers();
    const p3 = resolver.getPeers();
    pendingHolder.resolve?.(
      makeRegistryResponse([
        { name: "frontier", url: "https://x.example", participantId: PEER_A_ID },
      ]),
    );
    await Promise.all([p1, p2, p3]);
    expect(fetchStarted).toBe(2);
  });
});
