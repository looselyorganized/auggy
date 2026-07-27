import { createHash } from "node:crypto";
import type {
  DistributedCoordinationResultConfig,
  DistributedCoordinationTurnStateConfig,
  OutboundMessage,
  Part,
  PeerIdentity,
  ThreadHistorySnapshot,
  TurnResult,
} from "../types";
import { parseThreadHistoryMessages } from "../kernel/history-manager";
import { emptyTrace } from "../kernel/trace-emitter";
import type { DistributedPeerBindingV1, DistributedReplayResult } from "./types";

const MAX_REPLAY_MESSAGES = 32;
const MAX_DATA_DEPTH = 16;
const MAX_DATA_NODES = 2_000;

function digest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("non-finite value");
    return JSON.stringify(value);
  }
  if (typeof value === "string") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value !== "object") throw new Error("unsupported canonical value");
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .filter((key) => record[key] !== undefined)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonical(record[key])}`)
    .join(",")}}`;
}

export function createDistributedPeerBinding(peer: PeerIdentity | null): DistributedPeerBindingV1 {
  if (peer === null) {
    const projection = canonical({ version: 1, internal: true });
    return {
      version: 1,
      bindingHash: digest(`auggy-peer-binding-v1\0${projection}`),
      peerIdHash: null,
      promotionScopeHash: digest(`auggy-peer-promotion-v1\0${projection}`),
      trustLevel: "creator",
    };
  }
  const promotionScope = {
    version: 1,
    kind: peer.kind,
    sourceAugment: peer.sourceAugment,
    orgId: peer.orgId ?? null,
    delegatedOrigin: peer.delegatedOrigin ?? null,
  };
  const peerIdHash = digest(`auggy-peer-id-v1\0${peer.id}`);
  const projection = {
    ...promotionScope,
    peerIdHash,
    trustLevel: peer.trustLevel,
    publicSubstate: peer.publicSubstate ?? null,
  };
  return {
    version: 1,
    bindingHash: digest(`auggy-peer-binding-v1\0${canonical(projection)}`),
    peerIdHash,
    promotionScopeHash: digest(`auggy-peer-promotion-v1\0${canonical(promotionScope)}`),
    trustLevel: peer.trustLevel,
    ...(peer.publicSubstate ? { publicSubstate: peer.publicSubstate } : {}),
    ...(peer.authenticatedPriorPeerId
      ? { priorPeerIdHash: digest(`auggy-peer-id-v1\0${peer.authenticatedPriorPeerId}`) }
      : {}),
  };
}

function clonePlainData(value: unknown): unknown {
  const ancestors = new Set<object>();
  let nodes = 0;
  const clone = (input: unknown, depth: number): unknown => {
    nodes++;
    if (nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) {
      throw new Error("distributed payload exceeds structural limits");
    }
    if (input === null || typeof input === "boolean" || typeof input === "string") return input;
    if (typeof input === "number") {
      if (!Number.isFinite(input)) throw new Error("distributed payload contains non-finite data");
      return input;
    }
    if (Array.isArray(input)) {
      if (ancestors.has(input)) throw new Error("distributed payload is cyclic");
      ancestors.add(input);
      const value = input.map((item) => clone(item, depth + 1));
      ancestors.delete(input);
      return value;
    }
    if (typeof input !== "object") throw new Error("distributed payload is not plain data");
    const prototype = Object.getPrototypeOf(input);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error("distributed payload is not plain data");
    }
    if (ancestors.has(input)) throw new Error("distributed payload is cyclic");
    ancestors.add(input);
    const output: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(input as Record<string, unknown>)) {
      if (entry !== undefined) output[key] = clone(entry, depth + 1);
    }
    ancestors.delete(input);
    return output;
  };
  return clone(value, 0);
}

function plainRecord(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("invalid distributed message field");
  return value;
}

function sanitizedPart(value: unknown): Part {
  const part = plainRecord(value);
  if (!part) throw new Error("invalid distributed message part");
  if (part.kind === "text") {
    if (typeof part.text !== "string") throw new Error("invalid distributed text part");
    return { kind: "text", text: part.text };
  }
  if (part.kind === "file") {
    if (typeof part.uri !== "string") throw new Error("invalid distributed file part");
    const mimeType = optionalString(part, "mimeType");
    const name = optionalString(part, "name");
    return {
      kind: "file",
      uri: part.uri,
      ...(mimeType ? { mimeType } : {}),
      ...(name ? { name } : {}),
    };
  }
  if (part.kind === "data") {
    const data = clonePlainData(part.data);
    const record = plainRecord(data);
    if (!record) throw new Error("invalid distributed data part");
    return { kind: "data", data: record };
  }
  throw new Error("invalid distributed message part kind");
}

