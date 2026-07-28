import { z } from "zod";
import type {
  ContextOrigin,
  NamespaceMemoryProvider,
  Tool,
  ToolExecuteContext,
  ToolResult,
  TrustLevel,
} from "../types";
import { defineTool } from "../helpers";
import { effectiveTrustLevel } from "../kernel/capability-table";
import { lookupProvider } from "./registry";
import type { MemoryRegistry } from "./types";

const DEFAULT_MAX_MEMORY_OPS_PER_TURN = 20;
const EMERGENCY_CLEANUP_THRESHOLD = 1000;
const MAX_DERIVED_TOPIC_LENGTH = 80;
const NO_PEER_MEMORY_GUIDANCE =
  "No writable current-peer memory provider is available. Nothing was persisted. Peer-specific facts require a writable namespace provider such as layeredMemory and a stable peer identity for cross-session recall. Do not retry a peer fact under an agent-global label.";

function notPersisted(message: string): ToolResult {
  return { content: `NOT_PERSISTED: ${message}`, isError: true };
}

function persistenceUnknown(message: string): ToolResult {
  return { content: `PERSISTENCE_UNKNOWN: ${message}`, isError: true };
}

/**
 * Unified trust gate for memory operations. Returns an error string
 * if the operation should be denied, or null if allowed.
 *
 * Rule:
 *   - Missing context        → DENY (fail-closed)
 *   - origin "peer-derived"  → ALLOW (peer-scoped memory is open to all)
 *   - trust ∈ {creator, agent} → ALLOW
 *   - otherwise              → DENY (public, or any future level below agent)
 *
 * Null peer (internal/scheduled triggers) is treated as creator trust for the
 * origin policy. Explicit write allowlists require an actual peer so a
 * scheduled model turn cannot impersonate a verified creator.
 */
function assertMemoryAccess(
  operation: "read" | "write" | "search" | "list",
  origin: ContextOrigin,
  context: ToolExecuteContext | undefined,
  writeTrustLevels?: readonly TrustLevel[],
): string | null {
  if (!context) {
    return `Error: memory_${operation} requires turn context.`;
  }
  if (operation === "write" && writeTrustLevels) {
    if (!context.peer) {
      return "Error: memory_write on this destination requires an authenticated peer; internal turns do not satisfy an explicit write trust allowlist.";
    }
    const trustLevel = effectiveTrustLevel(context.peer);
    if (!writeTrustLevels.includes(trustLevel)) {
      return `Error: memory_write on this destination requires ${writeTrustLevels.join(" or ")} trust. Current peer trust: ${trustLevel}.`;
    }
  }
  if (origin === "peer-derived") {
    return null;
  }
  const trustLevel = effectiveTrustLevel(context.peer ?? null);
  if (trustLevel === "creator" || trustLevel === "agent") {
    return null;
  }
  return `Error: memory_${operation} on this label requires agent or creator trust. Current peer trust: ${trustLevel}.`;
}

function normalizeMemoryTopic(topic: string): string | null {
  const normalized = topic
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, MAX_DERIVED_TOPIC_LENGTH);

  return normalized.length > 0 ? normalized : null;
}

function labelForPeerTopic(prefix: string, peerId: string, topic: string): string | null {
  const normalizedTopic = normalizeMemoryTopic(topic);
  if (!normalizedTopic) return null;
  return `${prefix}${peerId}:${normalizedTopic}`;
}

export interface CreateMemoryToolsResult {
  tools: Tool[];
  onTurnEnd: (turnId: string) => void;
  onTurnStart: () => void;
}

