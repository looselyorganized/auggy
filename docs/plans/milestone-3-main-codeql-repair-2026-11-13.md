# Milestone 3 — full-main CodeQL fixture repair

Milestone 4's entry audit found ten fresh CodeQL alerts after PR #227 merged as
`d8d0072cd334834bc62e8270b40edd2a2a7a94e9`. Main's tree exactly matched reviewed
head `ba16ce3a`, but PR analysis used diff-informed scanning and reported zero;
the full main analysis reported additional results. CI and the analysis workflow
themselves passed. The open-finding audit correctly kept the M4 gate blocked.

Analysis `2158668062` reported alerts 118–127, all in test code: five generated-code
sanitization findings, one file-controlled outbound request, and four filesystem
race patterns. No runtime, package, lock or scanner configuration is changed by
this repair.

## Changes and preserved assertions

- Resolver rollback fixtures now use static executable source plus JSON fixture
  data. Server allocation still occurs before import/factory failure and invalid
  return; normalization still fails through the returned tools getter and closes
  through its actual shutdown hook. The allocated port is retained in memory
  instead of being read from a file to construct an HTTP request.
- A static subprocess fixture receives marker/PID paths through argv. Tests still
  exercise inherited pipes, escaped detached descendants, delayed effects,
  graceful SIGTERM and exact exit diagnostics.
- Filesystem tests assert ENOENT by reading and create absent files exclusively.
  Exact content, zero-byte preservation, terminal report preservation, oversized
  rejection and linked-target protection remain asserted.

Root repaired the resolver fixture; the harness specialist repaired its four
tests and shared subprocess fixture. The entry-gate auditor independently reviews
the combined frozen diff. Runtime and manifest/lock diffs against main are empty.

## Verification

Producer checks: resolver suite 8 passed / 42 assertions; four harness suites
48 passed / 253 assertions. Broader application suite: 33 passed / 200 assertions.
Strict typecheck and full lint passed (the existing Biome schema-version advisory
remains informational). Initial sandbox execution could not bind loopback ports;
the same tests passed with local-listener permission. No assertions were weakened
to accommodate the sandbox.

Independent review accepted the exact six changed test/fixture files. Its broader
application, harness and bounded-reader run passed 91 tests / 499 assertions with
zero failures, unchanged review hashes and no remaining idle fixture descendants.
Tracked inventory passed: 320 runtime, 34 admin and four isolated external tests
across 16 shards. Whitespace validation passed.

Before merge, require independent review, tracked test inventory, normal PR CI
and a full `workflow_dispatch` CodeQL analysis on the exact repair head. After
merge, verify main CI, PG17 and the exact-main open-alert API again. A successful
analysis job or a PR-only diff scan does not close this gate by itself.
