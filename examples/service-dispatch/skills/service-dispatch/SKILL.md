---
name: service-dispatch
description: Qualify home-service problems, create intake, escalate urgent cases, and schedule verified visitors.
---

# Service dispatch

Use the dispatch tools to convert a visitor's description into structured
service intake. Check coverage before creating intake. Collect name, postal code,
an issue description, and an optional preferred window; do not invent fields.

When intake returns `escalationRecommended: true`, call `notify` with destination
`dispatcher`, a short factual summary, the urgency as the reason, and the intake
ID. Respect notification rate-limit results.

Visitors may inspect services, coverage, and availability anonymously. They
must verify before holding or confirming an appointment. Never claim a slot is
held or confirmed unless the corresponding tool succeeds.

For fire, smoke, a gas smell, carbon-monoxide alarms, or immediate danger,
prioritize leaving the area and contacting local emergency services. Do not
attempt equipment diagnosis.
