/**
 * link augment — peer-to-peer A2A v0.2 transport.
 *
 * Wires the @auggy/link library into augment-1 so two Auggy agents (or any
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
 *      TaskCreateOutcome is deferred until augment-1 grows long-running task
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
 *     `creator` or `public` peers, augment-1 sees them as such automatically.
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
  AgentCard as LinkAgentCard,
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
 * Agent-card fields the link augment serves at /.well-known/agent.json.
 * Note this is the LINK card, not augment-1's general agent card — they
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
 * Operator-facing options for the link augment. Configured in agent.yaml:
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
 *               - "Find recent papers on agent benchmarks"
 */
export interface LinkAugmentOptions {
  /** Port for the Bun.serve binding the link HTTP service. Default 8081. */
  port?: number;
  /** Path to the SQLite file backing SqliteTaskStore. */
  dbPath: string;
  /** Agent-card fields. */
  agentCard: LinkAugmentAgentCard;
  /**
   * Configured peers keyed by their short name (the name the LLM uses with
   * `link_send`). Empty map = the augment runs but has no callable peers,
   * which is legal (operator may rely on inbound-only at first).
   */
  peers: Record<string, LinkPeerConfig>;
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
  // `auggy add`. Library types come from the `import type { ... }` block at
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
  const peers = opts.peers ?? {};

  // Build the AddressBook env once at construction time. The library's
  // EnvAddressBook takes a frozen snapshot, so this can't be hot-reloaded
  // until @auggy/link v0.2 lands richer config plumbing.
  const addressBookEnv = opts._addressBookEnv ?? buildAddressBookEnv(peers);
  const addressBook = new EnvAddressBook(addressBookEnv);

  const peerClient = opts._peerClient ?? new PeerClient({ addressBook });

  let kernel: TransportKernel | null = null;
  let registeredName = "link";
  let linkHandle: LinkAppHandle | null = null;
  let server: ReturnType<typeof Bun.serve> | null = null;

  // ---------------------------------------------------------------------------
  // Inbound MessageHandler — the bridge from link → augment-1 kernel
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
  // `onMessage` fires — by the time the augment-1 kernel sees a trigger,
  // the peer identity has already been resolved via
  // participantToPeerIdentity. There's no transport-level identify path
  // for link; the TransportSpec stub returns null.
  const identify: TransportSpec["identify"] = () => null;

  const transport: TransportSpec = {
    async register(k: TransportKernel, augmentName: string) {
      kernel = k;
      registeredName = augmentName;

      // Construct the link handle BEFORE binding Bun.serve so any
      // configuration error surfaces synchronously at boot.
      const taskStore = new SqliteTaskStore({ path: opts.dbPath });
      const auth = new BearerAuthProvider({ peers: buildAuthPeers(peers) });
      // Inlined from the former `buildLinkAgentCard` helper — `buildAgentCard`
      // is now bound from the lazy-loaded module at the top of the factory.
      // v0.1 advertises `skills: []`; v0.2 will harvest from the agent's
      // mounted skill folders.
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
        auth,
        taskStore,
        onMessage,
      });

      if (!opts._skipServer) {
        server = Bun.serve({ port, fetch: linkHandle.fetch });
      }
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
        // wire task polling into augment-1's tool surface; return the id so
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
      const list = Object.entries(peers).map(([name, cfg]) => {
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
    const names = Object.keys(peers);
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

  return {
    name: "link",
    capabilities: ["transport", "context", "tools"],
    transport,
    context,
    tools: [linkSendTool, linkListTool],
    async onShutdown() {
      // Stop the server first so no new admissions enter; THEN drain
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
