/**
 * link augment — peer-to-peer A2A v0.2 transport.
 *
 * Wires the @auggy/link library into Auggy so two Auggy agents (or any
 * A2A v0.2-speaking peer: LangChain agent, Python A2A agent, future Mesh
 * coordinator) can exchange messages over HTTP with mutual bearer auth and
 * no central service. Imported as an npm dependency at @auggy/link v0.1.1.
 *
 * What this augment owns:
 *   - The link HTTP service: GET /health, GET /.well-known/agent.json,
 *     POST /a2a/v1, GET /a2a/v1/stream (501 stub at v0.1). Bound on its own
 *     Bun.serve port (default 8081), SEPARATE from webTransport.
 *   - BearerAuthProvider config: which peers can call this Auggy, with which
 *     bearers, and what verified Participant identity is minted on match.
 *   - SqliteTaskStore: durable persistence for inbound async tasks (capacity
 *     reserved for v0.2+ TaskCreateOutcome work — see ADR-022 sequencing).
 *   - Outbound PeerClient: enumerated via an EnvAddressBook constructed from
 *     the agent.yaml `peers` config.
 *   - Tools: `link_send` (text-only synchronous send), `link_list` (enumerate
 *     configured peers so the LLM knows who it can call).
 *
 * Inbound flow:
 *   1. @auggy/link receives an HTTP request on /a2a/v1.
 *   2. BearerAuthProvider verifies the bearer → mints a verified Participant.
 *   3. createLinkApp invokes onMessage(ctx: HandlerContext).
 *   4. This module translates ctx → TurnTrigger and calls kernel.handleInbound.
 *   5. The TurnResult is translated back → HandlerOutcome.
 *   6. v0.1 returns ONLY MessageOutcome (sync) or ErrorOutcome.
 *      TaskCreateOutcome is deferred until Auggy grows long-running task
 *      semantics — see ADR-022 for sequencing.
 *
 * Why this is NOT webTransport:
 *   - webTransport speaks AG-UI (SSE event protocol shaped for browser chat).
 *   - link speaks A2A v0.2 (JSON-RPC over HTTP, peer-to-peer agent traffic).
 *   - Operators run both simultaneously; they bind different ports and own
 *     non-overlapping path prefixes.
 *
 * Trust model:
 *   - BearerAuthProvider only admits configured peers, all of whom carry
 *     `trust: "agent"` at v0.1. Public/anonymous traffic NEVER reaches the
 *     onMessage callback — it's rejected with 401 before we see it.
 *   - The translation layer preserves trust_level verbatim; if v0.2 admits
 *     `creator` or `public` peers, Auggy sees them as such automatically.
 */

import { z } from "zod";

// Type-only imports from @auggy/link — erased at compile, so the global
// `auggy` install doesn't transitively pull `@auggy/link` into consumers'
// resolution trees. The augment's runtime values come from `importFromAgent`
// at factory-call time (see the `link()` body below).
//
// `PeerClient` is aliased to `PeerClientType` so the lazily-resolved value
// can re-use the bare `PeerClient` name inside the factory body without a
// type/value collision.
import type {
  AddressBook as LinkAddressBook,
  AgentCard as LinkAgentCard,
  AuthProvider as LinkAuthProvider,
  HandlerContext as LinkHandlerContext,
  LinkAppHandle,
  MessageHandler as LinkMessageHandler,
  PeerBearerConfig,
  PeerClient as PeerClientType,
} from "@auggy/link";

