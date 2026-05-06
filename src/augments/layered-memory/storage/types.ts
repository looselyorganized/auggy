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

export interface MemoryStore {
  initialize(): Promise<void>;
  write(entry: Omit<StoreEntry, "id"> & { id?: string }): Promise<StoreEntry>;
  search(query: string, peerId?: string, limit?: number): Promise<StoreEntry[]>;
  read(label: string): Promise<StoreEntry | null>;
  list(peerId?: string): Promise<string[]>;
  forget(peerId: string): Promise<number>;
  supersede(entryId: string, newEntryId: string): Promise<void>;
  cleanup(): Promise<number>;
  close(): Promise<void>;
}

export interface SqliteStoreConfig {
  dbPath: string;
  retentionDays: number;
}

export interface SupabaseStoreConfig {
  client: SupabaseLikeClient;
  table: string;
  retentionDays: number;
}
