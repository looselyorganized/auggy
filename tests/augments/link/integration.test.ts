import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HandlerContext as LinkHandlerContext,
  Part as LinkPart,
  PeerSendError,
} from "@auggy/link";

import { _createLinkForTesting, link } from "@/augments/link";
import type {
  AgentCard,
  OutboundMessage,
  PeerIdentity,
  ToolExecuteContext,
  TransportKernel,
  TurnResult,
  TurnState,
  TurnTrigger,
} from "@/types";
import { asStringTool } from "../../fixtures/tool-helpers";

const SELF_PARTICIPANT_ID = "00000000-0000-4000-8000-00000000aaaa";
const PEER_PARTICIPANT_ID = "00000000-0000-4000-8000-00000000bbbb";

function uniqueDbPath(): string {
  return join(tmpdir(), `link-test-${crypto.randomUUID()}.db`);
}

function makeStubKernel(handler: (t: TurnTrigger) => TurnResult): {
  kernel: TransportKernel;
  triggers: TurnTrigger[];
} {
  const triggers: TurnTrigger[] = [];
  const kernel: TransportKernel = {
    handleInbound: async (trigger) => {
      triggers.push(trigger);
      return handler(trigger);
    },
    onOutbound: () => {},
    getAgentCard: () => ({}) as AgentCard,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
  return { kernel, triggers };
}

function completedResult(trigger: TurnTrigger, text: string): TurnResult {
  const response: OutboundMessage = { parts: [{ kind: "text", text }] };
  return {
    turnId: trigger.turnId,
    success: true,
    status: "completed",
    response,
    toolCalls: [],
    trace: {
      turnId: trigger.turnId,
      threadId: trigger.threadId ?? trigger.turnId,
      timestamp: 0,
      duration: 0,
      trigger: { type: "message" },
      contextAssembly: {
        augmentBlocks: [],
        preambleTokens: 0,
        toolSchemaTokens: 0,
        historyTokens: 0,
        totalTokens: 0,
        budgetUsed: 0,
      },
      toolSelection: {
        totalTools: 0,
        phase1Used: false,
        mountedTools: [],
        withheldTools: [],
      },
      inferenceSteps: [],
      capabilityChecks: [],
    },
  };
}

function rejectedResult(trigger: TurnTrigger, reason: string): TurnResult {
  return {
    turnId: trigger.turnId,
    success: false,
    status: "rejected",
    errorClass: "cap-denied",
    errorResponse: reason,
    toolCalls: [],
    trace: completedResult(trigger, "").trace,
  };
}

function makeLinkContext(overrides: Partial<LinkHandlerContext> = {}): LinkHandlerContext {
  return {
    from: {
      id: PEER_PARTICIPANT_ID,
      locator: "https://peer.example.org",
      type: "agent",
      trust: "agent",
    },
    parts: [{ kind: "text", text: "ping" }],
    request_id: 1,
    received_at: new Date().toISOString(),
    ...overrides,
  };
}

function makeOpts(): Parameters<typeof link>[0] {
  return {
    // agentDir: per the v0.3.2 package split, the link factory resolves
    // `@auggy/link` from <agentDir>/node_modules via importFromAgent. In this
    // repo, the workspace root has `@auggy/link` available via the
    // devDependency declared in package.json, so process.cwd() (the repo
    // root, when tests run via `bun test`) is a valid agentDir. Mirrors the
    // pattern at tests/cli/engine-resolver.test.ts (AGENT_DIR = process.cwd()).
    agentDir: process.cwd(),
    port: 0, // _skipServer is enabled in _createLinkForTesting, so port is ignored
    dbPath: uniqueDbPath(),
    agentCard: {
      id: SELF_PARTICIPANT_ID,
      name: "test-agent",
      description: "augment-1 link test agent",
      endpointUrl: "https://test-agent.example.org",
    },
    peers: {
      researcher: {
        url: "https://researcher.example.org",
        bearer: "outbound-secret",
        participantId: PEER_PARTICIPANT_ID,
        inboundBearer: "inbound-secret",
        inboundBearerId: "inbound-secret-id",
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Construction smoke
// ---------------------------------------------------------------------------

describe("link augment — construction", () => {
  it("returns an augment with transport + context + tools capability", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    expect(aug.name).toBe("link");
    expect(aug.capabilities).toContain("transport");
    expect(aug.capabilities).toContain("context");
    expect(aug.capabilities).toContain("tools");
    expect(aug.transport).toBeDefined();
    expect(aug.context).toBeDefined();
    expect(aug.tools).toBeDefined();
    expect(aug.tools?.map((t) => t.name).sort()).toEqual(["link_list", "link_send"]);
  });

  it("identify() always returns null (link auth handled by BearerAuthProvider)", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    expect(aug.transport?.identify({ anything: true })).toBeNull();
  });

  it("onShutdown is wired", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    expect(aug.onShutdown).toBeDefined();
    // Calling shutdown without prior register doesn't throw.
    await aug.onShutdown!();
  });
});

// ---------------------------------------------------------------------------
// Inbound flow — MessageHandler closure
// ---------------------------------------------------------------------------

describe("link augment — inbound flow", () => {
  it("dispatches inbound HandlerContext → kernel.handleInbound with the right trigger", async () => {
    const opts = makeOpts();
    const { augment, dispatch } = await _createLinkForTesting(opts);

    let captured: TurnTrigger | undefined;
    const kernel: TransportKernel = {
      handleInbound: async (trigger) => {
        captured = trigger;
        return completedResult(trigger, "pong");
      },
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };

    await augment.transport!.register(kernel, "link");

    const ctx = makeLinkContext({
      idempotency_key: "idem-1",
      request_id: "req-7",
    });
    const outcome = await dispatch(ctx);

    // Kernel saw a properly-shaped trigger
    expect(captured).toBeDefined();
    expect(captured?.type).toBe("message");
    expect(captured?.source).toBe("link");
    expect(captured?.threadId).toBe(`link-${PEER_PARTICIPANT_ID}`);
    expect(captured?.peer?.id).toBe(PEER_PARTICIPANT_ID);
    expect(captured?.peer?.trustLevel).toBe("agent");
    expect(captured?.peer?.sourceAugment).toBe("link");

    const inbound = captured?.payload as {
      parts: Array<{ text: string }>;
      metadata?: Record<string, unknown>;
    };
    expect(inbound.parts[0]?.text).toBe("ping");
    expect(inbound.metadata?.idempotency_key).toBe("idem-1");
    expect(inbound.metadata?.request_id).toBe("req-7");

    // Outcome matches the kernel's completed response
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.parts).toEqual([{ kind: "text", text: "pong" }]);
    }

    await augment.onShutdown!();
  });

  it("kernel rejection surfaces as ErrorOutcome on the wire", async () => {
    const { augment, dispatch } = await _createLinkForTesting(makeOpts());
    const { kernel } = makeStubKernel((t) => rejectedResult(t, "over budget"));
    await augment.transport!.register(kernel, "link");
    const outcome = await dispatch(makeLinkContext());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe(-32603);
      expect(outcome.message).toBe("over budget");
    }
    await augment.onShutdown!();
  });

  it("kernel thrown error surfaces as ErrorOutcome (no propagation past the augment)", async () => {
    const { augment, dispatch } = await _createLinkForTesting(makeOpts());
    const kernel: TransportKernel = {
      handleInbound: async () => {
        throw new Error("boom");
      },
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };
    await augment.transport!.register(kernel, "link");
    const outcome = await dispatch(makeLinkContext());
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("boom");
    }
    await augment.onShutdown!();
  });

  it("respects operator-renamed augment instance (sourceAugment + trigger.source)", async () => {
    const { augment, dispatch } = await _createLinkForTesting(makeOpts());
    let captured: TurnTrigger | undefined;
    const kernel: TransportKernel = {
      handleInbound: async (t) => {
        captured = t;
        return completedResult(t, "ok");
      },
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };
    await augment.transport!.register(kernel, "link-mesh");
    await dispatch(makeLinkContext());
    expect(captured?.source).toBe("link-mesh");
    expect(captured?.peer?.sourceAugment).toBe("link-mesh");
    await augment.onShutdown!();
  });
});

