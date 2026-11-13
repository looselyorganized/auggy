# Inspectable agent application ownership

Status: Accepted, 2026-11-12. Implementation pending the milestone gates.

## Decision

A generated Auggy agent is an executable application. Its engineer owns startup,
HTTP wiring, composition, and readable turn orchestration. Installed Auggy
packages own built-in implementations and maintained execution operations.

Central YAML remains the single configuration authority for enabled augments
and their options. TypeScript expresses execution and custom capabilities; it
must not establish a competing configuration list. This supersedes the earlier
Central YAML restriction that TypeScript is only for custom augments. The prior
2026-08-16 decision was referenced by main but its implementation/document lived
in an experimental worktree; it is not the implementation baseline.

## Boundaries

- Runtime operations retain identity validation, admission, scheduling,
  authorization, reservations, accounting, persistence, quarantine, finalization,
  and startup/shutdown ordering, including exception and cancellation paths.
- Augments remain the capability and authorization boundary. Application
  databases and durable workflows remain their respective systems of record.
- Project TypeScript is trusted code, not a sandboxed adversary. Supported
  orchestration operations preserve safeguards; raw model/tool calls are not
  the supported generated execution recipe.
- Built-ins remain installed dependencies. Dependency upgrades never overwrite
  application source. Breaking execution contracts require migration guidance.
- All supported launch paths must eventually use the project-selected runtime.
  Current main's global CLI owns its core runtime; this target is not yet met.
- Preserve POST /agent/run authentication, streaming, idempotency, and errors.
- Source navigation, declared metadata inspection, and runtime inspection are
  distinct. Current route inspection executes augment lifecycle code; static
  inspection is a future contract requiring metadata/runtime parity checks.
- Preserve single-replica SQLite and fail-closed PostgreSQL coordination.

## Sequencing and compatibility

Milestone 2 locks these semantics, not speculative function signatures or npm
package splits. Milestone 3 proves managed host and turn APIs in one application
before their public shape or scaffold becomes stable. A one-line hidden-loop
wrapper does not meet the inspectability requirement. Copying safeguards into
generated source would create an unsupported second runtime.

The current per-augment YAML scaffold remains in use during milestones 1–2.
The acceptance fixture tests this current behavior. Later milestones add
project-local launch and source-edit assertions to the same installed path.

## Alternatives and consequences

Configuration-only scaffolds leave the execution path hidden. Vendoring the
runtime or built-ins makes routine fixes difficult to deliver. Project-owned
orchestration adds a public compatibility surface and therefore requires proof
of lifecycle correctness before adoption. The maintained operations/application
control-flow boundary is the selected tradeoff.
