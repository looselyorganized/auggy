import { effectiveTrustLevel } from "../kernel/capability-table";
import type { ContextBlock, ContextOrigin, TrustLevel, TurnState } from "../types";
import type { MemoryRegistry } from "./types";

function canWrite(
  origin: ContextOrigin,
  writeTrustLevels: readonly TrustLevel[] | undefined,
  turn: TurnState,
): boolean {
  const trustLevel = effectiveTrustLevel(turn.peer);
  if (writeTrustLevels && !writeTrustLevels.includes(trustLevel)) return false;
  if (origin === "peer-derived") return true;

  return trustLevel === "creator" || trustLevel === "agent";
}

export function buildMemoryCapabilityContext(
  registry: MemoryRegistry,
  turn: TurnState,
): ContextBlock {
  const staticLabels = Array.from(registry.static.entries())
    .filter(([, augment]) => {
      const provider = augment.memory!;
      return (
        Boolean(provider.write) &&
        canWrite(provider.defaults.origin, provider.writeTrustLevels, turn)
      );
    })
    .map(([label]) => label)
    .sort();

  const writableTopicProviders = turn.peer?.id
    ? registry.namespaces
        .filter(({ augment }) => {
          const provider = augment.memory!;
          return (
            Boolean(provider.write) &&
            canWrite(provider.defaults.origin, provider.writeTrustLevels, turn)
          );
        })
        .map(({ augment }) => augment.name)
        .sort()
    : [];

  const exactLabels =
    staticLabels.length > 0
      ? staticLabels.map((label) => JSON.stringify(label)).join(", ")
      : "none";
  const topicCapability =
    writableTopicProviders.length > 0
      ? `writable via ${writableTopicProviders.map((name) => JSON.stringify(name)).join(", ")}`
      : "unavailable (no authorized writable namespace provider for the current peer)";
  const learnedProvider = registry.static.get("learned")?.memory;
  const learnedCapability =
    staticLabels.includes("learned") &&
    learnedProvider?.defaults.origin === "operator" &&
    learnedProvider.writeTrustLevels?.length === 1 &&
    learnedProvider.writeTrustLevels[0] === "creator"
      ? ' The "learned" label is writable for agent-global behavior.'
      : "";
  const peerIdentityCaveat =
    writableTopicProviders.length > 0 && turn.peer?.trustLevel === "public"
      ? turn.peer.publicSubstate === "recognized"
        ? " The current public peer is recognized; continuity still depends on durable provider storage."
        : " The current public peer is anonymous; this identity is temporary and does not provide cross-session continuity."
      : "";

  return {
    source: "memory-bus",
    content: [
      "Memory write destinations for this turn:",
      `- Exact writable labels: ${exactLabels}.${learnedCapability}`,
      `- Current-peer topic memory: ${topicCapability}.${peerIdentityCaveat}`,
      "Only claim persistence after memory_write reports PERSISTED.",
    ].join("\n"),
    placement: "system",
    provenance: "augment",
    priority: "required",
    eviction: "never",
    origin: "system",
    ttl: "turn",
  };
}