// ---------------------------------------------------------------------------
// Trust-gate translation
// ---------------------------------------------------------------------------

describe("link augment — trust gate", () => {
  it("trust: 'agent' participant → PeerIdentity.trustLevel = 'agent'", async () => {
    const { augment, dispatch } = await _createLinkForTesting(makeOpts());
    let peer: PeerIdentity | null | undefined;
    const kernel: TransportKernel = {
      handleInbound: async (t) => {
        peer = t.peer;
        return completedResult(t, "ok");
      },
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };
    await augment.transport!.register(kernel, "link");
    await dispatch(makeLinkContext({ from: { ...makeLinkContext().from, trust: "agent" } }));
    expect(peer?.trustLevel).toBe("agent");
    expect(peer?.kind).toBe("agent");
    await augment.onShutdown!();
  });

  it("trust: 'public' participant translates to public trust without publicSubstate", async () => {
    const { augment, dispatch } = await _createLinkForTesting(makeOpts());
    let peer: PeerIdentity | null | undefined;
    const kernel: TransportKernel = {
      handleInbound: async (t) => {
        peer = t.peer;
        return completedResult(t, "ok");
      },
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };
    await augment.transport!.register(kernel, "link");
    const ctx = makeLinkContext();
    await dispatch({ ...ctx, from: { ...ctx.from, trust: "public" } });
    expect(peer?.trustLevel).toBe("public");
    expect(peer?.publicSubstate).toBeUndefined();
    await augment.onShutdown!();
  });
});

