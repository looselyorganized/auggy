/**
 * peer-resolver — fetch peers from a registry, resolve env-based bearers,
 * cache in memory with TTL, support live refresh.
 *
 * Design (per `lo/docs/superpowers/specs/2026-05-20-link-peer-directory-v1.md`):
 *
 *   - The registry serves PUBLIC identity only: `{ name, url, participantId,
 *     agentCardUrl? }`. No bearers in the registry response.
 *
 *   - Bearers live in environment variables on each Auggy, keyed by peer
 *     name:
 *         LINK_BEARER_<UPPERCASE_NAME>             — outbound bearer
 *         LINK_INBOUND_BEARER_<UPPERCASE_NAME>     — inbound bearer
 *         LINK_INBOUND_BEARER_ID_<UPPERCASE_NAME>  — audit id paired with inbound
 *
 *   - The resolver fetches the registry, looks up the env-vars for each
 *     peer, and produces a `Record<string, LinkPeerConfig>` — the same
 *     shape the inline `peers` block in agent.yaml produces. The augment
 *     above this module is agnostic to whether peers came from inline or
 *     registry.
 *
 *   - Self-filter: a peer entry whose `participantId === agentCard.id` is
 *     dropped from the resolved map. Agents do not call themselves.
 *
 *   - Cache: in-memory only at v1. TTL governs refresh cadence; a refresh
 *     failure does NOT clear the last-good cache (degradation, not outage).
 *
 *   - Forget semantics: on successful refresh, peers no longer in the
 *     registry response are dropped from the resolved map. The augment
 *     propagates these removals into `AddressBook` + `BearerAuthProvider`
 *     via the dynamic-providers wrappers.
 */

import type { LinkPeerConfig } from "./index";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type PeerResolverError =
  | { kind: "fetch_failed"; status?: number; message: string }
  | { kind: "parse_failed"; message: string }
  | { kind: "missing_bearer"; peer: string; envVar: string };

export interface PeerResolverOptions {
  /** Registry URL to fetch on boot and on refresh. */
  url: string;
  /** Cache TTL in seconds. Default 60. */
  cacheSeconds?: number;
  /** Self-identity: peers with this `participantId` are filtered out. */
  selfParticipantId: string;
  /**
   * Env-var source. Defaults to `process.env`. Override for tests.
   */
  env?: Record<string, string | undefined>;
  /**
   * Fetch implementation. Defaults to `globalThis.fetch`. Override for
   * tests + dependency injection.
   */
  fetchImpl?: typeof fetch;
}

export interface PeerResolver {
  /**
   * Return the current peers map. If the cache is empty or expired, this
   * triggers a fresh fetch. Errors return a structured PeerResolverError
   * via the Result-like ok/error union — callers decide whether to fall
   * back to inline peers.
   */
  getPeers(): Promise<
    { ok: true; peers: Record<string, LinkPeerConfig> } | { ok: false; error: PeerResolverError }
  >;
  /**
   * Force a refresh on the next `getPeers()` call. Does NOT clear the
   * current cache (so failed refreshes don't drop existing state).
   */
  invalidate(): void;
  /**
   * Cache age in seconds since last successful fetch. Returns null if no
   * successful fetch has happened yet.
   */
  cacheAgeSeconds(): number | null;
}

// ---------------------------------------------------------------------------
// Internal types matching the registry contract
// ---------------------------------------------------------------------------

interface RegistryPeerEntry {
  name: string;
  url: string;
  participantId: string;
  agentCardUrl?: string;
}

interface RegistryResponseShape {
  peers: RegistryPeerEntry[];
}

// ---------------------------------------------------------------------------
// Env-var conventions
// ---------------------------------------------------------------------------

function envKey(prefix: string, peerName: string): string {
  // EnvAddressBook uses the same uppercase+underscore normalization. Keep
  // them aligned so `LINK_BEARER_FRONTIER` works the same way `EnvAddressBook`
  // resolves `PEER_FRONTIER_BEARER`.
  const sanitized = peerName.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  return `${prefix}${sanitized}`;
}

function readBearerFromEnv(
  env: Record<string, string | undefined>,
  peerName: string,
  prefix: string,
): string | null {
  const key = envKey(prefix, peerName);
  const val = env[key];
  return val && val.length > 0 ? val : null;
}

// ---------------------------------------------------------------------------
// Validation + parsing
// ---------------------------------------------------------------------------

