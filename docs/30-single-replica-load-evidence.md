# Single-Replica Runtime Load Evidence

Auggy includes a bounded load runner for its supported production topology:
one process serving one logical agent.

```sh
bun scripts/load/single-replica-runtime.ts \
  --profile=concierge \
  --seed=20260725 \
  --requests=1000 \
  --threads=64 \
  --max-concurrent=8 \
  --max-queued=1000 \
  --provider-latency-ms=2 \
  --delivery-latency-ms=2 \
  --provider-timeout-ms=1000
```

The runner starts `defineAgent` and drives the real keyed scheduler, turn loop,
stream event path, tool dispatcher, outbound delivery, operational snapshot,
graceful drain, and same-handle restart. It emits one JSON report with bounded
aggregate data. It accepts no credentials, URLs, prompts, customer records, or
provider response bodies.

The same-handle restart probe proves lifecycle re-admission only. It does not
clear custom provider work that ignored cancellation; only settlement or a
process replacement clears that fail-closed circuit.

This is deliberately separate from
[`distributed-coordination.ts`](../scripts/load/distributed-coordination.ts),
which remains labelled `mode: "reference-model"`. The two reports answer
different questions; neither enables replicas.

## Profiles and invariants

`concierge` performs one streamed deterministic inference and one delayed
outbound delivery per turn. `order-support` is an order-support-shaped fixture
that additionally performs a validated tool call and a second inference.
Request and thread assignment are seeded.

Every run checks:

- each submitted turn receives exactly one terminal classification;
- scheduler active and queued peaks do not exceed configured caps;
- two turns from one thread never overlap provider execution;
- one order-support request never produces duplicate tool effects;
- response-delivery and scheduler counters return to zero;
- new work is rejected after drain begins;
- a held active turn completes before shutdown finishes;
- the same agent handle can restart and complete a fresh probe; and
- non-cooperative provider work stays below the kernel's derived detached-work
  bound.

`--cancel-every=N` cancels deterministic queued candidates.
`--stall-every=N` makes selected first inferences ignore cancellation and must
be paired with a provider timeout of at most 30 seconds. The fault run verifies
outcome-unknown quarantine, continued bounded progress, and the detached
provider-attempt circuit. These are test-only faults; the runner never contacts
a model service. If faults fully open that circuit, the runner returns a
controlled report with invariant failures instead of claiming that its held
drain and restart probes succeeded.

Arguments are integer-validated before workload allocation. Runs are capped at
10,000 requests, 1,000 threads, 256 active turns, a 10,000-item queue, and ten
seconds of fixture latency. The JSON includes Bun version, platform,
architecture, logical CPU count, total memory, config, elapsed time, latency
percentiles, scheduler/delivery/provider peaks, memory observations, terminal
runtime counters, and invariant failures. Linux reports `/proc/self/fd` counts;
other platforms report file-descriptor telemetry as unavailable rather than
guessing.

## Recorded 2026-07-25 evidence

These local runs used Bun 1.3.14 on Darwin ARM64 with 12 logical CPUs and 32 GiB
of memory. The model was the runner's deterministic in-process fixture, not a
remote provider. Consequently the observed rate is useful for regression and
queue-shape comparison only.

| Workload | Result | Concurrency / queue | Latency p50 / p95 / p99 | RSS baseline / peak / end | Invariants |
| --- | --- | --- | --- | --- | --- |
| Concierge, 1,000 requests, 64 threads, 2 ms inference + 2 ms delivery | 1,000 completed; 0 failed/canceled/rejected/unknown; 664.171 ms | active 8 / queued 992 | 325.452 / 605.986 / 635.880 ms | 58.8 / 99.1 / 99.1 MB | passed |
| Order support, 1,000 requests, 64 threads, two 2 ms inferences + tool + 2 ms delivery | 1,000 completed; 1,000 unique tool effects; 0 failed/canceled/rejected/unknown; 1,000.048 ms | active 8 / queued 992 | 489.282 / 912.636 / 957.578 ms | 59.0 / 105.8 / 105.8 MB | passed |
| Order-support soak, 10,000 requests, 128 threads, two 1 ms inferences + tool + 1 ms delivery | 10,000 completed; 10,000 unique tool effects; 0 failed/canceled/rejected/unknown; 4,758.353 ms | active 8 / queued 9,992 | 2,360.989 / 4,480.197 / 4,672.546 ms | 63.0 / 225.2 / 225.2 MB | passed |
| Fault run, 128 concierge requests, cancel every 17th queued candidate, stall every 32nd request | 115 completed; 7 canceled; 2 quarantine-rejected; 4 outcome-unknown; 56.152 ms | active 8 / queued 120; provider peak 12, 4 detached | 27.820 / 47.165 / 49.543 ms | 56.0 / 78.8 / 78.8 MB | passed |

All runs rejected a post-drain probe, completed their active drain turn,
reached zero scheduler and delivery work, restarted successfully, reported no
same-thread overlap, and produced an empty `invariantFailures` array. File
descriptor measurements were unavailable on Darwin and are therefore `null`.

The large queued peaks are intentional burst tests, not recommended defaults.
The 10,000-request peak also includes the runner's bounded request promises,
latency samples, and deterministic histories before the function releases
them. It is an upper-bound observation for this exact fixture, not a steady
resident-memory guarantee.

## What this evidence does not prove

The reported turns-per-second number is not a production traffic limit. It
does not include internet latency, a paid provider, real application tools,
TLS, an HTTP load balancer, database contention, or a remote slow reader.
Existing sequential transport suites separately exercise real Bun HTTP/SSE
queue caps, disconnects, concurrent idempotency, and restart replay. A release
candidate should repeat the workload with its actual provider, deployment
machine, tool latencies, and client mix, and retain the JSON report with those
exact parameters.

Multiple replicas serving one logical Auggy remain unsupported. This runner
must not be used as replica, autoscaling, or load-balancer certification.