// ---------------------------------------------------------------------------
// Outbound link_send tool
// ---------------------------------------------------------------------------

describe("link_send tool", () => {
  function makeToolCtx(): ToolExecuteContext {
    return { turnId: "turn-1", peer: null, threadId: "thread-1" };
  }

  it("invokes PeerClient.send with text parts; returns ok+message+text on sync reply", async () => {
    const calls: Array<{ to: string; parts: readonly LinkPart[] }> = [];
    const fakePeerClient = {
      send: async (args: { to: string; parts: readonly LinkPart[] }) => {
        calls.push({ to: args.to, parts: args.parts });
        return {
          ok: true as const,
          value: {
            outcome: {
              message_id: "msg-1",
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: "world" }],
            },
            idempotencyKey: "idem-x",
          },
        };
      },
    };
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    const sendTool = aug.tools!.find((t) => t.name === "link_send")!;
    const result = await asStringTool(sendTool).execute(
      { to: "researcher", text: "hello" },
      makeToolCtx(),
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.to).toBe("researcher");
    expect(calls[0]?.parts).toEqual([{ kind: "text", text: "hello" }]);
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ ok: true, outcome: "message", text: "world" });
  });

  it("returns ok+task+taskId when peer responded with a Task", async () => {
    const fakePeerClient = {
      send: async () => {
        return {
          ok: true as const,
          value: {
            outcome: {
              id: "task-42",
              status: "submitted" as const,
              created_at: "2026-04-27T12:00:00.000Z",
              updated_at: "2026-04-27T12:00:00.000Z",
              parts: [{ kind: "text" as const, text: "hello" }],
              artifacts: [],
            },
            idempotencyKey: "idem-x",
          },
        };
      },
    };
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    const sendTool = aug.tools!.find((t) => t.name === "link_send")!;
    const result = await asStringTool(sendTool).execute(
      { to: "researcher", text: "kick off work" },
      makeToolCtx(),
    );
    const parsed = JSON.parse(result);
    expect(parsed).toEqual({ ok: true, outcome: "task", taskId: "task-42" });
  });

  it("returns ok:false+error on PeerSendError", async () => {
    const fakePeerClient = {
      send: async () => {
        const err: Partial<PeerSendError> & {
          code: string;
          message: string;
        } = { code: "peer_network_error", message: "ECONNREFUSED" };
        return { ok: false as const, error: err };
      },
    };
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    const sendTool = aug.tools!.find((t) => t.name === "link_send")!;
    const result = await asStringTool(sendTool).execute(
      { to: "researcher", text: "hello" },
      makeToolCtx(),
    );
    const parsed = JSON.parse(result);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toBe("peer_network_error");
    expect(parsed.message).toBe("ECONNREFUSED");
  });
});

// ---------------------------------------------------------------------------
// Outbound link_list tool
// ---------------------------------------------------------------------------

