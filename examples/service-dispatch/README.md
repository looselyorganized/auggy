# Field-Service Intake And Dispatch

This example shows an operational Auggy that turns an unstructured customer
problem into structured intake, operator escalation, and a deterministic
appointment.

## What it proves

- A form and the agent create the same intake records.
- Public visitors can inspect services, coverage, and availability cheaply.
- Appointment holds and confirmation require runtime-verified visitor identity.
- Urgent intake returns an explicit escalation signal; the agent uses `notify`
  to alert the configured dispatcher destination.
- `budgets` caps anonymous and recognized chat usage before model execution.
- Notify delivery has its own trust policy, cooldown, deduplication, and audit
  file rather than being embedded in the business tool.

| Shared capability | Deterministic route | Model-facing tool |
| --- | --- | --- |
| Service catalog | `GET /dispatch/services` | `dispatch_list_services` |
| Coverage | `GET /dispatch/coverage` | `dispatch_check_coverage` |
| Intake | `POST /dispatch/intakes` | `dispatch_create_intake` |
| Availability | `GET /dispatch/availability` | `dispatch_find_slots` |
| Appointment hold | `POST /dispatch/appointments/hold` | `dispatch_hold_appointment` |
| Confirmation | `POST /dispatch/appointments/:id/confirm` | `dispatch_confirm_appointment` |

State is intentionally in memory. Production scheduling requires a durable,
transactional calendar or dispatch system and idempotent provider operations.

## Run

```bash
cd examples/service-dispatch
bun install
cp .env.example .env
auggy doctor
auggy run
```

VisitorAuth and notifications both use local development adapters: magic links
print to the terminal and dispatch notifications append to
`data/dispatch-notifications.jsonl`.

## Test

```bash
bun test augments/service-dispatch/service-dispatch.test.ts
```
