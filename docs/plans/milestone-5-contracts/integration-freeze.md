# M5-00 C3/C4 implementation freeze

Candidate for independent acceptance; producer behavior is not implemented by
this record. Baseline is verified main `c39b746` plus reviewed M5 preparation.

The actual application-owned interfaces live at
`examples/company-app/src/server/contracts.ts`. They reuse Auggy authorization
types and keep the trusted session verifier separate from company resource policy.
The reference assertion TTL is 60 seconds. Missing verifier remains a fail-closed
configuration outcome; no production demo identity path is introduced.

The actual harness evidence types and bounds live at
`scripts/release-smoke/integration-contracts.ts`. Root owns this shared schema,
script registration and CI. Producer-specific fixtures must consume these types;
they must not invent another result format or report health as channel execution.
Runtime evidence validation/redaction is part of M5-07, not supplied by TypeScript.
Static command labels avoid recording credential-bearing argv. Existing M4 source
and child-process bounds remain authoritative; builds receive a separate bounded
10-minute phase, browser navigation 30 seconds and fixture requests 10 seconds.
Every subdeadline remains inside its containing phase/scenario budget.

## Exact fixture overlays

- The optional app's production composition is
  `examples/company-app/src/server/session-adapter.ts`. Only a separately copied,
  marked fixture-auth build replaces that module. The fixture registry stays
  server-only, cookies are opaque and seeded out of band, and the production
  bundle excludes the fixture adapter and marker. Next/browser versions and the
  isolated app manifest/lock remain root-owned, resolved and audited at M5-05.
- The generated Telegram worker adds `src/fixtures/telegram-network.ts` and an
  explicit installation call as the first statement of its exported `main`,
  before `launch.createHost`/`host.prepare`. This works for both CLI imports and
  direct execution through the existing runner. It preserves normal generated
  composition, YAML selection, storage admission, real HTTP/client behavior and
  SQLite replay. No runtime option or factory replacement is added.
- Harness preflight validates both overlay hashes and the installation marker
  before launching a child. Missing/wrong-overlay controls fail without contacting
  Telegram. The child wrapper restricts exact origin, dummy token and method;
  all fixture traffic still uses captured native fetch with actual serialized
  bodies and cancellation. Production builds omit both overlay and call.

## Exclusive producer ownership

| Producer | Assigned implementation surface | Root integration boundary |
| --- | --- | --- |
| M5-05 | Optional app server/client/UI and reference tests under `examples/company-app`; narrow owned order-service fixture | App manifest/lock, shared schemas and preexisting app-auth-bridge helpers |
| M5-06 | `scripts/release-smoke/integration-telegram.ts`, static fixture modules under `scripts/release-smoke/integration-fixtures/telegram/`, focused tests | Shared evidence/helpers and actual generated startup overlay are reviewed by root; no production Telegram source change |
| M5-07 | `scripts/release-smoke/integration-{consumer,browser,container,hosted}.ts`, matching focused tests | Root owns top-level `integration-suite.ts`, common evidence validation, manifests and CI |
| M5-08 | Public teaching after behavior stabilizes | Root integrates shared README/roadmap and generated-template parity |

Before assigning each producer, root records exact files and any newly delegated
shared file in the ledger. Independent installed acceptance waits for real storage,
replay and export implementations. A fixture must not replace a missing product
feature. Test suites use `bun:test`; Playwright is a browser API dependency only.

The synthetic order service demonstrates one company's customer records and
explicit grants, not a system of record. Private records do not enter shared
guidance. Public UI transcript history remains ephemeral; acceptance names the
actual durable operation/replay/memory stores and their recovery semantics.

Hosted resource selection, spend/retention limits and private fixture connectivity
remain G4 inputs. Root prepares concrete images and scenarios before requesting
hosted execution approval. No hosted, live IdP, real Telegram or paid-model action
is authorized by this freeze.