import { defineTool } from "../../helpers";
import type {
  Augment,
  ContextBlock,
  ToolExecuteContext,
  TransportKernel,
  TransportSpec,
  TurnState,
} from "../../types";
import { handlerContextToTrigger, turnResultToHandlerOutcome } from "./translate";
import { createPeerResolver, type PeerResolver, type SkippedPeer } from "./peer-resolver";
import { importFromAgent } from "../../cli/import-from-agent";

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/**
 * A configured peer. Each peer pair is symmetric: this Auggy uses `bearer` to
 * call the peer (outbound), and accepts `inboundBearer` FROM the peer (inbound).
 * The two bearers are independent — operators rotate them on independent
 * schedules so an in-flight rotation never breaks both directions at once.
 *
 *   url             — peer's link endpoint (e.g. https://researcher.example.org)
 *   bearer          — bearer this Auggy sends ON outbound requests TO the peer
 *   participantId   — peer's UUID (the verified Participant.id our messages
 *                     get tagged with on the peer's side; this Auggy must
 *                     know it for AddressBook lookup symmetry)
 *   inboundBearer   — bearer this Auggy ACCEPTS on inbound from the peer
 *   inboundBearerId — opaque audit id paired with inboundBearer (logged on
 *                     verify; never on the wire)
 *   purpose         — optional natural-language description of what this peer
 *                     is good for, surfaced to the LLM via `link_list`.
 *                     Semantic, not structural (per spine-north-star §4
 *                     Constraint 6). Drift risk: this is THIS agent's belief
 *                     about the peer, not the peer's self-declared card.
 *                     Forward-compat: coordinator era replaces this with the
 *                     participant registry.
 *   examples        — optional 1–2 example asks suitable for delegation. Used
 *                     by the LLM for few-shot routing. Beware: bad examples
 *                     mislead more than they help.
 */
export interface LinkPeerConfig {
  url: string;
  bearer: string;
  participantId: string;
  inboundBearer: string;
  inboundBearerId: string;
  purpose?: string;
  examples?: string[];
}

/**
 * Discriminated union of peer-source configurations.
 *
 * At v1, only the `registry` source type ships. Future variants
 * (`coordinator`, `mdns`, etc.) can be added without breaking existing
 * config — the discriminant is on `type`.
 *
 * See `lo/docs/superpowers/specs/2026-05-20-link-peer-directory-v1.md` for
 * the full design, including the discovery-vs-auth split (registry holds
 * public identities; bearers come from env vars).
 */
export type PeerSourceConfig = {
  /** Source-type discriminant. */
  type: "registry";
  /**
   * HTTPS URL the augment fetches at boot to populate its peer roster.
   * The URL must serve a JSON body matching `RegistryResponse`.
   */
  url: string;
  /**
   * In-memory cache TTL. After this many seconds the next operation that
   * needs peer state triggers a re-fetch. Default 60.
   */
  cacheSeconds?: number;
};

/**
 * Shape returned by a peer-registry endpoint. The stable wire contract
 * between the registry and the link augment.
 *
 * Public-only — no bearers. Bearers live in env vars on each Auggy:
 *   LINK_BEARER_<UPPERCASE_NAME>          — outbound bearer
 *   LINK_INBOUND_BEARER_<UPPERCASE_NAME>  — inbound bearer
 *   LINK_INBOUND_BEARER_ID_<UPPERCASE_NAME> — audit id paired with inbound
 */
export interface RegistryResponse {
  peers: RegistryPeer[];
}

/** A single peer entry served by a peer registry. */
export interface RegistryPeer {
  /** Short name the LLM uses with `link_send` (also the env-var lookup key). */
  name: string;
  /** Peer's link endpoint (e.g. https://researcher.example.org:8081). */
  url: string;
  /** Peer's UUID, used for AddressBook lookup symmetry. */
  participantId: string;
  /** Optional pointer to the peer's `/.well-known/agent.json` for richer discovery. */
  agentCardUrl?: string;
}

/**
 * Agent-card fields the link augment serves at /.well-known/agent.json.
 * Note this is the LINK card, not Auggy's general agent card — they
 * exist for different consumers (A2A peers vs AG-UI browsers).
 */
export interface LinkAugmentAgentCard {
  /** Stable UUID for this agent in the A2A network. */
  id: string;
  /** Display name shown in peer logs and address books. */
  name: string;
  /** One-line description of the agent's role. */
  description: string;
  /** Public URL this agent's link endpoint is reachable at. */
  endpointUrl: string;
  /** Capabilities the agent advertises (free-form strings at v0.1). */
  capabilities?: string[];
}

