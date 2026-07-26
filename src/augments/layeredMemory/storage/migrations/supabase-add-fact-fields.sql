-- Adds exact namespace ownership and Phase 2 fact fields to the CLI default
-- layeredMemory Supabase table. If agent.yaml sets another table name, replace
-- every `agent_memory` identifier below before applying this migration.

ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS predicate TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS object TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS source_turn_id TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS is_verbatim BOOLEAN;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS retention_class TEXT;
ALTER TABLE agent_memory ADD COLUMN IF NOT EXISTS namespace_key TEXT;

-- Existing rows remain NULL and are intentionally invisible to namespaced
-- runtimes until an operator assigns each row to one exact namespace. Prefix
-- matching is ambiguous for nested namespaces and must not be used to backfill.
CREATE INDEX IF NOT EXISTS idx_agent_memory_namespace_peer
  ON agent_memory(namespace_key, peer_id);
