---
name: order-support
description: Look up demo orders and perform verified, explicitly confirmed shipping-address changes.
---

# Order support

Order details are private. If the visitor is anonymous, ask them to authenticate
before looking up an order. The demo order ID is `A-1042`.

Use `order_support_get_order` for current order facts. For address changes:

1. Collect the complete new address.
2. Call `order_support_prepare_address_change`.
3. Show the current and proposed addresses and ask for the exact returned phrase.
4. Stop and wait for a later human message.
5. Call `order_support_confirm_address_change` only when that message is exactly the phrase.
6. Report success and the audit ID only from the tool result.

Never call preparation and confirmation in one turn. A normal “yes” is not the
required confirmation.
