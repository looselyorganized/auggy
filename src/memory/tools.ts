import { z } from "zod";
import type {
  Tool,
  NamespaceMemoryProvider,
  ToolExecuteContext,
  ContextOrigin,
} from "../types";
import { defineTool } from "../helpers";
import { lookupProvider } from "./registry";
import type { MemoryRegistry } from "./types";

const DEFAULT_MAX_MEMORY_OPS_PER_TURN = 20;
const EMERGENCY_CLEANUP_THRESHOLD = 1000;

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
 * matching the convention from effectiveTrustLevel in capability-table.ts.
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
  const trustLevel = context.peer?.trustLevel ?? "operator";
  if (trustLevel === "operator" || trustLevel === "facility") {
    return null;
  }
  return `Error: memory_${operation} on this label requires facility or operator trust. Current peer trust: ${trustLevel}.`;
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
      "Write content to a memory block by label. Only mutable labels can be written.",
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

      await spec.write(label, content);
      return `Successfully wrote to "${label}"`;
    },
  });

  const memorySearch = defineTool({
    name: "memory_search",
    description:
      "Search across namespace memory providers. Returns ranked results.",
    category: "memory",
    input: z.object({
      query: z.string().describe("The search query"),
      providers: z
        .array(z.string())
        .optional()
        .describe("Optional provider name filter"),
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
            assertMemoryAccess("search", ns.augment.memory!.defaults.origin, context) ===
            null,
        )
        .map((ns) => ns.augment);

      if (candidates.length === 0) {
        return "No searchable memory providers available";
      }

      const results = await Promise.allSettled(
        candidates.map(async (aug) => {
          const spec = aug.memory! as NamespaceMemoryProvider;
          return {
            provider: aug.name,
            entries: await spec.search(query),
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
    description:
      "List all available memory labels and namespace prefixes for this agent.",
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
          ([, aug]) =>
            assertMemoryAccess("list", aug.memory!.defaults.origin, context) === null,
        )
        .map(([label]) => label);

      const namespaces = registry.namespaces
        .filter(
          (ns) =>
            assertMemoryAccess("list", ns.augment.memory!.defaults.origin, context) ===
            null,
        )
        .map((ns) => `${ns.prefix}*`);

      return JSON.stringify({ static: staticLabels, namespaces });
    },
  });

  return {
    tools: [memoryRead, memoryWrite, memorySearch, memoryList],
    onTurnEnd,
    onTurnStart,
  };
}