/**
 * Operator-facing options for the link augment. Two ways to populate peers:
 *
 *   (1) `peerSource` — fetch a registry on boot. Public identities only;
 *       bearers come from env vars. Preferred for non-trivial N (operator
 *       maintains one source of truth, agents stay in sync).
 *
 *   (2) `peers` — inline list keyed by name, bearers embedded. Kept as a
 *       fallback for offline dev and as a safety net if the registry is
 *       unreachable.
 *
 * When both are present, `peerSource` takes precedence; `peers` is used as
 * fallback if the registry fetch fails at boot. If neither is configured,
 * the augment runs in inbound-only mode (no outbound peers).
 *
 * Example with registry:
 *
 *   augments:
 *     - name: link
 *       type: link
 *       options:
 *         port: 8081
 *         dbPath: ./link.db
 *         agentCard:
 *           id: <uuid>
 *           name: zip
 *           description: Front-door agent
 *           endpointUrl: https://zip.example.org
 *         peerSource:
 *           type: registry
 *           url: https://lorf-context.up.railway.app/peers.json
 *           cacheSeconds: 60
 *
 * Bearers (env, per peer name `researcher`):
 *   LINK_BEARER_RESEARCHER          # outbound bearer
 *   LINK_INBOUND_BEARER_RESEARCHER  # inbound bearer
 *   LINK_INBOUND_BEARER_ID_RESEARCHER # audit id
 *
 * Example with inline peers (legacy / dev / fallback):
 *
 *         peers:
 *           researcher:
 *             url: https://researcher.example.org
 *             bearer: ${RESEARCHER_BEARER}
 *             participantId: <uuid>
 *             inboundBearer: ${RESEARCHER_INBOUND_BEARER}
 *             inboundBearerId: <uuid>
 *             purpose: "Research specialist. Knows recent ML literature."
 *             examples:
 *               - "What's the state of test-time compute scaling?"
 */
export interface LinkAugmentOptions {
  /** Port for the Bun.serve binding the link HTTP service. Default 8081. */
  port?: number;
  /** Path to the SQLite file backing SqliteTaskStore. */
  dbPath: string;
  /** Agent-card fields. */
  agentCard: LinkAugmentAgentCard;
  /**
   * Inline-configured peers keyed by short name. When `peerSource` is also
   * set, this map is the fallback if the registry fetch fails. Omit (or
   * leave empty) for inbound-only mode.
   */
  peers?: Record<string, LinkPeerConfig>;
  /**
   * Fetch peers from a registry at boot. Preferred for non-trivial N where
   * inline maintenance is painful. Falls back to `peers` if the registry
   * fetch fails. See `PeerSourceConfig` for the JSON contract.
   */
  peerSource?: PeerSourceConfig;
}

/**
 * Internal options. Carries `agentDir` so the factory can resolve `@auggy/link`
 * from the agent's local `node_modules` via `importFromAgent`. `resolveLink`
 * in the CLI is the canonical caller and threads `agentDir` from the
 * augment-resolver's loop. Operator-facing yaml has no `agentDir` field —
 * that's why this lives on the internal type, not on `LinkAugmentOptions`.
 *
 * Test-only fields below default to unset in production. Tests use them to
 * bypass Bun.serve binding and inject fakes.
 */
