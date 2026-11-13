# Milestone 3 contract freeze

M3-00 freezes the implementation contracts against accepted main
`209185d0e7481b4ff5d3b4c87e3447e7583b2fef`. This packet defines the interfaces;
it does not claim that the managed runtime or reference application is implemented.
The [task ledger](../milestone-3-tasks.json) records acceptance and producer commits.

The authoritative TypeScript declarations are in `src/types.ts`, re-exported by
`src/index.ts`. `tests/fixtures/application-contract.ts` compiles a complete
turn/composition/HTTP/startup recipe against those public root exports and checks
invalid authority construction and mutation with expected type errors. These
checks do not prove runtime ownership enforcement. The `auggy/application`
runtime entry and installed-package type checks belong to subsequent tasks.

Read the bounded ownership maps before implementation:

- [Turn state](./turn-state-map.md): all terminal paths, receipt phases,
  accounting/history precedence, internal/causal work, and regression coverage.
- [Host and HTTP](./host-http-map.md): resource acquisition, readiness, guarded
  request/listener ownership, rollback, actual cleanup settlement and tests.
- [Launch parity](./launch-parity-map.md): declaration/capability metadata,
  explicit local runtime selection, recovery, deployment and installed assertions.

The final naming decisions are `ApplicationRunner` and
`ApplicationDirectLaunchOptions` in shared types, implemented later by the
`runApplication` function. `TurnProgramBinding` lives with the visible loop in the
reference's `src/turn.ts`, including its editable hard inference ceiling.
Application configuration enables augments once, in YAML. No application receives
a raw model, tool callback, transport kernel, trusted peer or admission lease.

Private producer seams are also frozen:

- `src/kernel/turn-contract.ts` defines `KernelTurnSummary` and the discriminated
  `KernelTurnSettlement`. The runtime owner adds `executeTurnSettled` to the
  turn-loop facade and preserves `executeTurn` as its unwrap adapter. A thrown
  `undefined` remains an error; use the discriminant. The agent combines this
  envelope with history settlement before bounded observation. Terminal success
  is buffered through that boundary; existing HTTP transport buffering remains.
- `src/application/hosted-agent.ts` defines `HostedAgentSnapshot` and
  `HostedAgentInstance`. The host owner integrates private `createHostedAgent`
  through the same constructor as public `defineAgent`, after the runtime owner
  returns `src/agent.ts`. Only package code opens/closes admission and observes
  quiescence. Snapshot data never supplies authority to release ownership.

Fixed policies: opt-in turn program deadline defaults to and cannot exceed
900,000 ms; legacy timing remains unchanged. Finalization observation runs once
per valid scheduling attempt, with a 1,000 ms timeout and immutable sanitized
metadata. `undefined` history commit results preserve the existing durable
contract; explicit valid dispositions distinguish committed and transport-staged
history. Invalid dispositions fail closed. Later transport commits and post-turn
hooks cannot be certified by an earlier observation.

Runner shutdown observes cleanup for 15,000 ms. Confirmed clean cleanup can exit
0; startup error, cleanup failure or retained ownership exits 1. Forced process
termination does not manually erase retained claims or quarantine. Programmatic
host stop defaults to 15,000 ms, permits a positive safe integer up to 900,000 ms,
and joins one cleanup task; a caller deadline never proves quiescence.

The runtime floor is Bun 1.3.14 across the tested package family and generated
deployment image. Metadata compares application contract capabilities, not npm
version equality. Deployment must not substitute a nearby same-version tarball;
explicit reviewed file dependencies remain supported. HTTP WebSockets are not
part of the current web transport and are not introduced here.

The CTO remains the sole manifest/lock/export writer. M3-01 temporarily owns
`src/agent.ts` for turn invocation and observation; M3-02 may change it only after
an explicit handoff. The host owner supplies the `dev.ts` extraction for serial
integration, followed by M3-03 launch wiring. Harness preparation may proceed
against these contracts, but real acceptance waits for the integrated reference.

All producer implementations must preserve the existing regression suites and
add the missing behavioral cases identified by their map. No phase is accepted
solely because a mock or these declarations compile. Contract changes pause
affected consumers and require coordinated fixture/map updates before resuming.
