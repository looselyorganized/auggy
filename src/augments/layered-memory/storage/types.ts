import type { MemoryOrigin, TrustLevel } from "../../../types";
import type { SupabaseLikeClient } from "../../supabase-memory";

export type RetentionClass = "operational" | "lesson";

/**
 * Re-export of the canonical MemoryOrigin from `src/types.ts`. The storage
 * layer's `origin` column matches the runtime MemoryEntry contract one-for-one;
 * having a single canonical type prevents drift.
 */
export type OriginValue = MemoryOrigin;

export interface StoreEntry {
  id: string;
  label: string;
  content: string;
  peerId: string | null;
  trustLevel: TrustLevel | null;
  createdAt: number;
  supersededBy: string | null;
  retentionClass: RetentionClass;
  isVerbatim: boolean;
  expiresAt: number | null;
  // Phase 2 — structured-fact + provenance fields (all optional; nullable in storage)
  subject?: string;
  predicate?: string;
  object?: string;
  sourceTurnId?: string;
  origin?: OriginValue;
}

/**
 * Arguments for the internal `writeAutoSavedEntry` path used by
 * layered-memory's extractor (Phase 2 of ADR-018, Decision 4 of the
 * memorist design). Distinct from the model-callable `memory_write`
 * tool: carries structured-fact + provenance fields the tool's input
 * schema doesn't expose, and `origin` is hardcoded to `"agent-derived"`
 * inside the implementation — there is no `origin` argument here, so
 * extraction prompts cannot forge `operator` or `peer-derived`.
 *
 * Namespace-prefix enforcement: implementations must reject any `label`
 * that doesn't start with the store's configured namespace. This
 * mirrors the discipline applied by the model-facing memory tools.
 */
export interface WriteAutoSavedArgs {
  peerId: string;
  label: string;
  content: string;
  subject?: string;
  predicate?: string;
  object?: string;
  confidence: number;
  retentionClass: RetentionClass;
  isVerbatim: boolean;
  sourceTurnId: string;
  model: string;
}

export interface MemoryStore {
  initialize(): Promise<void>;
  write(entry: Omit<StoreEntry, "id"> & { id?: string }): Promise<StoreEntry>;
  /**
   * Internal-to-layered-memory write path for the extractor (Phase 2).
   * Implementations enforce namespace-prefix discipline and hardcode
   * `origin: "agent-derived"`. Not exposed on any augment-public surface.
   */
  writeAutoSavedEntry(args: WriteAutoSavedArgs): Promise<void>;
  search(query: string, peerId?: string, limit?: number): Promise<StoreEntry[]>;
  read(label: string): Promise<StoreEntry | null>;
  list(peerId?: string): Promise<string[]>;
  forget(peerId: string): Promise<number>;
  supersede(entryId: string, newEntryId: string): Promise<void>;
  cleanup(): Promise<number>;
  /**
   * G36 — read-only views for /admin.
   * `listEntriesByPeer` returns most-recent entries (peer-scoped if peerId provided).
   * `countByRetentionClass` returns retention-class breakdown across live entries.
   */
  listEntriesByPeer(opts?: { peerId?: string; limit?: number }): Promise<StoreEntry[]>;
  countByRetentionClass(): Promise<{ operational: number; lesson: number; total: number }>;
  close(): Promise<void>;
}

export interface SqliteStoreConfig {
  dbPath: string;
  retentionDays: number;
  /**
   * Namespace prefix the store enforces on `writeAutoSavedEntry`. When
   * absent, the auto-save path throws — namespace-prefix discipline is
   * a hard requirement for the extractor write path. The augment factory
   * (`layered-memory/index.ts`) wires this through.
   */
  namespace?: string;
}

export interface SupabaseStoreConfig {
  client: SupabaseLikeClient;
  table: string;
  retentionDays: number;
  /**
   * Namespace prefix the store enforces on `writeAutoSavedEntry`. See
   * `SqliteStoreConfig.namespace`.
   */
  namespace?: string;
}
