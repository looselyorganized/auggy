# Repository security remediation report

Date: 2026-07-23

Repository: `looselyorganized/auggy`

Audit source: `docs/security-audit/2026-07-22-repository-security-audit.md`

Integration branch: `security/audit-remediation`

Base branch: `main`

Pull request: [#159 — fix(security): harden repository security boundaries](https://github.com/looselyorganized/auggy/pull/159)

## Executive outcome

The nine remediation groups from the repository audit were revalidated and
implemented on one integration branch. The branch closes all ten High findings,
all nineteen Medium findings, the twelve dependency advisories reported by the
original audit, and the directly assigned Low findings. The remaining
peer-display prompt hardening is documented as residual defense-in-depth. The
branch also adds cross-cutting hardening discovered during adversarial review.

The principal security outcomes are:

- peer, thread, organization, and request ownership are established before
  history access or model execution;
- idempotency, anonymous admission, tool, notification, and cost accounting
  decisions are atomic and fail closed;
- writable filesystem and console-managed paths use descriptor-relative POSIX
  operations and cannot be redirected through symlink or ancestor replacement;
- console, link, MCP, generated-route, provider, and CI trust transitions have
  explicit runtime authorization boundaries;
- HTTP redirects, DNS resolution, credential transport, request parsing, model
  output, MCP materialization, SSE queues, memory buffers, and Telegram replay
  handling are bounded;
- provider and post-dispatch errors cannot carry raw credential-bearing causes
  into public errors, logs, or evaluation artifacts; and
- package consumers and release artifacts are validated against the local
  repository tarballs rather than the stale npm release.

No finding was changed merely to satisfy an existing test. Authorization remains
a deterministic runtime decision. No package version was bumped and no package
was published.

## Scope and threat model

The review assumed attackers could:

- choose peer, visitor, thread, idempotency, proxy, HTTP, MCP, provider, and
  Telegram inputs;
- race duplicate requests and parallel tool or notification operations;
- control symlinks and replace writable path components concurrently;
- operate through proxies, redirects, mixed DNS answers, restarts, and multiple
  application instances;
- cause upstream services to echo submitted credentials in errors;
- submit branch-controlled configuration or artifacts to privileged CI entry
  points; and
- trigger failures after an external side effect or inference cost had begun.

Protected assets were conversation history, mutable memory, filesystem and
console-managed files, creator and delegated authority, credentials, quota and
cost integrity, provider routing policy, release identity, and downstream
application credentials.

The global invariant is that identity and authority are canonicalized and
validated at each trust transition, before protected reads, model execution, or
side effects. Ambiguous post-dispatch outcomes are terminal and not silently
retried.

## Finding disposition by remediation group

| Group | Findings | Result and introduced invariant | Primary commits |
| --- | --- | --- | --- |
| 1 — Identity, idempotency, memory, and filesystem | H-01, H-02, H-03, H-09, M-05, filesystem byte-count Low | Threads bind to one resolved peer before retrieval or inference. Idempotency binds peer, thread, body, and execution; concurrent duplicates join or replay. Anonymous rate limits use atomic shared policies rather than thread IDs. Supabase reads filter ownership before limiting. Writable paths are descriptor-pinned and reject symlink, prefix, nonexistent-descendant, and replacement escapes. | `76e972f`, `d7a0c1e`, `303e565`, `b0ed607`, `03454bf`, `2527916`, `8269a87` |
| 2 — Console and browser boundaries | H-04, M-08, M-09, forced-logout CSRF Low | Console access no longer depends on a client-derived loopback address. Host, Origin, proxy, session, framing, and CSRF checks fail closed. Managed files cannot traverse symlinks. Browser guidance uses a server-minted anonymous session or trusted external verification handoff instead of inventing recognized visitor authority. | `a888408`, `5dfc9a0`, `6943070`, `2527916`, `8269a87` |
| 3 — Link and MCP trust | H-05, H-06 | Link provenance preserves the originating caller's maximum authority. Public callers cannot acquire agent authority by delegation. Remote MCP annotations are non-authoritative, tools default creator-only, and delegation is rechecked immediately before execution. | `2a2ca74`, `b6a9be6`, `42c6230` |
| 4 — Redirect and SSRF hardening | H-07, H-08 | Credential headers are normalized and stripped across origin changes; redirects cannot restore them. Initial and redirected destinations require all-address public DNS validation, pinned lookup behavior, special-use address rejection, and downgrade protection. | `8a72845`, `54126ff`, `cf583ab`, `d7b379c`, `501a230` |
| 5 — Generated admin routes | H-10 | Shipped privileged Next.js handlers fail closed until the host verifies a session, explicit admin role, Origin, and CSRF. Server credentials remain server-only and scaffold tests exercise anonymous, non-admin, and admin behavior. | `38ea970`, `09ae6bf` |
| 6 — Dependencies and provider packages | Original twelve advisories, undeclared core peers, M-18 | Vulnerable transitive versions were upgraded without blind lockfile overrides. Each provider declares a compatible optional core peer, is packed with local consumer checks, and OpenRouter restrictive routing fails closed when invalid or unverifiable. | `566127c`, `5d88f72`, `6900925`, `a575c5d` |
| 7 — Quotas, accounting, and cancellation | M-01, M-02, M-03, M-10 | Tool and notification quota is reserved before dispatch, inference cost commits exactly once before successful completion, cancellation reaches first-party operations, and non-cancelable post-dispatch failures become outcome-unknown. | `afeb330`, `e3946b1`, `3256e25`, `626f22a`, `3ddd350` |
| 8 — Bounded resources and replay | M-04, M-06, M-07, M-11, M-12, M-19, SSE/backpressure Low | Byte limits precede body parsing. Provider and MCP bodies, streams, text, tool calls, arguments, depth, nodes, and accessors are bounded. Anonymous memory has thread, peer, global, and TTL limits. Telegram update admission is durable and atomic. Public errors are stable and streaming queues terminate when their limits are exceeded. | `1cb0a15`, `b17e111`, `9648ca3`, `be27cbc`, `3ddd350` |
| 9 — Secrets, assertions, provider transport, and CI | M-13, M-14, M-15, M-16, M-17, malformed-env Low, Telegram-validation Low, release-provenance Low | Secret files use owner-only permissions, Railway values do not enter diagnostic text, malformed env warnings omit content, credentialed plaintext non-loopback providers fail closed, generated assertions use no-store and durable replay protection, and security evaluation executes only a trusted harness against an exactly bound candidate configuration and SHA. Provider exceptions expose stable allowlisted metadata without raw causes. | `5e1af06`, `88abbee`, `04a5070`, `4a8e7a6`, `546c824`, `39e7226`, `e803aba`, `cf748ed`, `db72fa5`, `47a1095`, `a575c5d` |

## Revalidation and severity review

Every audit finding was traced to current source, callers, tests, configuration,
and downstream consumers before remediation.

- H-01, H-02, H-03, H-05 through H-09, and the Medium race/bounds findings were
  confirmed and reachable under their documented preconditions.
- H-04 remained a conditional High: exploitation requires a deployment that
  exposes or misclassifies the console through a proxy or browser boundary.
  The impact justified retaining High severity and removing the implicit waiver.
- H-10 remained a downstream scaffold vulnerability rather than a live route in
  the core runtime. It was still confirmed because generated applications would
  copy the unsafe privileged handler.
- M-15 remained maintainer-dispatch-conditioned rather than an automatic
  fork-pull-request secret leak. The privileged workflow nevertheless crossed a
  real trust boundary and was remediated.
- M-18 depended on upstream provider-routing behavior. Restrictive local policy
  now fails closed, so upstream fallback semantics cannot widen authority.
- Dependency scanner severities were not promoted to application exploit
  severities without reachability evidence. The vulnerable locked versions were
  still real and were upgraded.

No High or Medium finding was disproven. The audit's conditional and
defense-in-depth classifications were preserved rather than exaggerated.

## Adversarial review and disposition

Fresh hostile reviewers evaluated each group and the final cross-cutting diff.
The primary agent independently checked their evidence and rejected duplicate
or unsupported observations.

The final review rounds identified four Medium anonymous-admission gaps:

1. independent replicas could multiply limits without a shared ledger;
2. IPv6 `/128` rotation could evade per-network policy;
3. idempotent replay could consume new execution quota; and
4. malformed forwarded identity could collapse into a shared proxy bucket.

They were closed by:

- requiring an explicit `shared-store`, `trusted-edge`, or
  `single-process-development` anonymous-network posture;
- rejecting non-durable shared-store configuration and production use of the
  development posture;
- grouping IPv6 identities to `/64` by default and adding an audience-global
  cap;
- atomically claiming an idempotency leader and all rate policies in one
  `BEGIN IMMEDIATE` transaction; and
- rejecting ambiguous forwarded identity before admission, body processing, or
  model execution.

A separate review identified a conditional Medium credential-leak path when a
provider echoed a submitted secret in an exception or cause. Stable provider
errors were applied to Anthropic, OpenAI, OpenRouter, and every Ollama buffered,
stream-setup, and mid-stream path. Raw causes were also removed from HTTP, MCP,
Telegram, notification, accounting, and evaluation-artifact paths.

Lifecycle review additionally validated real stalled-child MCP cleanup,
bounded shutdown, cost-commit failure behavior, malformed model-response
rejection, and Windows fail-closed managed-file behavior.

Final hostile-review results:

- identity and anonymous admission: 186 focused tests passed, no unresolved
  High or Medium finding;
- MCP, lifecycle, accounting, model bounds, and Windows behavior: 148 focused
  tests passed, no unresolved High or Medium finding; and
- credential/provider/evaluation boundaries: 183 focused tests passed,
  including a dynamic Ollama mid-stream sentinel test, with no unresolved High
  or Medium finding.

## Compatibility, migration, and deployment impact

- The idempotency SQLite schema migrates from v1 to v2 and adds shared
  anonymous-network and global rate state. Multi-instance deployments must use
  genuinely shared durable storage or explicitly select a trusted-edge model.
- The console conversation store uses schema v4 ownership, including
  organization-aware separation.
- External custom visitor mappings now derive a domain-separated ID from
  provider, subject, organization, and mapped namespace. Existing mapped IDs
  should be treated as an identity migration.
- Anonymous browser first contact now returns `428` with a server-minted session
  instead of executing a model turn or minting recognized visitor authority.
- Telegram replay state is durable and must be shared for cross-instance
  exactly-once admission.
- POSIX mutable filesystem and console-managed operations require
  descriptor-relative primitives. On Windows, managed-file operations fail
  closed while non-file console and chat functions remain available.
- Provider-facing error text no longer includes raw SDK messages or causes.
  Consumers must use stable error codes/status metadata rather than parse
  upstream prose.
- Security evaluation binds the requested full commit SHA and candidate
  configuration to a trusted harness. Candidate repository code is not executed
  with the evaluation key.
- Explicit operator-configured localhost integrations remain available through
  narrowly scoped policy; public URL paths retain DNS and credential transport
  enforcement.

## Verification

Completed local gates:

| Command | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| cached Biome 2.5.5 `biome check` | Passed; only the existing 2.5.0 configuration-schema informational notice was emitted |
| `git diff --check` | Passed |
| `bun test --max-concurrency=1 --timeout=30000` | 3,952 passed, 0 failed, 12,248 assertions, 280 files |
| `cd admin && bun test --max-concurrency=1` | 243 passed, 0 failed, 1,093 assertions, 29 files |
| `cd admin && bun run build` | Passed; Vite emitted only its non-fatal large-chunk advisory |
| focused identity/rate review | 186 passed, 0 failed |
| focused lifecycle/MCP/model-limit review | 148 passed, 0 failed |
| focused provider/sentinel review | 183 passed, 0 failed |

Dependency and packaging gates:

- The last successful `bun audit --json` on the current unchanged lockfile
  returned `{}`. A final sandboxed rerun reached the audit command but network
  access was refused. `bun.lock` is unchanged by the late hardening commits.
- `bun run smoke:release` previously passed the local tarball, provider,
  CLI/scaffold, health, console, MCP, and cloud checks after the dependency
  remediation. The final local rerun installed the workspace, typechecked,
  rebuilt the console, and packed every publishable package, then the managed
  sandbox denied Bun temporary-file writes before the first isolated consumer
  install. The preserved log contains no package or import failure. The pull
  request's release-rehearsal CI is the final unsandboxed packaging authority.

No dependency versions or package versions changed after the successful audit.
There are no known remaining vulnerable locked dependencies from the original
advisory set.

## Residual risks and intentional deferrals

- SQLite coordinates processes only when every replica uses the same underlying
  filesystem and honors SQLite locking. Deployments with independent replica
  volumes must use a trusted-edge limiter or another shared admission design.
- The security-eval workflow safely evaluates candidate configuration with a
  trusted runtime; ordinary unprivileged CI remains responsible for exercising
  candidate executable code.
- Console-managed filesystem editing is intentionally unavailable on Windows
  until an equivalent descriptor-relative primitive is implemented.
- Browser applications must still protect their same-origin session and
  assertion handoff against application-level XSS.
- Some upstream transports cannot guarantee cancellation after dispatch. Such
  work is marked outcome-unknown and is never blindly retried.
- Provider SDK materialization cannot always be interrupted at the exact input
  byte; post-materialization structural limits remain a required second layer.
- Caller-controlled peer display metadata remains prompt-hardening
  defense-in-depth. Authorization does not depend on model interpretation, and
  request/response resource caps bound the exposure, but stricter display-field
  normalization can be added separately.

## Rollback considerations

- Back up idempotency, console-chat, and Telegram replay databases and stop all
  writers before any schema rollback.
- Do not selectively roll back ownership, idempotency, proxy, credential, or
  filesystem checks while retaining their new public contracts; that would
  silently restore the vulnerability.
- A rollback across external visitor-ID derivation may strand or conflate
  identity-linked history. Plan an explicit mapping migration.
- Provider error normalization is safe to roll back only if callers do not
  expose or persist raw upstream error objects.
- The commit history is intentionally unsquashed so each subsystem can be
  reviewed and, where its data contract permits, reverted independently.

## Pull request and review order

There is one independent, non-stacked pull request:

| PR | Branch | Base | State |
| --- | --- | --- | --- |
| [#159](https://github.com/looselyorganized/auggy/pull/159) | `security/audit-remediation` | `main` | Draft pending final CI packaging confirmation; not merged |

Recommended review order within the PR is the numbered remediation sequence:
identity/filesystem, console, link/MCP, HTTP, scaffold, dependencies, quotas,
bounded runtime, then secrets/CI. Review the four late adversarial-closure
commits (`2527916`, `8269a87`, `3ddd350`, and `a575c5d`) immediately after their
related group, followed by the documentation synchronization commit `780886b`.

At report creation, the only unrelated worktree content is the pre-existing
untracked `order-support/` directory. It was not read, modified, staged, or
committed by this remediation.