describe("link_list tool", () => {
  function makeToolCtx(): ToolExecuteContext {
    return { turnId: "turn-1", peer: null, threadId: "thread-1" };
  }

  it("returns the configured peer names as { name } entries", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {
        researcher: {
          url: "https://r.example.org",
          bearer: "x",
          participantId: PEER_PARTICIPANT_ID,
          inboundBearer: "y",
          inboundBearerId: "yi",
        },
        analyst: {
          url: "https://a.example.org",
          bearer: "x2",
          participantId: "00000000-0000-4000-8000-00000000cccc",
          inboundBearer: "y2",
          inboundBearerId: "yi2",
        },
      },
    });
    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute({}, makeToolCtx());
    const parsed = JSON.parse(result);
    const names = (parsed.peers as Array<{ name: string }>).map((p) => p.name);
    expect(new Set(names)).toEqual(new Set(["researcher", "analyst"]));
    // No purpose/examples were configured, so neither field appears.
    for (const entry of parsed.peers) {
      expect(entry.purpose).toBeUndefined();
      expect(entry.examples).toBeUndefined();
    }
  });

  it("returns an empty array when no peers are configured", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {},
    });
    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute({}, makeToolCtx());
    const parsed = JSON.parse(result);
    expect(parsed.peers).toEqual([]);
  });

  it("includes purpose + examples when configured", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {
        researcher: {
          url: "https://r.example.org",
          bearer: "x",
          participantId: PEER_PARTICIPANT_ID,
          inboundBearer: "y",
          inboundBearerId: "yi",
          purpose: "Research specialist. Recent ML literature.",
          examples: ["What's new in test-time compute?", "Find recent agents papers"],
        },
      },
    });
    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute({}, makeToolCtx());
    const parsed = JSON.parse(result);
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers[0]).toEqual({
      name: "researcher",
      purpose: "Research specialist. Recent ML literature.",
      examples: ["What's new in test-time compute?", "Find recent agents papers"],
    });
  });

  it("omits empty examples array but keeps purpose when only purpose set", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {
        researcher: {
          url: "https://r.example.org",
          bearer: "x",
          participantId: PEER_PARTICIPANT_ID,
          inboundBearer: "y",
          inboundBearerId: "yi",
          purpose: "Knows ML papers.",
          examples: [],
        },
      },
    });
    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute({}, makeToolCtx());
    const parsed = JSON.parse(result);
    expect(parsed.peers[0]).toEqual({ name: "researcher", purpose: "Knows ML papers." });
  });
});

// ---------------------------------------------------------------------------
// Context block — peer roster surfaced to the LLM
// ---------------------------------------------------------------------------