export function createMemoryTools(
  registry: MemoryRegistry,
  opts: { maxPerTurn?: number } = {},
): CreateMemoryToolsResult {
  const maxPerTurn = opts.maxPerTurn ?? DEFAULT_MAX_MEMORY_OPS_PER_TURN;
  const turnBudgets = new Map<string, number>();

  function checkBudget(turnId: string): string | null {
    const calls = turnBudgets.get(turnId) ?? 0;
    if (calls >= maxPerTurn) {
      return `Error: Memory operation budget exceeded (${maxPerTurn} per turn)`;
    }
    turnBudgets.set(turnId, calls + 1);
    return null;
  }

  // Primary cleanup: called by the agent's onTurnEnd lifecycle for every
  // completed turn (success, failure, or rejection). Removes that turn's
  // budget entry.
  function onTurnEnd(turnId: string): void {
    turnBudgets.delete(turnId);
  }

  // Defense-in-depth: emergency clear if the map grows beyond a sane bound.
  // Should never fire under normal operation (onTurnEnd handles cleanup).
  // If it does fire, that signals a kernel/agent bug to investigate.
  function onTurnStart(): void {
    if (turnBudgets.size > EMERGENCY_CLEANUP_THRESHOLD) {
      console.warn(
        `[memory-bus] Emergency budget cleanup: ${turnBudgets.size} stale entries. Indicates onTurnEnd hooks not firing.`,
      );
      turnBudgets.clear();
    }
  }

  const memoryRead = defineTool({
    name: "memory_read",
    description:
      "Read a memory block by label. Call memory_list() to see available labels and namespaces.",
    category: "memory",
    input: z.object({
      label: z.string().describe("The memory label to read (e.g. 'self')"),
    }),
    execute: async ({ label }, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return budgetErr;

      const provider = lookupProvider(registry, label);
      if (!provider) return `Error: No provider owns label "${label}"`;

      const spec = provider.memory!;
      if (!spec.read) {
        return `Error: Provider "${provider.name}" does not support reading by label (use memory_search)`;
      }

      const accessErr = assertMemoryAccess("read", spec.defaults.origin, context);
      if (accessErr) return accessErr;

      const entry = await spec.read(label);
      if (!entry) return `No entry found for label "${label}"`;
      return JSON.stringify(entry);
    },
  });

  const memoryWrite = defineTool({
    name: "memory_write",
    description:
      'Persist one of two distinct memory types. For a peer-specific fact, use topic + content; this requires a writable namespace provider such as layeredMemory. For creator-approved, agent-global operating behavior, use exact label "learned" + content. Never put visitor facts in "learned". Do not provide both label and topic. A write is persisted only when the result starts with PERSISTED.',
    category: "memory",
    input: z.object({
      label: z.string().optional().describe("Optional exact memory label to write to"),
      topic: z
        .string()
        .optional()
        .describe("Optional topic to save under the current peer's scoped memory"),
      provider: z
        .string()
        .optional()
        .describe("Optional namespace memory provider name when multiple writable providers exist"),
      content: z.string().describe("The content to store"),
    }),
    execute: async ({ label, topic, provider: providerName, content }, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return notPersisted(budgetErr.replace(/^Error:\s*/, ""));

      if (label && topic) {
        return notPersisted(
          "memory_write accepts either an exact label or a peer topic, not both. Nothing was persisted.",
        );
      }

      if (!label) {
        if (!topic) {
          return notPersisted(
            "memory_write requires either an exact label or a topic. Nothing was persisted.",
          );
        }
        if (!context) {
          return notPersisted(
            "memory_write by topic requires turn context. Nothing was persisted.",
          );
        }
        if (!context.peer?.id) {
          return notPersisted(
            "memory_write by topic requires a current peer. Nothing was persisted.",
          );
        }

        const candidates = registry.namespaces
          .filter((ns) => !providerName || ns.augment.name === providerName)
          .filter((ns) => {
            const spec = ns.augment.memory!;
            return (
              spec.owns.kind === "namespace" &&
              Boolean(spec.write) &&
              assertMemoryAccess("write", spec.defaults.origin, context, spec.writeTrustLevels) ===
                null
            );
          });

        if (candidates.length === 0) {
          return providerName
            ? notPersisted(
                `No writable memory provider named "${providerName}" is available for this peer. ${NO_PEER_MEMORY_GUIDANCE}`,
              )
            : notPersisted(NO_PEER_MEMORY_GUIDANCE);
        }
        if (candidates.length > 1) {
          const names = candidates.map((candidate) => candidate.augment.name).join(", ");
          return notPersisted(
            `Multiple writable memory providers are available (${names}). Retry with provider. Nothing was persisted.`,
          );
        }

        const candidate = candidates[0]!;
        const spec = candidate.augment.memory! as NamespaceMemoryProvider;
        const derivedLabel = labelForPeerTopic(spec.owns.prefix, context.peer.id, topic);
        if (!derivedLabel) {
          return notPersisted(
            "memory_write topic must contain at least one letter or number. Nothing was persisted.",
          );
        }

        try {
          await spec.write!(derivedLabel, content, {
            peerId: context.peer.id,
            trustLevel: context.peer.trustLevel,
          });
        } catch (err) {
          console.error(
            `[memory-bus] Provider "${candidate.augment.name}" failed to persist peer memory:`,
            err,
          );
          return persistenceUnknown(
            `The "${candidate.augment.name}" provider failed while writing this peer memory. The final persistence state is unknown; check the provider logs before retrying.`,
          );
        }
        return `PERSISTED: Successfully wrote peer memory to "${derivedLabel}".`;
      }

      const provider = lookupProvider(registry, label);
      if (!provider) {
        return notPersisted(`No provider owns label "${label}". Nothing was persisted.`);
      }

      const spec = provider.memory!;
      if (!spec.write) {
        return notPersisted(
          `Memory label "${label}" is immutable (owned by "${provider.name}"). Nothing was persisted.`,
        );
      }
      if (spec.owns.kind === "namespace") {
        return notPersisted(
          `Exact-label writes are not allowed for namespace memory. Use topic so Auggy binds the write to the current peer. Nothing was persisted.`,
        );
      }

      const accessErr = assertMemoryAccess(
        "write",
        spec.defaults.origin,
        context,
        spec.writeTrustLevels,
      );
      if (accessErr) {
        return notPersisted(`${accessErr.replace(/^Error:\s*/, "")} Nothing was persisted.`);
      }

      try {
        await spec.write(label, content);
      } catch (err) {
        console.error(
          `[memory-bus] Provider "${provider.name}" failed to persist "${label}":`,
          err,
        );
        return persistenceUnknown(
          `The "${provider.name}" provider failed while writing label "${label}". The final persistence state is unknown; check the provider logs before retrying.`,
        );
      }
      return `PERSISTED: Successfully wrote memory to "${label}".`;
    },
  });

  const memorySearch = defineTool({
    name: "memory_search",
    description: "Search across namespace memory providers. Returns ranked results.",
    category: "memory",
    input: z.object({
      query: z.string().describe("The search query"),
      providers: z.array(z.string()).optional().describe("Optional provider name filter"),
    }),
    execute: async ({ query, providers: restrictTo }, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return budgetErr;

      // Context required for search — without it we can't enforce the
      // origin gate, so deny rather than over-share.
      if (!context) {
        return "Error: memory_search requires turn context.";
      }

      const candidates = registry.namespaces
        .filter((ns) => !restrictTo || restrictTo.includes(ns.augment.name))
        .filter(
          (ns) =>
            assertMemoryAccess("search", ns.augment.memory!.defaults.origin, context) === null,
        )
        .map((ns) => ns.augment);

      if (candidates.length === 0) {
        return "No searchable memory providers available";
      }

      const results = await Promise.allSettled(
        candidates.map(async (aug) => {
          const spec = aug.memory! as NamespaceMemoryProvider;
          const entries = await spec.search(query, { peerId: context.peer?.id });
          return {
            provider: aug.name,
            entries,
          };
        }),
      );

      const output = results.map((r, i) => {
        if (r.status === "fulfilled") return r.value;
        return {
          provider: candidates[i]!.name,
          error: String(r.reason),
        };
      });

      return JSON.stringify(output);
    },
  });

  const memoryList = defineTool({
    name: "memory_list",
    description: "List all available memory labels and namespace prefixes for this agent.",
    category: "memory",
    input: z.object({}),
    execute: async (_input, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return budgetErr;

      // Context required — without it we can't filter by trust, so deny.
      if (!context) {
        return "Error: memory_list requires turn context.";
      }

      const staticLabels = Array.from(registry.static.entries())
        .filter(
          ([, aug]) => assertMemoryAccess("list", aug.memory!.defaults.origin, context) === null,
        )
        .map(([label]) => label);

      const namespaces = registry.namespaces
        .filter(
          (ns) => assertMemoryAccess("list", ns.augment.memory!.defaults.origin, context) === null,
        )
        .map((ns) => `${ns.prefix}*`);

      return JSON.stringify({ static: staticLabels, namespaces });
    },
  });

  const memoryForget = defineTool({
    name: "memory_forget",
    description:
      "Delete all episodic memory entries for a specific visitor. Use for right-to-erasure requests. Creator/agent only.",
    category: "memory",
    input: z.object({
      peerId: z.string().describe("The visitor ID to forget (e.g. 'vis_abc123')"),
    }),
    execute: async ({ peerId: targetPeerId }, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return budgetErr;

      if (!context) {
        return "Error: memory_forget requires turn context.";
      }

      // Destructive admin action — gated to creator/agent regardless of
      // any individual provider's origin. Null peer (internal trigger) is
      // treated as creator trust via effectiveTrustLevel.
      const trustLevel = effectiveTrustLevel(context.peer ?? null);
      if (trustLevel !== "creator" && trustLevel !== "agent") {
        return `Error: memory_forget requires agent or creator trust. Current peer trust: ${trustLevel}.`;
      }

      let totalDeleted = 0;
      const errors: string[] = [];
      for (const ns of registry.namespaces) {
        const spec = ns.augment.memory as NamespaceMemoryProvider;
        if (spec.forget) {
          try {
            totalDeleted += await spec.forget(targetPeerId);
          } catch {
            errors.push(`${ns.augment.name}: provider operation failed`);
          }
        }
      }

      return JSON.stringify({
        status: errors.length === 0 ? "ok" : "partial",
        deleted: totalDeleted,
        errors: errors.length > 0 ? errors : undefined,
        message: `Deleted ${totalDeleted} entries for peer "${targetPeerId}".`,
      });
    },
  });

  return {
    tools: [memoryRead, memoryWrite, memorySearch, memoryList, memoryForget],
    onTurnEnd,
    onTurnStart,
  };
}
