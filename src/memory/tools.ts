import { z } from "zod";
import type {
  ContextOrigin,
  MemoryEntry,
  NamespaceMemoryProvider,
  Tool,
  ToolExecuteContext,
} from "../types";
import { defineTool } from "../helpers";
import { effectiveTrustLevel } from "../kernel/capability-table";
import { lookupProvider } from "./registry";
import type { MemoryRegistry } from "./types";

const DEFAULT_MAX_MEMORY_OPS_PER_TURN = 20;
const EMERGENCY_CLEANUP_THRESHOLD = 1000;

/**
 * Phase 1b Task 7: explicit serializer for memory_search results.
 *
 * Memory providers may attach a per-entry `origin` field (the storage layer
 * uses the canonical OriginValue union — "operator" | "peer-derived" |
 * "agent-derived" | "agent" — added in Phase 1a). The MemoryEntry public
 * surface does not declare this field, but providers that track it pass
 * it through as an excess property; this helper surfaces it explicitly on
 * the search response so the model (and the context-allocator at render
 * time) can distinguish `[AGENT-DERIVED]` paraphrases from `[PEER-DERIVED]`
 * verbatim captures.
 *
 * No default fabrication: if the entry has no origin, the field stays
 * absent and the context-allocator falls back to provider defaults
 * (Task 8). Other excess properties on the entry are preserved as-is.
 */
function serializeEntryWithOrigin(entry: MemoryEntry): MemoryEntry & { origin?: string } {
  const maybeOrigin = (entry as MemoryEntry & { origin?: unknown }).origin;
  if (typeof maybeOrigin === "string") {
    return { ...entry, origin: maybeOrigin };
  }
  return entry;
}

/**
 * Unified trust gate for memory operations. Returns an error string
 * if the operation should be denied, or null if allowed.
 *
 * Rule:
 *   - Missing context        → DENY (fail-closed)
 *   - origin "peer-derived"  → ALLOW (peer-scoped memory is open to all)
 *   - trust ∈ {operator, facility} → ALLOW
 *   - otherwise              → DENY (untrusted, authenticated, or any future level)
 *
 * Null peer (internal/scheduled triggers) is treated as operator trust,
 * via the shared effectiveTrustLevel helper in capability-table.ts.
 */
function assertMemoryAccess(
  operation: "read" | "write" | "search" | "list",
  origin: ContextOrigin,
  context: ToolExecuteContext | undefined,
): string | null {
  if (!context) {
    return `Error: memory_${operation} requires turn context.`;
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
    description: "Write content to a memory block by label. Only mutable labels can be written.",
    category: "memory",
    input: z.object({
      label: z.string().describe("The label to write to"),
      content: z.string().describe("The content to store"),
    }),
    execute: async ({ label, content }, context?) => {
      const budgetErr = checkBudget(context?.turnId ?? "unknown");
      if (budgetErr) return budgetErr;

      const provider = lookupProvider(registry, label);
      if (!provider) return `Error: No provider owns label "${label}"`;

      const spec = provider.memory!;
      if (!spec.write) {
        return `Error: Memory label "${label}" is immutable (owned by "${provider.name}")`;
      }

      const accessErr = assertMemoryAccess("write", spec.defaults.origin, context);
      if (accessErr) return accessErr;

      if (spec.owns.kind === "namespace") {
        await spec.write(label, content, {
          peerId: context?.peer?.id,
          trustLevel: context?.peer?.trustLevel,
        });
      } else {
        await spec.write(label, content);
      }
      return `Successfully wrote to "${label}"`;
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
          // Phase 1b Task 7: explicit per-entry origin pass-through. Memory
          // providers may carry an `origin` field on individual entries
          // (Phase 1a's storage layer added it as an OriginValue) so the
          // model can distinguish `[AGENT-DERIVED]` paraphrases from
          // `[PEER-DERIVED]` verbatim peer statements at retrieval time.
          // We surface the field explicitly rather than relying on JSON
          // pass-through so a future MemoryEntry refactor can't silently
          // drop it. We do NOT fabricate a default — if an entry has no
          // origin, the field stays undefined and the context-allocator
          // (Task 8) handles fallback at render time.
          return {
            provider: aug.name,
            entries: entries.map(serializeEntryWithOrigin),
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
      "Delete all episodic memory entries for a specific visitor. Use for right-to-erasure requests. Operator/facility only.",
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
          } catch (err) {
            errors.push(`${ns.augment.name}: ${err instanceof Error ? err.message : String(err)}`);
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
