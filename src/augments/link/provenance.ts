import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Part as LinkPart, Participant as LinkParticipant } from "@auggy/link";
import type { PeerIdentity, PeerKind, TrustLevel } from "../../types";

const PROVENANCE_KEY = "auggy_link_origin_v1";
const PROVENANCE_VERSION = 1;
const PROVENANCE_TTL_MS = 5 * 60 * 1000;
const CLOCK_SKEW_MS = 30 * 1000;
const MAX_HOPS = 8;
const MAX_ID_LENGTH = 256;
const MAX_SOURCE_LENGTH = 128;
const BASE64URL_SHA256 = /^[A-Za-z0-9_-]{43}$/;
const TRUST_RANK: Record<TrustLevel, number> = {
  public: 0,
  agent: 1,
  creator: 2,
};

interface LinkOrigin {
  subject: string;
  kind: PeerKind;
  trustLevel: TrustLevel;
  sourceAugment: string;
  pathSha256: string;
  publicSubstate?: "anonymous" | "recognized";
  orgId?: string;
}

interface LinkProvenanceEnvelope {
  version: 1;
  issuer: string;
  audience: string;
  origin: LinkOrigin;
  hopCount: number;
  issuedAt: number;
  expiresAt: number;
  idempotencyKey: string;
  partsSha256: string;
  signature: string;
}

export type LinkProvenanceResolution =
  | { ok: true; peer: PeerIdentity; authenticated: boolean }
  | { ok: false; reason: string };

export function createAuthenticatedLinkParts(args: {
  parts: readonly LinkPart[];
  peer: PeerIdentity | null;
  issuer: string;
  audience: string;
  bearer: string;
  idempotencyKey: string;
  now?: number;
}): LinkPart[] {
  if (args.parts.length === 0) {
    throw new Error("link provenance: at least one part is required");
  }
  const origin = originForPeer(args.peer, args.issuer);
  const hopCount = (args.peer?.delegatedOrigin?.hopCount ?? 0) + 1;
  if (hopCount > MAX_HOPS) {
    throw new Error(`link provenance: maximum delegation depth (${MAX_HOPS}) exceeded`);
  }
  const now = args.now ?? Date.now();
  const unsigned: Omit<LinkProvenanceEnvelope, "signature"> = {
    version: PROVENANCE_VERSION,
    issuer: bounded(args.issuer, MAX_ID_LENGTH, "issuer"),
    audience: bounded(args.audience, MAX_ID_LENGTH, "audience"),
    origin,
    hopCount,
    issuedAt: now,
    expiresAt: now + PROVENANCE_TTL_MS,
    idempotencyKey: bounded(args.idempotencyKey, MAX_ID_LENGTH, "idempotency key"),
    partsSha256: hashParts(args.parts),
  };
  const envelope: LinkProvenanceEnvelope = {
    ...unsigned,
    signature: signEnvelope(unsigned, args.bearer),
  };
  const wireEnvelope = JSON.parse(JSON.stringify(envelope)) as NonNullable<
    LinkPart["metadata"]
  >[string];
  return args.parts.map((part, index) =>
    index === 0
      ? {
          ...part,
          metadata: {
            ...(part.metadata ?? {}),
            [PROVENANCE_KEY]: wireEnvelope,
          },
        }
      : { ...part },
  );
}

