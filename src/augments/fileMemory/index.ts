import { closeSync, lstatSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname } from "node:path";
import {
  createPinnedFile,
  inspectPinnedFile,
  pinDirectory,
  readPinnedFile,
  replacePinnedFile,
  type PinnedDirectory,
} from "../../lib/anchored-files";
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
  /** Optional immutable seed copied once when the durable source is absent. */
  seedSource?: string;
  mutable: boolean;
  /** Optional peer trust write allowlist. Omit to use the origin-based policy. */
  writeTrustLevels?: readonly TrustLevel[];
  origin: ContextOrigin;
  priority: ContextPriority;
  placement: ContextPlacement;
  eviction: EvictionPolicy;
  ttl?: "turn" | "session" | "persistent";
  /** @internal Deterministic persistence barriers for regression tests. */
  __testHooks?: {
    beforeReplace?: (content: string) => void | Promise<void>;
    beforeRename?: (content: string) => void;
  };
}

const MAX_FILE_MEMORY_BYTES = 128 * 1024 * 1024;

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
  let pinnedParent: PinnedDirectory | null = null;
  const leaf = basename(opts.source);
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
          const parent = pinnedParent;
          if (!parent) throw new Error("fileMemory: durable source is not admitted");
          await opts.__testHooks?.beforeReplace?.(content);
          replacePinnedFile(parent.fd, leaf, content, "fileMemory", {
            beforeRename: () => opts.__testHooks?.beforeRename?.(content),
          });
          cache = content;
        });
        writeQueue = queuedWrite.catch(() => undefined);
        await queuedWrite;
      }
    : undefined;

  const augmentName = `file-memory-${opts.label}`;

  const adminInfo = async (): Promise<AdminInfoBlock> => {
    let exists = false;
    let bytes = 0;
    let mtimeIso: string | null = null;
    if (pinnedParent) {
      try {
        const opened = inspectPinnedFile(pinnedParent.fd, leaf, "fileMemory");
        if (opened) {
          exists = true;
          bytes = opened.stat.size;
          mtimeIso = opened.stat.mtime.toISOString();
          closeSync(opened.fd);
        }
      } catch {
        // best-effort — fall through with bytes=0
      }
    } else {
      const stat = lstatSync(activeSource, { throwIfNoEntry: false });
      exists = Boolean(stat?.isFile() && !stat.isSymbolicLink());
      if (exists && stat) {
        bytes = stat.size;
        mtimeIso = stat.mtime.toISOString();
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
                : `Source file does not exist at ${activeSource}.`,
        },
      ],
    };
  };

  return {
    name: augmentName,
    type: "fileMemory",
    category: "memory",
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
      pinnedParent = pinDirectory(dirname(opts.source), "fileMemory parent", {
        create: Boolean(opts.seedSource),
      });
      try {
        if (opts.seedSource) {
          const existing = inspectPinnedFile(pinnedParent.fd, leaf, "fileMemory");
          if (existing) {
            closeSync(existing.fd);
          } else {
            const seed = await readFile(opts.seedSource, "utf-8");
            createPinnedFile(pinnedParent.fd, leaf, seed, "fileMemory seed");
          }
        }
        cache = readPinnedFile(
          pinnedParent.fd,
          leaf,
          "fileMemory",
          MAX_FILE_MEMORY_BYTES,
          opts.mutable,
        ).toString("utf8");
        activeSource = opts.source;
      } catch (error) {
        closeSync(pinnedParent.fd);
        pinnedParent = null;
        throw error;
      }
    },
    adminInfo,
    onShutdown: async () => {
      await writeQueue;
      if (pinnedParent) closeSync(pinnedParent.fd);
      pinnedParent = null;
    },
  };
}
