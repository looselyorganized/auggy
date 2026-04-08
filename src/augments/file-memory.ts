import { readFile, writeFile } from "node:fs/promises";
import type {
  Augment,
  MemoryEntry,
  ContextOrigin,
  ContextPriority,
  ContextPlacement,
  EvictionPolicy,
} from "../types";

export interface FileMemoryOptions {
  label: string;
  source: string;
  mutable: boolean;
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  ttl?: "turn" | "session" | "persistent";
}

/**
 * File-backed memory provider. Loads a file at boot into memory,
 * serves read requests from the cache, and (if mutable) persists
 * writes both in-memory and to disk.
 *
 * Used for identity (mutable: false, origin: "operator") and for
 * agent self-notes (mutable: true, origin: "system").
 */
export function fileMemory(opts: FileMemoryOptions): Augment {
  let cache: string | null = null;

  const read = async (label: string): Promise<MemoryEntry | null> => {
    if (label !== opts.label) return null;
    if (cache === null) return null;
    return { label: opts.label, content: cache };
  };

  const write = opts.mutable
    ? async (label: string, content: string): Promise<void> => {
        if (label !== opts.label) {
          throw new Error(
            `fileMemory: label "${label}" does not match declared label "${opts.label}"`,
          );
        }
        cache = content;
        await writeFile(opts.source, content, "utf-8");
      }
    : undefined;

  return {
    name: `file-memory-${opts.label}`,
    capabilities: ["context", "tools"],
    memory: {
      owns: { kind: "static", labels: [opts.label] },
      defaults: {
        mutable: opts.mutable,
        origin: opts.origin,
        priority: opts.priority,
        placement: opts.placement,
        eviction: opts.eviction,
        ttl: opts.ttl ?? "persistent",
      },
      read,
      write,
    },
    onBoot: async () => {
      cache = await readFile(opts.source, "utf-8");
    },
  };
}
