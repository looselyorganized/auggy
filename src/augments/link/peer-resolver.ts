/**
 * peer-resolver — fetch peers from a registry, resolve env-based bearers,
 * cache in memory with TTL, support live refresh.
 *
 * Security properties retained from the original design and adversarial
 * review:
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
 *   - HTTPS-by-default (Codex finding #1, critical): both `peerSource.url`
 *     and registry-supplied peer URLs MUST be https:. Plaintext is allowed
 *     only when `allowPlaintext: true` is explicitly passed (the augment
 *     wires this from `LINK_ALLOW_PLAINTEXT=1` env, matching link library
 *     convention for localhost-dev). Without override:
 *       - http: peerSource.url → resolver construction throws (operator
 *         error worth failing loud at boot)
 *       - http: peer entry URL → that entry is skipped + surfaced in
 *         `skipped` (one bad entry doesn't poison the whole refresh)
 *
 *   - Per-peer error handling (Codex finding #2, high): a single bad entry
 *     does NOT abort the whole refresh. Bad entries are skipped + surfaced
 *     via `skipped: [{ name, reason }]`; valid peers apply, and removals
 *     propagate. This ensures revocations land even when an unrelated
 *     onboarding entry is mis-configured.
 *
 *   - Timeout + single-flight (Codex finding #3, high): fetches have an
 *     abortable timeout (default 10s); concurrent `getPeers()` callers
 *     share the same in-flight promise so a slow registry can't stampede
 *     a degraded dependency.
 *
 *   - Cache: in-memory only at v1. TTL governs refresh cadence; a refresh
 *     failure does NOT clear the last-good cache (degradation, not outage).
 *
 *   - Self-filter: a peer entry whose `participantId === agentCard.id` is
 *     dropped from the resolved map. Agents do not call themselves.
 *
 *   - Forget semantics: on successful refresh, peers no longer in the
 *     registry response are dropped from the resolved map. The augment
 *     propagates these removals into `AddressBook` + `BearerAuthProvider`
 *     via the dynamic-providers wrappers.
 */
import { createRedirectRejectingFetch } from "../../http";

import type { LinkPeerConfig } from "./index";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Whole-response failure. Per-entry issues use `SkippedPeerReason` instead. */
export type PeerResolverError =
  | { kind: "fetch_failed"; status?: number; message: string }
  | { kind: "timeout"; message: string }
  | { kind: "parse_failed"; message: string };

/** Reason a single registry entry was skipped during build. */
export type SkippedPeerReason =
  | { kind: "missing_bearer"; envVar: string }
  | { kind: "insecure_url"; url: string }
  | { kind: "invalid_entry"; reason: string };

export interface SkippedPeer {
  name: string;
  reason: SkippedPeerReason;
}

/** Successful resolution: the applied peers + a list of entries that were skipped. */
export interface ResolvedPeers {
  peers: Record<string, LinkPeerConfig>;
  skipped: SkippedPeer[];
}

export interface PeerResolverOptions {
  /** Registry URL to fetch on boot and on refresh. MUST be https unless allowPlaintext. */
  url: string;
  /** Cache TTL in seconds. Default 60. */
  cacheSeconds?: number;
  /** Self-identity: peers with this `participantId` are filtered out. */
  selfParticipantId: string;
  /**
   * Allow http:// for both the registry URL and registry-supplied peer URLs.
   * Default false. Operators enable via `LINK_ALLOW_PLAINTEXT=1` for localhost
   * dev; the augment passes the env var through. Production setups should
   * leave this off so a registry that gets repointed cannot redirect bearer
   * traffic to attacker-controlled plaintext hosts.
   */
  allowPlaintext?: boolean;
  /**
   * Abortable fetch timeout in milliseconds. Default 10_000. Applied per
   * fetch so a hung registry doesn't stall agent startup or block the
   * refresh loop.
   */
  requestTimeoutMs?: number;
  /** Env-var source. Defaults to `process.env`. Override for tests. */
  env?: Record<string, string | undefined>;
  /** Fetch implementation. Defaults to `globalThis.fetch`. Override for tests. */
  fetchImpl?: typeof fetch;
}

