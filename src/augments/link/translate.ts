/**
 * Translation layer between @auggy/link's wire types and augment-1's runtime
 * types. Kept here (separate from index.ts) so the field mapping is exercised
 * in isolation by the unit tests.
 *
 * Field map summary (audit reference):
 *
 *   link.Participant.type  ("agent" | "human")        → PeerIdentity.kind
 *   link.Participant.trust ("creator"|"agent"|"public") → PeerIdentity.trustLevel
 *     (identical alphabet — string passes through)
 *   link.Participant.id    (UUID)                      → PeerIdentity.id
 *   link.Participant.org_id (optional)                 → PeerIdentity.orgId
 *
 *   link.HandlerContext.parts             → InboundMessage.parts (text-only at v0.1;
 *                                            link's metadata is dropped because
 *                                            augment-1's Part is bare)
 *   link.HandlerContext.task_id           → TurnTrigger.taskId / InboundMessage.taskId
 *   link.HandlerContext.idempotency_key   → InboundMessage.metadata.idempotency_key
 *   link.HandlerContext.request_id        → InboundMessage.metadata.request_id
 *   link.HandlerContext.parent_task_id    → InboundMessage.metadata.parent_task_id
 *   link.HandlerContext.received_at (ISO)  → InboundMessage.timestamp (epoch ms)
 *
 * v0.1 augment intentionally returns ONLY MessageOutcome (sync answer) or
 * ErrorOutcome. TaskCreateOutcome / TaskContinueOutcome are deferred until
 * augment-1's turn loop grows long-running task semantics — see ADR-022
 * sequencing.
 */

import type {
  HandlerContext as LinkHandlerContext,
  HandlerOutcome as LinkHandlerOutcome,
  Part as LinkPart,
  Participant as LinkParticipant,
} from "@auggy/link";

import type {
  InboundMessage,
  Part as Augment1Part,
  PeerIdentity,
  TurnResult,
  TurnTrigger,
} from "../../types";

// ---------------------------------------------------------------------------
// Participant ↔ PeerIdentity
// ---------------------------------------------------------------------------

/**
 * Translate a verified link Participant (returned by BearerAuthProvider) to an
 * augment-1 PeerIdentity. The trust alphabet is shared, so `trust` passes
 * through unchanged.
 *
 * `sourceAugment` is the augment-1 runtime name of the link augment instance
 * (defaults to "link", but operators can rename it in agent.yaml; the caller
 * passes the configured value).
 */
export function participantToPeerIdentity(p: LinkParticipant, sourceAugment: string): PeerIdentity {
  // Participant.type is "agent" | "human"; augment-1's PeerKind admits the
  // same two values plus "system"|"anonymous" (not produced by link).
  const kind: PeerIdentity["kind"] = p.type;

  // Participant.trust ∈ {creator, agent, public}; PeerIdentity.trustLevel ∈
  // the same set. Identity passes through.
  const identity: PeerIdentity = {
    id: p.id,
    kind,
    trustLevel: p.trust,
    sourceAugment,
  };
  if (p.org_id !== undefined) {
    identity.orgId = p.org_id;
  }
  return identity;
}

// ---------------------------------------------------------------------------
// Part ↔ Part (text-only at v0.1)
// ---------------------------------------------------------------------------

/**
 * Convert an inbound link Part to an augment-1 Part. v0.1 is text-only on
 * both sides; link's optional `metadata` is dropped because augment-1's
 * text Part doesn't carry metadata.
 *
 * The narrow union on link's side (`Part = TextPart` at v0.1) guarantees
 * the discriminator check below is exhaustive today; adding non-text parts
 * to link in v0.2 will flag this function as a TS coverage gap.
 */
export function linkPartToAugment1Part(p: LinkPart): Augment1Part {
  if (p.kind === "text") {
    return { kind: "text", text: p.text };
  }
  // Unreachable at v0.1 (link's Part union is text-only). Throw rather than
  // silently coerce — the runtime should surface schema drift loudly.
  throw new Error(
    `link: unsupported inbound Part kind "${(p as { kind: string }).kind}" — v0.1 augment is text-only`,
  );
}

/**
 * Convert an outbound augment-1 Part to a link Part. v0.1 is text-only;
 * file/data parts are silently dropped (caller filters before calling).
 * Returns `null` for non-text parts so the caller can prune them.
 */
export function augment1PartToLinkPart(p: Augment1Part): LinkPart | null {
  if (p.kind === "text") {
    return { kind: "text", text: p.text };
  }
  // file/data: dropped at v0.1.
  return null;
}

// ---------------------------------------------------------------------------
// HandlerContext → TurnTrigger
// ---------------------------------------------------------------------------

/**
 * Build the metadata object for InboundMessage from the link HandlerContext.
 * Only includes keys that are actually present so downstream consumers can
 * distinguish "absent" from "empty".
 */
