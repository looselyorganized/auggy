---
name: example-orders
description: Read the status of a fictional demo order for the agent's creator using example_get_order.
---

# Demo order lookup

Use `example_get_order` with `{ "orderId": "DEMO-1001" }` to read the fictional
order's status. The runtime must identify the caller as this agent's creator.
The tool never creates orders, changes state, or contacts a customer.

The same service backs the creator-authenticated HTTP route
`GET /example/orders/DEMO-1001`. `schemas.ts` defines valid input and output;
`service.ts` owns the lookup; `index.ts` owns tool and route authorization.
Replacing the lookup with a real backend does not transfer ownership of that
backend's records or workflows to the agent.
