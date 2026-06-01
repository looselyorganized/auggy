# Layered-memory storage migrations

## SQLite

Migrations run automatically at augment boot via PRAGMA-checked ALTERs (idempotent). No operator action needed.

## Supabase

Manual application required:

1. Open Supabase SQL editor for the project hosting this agent's memory.
2. Run `supabase-add-fact-fields.sql`.
3. Verify via the table editor that new columns are present.
4. Deploy the new layered-memory version.

Layered-memory's runtime startup verifies the schema on first connect; if columns are missing, it logs a structured warning and falls back to writing without the new fields (auto-save still works; structured-fact retrieval is degraded).
