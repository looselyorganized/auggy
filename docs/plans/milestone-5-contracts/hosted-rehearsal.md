# M5 G4 — isolated Railway rehearsal

Status: hosted acceptance remains open. Historical attempts and their cleanup
outcomes are recorded in `../milestone-5-evidence-2026-11-13.md`; authorization
for a consumed attempt does not authorize replaying its mutation journal.
This record amends the internal C4 preparation contract; it is not a product API
or a claim that M5 is complete.

## Focused validation and preflight

Use the existing TypeScript executor, Railway adapter and bounded child helper.
The one-off Python startup runner is retired; retain its original evidence only.
Do not add a second HTTP stack to repeat the managed CLI's health request.
Require the CLI's reported HTTP readiness, not merely exit zero or platform
SUCCESS. The worker profile must report HTTP as not applicable. Channel and
business effects still require their own observations.

Before allocation, run the installed CLI's passive `export docker` for each
managed artifact, with the selected ingress, port and health path. This validates
archive format, local dependency containment and profile compatibility without
Railway credentials. The shared `preflightHostedExport` helper removes its scratch
directory on success and failure. The existing executor invokes this in `--check`
and before execution; cleanup is independent of this preflight.

Choose required checks before starting. A startup regression needs its focused
local tests and packaged/hosted startup proof; it does not require replaying the
full four-service experiment. The full HTTP, polling, replacement and recovery
requirements below remain mandatory for M5 acceptance. Preparation, product
execution and resource cleanup have separate outcomes. Capture startup logs
before teardown, stop after the selected assertions pass, and expand only for a
changed boundary or observed failure. Preserve resource ownership, deadlines,
secret redaction and verified cleanup in every scope.

## Allocation and approval

Use one new private project in the explicitly selected workspace, with one
`rehearsal` environment. Never select an existing application project. The
approval identifies the absent project name and the allocation action; subsequent
operations bind the returned project/environment IDs and verify their parents.
Names alone never authorize operating on an existing resource.

The finite experiment uses four distinct services: HTTP, polling, HTTP recovery
and polling recovery. Each owns its corresponding original or restored volume.
Execute the workload phases sequentially. Separate recovery services keep channel
settings, credentials and deployment records isolated throughout recovery.
This replaces the initial three-service preparation proposal before any approval
or allocation. Current account metadata gives
each new volume a default capacity of 50000 provider MB; ordinary volume creation
does not expose a size parameter. Do not substitute the earlier 5 GiB assumption
or add an unverified resize operation. Record exact capacity, used storage,
attachment, readiness and deletion state independently.

Before workload launch, set and verify one replica, restart policy `NEVER`, sleep
disabled, and proposed caps of 4 vCPU and 4000000000 memory bytes per service.
Read-only discovery establishes the API surface, not acceptance or enforcement
of these settings. A refused setter, wider readback or unknown binding stops the
experiment and enters cleanup; it never widens the approved limits.

The current execution budget is one hour plus ten minutes reserved for cleanup.
The $5 cost target uses project-scoped usage monitoring. It is **not a provider
hard spending cap**; usage reporting can lag. Do not change workspace billing
controls, which affect unrelated applications. Creation rate limits and all
polling policies belong in the frozen executor and recorded action claims.

## Volume readiness and cleanup ownership

After a confirmed volume creation, allow 180 seconds for attachment, clipped to
the existing execution and approval deadlines. Observe immediately, then wait
five seconds after each completed observation. Request execution and process
reaping must fit the remaining budget. Progress never resets the deadline, and
provisioning must not consume the cleanup reserve or extend workload watchdogs.

Only the recognized absent-instance and owned unattached-instance states are
pending. Workload admission still requires the strict attachment binder and
pending-instance identity continuity. Invalid ownership or ambiguous inventory
fails immediately. Retain bounded sanitized readbacks and distinguish attachment
timeout from budget exhaustion and invalid readback; never recreate a volume
because readiness timed out.

Cleanup derives ownership from hash-verified successful creation receipts,
including resources whose readiness binding never succeeded. Before deletion,
retain a complete fresh inventory and verify exact project, volume, environment
and expected-service-or-unattached identity. Readiness, mount and usage failures
alone must not prevent removal of a proven-owned resource. Foreign or ambiguous
attachments cannot be bypassed through parent service/project deletion.

An exact absent resource may be skipped only after complete inventory validation.
Unknown creation outcomes are not adopted or replayed. Individual cleanup
failures remain failures even when later parent deletion establishes absence.
These are internal release-harness contracts, not public agent runtime APIs.

## Source, transport and fixture boundaries

