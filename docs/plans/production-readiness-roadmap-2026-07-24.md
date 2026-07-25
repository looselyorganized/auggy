# Production Readiness Roadmap

**Date:** 2026-07-24
**Status:** recorded follow-on work
**Precondition:** distributed coordination groups 1–4

Auggy has no production users to migrate today, which makes this the least
expensive point to establish explicit contracts. These seven workstreams are
the next sequence after distributed coordination. Each uses the same
revalidate, delegate, test-first, slice, hostile-review, verify, and PR loop.

## 1. Tenant cell and isolation contract

Define one logical agent/tenant cell across database roles and schemas, object
storage prefixes, encryption keys, credentials, egress identity, queues, audit
streams, admin authority, and quotas. Ensure request data cannot select a
namespace. Add cross-tenant negative and confused-deputy tests.

**Done when:** the isolation matrix is executable, all owned stores require a
namespace, cross-cell operations fail closed, and a compromised agent cell
cannot read or spend another cell's resources.

## 2. Observability, SLOs, and capacity signals

Add bounded metrics and traces for admission, queue wait, model/tool latency,
outbox lag, lease health, unknown outcomes, quarantine, recovery, provider
errors, and cost. Define concierge and order-support availability and latency
SLOs with burn alerts. Prove prompt, peer, credential, and tool-argument
redaction.

**Done when:** operators can distinguish overload, provider failure,
coordination loss, stuck delivery, and an application bug without inspecting
customer content.

## 3. Durable delivery and human recovery

Complete transactional outbox delivery for web, Telegram, AgentMail, link, and
notification paths. Add stable recipient operation IDs, retries with bounded
backoff, dead-letter state, reconciliation, and operator workflows for
outcome-unknown effects.

**Done when:** crash tests prove committed replies are not lost, recipients do
not receive duplicates where they support idempotency, and every ambiguous
effect has an auditable recovery path.

## 4. Data lifecycle, backup, and disaster recovery

Define retention, export, deletion, legal hold, encryption/key rotation,
backups, point-in-time recovery, regional failure, and restore consistency
across coordinator, history, memory, outbox, and provider artifacts.

**Done when:** timed restore drills meet declared RPO/RTO, deleted tenant data
does not survive outside documented backup windows, and recovery cannot replay
completed effects.

## 5. Provider resilience and routing policy

Add per-provider circuit breakers, bounded retries, jittered backoff, timeout
budgets, health-aware routing, spend-aware degradation, and explicit
idempotency classifications. Keep credentials and policy decisions
server-side.

**Done when:** failure injection proves a provider brownout cannot exhaust all
worker capacity, amplify spend, bypass allowlists, or silently retry
non-idempotent operations.

## 6. Real workload and chaos certification

Turn the initial load harness into repeatable release certification across
machine sizes and deployment platforms. Include burst, soak, reconnect,
rolling deploy, database failover, provider stall, slow consumer, and
multi-tenant noisy-neighbor profiles.

**Done when:** each supported topology publishes a measured capacity envelope
and passes zero-duplicate, isolation, bounded-memory, drain, recovery, and SLO
criteria.

## 7. Versioned public contracts and upgrades

Stabilize configuration, storage, coordinator, effect-idempotency, health, and
operator APIs as versioned v1 contracts. Add compatibility fixtures,
deprecation policy, schema/tooling version checks, upgrade rehearsals, and
rollback documentation.

**Done when:** the previous compatible release can participate in a rolling
upgrade, incompatible binaries fail before traffic, and every persisted
format has a tested migration and rollback policy.

## Recommended order

1. Tenant cell and isolation contract.
2. Observability and SLOs.
3. Durable delivery and recovery.
4. Data lifecycle and disaster recovery.
5. Provider resilience.
6. Workload and chaos certification.
7. Versioned v1 contracts and upgrade policy.

The workstreams can overlap in research, but their implementation order is
intentional: isolation and observability are prerequisites for safely
operating delivery, recovery, and resilience at multi-tenant scale.
