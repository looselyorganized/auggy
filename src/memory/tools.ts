import { z } from "zod";
import type { Tool, NamespaceMemoryProvider } from "../types";
import { defineTool } from "../helpers";
import { lookupProvider } from "./registry";
import type { MemoryRegistry } from "./types";

const DEFAULT_MAX_MEMORY_OPS_PER_TURN = 20;

export interface MemoryToolBudget {
  calls: number;
  max: number;
}

export interface CreateMemoryToolsOptions {
  maxPerTurn?: number;
  budgetRef?: MemoryToolBudget;
}

export function createMemoryTools(
  registry: MemoryRegistry,
  opts: CreateMemoryToolsOptions = {},
): Tool[] {
  const budget: MemoryToolBudget =
    opts.budgetRef ?? {
      calls: 0,
      max: opts.maxPerTurn ?? DEFAULT_MAX_MEMORY_OPS_PER_TURN,
    };

  const checkBudget = (): string | null => {
    if (budget.calls >= budget.max) {
      return `Error: Memory operation budget exceeded (${budget.max} per turn)`;
    }
    budget.calls++;
    return null;
  };

  const memoryRead = defineTool({
    name: "memory_read",
    description:
      "Read a memory block by label. Call memory_list() to see available labels and namespaces.",
    category: "memory",
    input: z.object({
      label: z.string().describe("The memory label to read (e.g. 'self')"),
    }),
    execute: async ({ label }) => {
      const err = checkBudget();
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
    execute: async ({ label, content }) => {
      const err = checkBudget();
      if (err) return err;

      const provider = lookupProvider(registry, label);
      if (!provider) return `Error: No provider owns label "${label}"`;

      const spec = provider.memory!;
      if (!spec.write) {
        return `Error: Memory label "${label}" is immutable (owned by "${provider.name}")`;
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
    execute: async ({ query, providers: restrictTo }) => {
      const err = checkBudget();
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
    execute: async () => {
      const err = checkBudget();
      if (err) return err;

      const staticLabels = Array.from(registry.static.keys());
      const namespaces = registry.namespaces.map((ns) => `${ns.prefix}*`);

      return JSON.stringify({ static: staticLabels, namespaces });
    },
  });

  return [memoryRead, memoryWrite, memorySearch, memoryList];
}
