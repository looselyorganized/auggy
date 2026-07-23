import { describe, expect, it } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HandlerContext as LinkHandlerContext,
  Part as LinkPart,
  PeerSendError,
} from "@auggy/link";

import { defineAgent } from "@/agent";
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
import { createMockModel } from "../../fixtures/mock-model";

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
      description: "Auggy link test agent",
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
  it("returns an augment with transport, context, and tools", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    expect(aug.name).toBe("link");
    expect(aug.transport).toBeDefined();
    expect(aug.transport?.ready).toBeDefined();
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

  it("rejects readiness before registration and is idempotent after registration", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    await expect(aug.transport!.ready!()).rejects.toThrow("before registration");
    const kernel: TransportKernel = {
      handleInbound: async (trigger) => completedResult(trigger, "ok"),
      onOutbound: () => {},
      getAgentCard: () => ({}) as AgentCard,
      getAugmentRoutes: () => [],
      getAugments: () => [],
    };
    await aug.transport!.register(kernel, "link");
    await aug.transport!.ready!();
    await aug.transport!.ready!();
    await aug.onShutdown!();
  });

  it("admin info surfaces preview trust posture", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    const info = await aug.adminInfo?.();
    const serialized = JSON.stringify(info);
    expect(serialized).toContain("Status");
    expect(serialized).toContain("preview");
    expect(serialized).toContain("configured peers are admitted as agent trust");
    expect(serialized).toContain("signed and capped by the authenticated forwarding peer");
    expect(serialized).toContain("creator, agent");
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
    expect(captured?.threadId).toMatch(/^link-[A-Za-z0-9_-]{32}$/);
    expect(captured?.peer?.id).toMatch(/^link-unprovenanced-/);
    expect(captured?.peer?.trustLevel).toBe("public");
    expect(captured?.peer?.publicSubstate).toBe("anonymous");
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
  it("downgrades an unprovenanced agent participant to public anonymous", async () => {
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
    expect(peer?.trustLevel).toBe("public");
    expect(peer?.publicSubstate).toBe("anonymous");
    expect(peer?.kind).toBe("agent");
    await augment.onShutdown!();
  });

  it("normalizes an unprovenanced public participant to public anonymous", async () => {
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
    expect(peer?.publicSubstate).toBe("anonymous");
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
    const calls: Array<{
      to: string;
      parts: readonly LinkPart[];
      idempotencyKey?: string;
    }> = [];
    const fakePeerClient = {
      send: async (args: { to: string; parts: readonly LinkPart[]; idempotencyKey?: string }) => {
        calls.push({
          to: args.to,
          parts: args.parts,
          idempotencyKey: args.idempotencyKey,
        });
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
    expect(calls[0]?.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
    expect(calls[0]?.parts[0]?.text).toBe("hello");
    expect(calls[0]?.parts[0]?.metadata?.auggy_link_origin_v1).toBeDefined();
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

  it("defaults public and missing-context callers to a no-side-effect denial", async () => {
    let sends = 0;
    const fakePeerClient = {
      send: async () => {
        sends++;
        throw new Error("must not execute");
      },
    };
    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    expect(aug.constraints?.perTrustLevel?.public?.neverExpose).toEqual(["link_send", "link_list"]);
    const sendTool = aug.tools!.find((tool) => tool.name === "link_send")!;
    const publicContext: ToolExecuteContext = {
      turnId: "public-turn",
      threadId: "public-thread",
      peer: {
        id: "visitor-1",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      },
    };

    expect(
      JSON.parse(
        await asStringTool(sendTool).execute({ to: "researcher", text: "hello" }, publicContext),
      ),
    ).toMatchObject({ ok: false, error: "link_authorization_denied" });
    expect(
      JSON.parse(await asStringTool(sendTool).execute({ to: "researcher", text: "hello" })),
    ).toMatchObject({ ok: false, error: "link_authorization_denied" });
    expect(sends).toBe(0);
  });

  it("turn loop denies a fabricated public link_send before the client runs", async () => {
    let sends = 0;
    const fakePeerClient = {
      send: async () => {
        sends++;
        throw new Error("must not execute");
      },
    };
    const augment = await link({
      ...makeOpts(),
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    const model = createMockModel();
    model.pushResponse({
      content: "",
      finishReason: "tool_use",
      toolCalls: [{ name: "link_send", arguments: { to: "researcher", text: "delegate" } }],
    });
    model.pushResponse({ content: "denied", finishReason: "end_turn" });
    const agent = defineAgent(
      { name: "link-security-test", model: "mock", augments: [augment] },
      model,
    );
    await agent.start();
    try {
      const peer: PeerIdentity = {
        id: "visitor",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "test",
      };
      const result = await agent.inject({
        type: "message",
        turnId: "public-link-turn",
        threadId: `public-link-thread-${crypto.randomUUID()}`,
        timestamp: Date.now(),
        source: "test",
        peer,
        payload: {
          parts: [{ kind: "text", text: "delegate" }],
          sourceAugment: "test",
          peer,
          timestamp: Date.now(),
        },
      });
      expect(result.toolCalls).toHaveLength(0);
      expect(result.trace.capabilityChecks).toContainEqual({
        tool: "link_send",
        result: "denied",
      });
      expect(sends).toBe(0);
    } finally {
      await agent.stop();
    }
  });

  it("preserves authenticated public origin without upgrading downstream authority", async () => {
    const captured: Array<{
      parts: readonly LinkPart[];
      idempotencyKey?: string;
    }> = [];
    const fakePeerClient = {
      send: async (args: { parts: readonly LinkPart[]; idempotencyKey?: string }) => {
        captured.push({ parts: args.parts, idempotencyKey: args.idempotencyKey });
        return {
          ok: true as const,
          value: {
            outcome: {
              message_id: "reply",
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: "ok" }],
            },
            idempotencyKey: args.idempotencyKey!,
          },
        };
      },
    };
    const sender = await link({
      ...makeOpts(),
      outbound: {
        allowedTrustLevels: ["creator", "agent", "public"],
        publicDelegationPeers: {
          researcher: {
            url: "https://researcher.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    const sendTool = sender.tools!.find((tool) => tool.name === "link_send")!;
    await asStringTool(sendTool).execute(
      { to: "researcher", text: "delegated request" },
      {
        turnId: "public-turn",
        threadId: "public-thread",
        peer: {
          id: "vis_original",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "recognized",
          sourceAugment: "web",
        },
      },
    );
    expect(captured).toHaveLength(1);

    const receiverOpts = makeOpts();
    const { augment: receiver, dispatch } = await _createLinkForTesting({
      ...receiverOpts,
      agentCard: {
        ...receiverOpts.agentCard,
        id: PEER_PARTICIPANT_ID,
      },
      peers: {
        sender: {
          url: "https://sender.example.org",
          bearer: "receiver-outbound",
          participantId: SELF_PARTICIPANT_ID,
          inboundBearer: "outbound-secret",
          inboundBearerId: "sender-inbound-key",
        },
      },
    });
    const { kernel, triggers } = makeStubKernel((trigger) => completedResult(trigger, "received"));
    await receiver.transport!.register(kernel, "link");
    const outcome = await dispatch({
      from: {
        id: SELF_PARTICIPANT_ID,
        locator: "https://sender.example.org",
        type: "agent",
        trust: "agent",
      },
      parts: [...captured[0]!.parts],
      idempotency_key: captured[0]!.idempotencyKey,
      request_id: "request-1",
      received_at: new Date().toISOString(),
    });

    expect(outcome.kind).toBe("message");
    expect(triggers).toHaveLength(1);
    expect(triggers[0]?.peer).toMatchObject({
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "link",
      delegatedOrigin: {
        subject: "vis_original",
        sourceAugment: "web",
        viaPeerId: SELF_PARTICIPANT_ID,
        hopCount: 1,
      },
    });
    expect(triggers[0]?.peer?.id).toMatch(/^link-origin-/);
    expect(triggers[0]?.threadId).toMatch(/^link-[A-Za-z0-9_-]{32}$/);
    await receiver.onShutdown!();
  });

  it("rejects content, audience, idempotency, and signature tampering before dispatch", async () => {
    const captured: {
      parts?: readonly LinkPart[];
      idempotencyKey?: string;
    } = {};
    const fakePeerClient = {
      send: async (args: { parts: readonly LinkPart[]; idempotencyKey?: string }) => {
        captured.parts = args.parts;
        captured.idempotencyKey = args.idempotencyKey;
        return {
          ok: true as const,
          value: {
            outcome: {
              message_id: "reply",
              role: "agent" as const,
              parts: [{ kind: "text" as const, text: "ok" }],
            },
            idempotencyKey: args.idempotencyKey!,
          },
        };
      },
    };
    const sender = await link({
      ...makeOpts(),
      outbound: {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {
          researcher: {
            url: "https://researcher.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
      _skipServer: true,
      _peerClient: fakePeerClient as unknown as import("@auggy/link").PeerClient,
    });
    await asStringTool(sender.tools!.find((tool) => tool.name === "link_send")!).execute(
      { to: "researcher", text: "signed text" },
      {
        turnId: "public-turn",
        threadId: "public-thread",
        peer: {
          id: "visitor",
          kind: "human",
          trustLevel: "public",
          publicSubstate: "anonymous",
          sourceAugment: "web",
        },
      },
    );

    const receiverOpts = makeOpts();
    const { augment: receiver, dispatch } = await _createLinkForTesting({
      ...receiverOpts,
      agentCard: { ...receiverOpts.agentCard, id: PEER_PARTICIPANT_ID },
      peers: {
        sender: {
          url: "https://sender.example.org",
          bearer: "unused",
          participantId: SELF_PARTICIPANT_ID,
          inboundBearer: "outbound-secret",
          inboundBearerId: "sender-key",
        },
      },
    });
    const { kernel, triggers } = makeStubKernel((trigger) =>
      completedResult(trigger, "unexpected"),
    );
    await receiver.transport!.register(kernel, "link");

    const baseContext = {
      from: {
        id: SELF_PARTICIPANT_ID,
        locator: "https://sender.example.org",
        type: "agent" as const,
        trust: "agent" as const,
      },
      idempotency_key: captured.idempotencyKey,
      request_id: "request-tamper",
      received_at: new Date().toISOString(),
    };
    const variants: LinkPart[][] = [];
    const changedText = structuredClone(captured.parts!) as LinkPart[];
    changedText[0]!.text = "changed";
    variants.push(changedText);
    for (const field of ["audience", "signature"] as const) {
      const changed = structuredClone(captured.parts!) as LinkPart[];
      const envelope = changed[0]!.metadata!.auggy_link_origin_v1 as Record<string, unknown>;
      envelope[field] = field === "audience" ? SELF_PARTICIPANT_ID : "A".repeat(43);
      variants.push(changed);
    }
    const changedIssuer = structuredClone(captured.parts!) as LinkPart[];
    (changedIssuer[0]!.metadata!.auggy_link_origin_v1 as Record<string, unknown>).issuer =
      PEER_PARTICIPANT_ID;
    variants.push(changedIssuer);
    const changedOrigin = structuredClone(captured.parts!) as LinkPart[];
    const originEnvelope = changedOrigin[0]!.metadata!.auggy_link_origin_v1 as Record<
      string,
      unknown
    >;
    (originEnvelope.origin as Record<string, unknown>).subject = "different-visitor";
    variants.push(changedOrigin);
    const expired = structuredClone(captured.parts!) as LinkPart[];
    (expired[0]!.metadata!.auggy_link_origin_v1 as Record<string, unknown>).expiresAt = 0;
    variants.push(expired);
    const duplicated = structuredClone(captured.parts!) as LinkPart[];
    duplicated.push(structuredClone(duplicated[0]!));
    variants.push(duplicated);

    for (const parts of variants) {
      const outcome = await dispatch({ ...baseContext, parts });
      expect(outcome).toMatchObject({
        kind: "error",
        message: "link augment: delegated origin verification failed",
      });
    }
    const idempotencyOutcome = await dispatch({
      ...baseContext,
      parts: [...captured.parts!],
      idempotency_key: "different-key",
    });
    expect(idempotencyOutcome.kind).toBe("error");
    expect(triggers).toHaveLength(0);
    await receiver.onShutdown!();
  });

  it("denies public delegation to a receiver without an operator provenance attestation", async () => {
    let sends = 0;
    const sender = await link({
      ...makeOpts(),
      outbound: {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {
          "upgraded-peer": {
            url: "https://upgraded.example.org",
            participantId: "00000000-0000-4000-8000-00000000dddd",
          },
        },
      },
      _skipServer: true,
      _peerClient: {
        send: async () => {
          sends++;
          throw new Error("must not send");
        },
      } as unknown as import("@auggy/link").PeerClient,
    });
    const publicContext = {
      turnId: "public-turn",
      threadId: "public-thread",
      peer: {
        id: "visitor",
        kind: "human" as const,
        trustLevel: "public" as const,
        publicSubstate: "anonymous" as const,
        sourceAugment: "web",
      },
    };
    const result = JSON.parse(
      await asStringTool(sender.tools!.find((tool) => tool.name === "link_send")!).execute(
        { to: "researcher", text: "must remain local" },
        publicContext,
      ),
    );
    const list = JSON.parse(
      await asStringTool(sender.tools!.find((tool) => tool.name === "link_list")!).execute(
        {},
        publicContext,
      ),
    );
    const context = await sender.context!({
      ...publicContext,
      tools: [],
      history: [],
      contextBlocks: [],
      trigger: {
        type: "message",
        turnId: "public-turn",
        payload: { parts: [] },
      },
    } as unknown as TurnState);

    expect(result).toMatchObject({
      ok: false,
      error: "link_authorization_denied",
    });
    expect(list).toEqual({ peers: [] });
    expect(context).toEqual([]);
    expect(sends).toBe(0);
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

  it("denies public and missing-context roster discovery by default", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    const listTool = aug.tools!.find((tool) => tool.name === "link_list")!;
    const publicResult = JSON.parse(
      await asStringTool(listTool).execute(
        {},
        {
          turnId: "public-turn",
          threadId: "public-thread",
          peer: {
            id: "visitor",
            kind: "human",
            trustLevel: "public",
            publicSubstate: "anonymous",
            sourceAugment: "web",
          },
        },
      ),
    );
    const missingContextResult = JSON.parse(await asStringTool(listTool).execute({}));
    expect(publicResult).toMatchObject({
      ok: false,
      error: "link_authorization_denied",
    });
    expect(missingContextResult).toMatchObject({
      ok: false,
      error: "link_authorization_denied",
    });
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

  it("does not advertise the peer roster to public turns by default", async () => {
    const aug = await link({ ...makeOpts(), _skipServer: true });
    const turn = makeTurnState();
    turn.peer = {
      id: "visitor",
      kind: "human",
      trustLevel: "public",
      publicSubstate: "recognized",
      sourceAugment: "web",
    };
    expect(await aug.context!(turn)).toEqual([]);
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
    const resolver = makeStubResolver(
      () =>
        ({
          ok: true,
          resolved: { peers: resolvedPeers, skipped: [] },
        }) as ResolverResult,
    );

    const aug = await link({
      ...makeOpts(),
      _skipServer: true,
      _skipRefreshLoop: true,
      _peerResolver: resolver,
      peerSource: {
        type: "registry",
        url: "https://example.org/peers.json",
        pins: {
          frontier: {
            url: "https://frontier.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
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
      peerSource: {
        type: "registry",
        url: "https://example.org/peers.json",
        pins: {
          backup: {
            url: "https://backup.example.org",
            participantId: "00000000-0000-4000-8000-00000000eeee",
          },
        },
      },
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
      peerSource: {
        type: "registry",
        url: "https://example.org/peers.json",
        pins: {
          frontier: {
            url: "https://frontier.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
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

  it("fails closed when a registry redirects an attested alias without changing its id", async () => {
    let sends = 0;
    const resolver = makeStubResolver(
      () =>
        ({
          ok: true,
          resolved: {
            peers: {
              frontier: {
                url: "https://replacement.example.org",
                bearer: "replacement-outbound",
                participantId: PEER_PARTICIPANT_ID,
                inboundBearer: "replacement-inbound",
                inboundBearerId: "replacement-key",
              },
            },
            skipped: [],
          },
        }) as ResolverResult,
    );
    const aug = await link({
      ...makeOpts(),
      outbound: {
        allowedTrustLevels: ["public"],
        publicDelegationPeers: {
          frontier: {
            url: "https://frontier.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
      _skipServer: true,
      _skipRefreshLoop: true,
      _peerResolver: resolver,
      _peerClient: {
        send: async () => {
          sends++;
          throw new Error("must not send");
        },
      } as unknown as import("@auggy/link").PeerClient,
      peerSource: {
        type: "registry",
        url: "https://example.org/peers.json",
        pins: {
          frontier: {
            url: "https://frontier.example.org",
            participantId: PEER_PARTICIPANT_ID,
          },
        },
      },
      peers: undefined,
    });
    const { kernel } = makeStubKernel((turn) => completedResult(turn, "unexpected"));
    await aug.transport!.register(kernel, "link");
    const publicContext: ToolExecuteContext = {
      turnId: "public-turn",
      threadId: "public-thread",
      peer: {
        id: "visitor",
        kind: "human",
        trustLevel: "public",
        publicSubstate: "recognized",
        sourceAugment: "web",
      },
    };

    const list = JSON.parse(
      await asStringTool(aug.tools!.find((tool) => tool.name === "link_list")!).execute(
        {},
        publicContext,
      ),
    );
    const send = JSON.parse(
      await asStringTool(aug.tools!.find((tool) => tool.name === "link_send")!).execute(
        { to: "frontier", text: "must remain local" },
        publicContext,
      ),
    );
    const context = await aug.context!({
      ...makeTurnState(),
      peer: publicContext.peer,
    });

    expect(list).toEqual({ peers: [] });
    expect(send).toMatchObject({ ok: false, error: "link_authorization_denied" });
    expect(context).toEqual([]);
    expect(sends).toBe(0);
    await aug.onShutdown!();
  });
});