export interface LinkAugmentInternalOptions extends LinkAugmentOptions {
  /**
   * Absolute path to the agent's directory. Used by the factory to resolve
   * `@auggy/link` against `<agentDir>/node_modules` via `importFromAgent`.
   * Required — the package is no longer carried in `auggy` core's deps.
   */
  agentDir: string;
  /**
   * Skip the Bun.serve binding. Useful for unit tests that exercise the
   * MessageHandler closure directly without claiming a port. When set, the
   * augment never calls Bun.serve — it builds the link handle and stores it
   * so tests can drive it via the exported `_dispatchInbound` test hook.
   */
  _skipServer?: boolean;
  /**
   * Skip the periodic peerSource refresh timer. Useful for unit tests that
   * exercise the augment with a one-shot resolver fetch but don't want a
   * background interval running. When `peerSource` is unset this option has
   * no effect (no timer is scheduled either way).
   */
  _skipRefreshLoop?: boolean;
  /**
   * Inject a pre-built peer resolver. Tests use this to exercise the
   * augment's resolver-driven path without spinning a real HTTP server or
   * mocking `fetch` globally. When set, the factory bypasses the
   * `createPeerResolver(opts.peerSource)` construction and uses the
   * provided instance directly. Production callers leave unset.
   */
  _peerResolver?: PeerResolver;
  /**
   * Inject a custom PeerClient. Tests use this to replace the real outbound
   * client with an in-process recorder.
   */
  _peerClient?: PeerClientType;
  /**
   * Inject the AddressBook env used by the default PeerClient. Tests skip
   * the synthesized PEERS / PEER_*_BEARER env mangling by passing an env
   * object directly.
   */
  _addressBookEnv?: Record<string, string | undefined>;
  /**
   * Test-only side channel. When provided, the factory writes the production
   * MessageHandler closure into `out.handler` so the test harness can drive
   * the EXACT same code path that real link traffic exercises. Avoids
   * duplicating the try/catch / translation pipeline in test code.
   */
  _captureMessageHandler?: { handler?: LinkMessageHandler };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a frozen env map from the peers config for EnvAddressBook.
 *
 * EnvAddressBook reads:
 *   - `PEERS=a,b,c` (comma-separated peer names)
 *   - `PEER_<UPPER_NAME>_URL` / `PEER_<UPPER_NAME>_BEARER` for each name
 *
 * Names are uppercased and underscored exactly the way EnvAddressBook
 * expects. The resulting map is passed to `new EnvAddressBook(env)`.
 */
function buildAddressBookEnv(peers: Record<string, LinkPeerConfig>): Record<string, string> {
  const names = Object.keys(peers);
  const env: Record<string, string> = {
    PEERS: names.join(","),
  };
  for (const [name, cfg] of Object.entries(peers)) {
    const upper = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    env[`PEER_${upper}_URL`] = cfg.url;
    env[`PEER_${upper}_BEARER`] = cfg.bearer;
  }
  return env;
}

/**
 * Build the BearerAuthProvider peers map. The auth provider expects keys to
 * EQUAL the verified Participant.id; values carry the active bearer + audit
 * id. v0.1 trusts every configured peer with `trust: "agent"` (link's
 * design — see plan §6 for the trust alphabet).
 */
function buildAuthPeers(
  peers: Record<string, LinkPeerConfig>,
): Readonly<Record<string, PeerBearerConfig>> {
  const out: Record<string, PeerBearerConfig> = {};
  for (const cfg of Object.values(peers)) {
    out[cfg.participantId] = {
      participant: {
        id: cfg.participantId,
        locator: cfg.url,
        type: "agent",
        trust: "agent",
      },
      active: {
        bearer: cfg.inboundBearer,
        bearer_id: cfg.inboundBearerId,
      },
    };
  }
  return Object.freeze(out);
}

/** Stable threadId for a given peer. */
function threadIdForPeer(participantId: string): string {
  return `link-${participantId}`;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export async function link(opts: LinkAugmentInternalOptions): Promise<Augment> {
  // Resolve @auggy/link from the agent's local node_modules. Per the v0.3.2
  // package split, the SDK no longer ships with `auggy` core — it's declared
  // in the agent's per-agent package.json (via the catalog's packageDeps for
  // the link augment) and installed by `bun install` during `auggy create` or
  // `auggy augment add`. Library types come from the `import type { ... }` block at
  // module top; the value names bound below are runtime-only.
  const {
    BearerAuthProvider,
    EnvAddressBook,
    PeerClient,
    SqliteTaskStore,
    buildAgentCard,
    createLinkApp,
    isTaskResult,
  } = await importFromAgent<typeof import("@auggy/link")>(opts.agentDir, "@auggy/link");

  const port = opts.port ?? 8081;

  // ---------------------------------------------------------------------------
  // Peer state — mutable so peerSource refreshes propagate to tools + context
  // ---------------------------------------------------------------------------
  //
  // `peerStateRef.current` holds the active peer map. When `peerSource` is
  // configured, the resolver mutates it on each successful refresh; the
  // tools + context block + dynamic auth + dynamic address book all read
  // from this single source of truth.
  const peerStateRef: { current: Record<string, LinkPeerConfig> } = {
    current: opts.peers ?? {},
  };

  // The library's EnvAddressBook + BearerAuthProvider take frozen snapshots
  // at construction. To support live refresh, we wrap each in a thin
  // delegating implementation that swaps the inner instance on update.
  // This keeps the `@auggy/link` handle stable while letting peer state
  // change underneath.

  let innerAddressBook = new EnvAddressBook(
    opts._addressBookEnv ?? buildAddressBookEnv(peerStateRef.current),
  );
  const dynamicAddressBook: LinkAddressBook = {
    getPeer(name) {
      return innerAddressBook.getPeer(name);
    },
  };
  function rebuildAddressBook() {
    innerAddressBook = new EnvAddressBook(buildAddressBookEnv(peerStateRef.current));
  }

  let innerAuth = new BearerAuthProvider({ peers: buildAuthPeers(peerStateRef.current) });
  const dynamicAuth: LinkAuthProvider = {
    verify(req) {
      return innerAuth.verify(req);
    },
  };
  function rebuildAuth() {
    innerAuth = new BearerAuthProvider({ peers: buildAuthPeers(peerStateRef.current) });
  }

  const peerClient = opts._peerClient ?? new PeerClient({ addressBook: dynamicAddressBook });

  // Optional peer-source resolver. Constructed once at factory time; activated
  // (initial fetch + refresh loop) in transport.register so the kernel is
  // already wired when the first refresh propagates peer changes.
  //
  // `allowPlaintext` reuses the link library's localhost-dev convention:
  // when LINK_ALLOW_PLAINTEXT=1 the resolver accepts http:// for the source
  // URL and registry-supplied peer URLs. Production setups should leave it
  // unset so a compromised/misconfigured registry can't repoint bearer
  // traffic to plaintext attacker hosts.
  const allowPlaintext = (process.env.LINK_ALLOW_PLAINTEXT ?? "") === "1";
  const resolver: PeerResolver | null =
    opts._peerResolver ??
    (opts.peerSource
      ? createPeerResolver({
          url: opts.peerSource.url,
          cacheSeconds: opts.peerSource.cacheSeconds,
          selfParticipantId: opts.agentCard.id,
          allowPlaintext,
        })
      : null);

  /**
   * Surface peers the resolver skipped during the last refresh. Each entry
   * is operator-actionable (missing env var, insecure URL, malformed entry).
   * Logged as warn so they're loud enough to see in `auggy dev` output
   * without crashing the agent.
   */
  function logSkippedPeers(skipped: SkippedPeer[], phase: string): void {
    if (skipped.length === 0) return;
    for (const s of skipped) {
      const detail =
        s.reason.kind === "missing_bearer"
          ? `missing env var ${s.reason.envVar}`
          : s.reason.kind === "insecure_url"
            ? `insecure http:// URL "${s.reason.url}" (set LINK_ALLOW_PLAINTEXT=1 for localhost dev)`
            : `invalid entry — ${s.reason.reason}`;
      console.warn(`[link] peerSource ${phase}: skipped peer "${s.name}" — ${detail}`);
    }
  }
  let refreshTimer: ReturnType<typeof setInterval> | null = null;

  /**
   * Apply a fresh peer map from the resolver. Replaces `peerStateRef.current`
   * and swaps the inner auth + address-book instances so subsequent
   * inbound/outbound traffic sees the new state immediately.
   *
   * Caller is responsible for filtering: this function trusts the input as
   * the authoritative peer set. Peers absent from `next` are dropped (the
   * "forget" semantics in §4.4 of the spec).
   */
  function applyResolvedPeers(next: Record<string, LinkPeerConfig>): void {
    peerStateRef.current = next;
    rebuildAddressBook();
    rebuildAuth();
  }

  let kernel: TransportKernel | null = null;
  let registeredName = "link";
  let linkHandle: LinkAppHandle | null = null;
  let taskStore: InstanceType<typeof SqliteTaskStore> | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;
  let ready = false;

  // ---------------------------------------------------------------------------
  // Inbound MessageHandler — the bridge from link → Auggy kernel
  // ---------------------------------------------------------------------------

  const onMessage: LinkMessageHandler = async function onMessage(ctx: LinkHandlerContext) {
    if (!kernel) {
      // Defense-in-depth: link's middleware shouldn't be wired before
      // register fires (createLinkApp runs inside register), but if a future
      // ordering bug pre-binds it, fail loudly rather than swallow the
      // message.
      return {
        kind: "error",
        code: -32603,
        message: "link augment: kernel not yet registered",
      };
    }

    const threadId = threadIdForPeer(ctx.from.id);
    const trigger = handlerContextToTrigger(ctx, registeredName, threadId);
    try {
      const result = await kernel.handleInbound(trigger);
      return turnResultToHandlerOutcome(result);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        kind: "error",
        code: -32603,
        message: `link augment: turn dispatch failed: ${message}`,
      };
    }
  };

  if (opts._captureMessageHandler) {
    opts._captureMessageHandler.handler = onMessage;
  }

  // ---------------------------------------------------------------------------
  // TransportSpec.identify
  // ---------------------------------------------------------------------------
  //
  // link auth happens inside @auggy/link's BearerAuthProvider before
  // `onMessage` fires — by the time the Auggy kernel sees a trigger,
  // the peer identity has already been resolved via
  // participantToPeerIdentity. There's no transport-level identify path
  // for link; the TransportSpec stub returns null.
  const identify: TransportSpec["identify"] = () => null;

  const transport: TransportSpec = {
    async register(k: TransportKernel, augmentName: string) {
      kernel = k;
      registeredName = augmentName;

      // If `peerSource` is configured, fetch initial peers before constructing
      // the link app so the very first inbound request sees the right auth
      // table. On fetch failure, fall back to inline `opts.peers` (already
      // loaded into peerStateRef.current).
      if (resolver) {
        const initial = await resolver.getPeers();
        if (initial.ok) {
          applyResolvedPeers(initial.resolved.peers);
          logSkippedPeers(initial.resolved.skipped, "initial fetch");
        } else {
          const inlineCount = Object.keys(peerStateRef.current).length;
          console.warn(
            `[link] peerSource initial fetch failed (${initial.error.kind}): ${initial.error.message}. ${
              inlineCount > 0
                ? `Falling back to ${inlineCount} inline peer(s).`
                : "No inline peers — running inbound-only until next refresh succeeds."
            }`,
          );
        }
      }

      // Construct the link handle BEFORE binding Bun.serve so any
      // configuration error surfaces synchronously at boot.
      taskStore = new SqliteTaskStore({ path: opts.dbPath });
      // Inlined from the former `buildLinkAgentCard` helper — `buildAgentCard`
      // is now bound from the lazy-loaded module at the top of the factory.
      // v0.1 advertises `skills: []`; v0.2 will harvest from the agent's
      // mounted skill folders.
      try {
        const operatorCard = opts.agentCard;
        const agentCard: LinkAgentCard = buildAgentCard({
          id: operatorCard.id,
          name: operatorCard.name,
          description: operatorCard.description,
          endpoint_url: operatorCard.endpointUrl,
          capabilities: operatorCard.capabilities ?? [],
          skills: [],
        });

        linkHandle = createLinkApp({
          agentCard,
          auth: dynamicAuth,
          taskStore,
          onMessage,
        });
      } catch (err) {
        taskStore.close();
        taskStore = null;
        throw err;
      }
    },
    async ready() {
      if (!kernel || !linkHandle) {
        throw new Error("link augment: cannot become ready before registration");
      }
      if (ready) return;

      if (!opts._skipServer) {
        server = Bun.serve({ port, fetch: linkHandle.fetch });
      }

      // Schedule periodic refresh. The resolver itself caches by TTL, but
      // we need an active timer to drive the propagation — without a timer,
      // peer-state changes only land when getPeers() is called, which today
      // happens only in the tools at user request. The interval matches the
      // cache TTL so each tick yields exactly one fetch.
      if (resolver && !opts._skipRefreshLoop) {
        const intervalMs = (opts.peerSource?.cacheSeconds ?? 60) * 1000;
        refreshTimer = setInterval(() => {
          // fire-and-forget — errors are surfaced inside getPeers. The
          // resolver guarantees single-flight, so even if the previous
          // tick is still in-flight (slow registry), this `getPeers()`
          // joins the existing promise rather than launching a new fetch.
          void (async () => {
            resolver.invalidate();
            const result = await resolver.getPeers();
            if (result.ok) {
              applyResolvedPeers(result.resolved.peers);
              logSkippedPeers(result.resolved.skipped, "refresh");
            } else {
              console.warn(
                `[link] peerSource refresh failed (${result.error.kind}): ${result.error.message}. Keeping last-known peer state.`,
              );
            }
          })();
        }, intervalMs);
      }
      ready = true;
    },
    identify,
  };

  // ---------------------------------------------------------------------------
  // Outbound tools
  // ---------------------------------------------------------------------------

  const linkSendTool = defineTool({
    name: "link_send",
    description:
      "Send a text message to another agent via A2A peer-to-peer. The `to` parameter must be one of the peers configured in this agent's link config — call `link_list` to see them. Returns the peer's synchronous reply text when available, or a task id if the peer chose to handle the request asynchronously.",
    category: "communication",
    input: z.object({
      to: z
        .string()
        .describe("Peer short name from the link config (also surfaced by `link_list`)."),
      text: z.string().describe("Message text to send. v0.1 link traffic is text-only."),
    }),
    execute: async ({ to, text }, _ctx?: ToolExecuteContext) => {
      const result = await peerClient.send({
        to,
        parts: [{ kind: "text", text }],
      });

      if (!result.ok) {
        return JSON.stringify({
          ok: false,
          error: result.error.code,
          message: result.error.message,
        });
      }

      const { outcome } = result.value;
      if (isTaskResult(outcome)) {
        // Async task path — peer chose to create a Task. v0.1 doesn't yet
        // wire task polling into Auggy's tool surface; return the id so
        // the LLM (or operator) can follow up via future tools.
        return JSON.stringify({
          ok: true,
          outcome: "task",
          taskId: outcome.id,
        });
      }

      // Sync message path — concatenate text parts (link is text-only at
      // v0.1, so every part is a TextPart).
      const replyText = outcome.parts.map((p) => (p.kind === "text" ? p.text : "")).join("");
      return JSON.stringify({
        ok: true,
        outcome: "message",
        text: replyText,
      });
    },
  });

  const linkListTool = defineTool({
    name: "link_list",
    description:
      "List the peers configured for outbound A2A traffic. Returns `{ peers: [{ name, purpose?, examples? }] }`. The `name` is the value to pass as the `to` argument to `link_send`. `purpose` and `examples` (when present) describe what the peer is good for and what kinds of asks to delegate.",
    category: "communication",
    input: z.object({}),
    execute: async () => {
      const list = Object.entries(peerStateRef.current).map(([name, cfg]) => {
        const entry: { name: string; purpose?: string; examples?: string[] } = { name };
        if (cfg.purpose) entry.purpose = cfg.purpose;
        if (cfg.examples && cfg.examples.length > 0) entry.examples = cfg.examples;
        return entry;
      });
      return JSON.stringify({ peers: list });
    },
  });

  // ---------------------------------------------------------------------------
  // Context — minimal peer roster
  // ---------------------------------------------------------------------------
  //
  // Surfaces peer NAMES only (not purpose/examples) in every turn's preamble
  // so the LLM has awareness without context bloat. The model calls
  // `link_list` when it needs the richer per-peer purpose/examples for
  // routing decisions. Empty peers → no block (don't pollute preamble).
  const context = async (_turn: TurnState): Promise<ContextBlock[]> => {
    const names = Object.keys(peerStateRef.current);
    if (names.length === 0) return [];
    const content =
      `Peers reachable via link_send: ${names.join(", ")}. ` +
      "Call link_list to see what each peer is good for.";
    return [
      {
        source: "link",
        content,
        placement: "preamble",
        provenance: "augment",
        priority: "normal",
        eviction: "drop",
        origin: "system",
        ttl: "turn",
      },
    ];
  };

  const adminInfo = async (): Promise<import("../../types").AdminInfoBlock> => {
    const peerEntries = Object.entries(opts.peers ?? {});
    return {
      augmentName: "link",
      title: "Link (aug1 ↔ aug1)",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Status", value: "preview" },
            { label: "Inbound trust", value: "configured peers are admitted as agent trust" },
            { label: "Auth boundary", value: "bearer possession grants peer admission" },
            { label: "Listen port", value: String(opts.port ?? 8081) },
            { label: "Agent id", value: opts.agentCard?.id ?? "(unset)" },
            { label: "Agent name", value: opts.agentCard?.name ?? "(unset)" },
            { label: "Peer count", value: String(peerEntries.length) },
          ],
        },
        {
          kind: "table",
          columns: ["Name", "URL", "Participant id"],
          caption:
            peerEntries.length === 0
              ? "No peers configured."
              : `${peerEntries.length} peer${peerEntries.length === 1 ? "" : "s"}.`,
          rows: peerEntries.map(([name, p]) => [name, p.url, p.participantId]),
        },
      ],
    };
  };

  return {
    name: "link",
    type: "link",
    category: "transports",
    transport,
    context,
    tools: [linkSendTool, linkListTool],
    adminInfo,
    async onShutdown() {
      // Stop the refresh loop FIRST so an in-flight refresh doesn't try to
      // touch state that's about to be torn down.
      if (refreshTimer) {
        clearInterval(refreshTimer);
        refreshTimer = null;
      }
      // Stop the server next so no new admissions enter; THEN drain
      // in-flight requests via linkHandle.shutdown() so the store closes
      // cleanly. Order matters: if the store closes while a request is
      // still in flight, that request would see a store error.
      if (server) {
        try {
          server.stop();
        } catch (err) {
          console.warn(`[link] server.stop() failed: ${(err as Error).message}`);
        }
        server = null;
      }
      if (linkHandle) {
        try {
          await linkHandle.shutdown();
        } catch (err) {
          console.warn(`[link] linkHandle.shutdown() failed: ${(err as Error).message}`);
        }
        linkHandle = null;
      }
      // LinkApp owns this store after successful construction, but close is
      // idempotent. Keeping the reference lets rollback close it even when
      // construction or LinkApp shutdown only partially succeeds.
      taskStore?.close();
      taskStore = null;
      ready = false;
      kernel = null;
      registeredName = "link";
    },
  };
}