export interface PeerResolver {
  /**
   * Return the current peers + the list of entries that were skipped. If
   * the cache is empty or expired, this triggers a single-flight fresh
   * fetch (concurrent callers share the same in-flight promise).
   *
   * Whole-response errors return `{ ok: false, error }` and preserve the
   * last-good cache (subsequent callers still receive the cached state).
   */
  getPeers(): Promise<
    { ok: true; resolved: ResolvedPeers } | { ok: false; error: PeerResolverError }
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

export interface ParsedRegistryEntry {
  entry: RegistryPeerEntry;
}

export interface ParseEntryError {
  /** Best-effort name for surfacing skipped entries with anonymous failures. */
  name: string;
  reason: SkippedPeerReason;
}

export interface ParsedRegistryResponse {
  entries: ParsedRegistryEntry[];
  /** Entries the parser couldn't accept — surfaced into the caller's `skipped` list. */
  parseSkipped: ParseEntryError[];
}

// ---------------------------------------------------------------------------
// Env-var conventions
// ---------------------------------------------------------------------------

function envKey(prefix: string, peerName: string): string {
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
// URL validation
// ---------------------------------------------------------------------------

function isUuid(s: unknown): s is string {
  return (
    typeof s === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s)
  );
}

interface UrlCheckResult {
  ok: boolean;
  /** Discriminates: insecure (http: when not allowed) vs invalid (not a URL / bad scheme). */
  reason?: "insecure" | "invalid";
}

function checkUrl(s: unknown, allowPlaintext: boolean): UrlCheckResult {
  if (typeof s !== "string" || s.length === 0) return { ok: false, reason: "invalid" };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (u.protocol === "https:") return { ok: true };
  if (u.protocol === "http:") {
    return allowPlaintext ? { ok: true } : { ok: false, reason: "insecure" };
  }
  return { ok: false, reason: "invalid" };
}

// ---------------------------------------------------------------------------
// Validation + parsing — per-entry, not all-or-nothing
// ---------------------------------------------------------------------------

export function parseRegistryResponse(
  body: unknown,
  allowPlaintext: boolean,
): { ok: true; parsed: ParsedRegistryResponse } | { ok: false; message: string } {
  if (!body || typeof body !== "object") {
    return { ok: false, message: "registry response is not an object" };
  }
  const peersRaw = (body as { peers?: unknown }).peers;
  if (!Array.isArray(peersRaw)) {
    return { ok: false, message: "registry response missing `peers` array" };
  }

  const entries: ParsedRegistryEntry[] = [];
  const parseSkipped: ParseEntryError[] = [];

  for (let i = 0; i < peersRaw.length; i++) {
    const raw = peersRaw[i];
    const name =
      raw && typeof raw === "object" && typeof (raw as { name?: unknown }).name === "string"
        ? ((raw as { name: string }).name as string)
        : `<entry ${i}>`;

    if (!raw || typeof raw !== "object") {
      parseSkipped.push({
        name,
        reason: { kind: "invalid_entry", reason: "entry is not an object" },
      });
      continue;
    }
    const e = raw as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) {
      parseSkipped.push({
        name,
        reason: { kind: "invalid_entry", reason: "missing or empty `name`" },
      });
      continue;
    }
    const urlCheck = checkUrl(e.url, allowPlaintext);
    if (!urlCheck.ok) {
      const url = typeof e.url === "string" ? e.url : "<missing>";
      if (urlCheck.reason === "insecure") {
        parseSkipped.push({ name: e.name, reason: { kind: "insecure_url", url } });
      } else {
        parseSkipped.push({
          name: e.name,
          reason: { kind: "invalid_entry", reason: `url is not a valid http(s) URL: ${url}` },
        });
      }
      continue;
    }
    if (!isUuid(e.participantId)) {
      parseSkipped.push({
        name: e.name,
        reason: { kind: "invalid_entry", reason: "missing or malformed `participantId` (UUID)" },
      });
      continue;
    }
    if (e.agentCardUrl !== undefined) {
      const cardCheck = checkUrl(e.agentCardUrl, allowPlaintext);
      if (!cardCheck.ok) {
        const url = typeof e.agentCardUrl === "string" ? e.agentCardUrl : "<missing>";
        parseSkipped.push({
          name: e.name,
          reason:
            cardCheck.reason === "insecure"
              ? { kind: "insecure_url", url }
              : { kind: "invalid_entry", reason: `agentCardUrl is invalid: ${url}` },
        });
        continue;
      }
    }
    entries.push({
      entry: {
        name: e.name as string,
        url: e.url as string,
        participantId: e.participantId as string,
        agentCardUrl: typeof e.agentCardUrl === "string" ? e.agentCardUrl : undefined,
      },
    });
  }

  return { ok: true, parsed: { entries, parseSkipped } };
}

// ---------------------------------------------------------------------------
// Building a resolved peers map — per-peer, not all-or-nothing
// ---------------------------------------------------------------------------

/**
 * Translate parsed registry entries + env-resolved bearers into the
 * `Record<string, LinkPeerConfig>` shape the rest of the augment expects.
 *
 * Per Codex review finding #2: skip-not-fail on per-entry errors. A peer
 * with missing bearers is added to `skipped`, not bubbled as a top-level
 * error — so removals + valid updates still apply.
 *
 * Self-filter (skip the entry whose participantId === selfParticipantId)
 * happens here.
 */
