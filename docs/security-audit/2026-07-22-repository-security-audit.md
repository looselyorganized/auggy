# Repository Security Audit

**Audit date:** 2026-07-22
**Audited commit:** `ad2622b62759ca0664a4b6a5e3253b79591efa2a`
**Overall risk:** High
**Production-code changes made by the audit:** None

## Executive summary

The audit covered the complete tracked repository, including all runtime code
under `src/`, provider packages, the creator console, scaffolds and templates,
examples, tests, scripts, dependency manifests, and GitHub Actions workflows.
Manual review was divided among specialized auth/transport, kernel/memory,
augment, provider/template, CLI, and release-workflow streams. Candidate
findings were then reviewed centrally for reachability, preconditions,
countercontrols, and severity.

No Critical issue was found. The audit confirmed:

- 10 High-severity findings;
- 19 Medium-severity findings;
- several Low-severity and defense-in-depth gaps; and
- 12 vulnerable-dependency advisories: 3 High, 8 Moderate, and 1 Low.

The highest-priority risks are authorization and isolation failures:

1. Caller-controlled thread IDs allow cross-peer conversation access.
2. Reused idempotency keys bypass budget accounting while re-executing work.
3. Filesystem writes can escape a mount through a symlinked parent.
4. Console authentication can be bypassed under unsafe loopback/proxy
   assumptions.
5. `link_send` upgrades public callers to agent trust downstream.
6. MCP tools default too broadly and trust remote risk annotations.
7. Redirects can disclose credentials cross-origin.
8. `webFetch` remains vulnerable to DNS-based/internal-network SSRF.
9. The legacy Supabase memory provider ignores peer isolation.
10. A bundled Next.js template exposes a privileged admin action without
    authenticating its inbound caller.

The public-facing runtime should not be considered ready for hostile
multi-tenant exposure until H-01 through H-09 are addressed.

## Scope and method

The reviewed surfaces included:

- `src/kernel`, `src/augments`, `src/transports`, `src/cli`, `src/memory`, and
  shared runtime/type contracts;
- all provider adapters and eval packages under `packages/`;
- the console source in `admin/src/` and its production build;
- scaffolded applications, skills, route handlers, and configuration templates;
- release, deployment, and helper scripts;
- GitHub Actions CI, security-eval, and release workflows;
- package manifests, the lockfile, and transitive dependency advisories; and
- tests, examples, and documentation where they define public security
  behavior.

Review methods included manual data-flow and authorization analysis, targeted
test execution, temporary filesystem and mock-provider proofs of concept,
secret-pattern scanning, dependency auditing, console production builds, and
an end-to-end release smoke test using tarballs packed from the audited working
tree.

## High-severity findings

### H-01 — Cross-peer thread-history access

`/agent/run` accepts a caller-provided thread ID, while ordinary in-memory
history is keyed only by that ID and is not consistently associated with its
originating peer. A caller who obtains another peer's thread ID can supply it,
receive that transcript as model context, and append to or poison its history.

**Evidence**

