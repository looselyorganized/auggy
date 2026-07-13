import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import type {
  AdminInfoBlock,
  Augment,
  MemoryEntry,
  ContextOrigin,
  ContextPriority,
  ContextPlacement,
  EvictionPolicy,
  TrustLevel,
} from "../../types";

export interface FileMemoryOptions {
  label: string;
  source: string;
  fallbackSources?: string[];
  mutable: boolean;
  /** Optional peer trust write allowlist. Omit to use the origin-based policy. */
  writeTrustLevels?: readonly TrustLevel[];
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
 * Used for identity (immutable operator guidance) and for creator-approved
 * learned behavior (mutable operator guidance with a write trust allowlist).
 */
export function fileMemory(opts: FileMemoryOptions): Augment {
  let cache: string | null = null;
  let activeSource = opts.source;
  let activeWriteTarget = opts.source;
  let writeQueue: Promise<void> = Promise.resolve();

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

        const queuedWrite = writeQueue.then(async () => {
          const targetStat = await stat(activeWriteTarget);
          const tempSource = `${activeWriteTarget}.auggy-${process.pid}-${randomUUID()}.tmp`;
          try {
            await writeFile(tempSource, content, {
              encoding: "utf-8",
              mode: targetStat.mode,
            });
            await rename(tempSource, activeWriteTarget);
            cache = content;
          } finally {
            await rm(tempSource, { force: true });
          }
        });
        writeQueue = queuedWrite.catch(() => undefined);
        await queuedWrite;
      }
    : undefined;

  const augmentName = `file-memory-${opts.label}`;

  const adminInfo = async (): Promise<AdminInfoBlock> => {
    const exists = existsSync(activeSource);
    let bytes = 0;
    let mtimeIso: string | null = null;
    if (exists) {
      try {
        const st = statSync(activeSource);
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
            ...(opts.fallbackSources?.length
              ? [{ label: "Fallback source paths", value: opts.fallbackSources.join(", ") }]
              : []),
            ...(activeSource !== opts.source
              ? [{ label: "Active source path", value: activeSource }]
              : []),
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
                : `Source file does not exist at ${activeSource}.`,
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
      writeTrustLevels: opts.writeTrustLevels,
      read,
      write,
    },
    onBoot: async () => {
      let lastError: unknown;
      for (const source of [opts.source, ...(opts.fallbackSources ?? [])]) {
        try {
          cache = await readFile(source, "utf-8");
          activeSource = source;
          activeWriteTarget = await realpath(source);
          return;
        } catch (err) {
          lastError = err;
        }
      }
      throw lastError;
    },
    adminInfo,
  };
}