function buildInboundMetadata(ctx: LinkHandlerContext): Record<string, unknown> {
  const md: Record<string, unknown> = { request_id: ctx.request_id };
  if (ctx.idempotency_key !== undefined) {
    md.idempotency_key = ctx.idempotency_key;
  }
  if (ctx.parent_task_id !== undefined) {
    md.parent_task_id = ctx.parent_task_id;
  }
  return md;
}

/**
 * Parse the ISO-8601 `received_at` to epoch ms. Falls back to `Date.now()`
 * when the timestamp is unparseable (defense-in-depth — link's schema
 * enforces ISO-8601 at the wire, but a corrupted store could produce
 * NaN).
 */
function parseReceivedAtMs(receivedAt: string): number {
  const ms = Date.parse(receivedAt);
  return Number.isFinite(ms) ? ms : Date.now();
}

/**
 * Build an augment-1 TurnTrigger from a verified link HandlerContext.
 *
 * Two pieces of state come from the augment (not the wire):
 *   - sourceAugment: the configured instance name in agent.yaml (e.g. "link"
 *     or "link-mesh"). Used as both `peer.sourceAugment` and `trigger.source`.
 *   - threadId: derived by the caller. For initial sends, the link augment
 *     uses `link-<participantId>` so a given peer's traffic threads stably
 *     across requests. For task resumptions, the caller passes the existing
 *     threadId so history doesn't fragment.
 *
 * `turnId` is freshly minted on every call; augment-1's kernel owns turn
 * ids, not link's request id.
 */
export function handlerContextToTrigger(
  ctx: LinkHandlerContext,
  sourceAugment: string,
  threadId: string,
): TurnTrigger {
  const peer = participantToPeerIdentity(ctx.from, sourceAugment);
  const parts = ctx.parts.map(linkPartToAugment1Part);
  const timestamp = parseReceivedAtMs(ctx.received_at);
  const inbound: InboundMessage = {
    parts,
    sourceAugment,
    peer,
    timestamp,
    metadata: buildInboundMetadata(ctx),
  };
  if (ctx.task_id !== undefined) {
    inbound.taskId = ctx.task_id;
  }
  const trigger: TurnTrigger = {
    type: "message",
    turnId: crypto.randomUUID(),
    threadId,
    timestamp,
    source: sourceAugment,
    peer,
    payload: inbound,
  };
  if (ctx.task_id !== undefined) {
    trigger.taskId = ctx.task_id;
  }
  return trigger;
}

// ---------------------------------------------------------------------------
// TurnResult → HandlerOutcome
// ---------------------------------------------------------------------------

/**
 * JSON-RPC INTERNAL_ERROR code per @auggy/link's `INTERNAL_ERROR` constant
 * (mirrored here to avoid a runtime import the test harness has to mock).
 * link's protocol/errors module surfaces this same value.
 */
const INTERNAL_ERROR_CODE = -32603;

/**
 * Translate an augment-1 TurnResult to a link HandlerOutcome.
 *
 * v0.1 augment policy:
 *   - On rejected/failed → ErrorOutcome with INTERNAL_ERROR. `errorResponse`
 *     becomes the message; falls back to `turn <status>` when empty.
 *   - On completed with response → MessageOutcome with the text parts
 *     (file/data parts dropped because link is text-only at v0.1).
 *   - Defensive: completed-without-response should not happen for a turn
 *     that admitted via this transport, but if it does, surface as
 *     ErrorOutcome rather than silently emitting an empty message
 *     (an empty `parts: []` would fail link's MessageOutcome validation).
 */
export function turnResultToHandlerOutcome(result: TurnResult): LinkHandlerOutcome {
  if (result.status === "rejected" || result.status === "failed") {
    return {
      kind: "error",
      code: INTERNAL_ERROR_CODE,
      message: result.errorResponse ?? `turn ${result.status}`,
    };
  }

  // Other non-"completed" states (canceled, input-required, auth-required,
  // working) shouldn't appear as a sync TurnResult from the kernel, but if
  // they do, treat them as errors so callers don't silently miss them.
  if (result.status !== "completed") {
    return {
      kind: "error",
      code: INTERNAL_ERROR_CODE,
      message: `unexpected turn status "${result.status}" for link sync flow`,
    };
  }

  const response = result.response;
  if (!response || response.parts.length === 0) {
    return {
      kind: "error",
      code: INTERNAL_ERROR_CODE,
      message: "turn completed without a response",
    };
  }

  const linkParts: LinkPart[] = [];
  for (const part of response.parts) {
    const translated = augment1PartToLinkPart(part);
    if (translated) linkParts.push(translated);
  }
  if (linkParts.length === 0) {
    return {
      kind: "error",
      code: INTERNAL_ERROR_CODE,
      message: "turn response had no text parts (link is text-only at v0.1)",
    };
  }

  return {
    kind: "message",
    parts: linkParts,
  };
}