export function resolveAuthenticatedLinkPeer(args: {
  parts: readonly LinkPart[];
  immediate: LinkParticipant;
  selfParticipantId: string;
  inboundBearer: string | undefined;
  sourceAugment: string;
  idempotencyKey: string | undefined;
  now?: number;
}): LinkProvenanceResolution {
  const candidates = args.parts.flatMap((part) => {
    const value = part.metadata?.[PROVENANCE_KEY];
    return value === undefined ? [] : [value];
  });
  if (candidates.length === 0) {
    return {
      ok: true,
      authenticated: false,
      peer: unprovenancedPeer(args.immediate, args.selfParticipantId, args.sourceAugment),
    };
  }
  if (candidates.length !== 1) {
    return { ok: false, reason: "multiple origin assertions" };
  }
  if (!args.inboundBearer) {
    return { ok: false, reason: "origin assertion has no configured verification key" };
  }
  const parsed = parseEnvelope(candidates[0]);
  if (!parsed.ok) return parsed;
  const envelope = parsed.envelope;
  if (envelope.issuer !== args.immediate.id) {
    return { ok: false, reason: "origin assertion issuer mismatch" };
  }
  if (envelope.audience !== args.selfParticipantId) {
    return { ok: false, reason: "origin assertion audience mismatch" };
  }
  if (!args.idempotencyKey || envelope.idempotencyKey !== args.idempotencyKey) {
    return { ok: false, reason: "origin assertion idempotency mismatch" };
  }
  if (envelope.partsSha256 !== hashParts(args.parts, true)) {
    return { ok: false, reason: "origin assertion content mismatch" };
  }
  const now = args.now ?? Date.now();
  if (
    envelope.issuedAt > now + CLOCK_SKEW_MS ||
    envelope.expiresAt < now - CLOCK_SKEW_MS ||
    envelope.expiresAt <= envelope.issuedAt ||
    envelope.expiresAt - envelope.issuedAt > PROVENANCE_TTL_MS
  ) {
    return { ok: false, reason: "origin assertion expired or outside its validity window" };
  }
  const { signature: _signature, ...unsigned } = envelope;
  const expected = signEnvelope(unsigned, args.inboundBearer);
  if (!safeSignatureEqual(envelope.signature, expected)) {
    return { ok: false, reason: "origin assertion signature mismatch" };
  }

  const trustLevel = leastTrust(envelope.origin.trustLevel, args.immediate.trust);
  const publicSubstate =
    trustLevel === "public"
      ? envelope.origin.trustLevel === "public"
        ? (envelope.origin.publicSubstate ?? "anonymous")
        : "anonymous"
      : undefined;
  const peer: PeerIdentity = {
    id: delegatedPeerId(envelope.audience, args.sourceAugment, envelope.issuer, envelope.origin),
    kind: envelope.origin.kind,
    trustLevel,
    ...(publicSubstate ? { publicSubstate } : {}),
    sourceAugment: args.sourceAugment,
    ...(envelope.origin.orgId ? { orgId: envelope.origin.orgId } : {}),
    delegatedOrigin: {
      subject: envelope.origin.subject,
      sourceAugment: envelope.origin.sourceAugment,
      viaPeerId: args.immediate.id,
      hopCount: envelope.hopCount,
    },
  };
  return { ok: true, authenticated: true, peer };
}

export function threadIdForLinkPeer(immediatePeerId: string, peer: PeerIdentity): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        immediatePeerId,
        peer.id,
        peer.kind,
        peer.trustLevel,
        peer.publicSubstate ?? null,
        peer.sourceAugment,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);
  return `link-${digest}`;
}

function originForPeer(peer: PeerIdentity | null, selfParticipantId: string): LinkOrigin {
  if (!peer) {
    return {
      subject: bounded(selfParticipantId, MAX_ID_LENGTH, "origin subject"),
      kind: "agent",
      trustLevel: "agent",
      sourceAugment: "link",
      pathSha256: originPathHash(["direct-internal", selfParticipantId, "agent", "agent", "link"]),
    };
  }
  const source = peer.delegatedOrigin?.sourceAugment ?? peer.sourceAugment;
  const subject = peer.delegatedOrigin?.subject ?? peer.id;
  return {
    subject: bounded(subject, MAX_ID_LENGTH, "origin subject"),
    kind: peer.kind,
    trustLevel: peer.trustLevel,
    sourceAugment: bounded(source, MAX_SOURCE_LENGTH, "origin source"),
    pathSha256: peer.delegatedOrigin
      ? originPathHash([
          "delegated",
          peer.id,
          peer.delegatedOrigin.viaPeerId,
          peer.delegatedOrigin.hopCount,
        ])
      : originPathHash([
          "direct",
          peer.id,
          peer.kind,
          peer.trustLevel,
          peer.publicSubstate ?? null,
          peer.sourceAugment,
          peer.orgId ?? null,
        ]),
    ...(peer.trustLevel === "public" ? { publicSubstate: peer.publicSubstate ?? "anonymous" } : {}),
    ...(peer.orgId ? { orgId: bounded(peer.orgId, MAX_ID_LENGTH, "origin organization") } : {}),
  };
}

