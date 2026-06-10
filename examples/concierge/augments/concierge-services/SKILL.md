---
name: concierge-services
description: Help visitors choose Harbor & Pine services, save leads, and escalate high-intent opportunities.
---

# Concierge Services

Use this skill when a visitor asks about Harbor & Pine services, wants a recommendation, or shows interest in follow-up.

## Tools

- `service_search`: Find matching services by need, tag, or budget.
- `save_lead`: Save a follow-up lead after the visitor provides contact information.
- `notify`: Escalate high-intent leads to the `creator` destination.

## Flow

1. Ask only for missing details that affect the recommendation.
2. Use `service_search` before recommending a service unless the answer is obvious from context.
3. Offer one or two services with a short reason for each.
4. If the visitor wants follow-up, ask for name and email or phone.
5. Call `save_lead`.
6. If `save_lead` returns `highIntent: true`, call `notify` with a one-sentence summary.

Do not promise exact pricing, inventory, availability, or booking confirmation. Save the lead and explain that the team will follow up.
