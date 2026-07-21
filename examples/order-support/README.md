# Secure Order Support

This example demonstrates why an Auggy capability is more than a model tool. A
custom augment owns private order access, visitor identity checks, an expiring
prepare/confirm state machine, turn lifecycle evidence, replay prevention, and
an audit result.

The same order service is exposed to deterministic software and chat:

| Shared capability | Deterministic route | Model-facing tool |
| --- | --- | --- |
| Order lookup | `GET /order-support/orders/:id` | `order_support_get_order` |
| Prepare address change | `POST /order-support/orders/:id/address-change/prepare` | `order_support_prepare_address_change` |
| Confirm address change | `POST /order-support/orders/:id/address-change/confirm` | `order_support_confirm_address_change` |

All routes require a verified visitor token. Tool calls accept only the
runtime-verified creator or a recognized visitor. Chat confirmation has an
additional guarantee: the exact phrase must be the human's current message in a
later turn. A model cannot authorize its own mutation by copying the phrase
from a previous tool result.

The demo order is `A-1042`. State is intentionally in memory and resets when the
process restarts; a production implementation should put orders, pending
changes, and audit records in a transactional store.

## Run

```bash
cd examples/order-support
bun install
cp .env.example .env
auggy doctor
auggy run
```

Local visitor authentication uses the console transport. The verification URL
is printed in the Auggy terminal instead of being emailed.

Generate a browser client for a conventional order-management screen:

```bash
auggy routes --client ts --target browser --out order-support-client.ts
```

## Test

```bash
bun test augments/order-support/order-support.test.ts
```
