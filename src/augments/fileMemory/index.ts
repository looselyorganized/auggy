import { existsSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import type {
  AdminInfoBlock,
  Augment,
  MemoryEntry,
  ContextOrigin,
  ContextPriority,
  ContextPlacement,
  EvictionPolicy,
} from "../../types";

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
 * agent self-notes (mutable: true, origin: "agent").
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

  const augmentName = `file-memory-${opts.label}`;

  const adminInfo = async (): Promise<AdminInfoBlock> => {
    const exists = existsSync(opts.source);
    let bytes = 0;
    let mtimeIso: string | null = null;
    if (exists) {
      try {
        const st = statSync(opts.source);
        bytes = st.size;
        mtimeIso = st.mtime.toISOString();
      } catch {
        // best-effort — fall through with bytes=0
      }
    }
    return {
      augmentName,
      title: `File memory — ${opts.label}`,
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Label", value: opts.label },
            { label: "Source path", value: opts.source },
            { label: "Mutable", value: opts.mutable ? "true" : "false" },
            { label: "Origin", value: opts.origin },
            { label: "Priority", value: opts.priority },
            { label: "Placement", value: opts.placement },
            { label: "Eviction", value: opts.eviction },
            { label: "TTL", value: opts.ttl ?? "persistent" },
            { label: "Cached", value: cache === null ? "no" : `${cache.length} chars` },
            { label: "On disk", value: exists ? `${bytes} bytes` : "(missing)" },
            ...(mtimeIso ? [{ label: "Modified", value: mtimeIso }] : []),
          ],
        },
        {
          kind: "status",
          level: cache !== null ? "ok" : exists ? "warn" : "error",
          message:
            cache !== null
              ? "Loaded from disk."
              : exists
                ? "File found but not yet loaded (onBoot has not run)."
                : `Source file does not exist at ${opts.source}.`,
        },
      ],
    };
  };

  return {
    name: augmentName,
    type: "fileMemory",
    category: "memory",
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
    adminInfo,
  };
}
