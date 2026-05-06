-- Adds Phase 2 fact-fields. Apply via Supabase SQL editor or `supabase db push`.

ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS subject TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS predicate TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS object TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS source_turn_id TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS origin TEXT;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS is_verbatim BOOLEAN;
ALTER TABLE memory_entries ADD COLUMN IF NOT EXISTS retention_class TEXT;