function isUuid(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

function isHttpUrl(s: unknown): s is string {
  if (typeof s !== "string") return false;
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

function parseRegistryResponse(body: unknown): RegistryResponseShape | null {
  if (!body || typeof body !== "object") return null;
  const peersRaw = (body as { peers?: unknown }).peers;
  if (!Array.isArray(peersRaw)) return null;

  const peers: RegistryPeerEntry[] = [];
  for (const entry of peersRaw) {
    if (!entry || typeof entry !== "object") return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) return null;
    if (!isHttpUrl(e.url)) return null;
    if (!isUuid(e.participantId)) return null;
    if (e.agentCardUrl !== undefined && !isHttpUrl(e.agentCardUrl)) return null;
    peers.push({
      name: e.name,
      url: e.url,
      participantId: e.participantId,
      agentCardUrl: typeof e.agentCardUrl === "string" ? e.agentCardUrl : undefined,
    });
  }
  return { peers };
}

// ---------------------------------------------------------------------------
// Building a resolved peers map
// ---------------------------------------------------------------------------

/**
 * Translate the registry response + env-resolved bearers into the
 * `Record<string, LinkPeerConfig>` shape the rest of the augment expects.
 *
 * Self-filter (skip the entry whose participantId === selfParticipantId)
 * happens here.
 *
 * Returns the first missing-bearer error encountered; callers decide
 * whether to fail loud or fall back.
 */
export function buildPeerConfigsFromRegistry(
  registry: RegistryResponseShape,
  selfParticipantId: string,
  env: Record<string, string | undefined>,
): { ok: true; peers: Record<string, LinkPeerConfig> } | { ok: false; error: PeerResolverError } {
  const out: Record<string, LinkPeerConfig> = {};
  for (const entry of registry.peers) {
    if (entry.participantId === selfParticipantId) continue; // self-filter

    const bearer = readBearerFromEnv(env, entry.name, "LINK_BEARER_");
    if (!bearer) {
      return {
        ok: false,
        error: {
          kind: "missing_bearer",
          peer: entry.name,
          envVar: envKey("LINK_BEARER_", entry.name),
        },
      };
    }

    const inboundBearer = readBearerFromEnv(env, entry.name, "LINK_INBOUND_BEARER_");
    if (!inboundBearer) {
      return {
        ok: false,
        error: {
          kind: "missing_bearer",
          peer: entry.name,
          envVar: envKey("LINK_INBOUND_BEARER_", entry.name),
        },
      };
    }

    const inboundBearerId = readBearerFromEnv(env, entry.name, "LINK_INBOUND_BEARER_ID_");
    if (!inboundBearerId) {
      return {
        ok: false,
        error: {
          kind: "missing_bearer",
          peer: entry.name,
          envVar: envKey("LINK_INBOUND_BEARER_ID_", entry.name),
        },
      };
    }

    out[entry.name] = {
      url: entry.url,
      bearer,
      participantId: entry.participantId,
      inboundBearer,
      inboundBearerId,
    };
  }
  return { ok: true, peers: out };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createPeerResolver(opts: PeerResolverOptions): PeerResolver {
  const ttlSeconds = opts.cacheSeconds ?? 60;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const fetchImpl = opts.fetchImpl ?? fetch;

  let cache: Record<string, LinkPeerConfig> | null = null;
  let cachedAtMs: number | null = null;
  let forceRefresh = false;

  async function fetchAndBuild(): Promise<
    { ok: true; peers: Record<string, LinkPeerConfig> } | { ok: false; error: PeerResolverError }
  > {
    let response: Response;
    try {
      response = await fetchImpl(opts.url, {
        method: "GET",
        headers: { accept: "application/json" },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: "fetch_failed", message } };
    }

    if (!response.ok) {
      return {
        ok: false,
        error: {
          kind: "fetch_failed",
          status: response.status,
          message: `HTTP ${response.status} from ${opts.url}`,
        },
      };
    }

    let body: unknown;
    try {
      body = await response.json();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { ok: false, error: { kind: "parse_failed", message: `invalid JSON: ${message}` } };
    }

    const registry = parseRegistryResponse(body);
    if (!registry) {
      return {
        ok: false,
        error: {
          kind: "parse_failed",
          message: "registry response did not match { peers: RegistryPeerEntry[] } contract",
        },
      };
    }

    return buildPeerConfigsFromRegistry(registry, opts.selfParticipantId, env);
  }

  return {
    async getPeers() {
      const now = Date.now();
      const expired =
        cachedAtMs === null || (now - cachedAtMs) / 1000 >= ttlSeconds || forceRefresh;

      if (!expired && cache) {
        return { ok: true, peers: cache };
      }

      const result = await fetchAndBuild();
      if (result.ok) {
        cache = result.peers;
        cachedAtMs = now;
        forceRefresh = false;
        return result;
      }

      // Refresh failed. Per spec, the last-good cache stays in use rather
      // than dropping everyone. Surface the error so the caller can log
      // it; preserve cache for next call.
      if (cache) {
        return { ok: true, peers: cache };
      }
      return result;
    },
    invalidate() {
      forceRefresh = true;
    },
    cacheAgeSeconds() {
      if (cachedAtMs === null) return null;
      return Math.floor((Date.now() - cachedAtMs) / 1000);
    },
  };
}