The final approval binds exact source revision/tree, package and lock inventories,
export/context files, Dockerfile, entrypoint, fixture overlays, pinned base image,
accepted local/container evidence, action manifest and executor source closure.
Baseline, owned-source edit and maintenance variants are separate artifacts.
For a source build, the deployment ID and final OCI digest are observed outputs;
do not invent a final image digest or separate build ID before uploading.

The HTTP and Telegram fixtures use private service-loopback endpoints, synthetic
identities and synthetic effects. No live Telegram, identity provider or paid
model is included. Generated application startup and actual installed runtime,
provider, transport and domain adapter paths remain the execution path.

Remote control uses one newly generated workspace SSH key. Railway does not offer
project-scoped keys or an expiry for this interface. The final approval must state
that broader scope and the exact public fingerprint; the private key stays in an
owned local directory and never enters source, uploads or evidence.

Relay host trust is an explicitly approved first-use pin. Read-only preparation
did not establish an independently authenticated provider key. Bind the exact
observed fingerprint and owned `known_hosts` bytes, require strict host checking,
and refuse any changed key. Disable ambient SSH config, agents, forwarding,
proxies and connection sharing. Independently rebind the deployment, image and
singleton instance before every authenticated connection.

The remote envelope accepts only a finite registry of reviewed bundled commands.
It owns a separate deadline and process group, binds a complete input
acknowledgment, and persists an exclusive claim and committed receipt. A local
SSH exit is not proof of remote completion. A claim without a receipt is unknown,
never permission to execute the same request again. Reading a stored failed
receipt successfully does not turn that receipt into a successful operation.

Actual registered commands must fit inside the existing 60-second transport
ceiling, including connection, input, command, reap and output allowances. Provider
readbacks have their own bounded supervisor. All phase budgets share an immutable
journal-owned start time; a new helper invocation cannot restart the clock.

## Required observations

1. Deploy both profiles through the actual managed path. Verify the HTTP domain
   and the worker's absence of public ingress, then perform real channel/tool
   operations against the private fixtures.
2. Finish and seal each generation before recording its result. The sealed
   journal must account for every admitted request, provider generation and
   domain effect. Later work, omitted generations, rejected activity or uncertain
   listener/process cleanup fail acceptance.
3. Replace each agent on its original volume, demonstrate replay without a
   duplicate effect, and observe the approved owned-source edit. A mismatched
   source marker must fail the observer.
4. Stop the runtime before backup and maintenance. Verify an actual public CLI
   backup, restore into a new volume, and exercise the restore hold and explicit
   reconciliation. For HTTP, restore an older Auggy backup while retaining the
   newer downstream fixture checkpoint. Never automatically resend an operation
   whose outcome is missing from the older runtime state.
5. Export final immutable evidence, stop and remove every owned resource, remove
   the exact newly registered key, and independently verify absence. CLI project
   deletion schedules a grace period; use the explicitly approved immediate
   project deletion API for this ephemeral project. A boolean deletion response
   alone is insufficient proof of teardown.

The HTTP fixture checkpoint is a bounded logical copy of synthetic downstream
state held independently of the Auggy volume. It is not a production database
backup protocol or a hard-crash durability guarantee for an external service.
The restore proof must preserve newer effects and the runtime replay guard across
reconciliation and restart, while allowing a new authorized effect after the hold.

The hosted HTTP fixture uses a separately inventoried 180-second assertion TTL
and the existing 30-second clock-skew allowance. The accepted local 20-second TTL
proof remains a distinct artifact. This gives the real hosted deployment time to
reach the restored service before its hold expires; missing the actual 503 still
fails the observation. Stop the held generation before its 110-second watchdog,
then wait with no active workload against the recorded restore epoch. The finite
manifest permits at most 240 seconds for that controller-only wait, using sleep
increments no larger than 30 seconds and rechecking the immutable overall budget.
No managed CLI, SSH, remote command, or runtime lifetime limit is increased.

## Evidence and completion

Every attempted mutation receives an exclusive, fsynced action claim and outcome,
including unknown outcomes. Resolve uncertainty with bounded owner-specific
readback; never blindly repeat resource creation. Cleanup uses only recorded
owned IDs, runs on failure as well as success, and records incomplete deletion
honestly. Retain sanitized private evidence for at most seven days, with no hosted
resource retention.

Producer results require independent acceptance. The accepted `83dca71` package
and CI results remain their own evidence scope; later source overlays do not
retroactively become part of that certification. Hosted acceptance and final
candidate CI are still required before closing M5. Merge, version changes and npm
publication remain separate decisions.
