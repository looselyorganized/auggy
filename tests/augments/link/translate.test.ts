import { describe, expect, it } from "bun:test";
import type {
  HandlerContext as LinkHandlerContext,
  Participant as LinkParticipant,
} from "@auggy/link";

import type { OutboundMessage, TurnResult } from "@/types";
import {
  augment1PartToLinkPart,
  handlerContextToTrigger,
  linkPartToAugment1Part,
  participantToPeerIdentity,
  turnResultToHandlerOutcome,
} from "@/augments/link/translate";

const PEER_ID = "00000000-0000-4000-8000-000000000001";

function makeParticipant(overrides: Partial<LinkParticipant> = {}): LinkParticipant {
  return {
    id: PEER_ID,
    locator: "https://peer.example.org",
    type: "agent",
    trust: "agent",
    ...overrides,
  };
}

function makeHandlerContext(overrides: Partial<LinkHandlerContext> = {}): LinkHandlerContext {
  return {
    from: makeParticipant(),
    parts: [{ kind: "text", text: "hello" }],
    request_id: 1,
    received_at: "2026-04-27T12:00:00.000Z",
    ...overrides,
  };
}

function makeTurnResult(overrides: Partial<TurnResult> = {}): TurnResult {
  const base: TurnResult = {
    turnId: "turn-x",
    success: true,
    status: "completed",
    toolCalls: [],
    trace: {
      turnId: "turn-x",
      threadId: "thread-x",
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
  return { ...base, ...overrides };
}

// ---------------------------------------------------------------------------
// participantToPeerIdentity
// ---------------------------------------------------------------------------

describe("participantToPeerIdentity", () => {
  it("maps an agent participant with trust=agent", () => {
    const p = makeParticipant({ type: "agent", trust: "agent" });
    const identity = participantToPeerIdentity(p, "link");
    expect(identity).toEqual({
      id: PEER_ID,
      kind: "agent",
      trustLevel: "agent",
      sourceAugment: "link",
    });
  });

  it("maps a human participant with trust=creator (link's wire shape; rare at v0.1)", () => {
    const p = makeParticipant({ type: "human", trust: "creator" });
    const identity = participantToPeerIdentity(p, "link");
    expect(identity.kind).toBe("human");
    expect(identity.trustLevel).toBe("creator");
  });

  it("maps trust=public verbatim", () => {
    const p = makeParticipant({ trust: "public" });
    const identity = participantToPeerIdentity(p, "link");
    expect(identity.trustLevel).toBe("public");
    // publicSubstate is not synthesized for link peers — public-trust over
    // link means the BearerAuthProvider admitted them, not anonymous web
    // visitors.
    expect(identity.publicSubstate).toBeUndefined();
  });

  it("carries orgId when present", () => {
    const p = makeParticipant({ org_id: "org-42" });
    const identity = participantToPeerIdentity(p, "link");
    expect(identity.orgId).toBe("org-42");
  });

  it("omits orgId when participant has no org_id", () => {
    const p = makeParticipant();
    const identity = participantToPeerIdentity(p, "link");
    expect(identity.orgId).toBeUndefined();
  });

  it("uses the configured sourceAugment string verbatim", () => {
    const p = makeParticipant();
    const identity = participantToPeerIdentity(p, "link-mesh");
    expect(identity.sourceAugment).toBe("link-mesh");
  });
});

// ---------------------------------------------------------------------------
// linkPartToAugment1Part / augment1PartToLinkPart
// ---------------------------------------------------------------------------

describe("part translation", () => {
  it("round-trips text parts", () => {
    const linkPart = { kind: "text" as const, text: "hi" };
    const augPart = linkPartToAugment1Part(linkPart);
    expect(augPart).toEqual({ kind: "text", text: "hi" });
    const back = augment1PartToLinkPart(augPart);
    expect(back).toEqual({ kind: "text", text: "hi" });
  });

  it("drops link metadata on inbound (augment-1 text Part has no metadata)", () => {
    // metadata is part of link's wire shape but augment-1 doesn't carry it.
    const linkPart = {
      kind: "text" as const,
      text: "hi",
      metadata: { request_id: "abc" },
    };
    const augPart = linkPartToAugment1Part(linkPart);
    expect(augPart).toEqual({ kind: "text", text: "hi" });
  });

  it("returns null for outbound file parts (link is text-only at v0.1)", () => {
    const filePart = { kind: "file" as const, uri: "https://example.org/a.png" };
    expect(augment1PartToLinkPart(filePart)).toBeNull();
  });

  it("returns null for outbound data parts", () => {
    const dataPart = { kind: "data" as const, data: { foo: "bar" } };
    expect(augment1PartToLinkPart(dataPart)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// handlerContextToTrigger
// ---------------------------------------------------------------------------

describe("handlerContextToTrigger", () => {
  it("builds a message TurnTrigger with peer + payload + threadId", () => {
    const ctx = makeHandlerContext();
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    expect(trigger.type).toBe("message");
    expect(trigger.threadId).toBe("thread-1");
    expect(trigger.source).toBe("link");
    expect(trigger.peer?.id).toBe(PEER_ID);
    expect(trigger.peer?.trustLevel).toBe("agent");
    expect(trigger.turnId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    const inbound = trigger.payload as { parts: Array<{ kind: string; text: string }> };
    expect(inbound.parts).toEqual([{ kind: "text", text: "hello" }]);
  });

  it("parses received_at to epoch ms", () => {
    const ctx = makeHandlerContext({ received_at: "2026-04-27T12:00:00.000Z" });
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    const expected = Date.parse("2026-04-27T12:00:00.000Z");
    expect(trigger.timestamp).toBe(expected);
    const inbound = trigger.payload as { timestamp: number };
    expect(inbound.timestamp).toBe(expected);
  });

  it("falls back to Date.now() when received_at is unparseable", () => {
    const before = Date.now();
    const ctx = makeHandlerContext({ received_at: "not-a-date" });
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    const after = Date.now();
    expect(trigger.timestamp).toBeGreaterThanOrEqual(before);
    expect(trigger.timestamp).toBeLessThanOrEqual(after);
  });

  it("threads taskId from ctx to trigger and InboundMessage", () => {
    const taskId = "00000000-0000-4000-8000-000000000099";
    const ctx = makeHandlerContext({ task_id: taskId });
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    expect(trigger.taskId).toBe(taskId);
    const inbound = trigger.payload as { taskId?: string };
    expect(inbound.taskId).toBe(taskId);
  });

  it("packs idempotency_key, request_id, parent_task_id into metadata", () => {
    const ctx = makeHandlerContext({
      idempotency_key: "idem-abc",
      request_id: "req-1",
      parent_task_id: "00000000-0000-4000-8000-000000000077",
    });
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    const inbound = trigger.payload as { metadata?: Record<string, unknown> };
    expect(inbound.metadata?.idempotency_key).toBe("idem-abc");
    expect(inbound.metadata?.request_id).toBe("req-1");
    expect(inbound.metadata?.parent_task_id).toBe("00000000-0000-4000-8000-000000000077");
  });

  it("metadata always includes request_id even when idempotency_key is absent", () => {
    const ctx = makeHandlerContext({ request_id: 42 });
    const trigger = handlerContextToTrigger(ctx, "link", "thread-1");
    const inbound = trigger.payload as { metadata?: Record<string, unknown> };
    expect(inbound.metadata?.request_id).toBe(42);
    expect(inbound.metadata?.idempotency_key).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// turnResultToHandlerOutcome
// ---------------------------------------------------------------------------

describe("turnResultToHandlerOutcome", () => {
  it("translates completed turn with text response → MessageOutcome", () => {
    const response: OutboundMessage = {
      parts: [{ kind: "text", text: "hi back" }],
    };
    const result = makeTurnResult({ response });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.parts).toEqual([{ kind: "text", text: "hi back" }]);
    }
  });

  it("rejected turn → ErrorOutcome with INTERNAL_ERROR + errorResponse", () => {
    const result = makeTurnResult({
      success: false,
      status: "rejected",
      errorClass: "cap-denied",
      errorResponse: "over budget",
    });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.code).toBe(-32603);
      expect(outcome.message).toBe("over budget");
    }
  });

  it("failed turn with no errorResponse → ErrorOutcome with fallback message", () => {
    const result = makeTurnResult({ success: false, status: "failed" });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toBe("turn failed");
    }
  });

  it("completed turn with no response → ErrorOutcome (defensive)", () => {
    const result = makeTurnResult({ response: undefined });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toBe("turn completed without a response");
    }
  });

  it("completed turn with empty parts → ErrorOutcome (defensive)", () => {
    const result = makeTurnResult({ response: { parts: [] } });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
  });

  it("drops file/data response parts and surfaces text only", () => {
    const response: OutboundMessage = {
      parts: [
        { kind: "text", text: "answer" },
        { kind: "file", uri: "https://example.org/a.png" },
        { kind: "data", data: { stuff: 1 } },
      ],
    };
    const result = makeTurnResult({ response });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("message");
    if (outcome.kind === "message") {
      expect(outcome.parts).toEqual([{ kind: "text", text: "answer" }]);
    }
  });

  it("completed turn with only file parts → ErrorOutcome (link is text-only at v0.1)", () => {
    const response: OutboundMessage = {
      parts: [{ kind: "file", uri: "https://example.org/a.png" }],
    };
    const result = makeTurnResult({ response });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("text-only");
    }
  });

  it("unexpected non-terminal status (working) → ErrorOutcome", () => {
    const result = makeTurnResult({ status: "working" });
    const outcome = turnResultToHandlerOutcome(result);
    expect(outcome.kind).toBe("error");
    if (outcome.kind === "error") {
      expect(outcome.message).toContain("working");
    }
  });
});
