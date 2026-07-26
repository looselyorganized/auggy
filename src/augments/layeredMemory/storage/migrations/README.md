# Layered-memory storage migrations

## SQLite

Migrations run automatically at augment boot via PRAGMA-checked ALTERs (idempotent). No operator action needed.

## Supabase

Manual application required:

1. Open Supabase SQL editor for the project hosting this agent's memory.
2. Confirm the configured table name. The CLI default is `agent_memory`; edit
   every identifier in `supabase-add-fact-fields.sql` if your config uses a
   different table.
3. Back up the table and run the edited SQL.
4. Verify via the table editor that the columns and exact-owner index exist.
5. Assign `namespace_key` only through an authoritative offline mapping.
6. Deploy the new layered-memory version.

The Supabase backend does not migrate or preflight the remote schema at boot.
Missing columns fail closed when the first affected query runs; there is no
legacy fallback. Existing rows with a null `namespace_key` are intentionally
invisible. Verify the migration before accepting traffic.