function parseEnvelope(
  value: unknown,
): { ok: true; envelope: LinkProvenanceEnvelope } | { ok: false; reason: string } {
  if (!isRecord(value)) return { ok: false, reason: "malformed origin assertion" };
  const allowed = new Set([
    "version",
    "issuer",
    "audience",
    "origin",
    "hopCount",
    "issuedAt",
    "expiresAt",
    "idempotencyKey",
    "partsSha256",
    "signature",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    return { ok: false, reason: "origin assertion contains unknown fields" };
  }
  if (
    value.version !== PROVENANCE_VERSION ||
    !isBoundedString(value.issuer, MAX_ID_LENGTH) ||
    !isBoundedString(value.audience, MAX_ID_LENGTH) ||
    !Number.isInteger(value.hopCount) ||
    (value.hopCount as number) < 1 ||
    (value.hopCount as number) > MAX_HOPS ||
    !Number.isSafeInteger(value.issuedAt) ||
    !Number.isSafeInteger(value.expiresAt) ||
    !isBoundedString(value.idempotencyKey, MAX_ID_LENGTH) ||
    typeof value.partsSha256 !== "string" ||
    !BASE64URL_SHA256.test(value.partsSha256) ||
    typeof value.signature !== "string" ||
    !BASE64URL_SHA256.test(value.signature)
  ) {
    return { ok: false, reason: "malformed origin assertion" };
  }
  const origin = parseOrigin(value.origin);
  if (!origin) return { ok: false, reason: "malformed origin assertion principal" };
  return {
    ok: true,
    envelope: {
      version: 1,
      issuer: value.issuer,
      audience: value.audience,
      origin,
      hopCount: value.hopCount as number,
      issuedAt: value.issuedAt as number,
      expiresAt: value.expiresAt as number,
      idempotencyKey: value.idempotencyKey,
      partsSha256: value.partsSha256,
      signature: value.signature,
    },
  };
}

function parseOrigin(value: unknown): LinkOrigin | null {
  if (!isRecord(value)) return null;
  const allowed = new Set([
    "subject",
    "kind",
    "trustLevel",
    "sourceAugment",
    "pathSha256",
    "publicSubstate",
    "orgId",
  ]);
  if (
    Object.keys(value).some((key) => !allowed.has(key)) ||
    !isBoundedString(value.subject, MAX_ID_LENGTH) ||
    !isPeerKind(value.kind) ||
    !isTrustLevel(value.trustLevel) ||
    !isBoundedString(value.sourceAugment, MAX_SOURCE_LENGTH) ||
    typeof value.pathSha256 !== "string" ||
    !BASE64URL_SHA256.test(value.pathSha256) ||
    (value.orgId !== undefined && !isBoundedString(value.orgId, MAX_ID_LENGTH))
  ) {
    return null;
  }
  if (value.trustLevel === "public") {
    if (value.publicSubstate !== "anonymous" && value.publicSubstate !== "recognized") return null;
  } else if (value.publicSubstate !== undefined) {
    return null;
  }
  return {
    subject: value.subject,
    kind: value.kind,
    trustLevel: value.trustLevel,
    sourceAugment: value.sourceAugment,
    pathSha256: value.pathSha256,
    ...(value.publicSubstate ? { publicSubstate: value.publicSubstate } : {}),
    ...(value.orgId ? { orgId: value.orgId } : {}),
  };
}

function hashParts(parts: readonly LinkPart[], stripProvenance = false): string {
  const canonical = parts.map((part) => {
    const metadataEntries = Object.entries(part.metadata ?? {})
      .filter(([key]) => !stripProvenance || key !== PROVENANCE_KEY)
      .sort(([left], [right]) => left.localeCompare(right));
    return {
      kind: part.kind,
      text: part.text,
      ...(metadataEntries.length > 0 ? { metadata: Object.fromEntries(metadataEntries) } : {}),
    };
  });
  return createHash("sha256").update(JSON.stringify(canonical)).digest("base64url");
}

function signEnvelope(envelope: Omit<LinkProvenanceEnvelope, "signature">, bearer: string): string {
  return createHmac("sha256", bearer).update(canonicalEnvelope(envelope)).digest("base64url");
}

function canonicalEnvelope(envelope: Omit<LinkProvenanceEnvelope, "signature">): string {
  const origin = envelope.origin;
  return JSON.stringify([
    envelope.version,
    envelope.issuer,
    envelope.audience,
    [
      origin.subject,
      origin.kind,
      origin.trustLevel,
      origin.sourceAugment,
      origin.pathSha256,
      origin.publicSubstate ?? null,
      origin.orgId ?? null,
    ],
    envelope.hopCount,
    envelope.issuedAt,
    envelope.expiresAt,
    envelope.idempotencyKey,
    envelope.partsSha256,
  ]);
}

function delegatedPeerId(
  audience: string,
  localSourceAugment: string,
  issuer: string,
  origin: LinkOrigin,
): string {
  const digest = createHash("sha256")
    .update(
      JSON.stringify([
        audience,
        localSourceAugment,
        issuer,
        origin.sourceAugment,
        origin.subject,
        origin.pathSha256,
        origin.kind,
        origin.trustLevel,
        origin.publicSubstate ?? null,
        origin.orgId ?? null,
      ]),
    )
    .digest("base64url")
    .slice(0, 32);
  return `link-origin-${digest}`;
}

function unprovenancedPeer(
  immediate: LinkParticipant,
  audience: string,
  sourceAugment: string,
): PeerIdentity {
  const digest = createHash("sha256")
    .update(JSON.stringify([audience, sourceAugment, immediate.id, immediate.type]))
    .digest("base64url")
    .slice(0, 32);
  return {
    id: `link-unprovenanced-${digest}`,
    kind: immediate.type,
    trustLevel: "public",
    publicSubstate: "anonymous",
    sourceAugment,
    delegatedOrigin: {
      subject: immediate.id,
      sourceAugment,
      viaPeerId: immediate.id,
      hopCount: 0,
    },
  };
}

function leastTrust(left: TrustLevel, right: TrustLevel): TrustLevel {
  return TRUST_RANK[left] <= TRUST_RANK[right] ? left : right;
}

function originPathHash(parts: readonly unknown[]): string {
  return createHash("sha256").update(JSON.stringify(parts)).digest("base64url");
}

function safeSignatureEqual(left: string, right: string): boolean {
  try {
    const leftBytes = Buffer.from(left, "base64url");
    const rightBytes = Buffer.from(right, "base64url");
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
  } catch {
    return false;
  }
}

function bounded(value: string, max: number, label: string): string {
  if (!isBoundedString(value, max)) {
    throw new Error(`link provenance: ${label} must be 1-${max} characters`);
  }
  return value;
}

function isBoundedString(value: unknown, max: number): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= max;
}

function isTrustLevel(value: unknown): value is TrustLevel {
  return value === "creator" || value === "agent" || value === "public";
}

function isPeerKind(value: unknown): value is PeerKind {
  return value === "human" || value === "agent" || value === "system" || value === "anonymous";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