// ---------------------------------------------------------------------------
// Test-only hooks
// ---------------------------------------------------------------------------

/**
 * Test-only helper: build an augment alongside a handle to the MessageHandler
 * closure so integration tests can fire fake A2A messages without spinning up
 * a real Bun.serve.
 *
 * Returns:
 *   - augment: the assembled Augment (caller passes to defineAgent)
 *   - dispatch: pass a fake HandlerContext to invoke onMessage directly;
 *     returns the resolved HandlerOutcome
 *
 * This intentionally lives in the same file as the factory so the closure
 * over `onMessage` is in scope. The factory ignores the test hooks when
 * called from production paths.
 */
export async function _createLinkForTesting(opts: LinkAugmentInternalOptions): Promise<{
  augment: Augment;
  dispatch: (ctx: LinkHandlerContext) => Promise<ReturnType<LinkMessageHandler>>;
}> {
  // Capture the production MessageHandler via the side channel so the test
  // exercises THE SAME closure that real link traffic runs through. No
  // duplicated try/catch or translation logic in test code.
  const capture: { handler?: LinkMessageHandler } = {};
  const internalOpts: LinkAugmentInternalOptions = {
    ...opts,
    _skipServer: true,
    _captureMessageHandler: capture,
  };
  const augment = await link(internalOpts);

  const dispatch = async (ctx: LinkHandlerContext): Promise<ReturnType<LinkMessageHandler>> => {
    if (!capture.handler) {
      throw new Error(
        "_createLinkForTesting: production handler not captured — link() factory contract changed?",
      );
    }
    return capture.handler(ctx);
  };

  return { augment, dispatch };
}
