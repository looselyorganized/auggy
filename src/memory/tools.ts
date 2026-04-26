import { z } from "zod";
import type { Tool, NamespaceMemoryProvider, ToolExecuteContext } from "../types";
import { defineTool } from "../helpers";
import { lookupProvider } from "./registry";
import type { MemoryRegistry } from "./types";

const DEFAULT_MAX_MEMORY_OPS_PER_TURN = 20;

export interface CreateMemoryToolsResult {
  tools: Tool[];
  cleanupHook: () => void;
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

  function cleanupHook(): void {
    if (turnBudgets.size > 100) turnBudgets.clear();
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
      const err = checkBudget(context?.turnId ?? "unknown");
      if (err) return err;

      const provider = lookupProvider(registry, label);
      if (!provider) return `Error: No provider owns label "${label}"`;

      const spec = provider.memory!;
      if (!spec.read) {
        return `Error: Provider "${provider.name}" does not support reading by label (use memory_search)`;
      }
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
      const err = checkBudget(context?.turnId ?? "unknown");
      if (err) return err;

      const provider = lookupProvider(registry, label);
      if (!provider) return `Error: No provider owns label "${label}"`;

      const spec = provider.memory!;
      if (!spec.write) {
        return `Error: Memory label "${label}" is immutable (owned by "${provider.name}")`;
      }

      const origin = spec.defaults.origin;
      const trustLevel = context?.peer?.trustLevel ?? "operator";
      if (origin !== "peer-derived") {
        if (trustLevel === "untrusted" || trustLevel === "authenticated") {
          return `Error: Memory label "${label}" requires facility or operator trust to write. Current peer trust: ${trustLevel}.`;
        }
      }

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
      const err = checkBudget(context?.turnId ?? "unknown");
      if (err) return err;

      const candidates = registry.namespaces
        .filter((ns) => !restrictTo || restrictTo.includes(ns.augment.name))
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
      const err = checkBudget(context?.turnId ?? "unknown");
      if (err) return err;

      const staticLabels = Array.from(registry.static.keys());
      const namespaces = registry.namespaces.map((ns) => `${ns.prefix}*`);

      return JSON.stringify({ static: staticLabels, namespaces });
    },
  });

  return {
    tools: [memoryRead, memoryWrite, memorySearch, memoryList],
    cleanupHook,
  };
}