- [`src/transports/web-transport.ts:1770`](../../src/transports/web-transport.ts#L1770)
- [`src/agent.ts:143`](../../src/agent.ts#L143)
- [`src/kernel/turn-loop.ts:126`](../../src/kernel/turn-loop.ts#L126)

**Precondition:** The attacker knows or obtains a victim thread ID.

**Remediation:** Server-mint thread IDs and bind every in-memory thread to an
immutable peer owner before model invocation. Add a regression test in which
peer A creates a thread and peer B is denied when reusing its ID.

### H-02 — Idempotency keys bypass budgets and duplicate side effects

The caller controls `Idempotency-Key`. The budget store reuses an earlier allow
decision based solely on `turn_id`, but the kernel still performs a new
inference and tool execution. Only the first reservation and cost commit are
counted. The key can also be reused with a changed peer, thread, or body.

**Evidence**

- [`src/transports/web-transport.ts:1647`](../../src/transports/web-transport.ts#L1647)
- [`src/augments/budgets/budget-store.ts:447`](../../src/augments/budgets/budget-store.ts#L447)
- [`tests/integration/budgets-and-trust.test.ts:293`](../../tests/integration/budgets-and-trust.test.ts#L293)

The existing integration test explicitly executes the model twice with the
same key while expecting a single reservation.

**Remediation:** Bind idempotency keys to peer, thread, and a canonical request
hash. Coalesce in-flight duplicates and replay a cached terminal response.
Reject reuse when any bound request attribute changes.

### H-03 — Writable filesystem mount escape through symlink parents

For a nonexistent destination, `realpath` failure falls back to checking the
lexical path. If an existing parent inside the mount is a symlink outside it,
`fs_write` and `fs_mkdir` follow that symlink and create files outside the
configured mount.

**Evidence**

- [`src/augments/filesystem/index.ts:332`](../../src/augments/filesystem/index.ts#L332)
- [`src/augments/filesystem/index.ts:410`](../../src/augments/filesystem/index.ts#L410)
- [`src/augments/filesystem/index.ts:503`](../../src/augments/filesystem/index.ts#L503)

This was reproduced in a temporary mount. Existing tests cover existing target
symlinks but not nonexistent targets below symlinked parents.

**Remediation:** Validate the nearest existing ancestor or use
descriptor-relative, no-follow operations. Add write and mkdir regression
tests for nonexistent targets beneath symlink parents.

### H-04 — Console authentication depends unsafely on loopback/proxy identity

Console authentication is waived for loopback callers. Requests are not
protected with strict Host/Origin checks, and Railway environments broadly
trust forwarded client-IP information. DNS rebinding or deployments that
preserve attacker-controlled forwarding headers can therefore turn a remote
request into an apparent loopback request.

**Evidence**

- [`src/transports/admin/admin-auth.ts:21`](../../src/transports/admin/admin-auth.ts#L21)
- [`src/transports/web-transport.ts:419`](../../src/transports/web-transport.ts#L419)
- [`src/transports/web-transport.ts:2402`](../../src/transports/web-transport.ts#L2402)

**Precondition:** Exploitability depends on browser, network, and proxy
behavior. The impact is creator-console authority when those conditions hold.

**Remediation:** Require authentication on loopback by default, validate Host
and Origin, and trust only explicit proxy CIDRs with a verified right-to-left
forwarding chain.

### H-05 — `link_send` launders public authority into agent authority

The tool does not constrain its originating peer, but outbound calls
authenticate using the configured link bearer. The receiving agent therefore
sees an agent-trust peer rather than the original public caller.

**Evidence**

- [`src/augments/link/index.ts:333`](../../src/augments/link/index.ts#L333)
- [`src/augments/link/index.ts:654`](../../src/augments/link/index.ts#L654)
- [`src/augments/link/index.ts:778`](../../src/augments/link/index.ts#L778)

**Remediation:** Hide the tool from public peers by default, preserve signed
originating-peer provenance, and ensure downstream authority cannot exceed the
original caller's authority.

### H-06 — MCP tools fail open and trust server-provided risk annotations

Absent an operator policy, MCP tools are available across trust levels.
Restrictions are primarily derived from the remote server's own
`destructiveHint` and `openWorldHint` annotations. A compromised or incorrect
MCP service can understate its risk and expose credentialed operations to
public callers.

**Evidence**

- [`src/augments/mcp/manager.ts:361`](../../src/augments/mcp/manager.ts#L361)
- [`src/augments/mcp/manager.ts:400`](../../src/augments/mcp/manager.ts#L400)

**Remediation:** Default every remotely supplied tool to creator-only. Treat
remote annotations as display metadata, not authorization evidence, and
require explicit operator delegation for less-trusted callers.

### H-07 — Cross-origin redirects can disclose credentials

Redirect sanitization deletes only exact lowercase `authorization`, `cookie`,
and `proxy-authorization` properties from a plain object. Mixed-case variants
such as `Authorization` survive. Custom credentials such as `X-API-Key` are
never stripped, including webhook headers.

**Evidence**

- [`src/http.ts:184`](../../src/http.ts#L184)
- [`src/http.ts:277`](../../src/http.ts#L277)
- [`src/augments/notify/adapters/webhook.ts:38`](../../src/augments/notify/adapters/webhook.ts#L38)

**Remediation:** Normalize through `Headers`, define explicit
sensitive-header handling, and preferably use a per-origin allowlist after a
cross-origin redirect.

### H-08 — `webFetch` SSRF protection does not validate resolved addresses

The protection checks the URL's literal hostname but deliberately performs no
DNS resolution. Public-looking attacker-controlled domains may resolve or
rebind to internal services. Several non-global IPv4 ranges, including
carrier-grade NAT and benchmarking networks, are also omitted.

**Evidence**

- [`src/http.ts:42`](../../src/http.ts#L42)
- [`src/http.ts:128`](../../src/http.ts#L128)
- [`src/http.ts:245`](../../src/http.ts#L245)

**Remediation:** Resolve and validate every A/AAAA address on every hop, reject
all non-global destinations, connect to the validated address, and reject
HTTPS-to-HTTP downgrade redirects.

### H-09 — Supabase memory provider ignores peer isolation

The provider discards `MemoryQueryOpts.peerId`; searches and exact-label reads
can return another peer's records. Higher layers pass the peer correctly, but
this implementation does not enforce it.

**Evidence**

- [`src/augments/supabaseMemory/index.ts:66`](../../src/augments/supabaseMemory/index.ts#L66)
- [`src/augments/supabaseMemory/index.ts:96`](../../src/augments/supabaseMemory/index.ts#L96)
- [`src/memory/tools.ts:351`](../../src/memory/tools.ts#L351)

A mock-provider proof of concept returned a victim row under an attacker query.

**Remediation:** Store `peer_id` separately and constrain every query before
`LIMIT`. Require ownership for exact reads and add Supabase RLS as defense in
depth.

### H-10 — Bundled Next.js admin route is an unauthenticated confused deputy

The shipped template creates a privileged server client with
`AUGGY_BEARER_TOKEN`, then exports a public `POST` handler that invokes
`/admin/reindex` without verifying an application session, operator role,
Origin, or CSRF token.

**Evidence**

- [`admin-reindex-route.ts.txt:3`](../../src/scaffold-starter-skills/auggy/assets/templates/nextjs-server-client/admin-reindex-route.ts.txt#L3)

This does not affect the current runtime until the template is copied into an
application, but it creates an insecure downstream default.

**Remediation:** Make the generated handler fail closed until application
authentication and explicit operator authorization succeed. Add Origin/CSRF
protection where cookie authentication is used.

## Medium-severity findings

### M-01 — Parallel tool calls bypass per-turn limits

All calls are authorized before counters change, and only successful calls
count. Reserve attempt slots synchronously before dispatch and count failed or
throwing attempts.

Evidence: [`src/kernel/turn-loop.ts:862`](../../src/kernel/turn-loop.ts#L862)

### M-02 — Timeouts do not cancel underlying work

`Promise.race` returns a timeout while writes, messages, or deletions may finish
later. Propagate a combined request/deadline `AbortSignal` through tools,
contexts, and lifecycle hooks, and treat non-cancelable timeouts as
outcome-unknown.

Evidence: [`src/kernel/timeout.ts:8`](../../src/kernel/timeout.ts#L8)

### M-03 — Aborts after inference omit known cost

A disconnect during post-inference tool execution reaches a finalization path
without committing recorded inference cost. All terminal paths should commit
every completed inference step exactly once.

Evidence: [`src/kernel/turn-loop.ts:250`](../../src/kernel/turn-loop.ts#L250)

### M-04 — Anonymous layered-memory transcripts are unbounded

Per-thread buffers have no byte, turn, peer, global, or TTL limits and may
survive indefinitely. Add bounded storage, idle expiry, and real session
cleanup; avoid buffering when no extractor exists.

Evidence:
[`src/augments/layeredMemory/index.ts:377`](../../src/augments/layeredMemory/index.ts#L377),
[`buffer.ts:29`](../../src/augments/layeredMemory/extractor/buffer.ts#L29)

### M-05 — Anonymous rate limiting is bypassable by rotating thread IDs

Anonymous peer identity derives from the caller-controlled thread ID. Add a
network, visitor, and/or global fallback bucket that cannot be reset by choosing
a new conversation ID.

Evidence:
[`src/transports/web-transport.ts:1194`](../../src/transports/web-transport.ts#L1194)

### M-06 — Large request bodies are parsed before application caps

`/agent/run` and multiple console endpoints call `json()` or `text()` before
bounded validation. Enforce streaming byte limits before parsing, including
for requests without `Content-Length`.

Evidence:
[`src/transports/web-transport.ts:1749`](../../src/transports/web-transport.ts#L1749),
[`src/transports/admin/index.ts:531`](../../src/transports/admin/index.ts#L531)

### M-07 — Internal exception strings can reach public responses

Tool, context, and augment errors preserve raw exception messages. Return
stable public codes and log sanitized details internally.

Evidence:
[`src/kernel/turn-loop.ts:1000`](../../src/kernel/turn-loop.ts#L1000)

### M-08 — Console-managed files follow workspace symlinks

Identity, skill, and credential reads/writes use lexical paths and ordinary
file operations. Pin canonical targets and use no-follow semantics.

Evidence:
[`admin-identity.ts:31`](../../src/transports/admin/admin-identity.ts#L31),
[`admin-skills.ts:138`](../../src/transports/admin/admin-skills.ts#L138),
[`admin-credentials.ts:33`](../../src/transports/admin/admin-credentials.ts#L33)

### M-09 — Console is frameable

Static responses lack `frame-ancestors` or `X-Frame-Options`, enabling
clickjacking of authenticated controls.

Evidence:
[`src/transports/admin/admin-static.ts:129`](../../src/transports/admin/admin-static.ts#L129)

### M-10 — Notify quotas race

Limits are checked before awaiting delivery and recorded afterward, allowing
concurrent requests to overrun caps. Atomically reserve quota before dispatch.

Evidence:
[`src/augments/notify/index.ts:289`](../../src/augments/notify/index.ts#L289)

### M-11 — MCP caps apply after SDK materialization

Oversized or deeply nested schemas and results may exhaust memory or stack
before repository-level limits run. Add transport-byte, depth, node,
tool-count, and argument-size limits.

Evidence:
[`src/augments/mcp/manager.ts:316`](../../src/augments/mcp/manager.ts#L316)

### M-12 — Telegram updates lack durable replay protection

Webhook deliveries are dispatched without recording `update_id`; polling
offset is memory-only. Persist and atomically deduplicate update IDs.

Evidence:
[`webhook.ts:26`](../../src/augments/telegramTransport/webhook.ts#L26),
[`telegramTransport/index.ts:305`](../../src/augments/telegramTransport/index.ts#L305)

### M-13 — Generated `.env` files lack explicit owner-only permissions

Actual API keys and the web bearer may be created as `0644` under a common
umask. Create them with mode `0600` and correct permissions when updating an
existing file.

Evidence:
[`src/cli/commands/create.ts:591`](../../src/cli/commands/create.ts#L591),
[`src/cli/scaffold.ts:123`](../../src/cli/scaffold.ts#L123)

### M-14 — Railway secrets enter argv and errors verbatim

Failed variable commands can expose credentials in logs, crash reports, and
process listings. Array-based process spawning prevents command injection but
does not prevent this confidentiality leak. Use a non-argv secret channel and
redact diagnostic commands independently.

Evidence:
[`src/cli/deploy/railway-cli.ts:180`](../../src/cli/deploy/railway-cli.ts#L180),
[`src/cli/deploy/railway-cli.ts:308`](../../src/cli/deploy/railway-cli.ts#L308)

### M-15 — Manual security-eval workflow can run branch-controlled code with a secret

This is not an automatic fork-PR leak. However, the documented "any branch/PR"
dispatch can expose the eval key if a maintainer selects unreviewed code. Run a
trusted default-branch harness and ingest candidate configuration only as data.

Evidence:
[`.github/workflows/security-eval.yml:3`](../../.github/workflows/security-eval.yml#L3)

### M-16 — Remote provider credentials may be sent over plaintext HTTP

The creation flow accepts non-loopback `http://` Ollama URLs with a bearer
token. Reject credentials over plaintext except for an explicit, high-friction
local development override. Apply the same rule to other configurable provider
base URLs.

Evidence:
[`src/cli/commands/create.ts:194`](../../src/cli/commands/create.ts#L194),
[`packages/ollama/src/index.ts:78`](../../packages/ollama/src/index.ts#L78)

### M-17 — Generated auth-assertion bridges are cache/replay unsafe

Assertions are minted through GET without `Cache-Control: no-store, private`,
while a shipped configuration disables replay protection. Use POST or explicit
no-store behavior and enable an atomic shared replay store for multi-instance
deployments.

Evidence:
[`next-route.ts.txt:4`](../../src/scaffold-starter-skills/auggy/assets/templates/app-auth-bridge/next-route.ts.txt#L4),
[`webtransport-external-auth.yaml.txt:19`](../../src/scaffold-starter-skills/auggy/assets/templates/app-auth-bridge/webtransport-external-auth.yaml.txt#L19)

### M-18 — OpenRouter `only` allowlists may fail open on typo

The adapter explicitly does not validate provider slugs. If used as a
residency or compliance boundary, an invalid slug may permit default routing.
Validate against an authoritative list, or verify and document that upstream
rejects unknown providers.

Evidence:
[`packages/openrouter/src/index.ts:43`](../../packages/openrouter/src/index.ts#L43)

### M-19 — Provider responses lack application-layer structural bounds

Token settings exist, but compromised or nonconforming proxies can return
oversized text, tool calls, or deeply nested arguments before kernel budgeting.
Add response-byte, text-byte, tool-call-count, argument-byte, depth, and node
limits.

Evidence:
[`packages/anthropic/src/index.ts:364`](../../packages/anthropic/src/index.ts#L364),
[`packages/ollama/src/index.ts:283`](../../packages/ollama/src/index.ts#L283)

## Dependency advisories

`bun audit --json` reported 12 advisories.

| Package | Locked version | Highest severity | Assessment |
| --- | ---: | --- | --- |
| `fast-uri` | 3.1.2 | High | Two host-confusion advisories through AJV/MCP dependencies. Upgrade to a fixed release, expected to be at least 3.1.4. |
| `hono` | 4.12.21 | High | Eight advisories, including credentialed wildcard CORS. Upgrade to at least 4.12.27. |
| `@hono/node-server` | 1.19.14 | Moderate | Windows encoded-backslash traversal; fixed in 2.0.5 or later. |
| `body-parser` | 2.2.2 | Low | Invalid-limit denial of service; fixed in 2.3.0 or later. |

Relevant upstream advisories include:

- [`fast-uri` literal-backslash host confusion](https://github.com/advisories/GHSA-v2hh-gcrm-f6hx)
- [`fast-uri` IDN canonicalization host confusion](https://github.com/advisories/GHSA-4c8g-83qw-93j6)
- [Hono credentialed wildcard CORS](https://github.com/advisories/GHSA-88fw-hqm2-52qc)
- [`@hono/node-server` Windows path traversal](https://github.com/advisories/GHSA-frvp-7c67-39w9)
- [`body-parser` invalid-limit denial of service](https://github.com/advisories/GHSA-v422-hmwv-36x6)

The Hono/server packages enter primarily through
`@modelcontextprotocol/sdk` and `@auggy/link`; `fast-uri` enters through AJV.
The audit did not demonstrate that the vulnerable server adapters or CORS
defaults are reachable in the runtime. These are therefore confirmed vulnerable
dependency versions, not proven application exploits.

The adapter packages also import `auggy` runtime/internal modules without
declaring an `auggy` peer dependency. This is a release-integrity defect that
can cause incompatible or missing core resolution in consumer projects.

Evidence:
[`packages/anthropic/package.json:32`](../../packages/anthropic/package.json#L32)

## Low-severity and hardening findings

- Malformed `.env` warnings can print an entire pasted secret.
  Evidence:
  [`src/cli/deploy/secrets.ts:64`](../../src/cli/deploy/secrets.ts#L64)
- Telegram validation warns about an invalid admitted agent but does not
  reliably demote or remove the configured mapping.
  Evidence:
  [`src/augments/telegramTransport/index.ts:50`](../../src/augments/telegramTransport/index.ts#L50)
- Filesystem `maxWriteSize` measures JavaScript characters rather than encoded
  bytes.
  Evidence:
  [`src/augments/filesystem/index.ts:415`](../../src/augments/filesystem/index.ts#L415)
- Console logout accepts GET and is susceptible to forced-logout CSRF.
  Evidence:
  [`src/transports/admin/index.ts:339`](../../src/transports/admin/index.ts#L339)
- Several SSE/request aggregation paths do not enforce consistent
  event-count/backpressure limits.
- Caller-controlled peer metadata is interpolated into model context without
  tight length/character normalization. Deterministic runtime authorization is
  not based on the model, so this is prompt hardening rather than a confirmed
  authorization vulnerability.
- Release provenance is disabled and publishing uses a long-lived npm token
  despite OIDC permission being available. No publish-workflow bypass was
  confirmed.

## Controls that held up well

The review did not find material defects in:

- external-auth HMAC domain separation, expiry, audience/provider validation,
  timing-safe comparison, key rotation, and fail-closed behavior;
- delegated authorization's exact action/resource/constraint checks;
- visitor-token signature, expiry, agent binding, revocation, and promotion;
- console HMAC sessions and per-action CSRF;
- persisted console-chat ownership checks;
- webhook raw-body signature and timestamp verification;
- restricted bash argv execution, allowlisting, environment isolation,
  timeouts, and output caps;
- knowledge manifest traversal and symlink defenses;
- AgentMail admission, review, signature, and durable ledger handling;
- layered SQLite/Supabase stores—the peer-isolation finding is limited to the
  separate legacy `supabaseMemory` implementation;
- file-memory atomic replacement and boot-pinned paths;
- publish-workflow SHA-pinned actions, minimal permissions, tag/main ancestry
  verification, version lockstep, packed artifacts, and secret scoping; and
- console Markdown sanitization and unsafe-link blocking.

## Verification results

| Verification | Result |
| --- | --- |
| `bun run typecheck` | Passed |
| `bun run lint` | Passed; informational Biome schema 2.5.0 versus CLI 2.5.5 mismatch |
| Console tests | 239 passed, 0 failed |
| Focused HTTP tests | 32 passed, 0 failed |
| Specialist kernel/memory suite | 564 passed, 0 failed |
| Specialist augment and auth/transport suites | Focused selections passed |
| Console production build | Passed |
| `bun run smoke:release` | Passed end to end using tarballs packed from this working tree |
| Secret-pattern scan | No apparent live credential found |
| `bun audit --json` | 12 advisories: 3 High, 8 Moderate, 1 Low |

The release smoke test covered local package packing and content verification,
installation of the locally built CLI tarball, generated-agent creation,
dependency installation, doctor, health, console assets, knowledge/MCP setup,
and cloud preflight.

The full runtime sweep was not clean: **3,049 tests passed, 170 failed, and 2
errored**. The failures cascade from Bun 1.3.14 repeatedly returning
`EADDRINUSE`, including for `port: 0`; affected HTTP tests pass in focused runs.
The aggregate suite should be stabilized or sharded in CI. This limitation does
not invalidate the code-level findings, but it prevents claiming a completely
green full-suite baseline.

## Truth and severity review

The report distinguishes demonstrated vulnerabilities from conditional risks:

- H-03 and H-09 were reproduced with temporary-filesystem and mock-provider
  proofs of concept.
- H-02 is directly supported by an existing integration test that codifies
  duplicate execution.
- H-04 is High impact but conditional on proxy/network/browser behavior.
- H-10 affects downstream applications that copy the bundled template; it is
  not a live route in the current runtime.
- The Railway finding is a confidentiality issue, not command injection,
  because subprocess arguments are not passed through a shell.
- The security-eval workflow is not an automatic fork-PR secret leak; it
  requires a maintainer to dispatch unreviewed branch-controlled code.
- The OpenRouter result depends on the upstream provider-routing contract and
  should be verified against current upstream behavior.
- Dependency scanner severity was not promoted to application severity without
  demonstrated reachability.

## Recommended remediation order

1. Fix thread ownership, idempotency semantics, Supabase peer filtering, and
   filesystem path handling.
2. Remove console IP-based authentication waivers and harden Host, Origin, and
   proxy trust.
3. Make link and MCP authority explicitly fail closed.
4. Complete DNS-aware SSRF protection and redirect credential sanitization.
5. Correct the privileged Next.js template before further distribution.
6. Upgrade vulnerable transitive dependencies.
7. Make quota reservation and notification caps atomic and propagate
   cancellation.
8. Add request, response, and memory-buffer bounds plus Telegram replay
   persistence.
9. Harden CLI secret permissions, Railway handling, auth templates, and CI
   eval execution.
