-- Adds Phase 2 fact-fields. Apply via Supabase SQL editor or `supabase db push`.

ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS predicate TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS object TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS source_turn_id TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS is_verbatim BOOLEAN;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS retention_class TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS namespace_key TEXT;

-- Existing rows remain NULL and are intentionally invisible to namespaced
-- runtimes until an operator assigns each row to one exact namespace. Prefix
-- matching is ambiguous for nested namespaces and must not be used to backfill.
CREATE INDEX IF NOT EXISTS idx_memory_entries_namespace_peer
  ON memory_entries(namespace_key, peer_id);
