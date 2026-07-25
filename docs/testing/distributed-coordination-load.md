# Synthetic distributed-coordination load harness

`scripts/load/distributed-coordination.ts` is a deterministic, secret-free workload model for the distributed-coordination work. It is intentionally a small reference model, so it can make admission, queueing, idempotency, namespace, and fencing invariants visible before a real Postgres coordinator is wired into runtime tests.

Run either workload with bounded input:

```sh
bun scripts/load/distributed-coordination.ts --profile=concierge --seed=20260724 --replicas=3 --requests=240
bun scripts/load/distributed-coordination.ts --profile=order-support --seed=20260724 --replicas=3 --requests=240
```

The JSON result is explicitly labelled `mode: "reference-model"`. It assigns each synthetic request to a logical replica and contains only bounded aggregate metrics: the requested replica count and assignments, throughput, active and queued peaks, p50/p95/p99 queue wait, rejections, unavailable and outcome-unknown counts, duplicate mutations, same-thread overlap, stale-fence accepts/rejects, and namespace violations/rejects. It never accepts provider credentials or production traffic data.

The `concierge` profile represents bursty visitor sessions with read and escalation work. The `order-support` profile represents authenticated lookups plus idempotent mutations and duplicate delivery. The deterministic seed means a failed assertion can be replayed exactly.

The model actively sends one stale-fence and one cross-namespace read probe through its reference seams. Its test-only fault settings can deliberately break those seams or simulate unavailable/unknown outcomes; a nonzero result must fail the default threshold evaluation. This makes the output a model check, not evidence that production storage or a networked coordinator rejected the same operation.

This is **not** a replica-safety certification. It deliberately models the expected invariants in-process. Certification requires the same profiles to run against the real Postgres coordinator with independent worker processes, explicit READY/GO barriers, crash points, and a service-backed CI job. Until then, deployments that require multiple replicas must remain explicitly unsupported.
