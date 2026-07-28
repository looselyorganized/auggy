import type { DistributedCoordinationMemoryConfig, DistributedMemoryPolicyV1 } from "../types";
import type { DistributedPeerBindingV1 } from "./types";

const MAX_POLICIES = 16;
const MAX_CAPACITY = 1_000_000;
const MAX_BYTES = 1_048_576;
const MAX_RETAINED_BYTES = 1_073_741_824;
const MAX_RETENTION_MS = 31_536_000_000;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/;

function identifier(name: string, value: unknown): string {
  if (typeof value !== "string" || !IDENTIFIER.test(value)) throw new Error(`${name} is invalid`);
  return value;
}

function limit(name: string, value: unknown, minimum: number, maximum = MAX_CAPACITY): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw new Error(`${name} is invalid`);
  }
  return value as number;
}

export function normalizeDistributedMemoryPolicy(
  value: DistributedMemoryPolicyV1,
  terminalRequestRetentionMs?: number,
): DistributedMemoryPolicyV1 {
  const normalized: DistributedMemoryPolicyV1 = {
    id: identifier("memory.id", value.id),
    namespacePrefix: identifier("memory.namespacePrefix", value.namespacePrefix),
    maxEntries: limit("memory.maxEntries", value.maxEntries, 1),
    maxEntriesPerPeer: limit("memory.maxEntriesPerPeer", value.maxEntriesPerPeer, 1),
    maxBytes: limit("memory.maxBytes", value.maxBytes, 1, MAX_RETAINED_BYTES),
    maxBytesPerPeer: limit("memory.maxBytesPerPeer", value.maxBytesPerPeer, 1, MAX_RETAINED_BYTES),
    maxEntryBytes: limit("memory.maxEntryBytes", value.maxEntryBytes, 1, MAX_BYTES),
    maxQueryBytes: limit("memory.maxQueryBytes", value.maxQueryBytes, 1, MAX_BYTES),
    maxResultBytes: limit("memory.maxResultBytes", value.maxResultBytes, 1, MAX_BYTES),
    maxResults: limit("memory.maxResults", value.maxResults, 1),
    maxMutationsPerTurn: limit("memory.maxMutationsPerTurn", value.maxMutationsPerTurn, 1, 1_000),
    maxOperations: limit("memory.maxOperations", value.maxOperations, 1),
    maxTombstones: limit("memory.maxTombstones", value.maxTombstones, 1),
    operationRetentionMs: limit(
      "memory.operationRetentionMs",
      value.operationRetentionMs,
      60_000,
      MAX_RETENTION_MS,
    ),
    entryRetentionMs: limit(
      "memory.entryRetentionMs",
      value.entryRetentionMs,
      60_000,
      MAX_RETENTION_MS,
    ),
  };
  if (normalized.maxEntriesPerPeer > normalized.maxEntries) {
    throw new Error("memory.maxEntriesPerPeer exceeds memory.maxEntries");
  }
  if (
    normalized.maxBytesPerPeer > normalized.maxBytes ||
    normalized.maxEntryBytes > normalized.maxBytesPerPeer
  ) {
    throw new Error("memory byte limits are inconsistent");
  }
  if (normalized.maxResultBytes < normalized.maxEntryBytes) {
    throw new Error("memory.maxResultBytes cannot be smaller than memory.maxEntryBytes");
  }
  if (
    normalized.operationRetentionMs < normalized.entryRetentionMs ||
    (terminalRequestRetentionMs !== undefined &&
      normalized.operationRetentionMs < terminalRequestRetentionMs)
  ) {
    throw new Error(
      "memory operation retention cannot be shorter than retained memory or turn replay",
    );
  }
  return Object.freeze(normalized);
}

export function normalizeDistributedMemoryConfig(
  value: DistributedCoordinationMemoryConfig | undefined,
  terminalRequestRetentionMs?: number,
): DistributedCoordinationMemoryConfig {
  const policies = [...(value?.policies ?? [])].map((policy) =>
    normalizeDistributedMemoryPolicy(policy, terminalRequestRetentionMs),
  );
  if (policies.length > MAX_POLICIES) throw new Error("distributed memory policies exceed bounds");
  policies.sort((left, right) => left.id.localeCompare(right.id));
  if (policies.some((policy, index) => policy.id === policies[index - 1]?.id)) {
    throw new Error("distributed memory policy ids must be unique");
  }
  if (new Set(policies.map((policy) => policy.namespacePrefix)).size !== policies.length) {
    throw new Error("distributed memory namespace prefixes must be unique");
  }
  return Object.freeze({ policies: Object.freeze(policies) });
}

export function distributedMemoryPolicyFingerprint(
  value: DistributedCoordinationMemoryConfig,
): string {
  return new Bun.CryptoHasher("sha256")
    .update("auggy-distributed-memory-policy-v1\0")
    .update(JSON.stringify(value))
    .digest("hex");
}

export function sameDistributedMemoryPolicy(
  left: DistributedMemoryPolicyV1,
  right: DistributedMemoryPolicyV1,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** Never collapse unauthenticated creator/agent bindings into one partition. */
export function distributedMemoryPeerScope(binding: DistributedPeerBindingV1): string {
  return binding.peerIdHash ?? binding.bindingHash;
}

/** The public peer-id hash domain is shared with coordinator peer bindings. */
export function isCanonicalDistributedMemoryEraseTarget(
  targetPeerId: unknown,
): targetPeerId is string {
  if (typeof targetPeerId !== "string" || targetPeerId.length === 0 || targetPeerId.length > 256) {
    return false;
  }
  return (
    targetPeerId === targetPeerId.normalize("NFC") &&
    !Array.from(targetPeerId).some((character) => {
      const codePoint = character.codePointAt(0)!;
      return codePoint <= 0x1f || codePoint === 0x7f;
    })
  );
}

export function distributedMemoryEraseTargetScope(targetPeerId: string): string {
  const canonical = targetPeerId.normalize("NFC");
  if (!isCanonicalDistributedMemoryEraseTarget(targetPeerId) || canonical !== targetPeerId) {
    throw new Error("memory erase target is invalid");
  }
  return new Bun.CryptoHasher("sha256")
    .update("auggy-peer-id-v1\0")
    .update(canonical)
    .digest("hex");
}

/** Canonical, searchable committed-memory payload; never store arbitrary blobs. */
export function decodeDistributedMemoryDocument(body: Uint8Array): { content: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { content?: unknown }).content !== "string" ||
      Object.keys(parsed).length !== 2
    ) {
      throw new Error("invalid");
    }
    const content = (parsed as { content: string }).content;
    if (JSON.stringify({ version: 1, content }) !== text) throw new Error("invalid");
    return { content };
  } catch {
    throw new Error("distributed memory document is invalid");
  }
}

/** Query is intentionally small, canonical, and interpreted by the coordinator. */
export function decodeDistributedMemoryQuery(query: Uint8Array): { contains: string } {
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(query);
    const parsed = JSON.parse(text) as unknown;
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Array.isArray(parsed) ||
      (parsed as { version?: unknown }).version !== 1 ||
      typeof (parsed as { contains?: unknown }).contains !== "string" ||
      Object.keys(parsed).length !== 2
    ) {
      throw new Error("invalid");
    }
    const contains = (parsed as { contains: string }).contains;
    if (contains.length === 0 || JSON.stringify({ version: 1, contains }) !== text)
      throw new Error("invalid");
    return { contains };
  } catch {
    throw new Error("distributed memory query is invalid");
  }
}
