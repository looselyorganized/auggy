# example

Sample read-only lookup logic created by `auggy augment create example` and
registered once in `agent.yaml`. The deterministic in-memory fixture is not a
production database, durable workflow, or system of record.

- `schemas.ts` owns validation shared by the tool and route.
- `service.ts` owns the read-only lookup. Replace it with a narrow system-of-record adapter.
- `index.ts` exposes `example_lookup_record` and `GET /example/records/:id`.
- `tests/augments/example.test.ts` checks validation, lookup, missing records, and tool denial.

The sample ID is SAMPLE-001. The route requires creator authentication through the
managed HTTP transport, returns 400 for invalid IDs and 404 for missing records.
The tool has creator-only exposure constraints and an execution-time identity check.
Route authentication and tool authorization remain separate decisions. Do not relax
either without an explicit policy for the intended callers.

Run `bun test tests/augments/example.test.ts` from the project root. HTTP authentication
must also be tested through the running managed transport; calling a route handler
directly does not authenticate a request.