export function buildPeerConfigsFromRegistry(
  parsed: ParsedRegistryResponse,
  selfParticipantId: string,
  env: Record<string, string | undefined>,
): ResolvedPeers {
  const out: Record<string, LinkPeerConfig> = {};
  const skipped: SkippedPeer[] = [...parsed.parseSkipped];

  for (const { entry } of parsed.entries) {
    if (entry.participantId === selfParticipantId) continue; // self-filter

    const bearer = readBearerFromEnv(env, entry.name, "LINK_BEARER_");
    if (!bearer) {
      skipped.push({
        name: entry.name,
        reason: { kind: "missing_bearer", envVar: envKey("LINK_BEARER_", entry.name) },
      });
      continue;
    }

    const inboundBearer = readBearerFromEnv(env, entry.name, "LINK_INBOUND_BEARER_");
    if (!inboundBearer) {
      skipped.push({
        name: entry.name,
        reason: { kind: "missing_bearer", envVar: envKey("LINK_INBOUND_BEARER_", entry.name) },
      });
      continue;
    }

    const inboundBearerId = readBearerFromEnv(env, entry.name, "LINK_INBOUND_BEARER_ID_");
    if (!inboundBearerId) {
      skipped.push({
        name: entry.name,
        reason: {
          kind: "missing_bearer",
          envVar: envKey("LINK_INBOUND_BEARER_ID_", entry.name),
        },
      });
      continue;
    }

    out[entry.name] = {
      url: entry.url,
      bearer,
      participantId: entry.participantId,
      inboundBearer,
      inboundBearerId,
    };
  }

  return { peers: out, skipped };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

const DEFAULT_TTL_SECONDS = 60;
const DEFAULT_TIMEOUT_MS = 10_000;

export function createPeerResolver(opts: PeerResolverOptions): PeerResolver {
  const ttlSeconds = opts.cacheSeconds ?? DEFAULT_TTL_SECONDS;
  const timeoutMs = opts.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS;
  const allowPlaintext = opts.allowPlaintext === true;
  const env = opts.env ?? (process.env as Record<string, string | undefined>);
  const fetchImpl = opts.fetchImpl ?? createRedirectRejectingFetch();

  // HTTPS gate on the source URL at construction time. Operator-controlled
  // config; failing loud here is appropriate.
  const sourceCheck = checkUrl(opts.url, allowPlaintext);
  if (!sourceCheck.ok) {
    const detail =
      sourceCheck.reason === "insecure"
        ? `peerSource.url must use https:// (got "${opts.url}"). Set LINK_ALLOW_PLAINTEXT=1 to override for localhost dev.`
        : `peerSource.url is not a valid http(s) URL: "${opts.url}"`;
    throw new Error(`createPeerResolver: ${detail}`);
  }

  let cache: ResolvedPeers | null = null;
  let cachedAtMs: number | null = null;
  let forceRefresh = false;

  // Single-flight: while a fetch is in flight, concurrent callers share
  // the same promise. Prevents stampede when the timer + a direct caller
  // both hit getPeers() against a slow registry.
  let inFlight: Promise<
    { ok: true; resolved: ResolvedPeers } | { ok: false; error: PeerResolverError }
  > | null = null;

  async function fetchAndBuild(): Promise<
    { ok: true; resolved: ResolvedPeers } | { ok: false; error: PeerResolverError }
  > {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), timeoutMs);

    let response: Response;
    try {
      response = await fetchImpl(opts.url, {
        method: "GET",
        headers: { accept: "application/json" },
        signal: ac.signal,
      });
    } catch (err) {
      // AbortController signals via DOMException name === "AbortError" in
      // most runtimes; Bun + Node both follow.
      const aborted =
        (err instanceof Error && err.name === "AbortError") ||
        (err as { name?: string })?.name === "AbortError";
      const message = err instanceof Error ? err.message : String(err);
      if (aborted) {
        return {
          ok: false,
          error: { kind: "timeout", message: `registry fetch exceeded ${timeoutMs}ms` },
        };
      }
      return { ok: false, error: { kind: "fetch_failed", message } };
    } finally {
      clearTimeout(timer);
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

    const parse = parseRegistryResponse(body, allowPlaintext);
    if (!parse.ok) {
      return { ok: false, error: { kind: "parse_failed", message: parse.message } };
    }

    const resolved = buildPeerConfigsFromRegistry(parse.parsed, opts.selfParticipantId, env);
    return { ok: true, resolved };
  }

  return {
    async getPeers() {
      const now = Date.now();
      const expired =
        cachedAtMs === null || (now - cachedAtMs) / 1000 >= ttlSeconds || forceRefresh;

      if (!expired && cache) {
        return { ok: true, resolved: cache };
      }

      // Single-flight: if a fetch is already running, await it instead of
      // launching another.
      if (inFlight) return inFlight;

      inFlight = (async () => {
        try {
          const result = await fetchAndBuild();
          if (result.ok) {
            cache = result.resolved;
            cachedAtMs = Date.now();
            forceRefresh = false;
            return result;
          }
          // Refresh failed: preserve last-good cache. Callers that have a
          // valid cache get it back as ok; callers with no cache get the
          // error so they can decide to fall back to inline peers.
          if (cache) {
            return { ok: true, resolved: cache } as const;
          }
          return result;
        } finally {
          inFlight = null;
        }
      })();

      return inFlight;
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