describe("link augment — context block", () => {
  function makeTurnState(): TurnState {
    return {
      turnId: "turn-1",
      threadId: "thread-1",
      peer: null,
      tools: [],
      history: [],
      contextBlocks: [],
      trigger: { type: "message", turnId: "turn-1", payload: { parts: [] } },
    } as unknown as TurnState;
  }

  it("emits a single preamble block listing peer names when peers are configured", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {
        researcher: {
          url: "https://r.example.org",
          bearer: "x",
          participantId: PEER_PARTICIPANT_ID,
          inboundBearer: "y",
          inboundBearerId: "yi",
          purpose: "ML papers",
        },
        analyst: {
          url: "https://a.example.org",
          bearer: "x2",
          participantId: "00000000-0000-4000-8000-00000000cccc",
          inboundBearer: "y2",
          inboundBearerId: "yi2",
        },
      },
    });
    const blocks = await aug.context!(makeTurnState());
    const blockArr = blocks as Array<{
      source: string;
      content: string;
      placement: string;
      provenance: string;
    }>;
    expect(blockArr).toHaveLength(1);
    expect(blockArr[0]?.source).toBe("link");
    expect(blockArr[0]?.placement).toBe("preamble");
    expect(blockArr[0]?.provenance).toBe("augment");
    // Names appear; purpose intentionally does NOT (call link_list for that).
    expect(blockArr[0]?.content).toContain("researcher");
    expect(blockArr[0]?.content).toContain("analyst");
    expect(blockArr[0]?.content).not.toContain("ML papers");
    expect(blockArr[0]?.content).toContain("link_list");
  });

  it("emits no block when peers map is empty", async () => {
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      peers: {},
    });
    const blocks = await aug.context!(makeTurnState());
    expect(blocks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// peerSource — registry-based resolution
// ---------------------------------------------------------------------------

import type { PeerResolver } from "@/augments/link/peer-resolver";
import type { LinkPeerConfig } from "@/augments/link";

type ResolverResult = Awaited<ReturnType<PeerResolver["getPeers"]>>;

function makeStubResolver(behavior: () => ResolverResult): PeerResolver {
  return {
    async getPeers() {
      return behavior();
    },
    invalidate() {},
    cacheAgeSeconds() {
      return null;
    },
  };
}

describe("link augment — peerSource integration", () => {
  function makeTurnState(): TurnState {
    return {
      turnId: "turn-1",
      threadId: "thread-1",
      peer: null,
      tools: [],
      history: [],
      contextBlocks: [],
      trigger: { type: "message", turnId: "turn-1", payload: { parts: [] } },
    } as unknown as TurnState;
  }

  it("uses resolved peers when initial fetch succeeds (no inline peers)", async () => {
    const resolvedPeers: Record<string, LinkPeerConfig> = {
      frontier: {
        url: "https://frontier.example.org",
        bearer: "outbound",
        participantId: PEER_PARTICIPANT_ID,
        inboundBearer: "inbound",
        inboundBearerId: "inbound-id",
      },
    };
    const resolver = makeStubResolver(() => ({ ok: true, peers: resolvedPeers }) as ResolverResult);

    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _skipRefreshLoop: true,
      _peerResolver: resolver,
      peerSource: { type: "registry", url: "https://example.org/peers.json" },
      peers: undefined,
    });

    const { kernel } = makeStubKernel((t) => completedResult(t, "ok"));
    await aug.transport!.register(kernel, "link");

    // link_list reflects the resolved peers
    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute(
      {},
      {
        turnId: "t",
        peer: null,
        threadId: "th",
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.peers).toHaveLength(1);
    expect(parsed.peers[0].name).toBe("frontier");

    // context block reflects the resolved peers
    const blocks = await aug.context!(makeTurnState());
    expect(blocks).toHaveLength(1);
    expect((blocks as Array<{ content: string }>)[0]?.content).toContain("frontier");

    await aug.onShutdown!();
  });

  it("falls back to inline peers when initial fetch fails", async () => {
    const resolver = makeStubResolver(
      () =>
        ({
          ok: false,
          error: { kind: "fetch_failed", status: 503, message: "registry down" },
        }) as ResolverResult,
    );

    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _skipRefreshLoop: true,
      _peerResolver: resolver,
      peerSource: { type: "registry", url: "https://example.org/peers.json" },
      peers: {
        backup: {
          url: "https://backup.example.org",
          bearer: "x",
          participantId: "00000000-0000-4000-8000-00000000eeee",
          inboundBearer: "y",
          inboundBearerId: "yi",
        },
      },
    });

    const { kernel } = makeStubKernel((t) => completedResult(t, "ok"));
    await aug.transport!.register(kernel, "link");

    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute(
      {},
      {
        turnId: "t",
        peer: null,
        threadId: "th",
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.peers.map((p: { name: string }) => p.name)).toEqual(["backup"]);

    await aug.onShutdown!();
  });

  it("runs in inbound-only mode when fetch fails and no inline peers", async () => {
    const resolver = makeStubResolver(
      () =>
        ({
          ok: false,
          error: { kind: "fetch_failed", message: "network unreachable" },
        }) as ResolverResult,
    );

    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _skipRefreshLoop: true,
      _peerResolver: resolver,
      peerSource: { type: "registry", url: "https://example.org/peers.json" },
      peers: undefined,
    });

    const { kernel } = makeStubKernel((t) => completedResult(t, "ok"));
    await aug.transport!.register(kernel, "link");

    const listTool = aug.tools!.find((t) => t.name === "link_list")!;
    const result = await asStringTool(listTool).execute(
      {},
      {
        turnId: "t",
        peer: null,
        threadId: "th",
      },
    );
    const parsed = JSON.parse(result);
    expect(parsed.peers).toEqual([]);

    // Context block is empty (no peers)
    const blocks = await aug.context!(makeTurnState());
    expect(blocks).toEqual([]);

    await aug.onShutdown!();
  });
});