function sanitizedMessage(value: unknown): OutboundMessage {
  const message = plainRecord(value);
  if (!message || !Array.isArray(message.parts) || message.parts.length > 256) {
    throw new Error("distributed message parts exceed limits");
  }
  const targetAugment = optionalString(message, "targetAugment");
  const targetPeer = optionalString(message, "targetPeer");
  const contextId = optionalString(message, "contextId");
  const taskId = optionalString(message, "taskId");
  return {
    parts: message.parts.map(sanitizedPart),
    ...(targetAugment ? { targetAugment } : {}),
    ...(targetPeer ? { targetPeer } : {}),
    ...(contextId ? { contextId } : {}),
    ...(taskId ? { taskId } : {}),
  };
}

export function encodeDistributedReplay(
  result: TurnResult,
  threadId: string,
  limits: DistributedCoordinationResultConfig,
): DistributedReplayResult {
  if (!result.success || result.status !== "completed") {
    throw new Error("only successful completed turns are replayable");
  }
  if ((result.responses?.length ?? 0) > MAX_REPLAY_MESSAGES) {
    throw new Error("distributed replay messages exceed limits");
  }
  const body = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      turnId: result.turnId,
      threadId,
      status: "completed",
      ...(result.response ? { response: sanitizedMessage(result.response) } : {}),
      ...(result.responses ? { responses: result.responses.map(sanitizedMessage) } : {}),
    }),
  );
  if (body.byteLength > limits.maxReplayBytes) throw new Error("distributed replay exceeds limits");
  return { body, contentType: "application/json" };
}

export function decodeDistributedReplay(
  result: DistributedReplayResult,
  expectedThreadId?: string,
): TurnResult {
  const parsed = plainRecord(
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body)),
  );
  if (
    result.contentType !== "application/json" ||
    !parsed ||
    parsed.version !== 1 ||
    typeof parsed.turnId !== "string" ||
    parsed.turnId.length === 0 ||
    typeof parsed.threadId !== "string" ||
    parsed.threadId.length === 0 ||
    (expectedThreadId !== undefined && parsed.threadId !== expectedThreadId) ||
    parsed.status !== "completed" ||
    Object.keys(parsed).some(
      (key) =>
        key !== "version" &&
        key !== "turnId" &&
        key !== "threadId" &&
        key !== "status" &&
        key !== "response" &&
        key !== "responses",
    )
  ) {
    throw new Error("invalid distributed replay");
  }
  const response = parsed.response === undefined ? undefined : sanitizedMessage(parsed.response);
  const responses =
    parsed.responses === undefined
      ? undefined
      : Array.isArray(parsed.responses) && parsed.responses.length <= MAX_REPLAY_MESSAGES
        ? parsed.responses.map(sanitizedMessage)
        : (() => {
            throw new Error("invalid distributed replay responses");
          })();
  return {
    turnId: parsed.turnId,
    success: true,
    status: "completed",
    ...(response ? { response } : {}),
    ...(responses ? { responses } : {}),
    toolCalls: [],
    trace: emptyTrace({
      turnId: parsed.turnId,
      threadId: parsed.threadId,
      trigger: { type: "distributed-replay" },
    }),
  };
}

export function encodeDistributedHistory(
  snapshot: ThreadHistorySnapshot,
  limits: DistributedCoordinationTurnStateConfig["history"],
): { version: 1; body: Uint8Array; messageCount: number } {
  if (snapshot.messages.length > limits.maxMessages) {
    throw new Error("distributed history message count exceeds limits");
  }
  const body = new TextEncoder().encode(JSON.stringify(snapshot));
  if (body.byteLength > limits.maxSnapshotBytes) {
    throw new Error("distributed history bytes exceed limits");
  }
  return { version: 1, body, messageCount: snapshot.messages.length };
}

export function decodeDistributedHistory(body: Uint8Array): ThreadHistorySnapshot {
  const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
  return {
    version: 1,
    messages: parseThreadHistoryMessages(parsed, { allowLegacyArray: false }),
  };
}

export function encodeDistributedOutboxBody(
  targetAugment: string,
  peer: PeerIdentity,
  message: OutboundMessage,
  limits: DistributedCoordinationTurnStateConfig["outbox"],
): Uint8Array {
  const deliveryPeer = {
    id: peer.id,
    kind: peer.kind,
    trustLevel: peer.trustLevel,
    sourceAugment: peer.sourceAugment,
    ...(peer.publicSubstate ? { publicSubstate: peer.publicSubstate } : {}),
    ...(peer.orgId ? { orgId: peer.orgId } : {}),
    ...(peer.delegatedOrigin ? { delegatedOrigin: peer.delegatedOrigin } : {}),
  };
  const body = new TextEncoder().encode(
    JSON.stringify({
      version: 1,
      targetAugment,
      peer: clonePlainData(deliveryPeer),
      message: sanitizedMessage(message),
    }),
  );
  if (body.byteLength > limits.maxIntentBytes) {
    throw new Error("distributed outbox intent exceeds limits");
  }
  return body;
}
