# Foundation dependency closure — 2026-11-12

Base: `dc03a00f30324feb91567e0094cd9e7cf493ad2f`. Verification used Bun 1.3.14 and Node 24.11.1. Registry/advisory checks were captured on 2026-11-13 UTC (2026-11-12 Pacific).

The safe dependency changes are implemented. **Dependency closure remains blocked by the optional Link package’s Zod 3 dependency.** The final full-workspace audit exits 1 with `GHSA-mrhx-c7xc-m3w5`; no advisory was suppressed or accepted as an exception. A passing core-only consumer audit would not close the workspace or Link-selected consumer gate.

## Per-advisory dispositions

The prior saved audit contained 23 advisories across 10 packages. The current feed added five Hono advisories; all 28 records are accounted for below. Dependency versions are actual locked resolutions, not merely manifest ranges.

| Advisory | Package and exposure | Disposition |
| --- | --- | --- |
| [GHSA-6qxp-vccf-f47h](https://github.com/advisories/GHSA-6qxp-vccf-f47h) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-22jm-h49p-29qw](https://github.com/advisories/GHSA-22jm-h49p-29qw) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-46jr-4wx8-v453](https://github.com/advisories/GHSA-46jr-4wx8-v453) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-6prh-2h8m-c8cw](https://github.com/advisories/GHSA-6prh-2h8m-c8cw) | `@modelcontextprotocol/sdk` — Core runtime: MCP client; SDK also installs server/Express code. | Raised direct minimum to ^1.32.0; lock 1.32.2. Existing client transport and stdio tests pass. See server-limit qualification below. |
| [GHSA-gcqx-w48m-w2h4](https://github.com/advisories/GHSA-gcqx-w48m-w2h4) | `deepmerge` — Development: admin → shadcn. | Removed shadcn generator from installed graph. No patched compatible deepmerge release verified. |
| [GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249) | `minimatch` — Development: admin → shadcn → ts-morph → common. | Removed generator graph. No cross-major minimatch 11 override of parent ^10. |
| [GHSA-rj75-hqrm-r3gf](https://github.com/advisories/GHSA-rj75-hqrm-r3gf) | `postcss-selector-parser` — Development: admin → shadcn. | Removed generator graph; no installed occurrence remains. |
| [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h) | `proxy-addr` — Runtime transitive: MCP SDK → Express. | Compatible override 2.0.8, including generated consumer policy. |
| [GHSA-x5fp-wj9c-mxmx](https://github.com/advisories/GHSA-x5fp-wj9c-mxmx) | `qs` — Runtime transitive: MCP SDK → Express/body-parser. | Compatible override 6.16.1, including generated consumer policy. |
| [GHSA-4mjr-xmp4-gh2g](https://github.com/advisories/GHSA-4mjr-xmp4-gh2g) | `qs` — Runtime transitive: MCP SDK → Express/body-parser. | Compatible override 6.16.1, including generated consumer policy. |
| [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw) | `qs` — Runtime transitive: MCP SDK → Express/body-parser. | Compatible override 6.16.1, including generated consumer policy. |
| [GHSA-68fv-2mgg-jv7q](https://github.com/advisories/GHSA-68fv-2mgg-jv7q) | `source-map-js` — Development: Tailwind/PostCSS console build. | Compatible override 1.2.2; console build passes. |
| [GHSA-3f7j-7jwc-fxfj](https://github.com/advisories/GHSA-3f7j-7jwc-fxfj) | `systeminformation` — Development: admin → shadcn → dotenvx. | Removed generator graph; no installed occurrence remains. |
| [GHSA-4vjg-vx72-qq4g](https://github.com/advisories/GHSA-4vjg-vx72-qq4g) | `systeminformation` — Development: admin → shadcn → dotenvx. | Removed generator graph; no installed occurrence remains. |
| [GHSA-7648-jmwf-vw7j](https://github.com/advisories/GHSA-7648-jmwf-vw7j) | `systeminformation` — Development: admin → shadcn → dotenvx. | Removed generator graph; no installed occurrence remains. |
| [GHSA-9jrq-w75r-8gcw](https://github.com/advisories/GHSA-9jrq-w75r-8gcw) | `vite` — Development: console dev server/build. | Raised minimum to ^6.4.4; lock 6.4.6. Console build passes. |
| [GHSA-rq7h-c2jc-7f22](https://github.com/advisories/GHSA-rq7h-c2jc-7f22) | `vite` — Development: console dev server/build. | Raised minimum to ^6.4.4; lock 6.4.6. Console build passes. |
| [GHSA-698v-4r3x-3vcv](https://github.com/advisories/GHSA-698v-4r3x-3vcv) | `vite` — Development: console dev server/build. | Raised minimum to ^6.4.4; lock 6.4.6. Console build passes. |
| [GHSA-r825-w8mm-5pxw](https://github.com/advisories/GHSA-r825-w8mm-5pxw) | `vite` — Development: console dev server/build. | Raised minimum to ^6.4.4; lock 6.4.6. Console build passes. |
| [GHSA-587h-7wmj-h5pm](https://github.com/advisories/GHSA-587h-7wmj-h5pm) | `vite` — Development: console dev server/build. | Raised minimum to ^6.4.4; lock 6.4.6. Console build passes. |
| [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5) | `zod` — Direct core/evals runtime, plus optional Link runtime. | Core/evals minimum ^4.6.6, lock 4.6.7. Link 0.1.2 still resolves 3.25.76: OPEN, blocks merge/release; no exception. |
| [GHSA-4m76-xfj5-7975](https://github.com/advisories/GHSA-4m76-xfj5-7975) | `hono` — Runtime transitive: MCP SDK and optional Link. | New feed findings: compatible override 4.13.16 in workspace and generated consumer policy; Link/MCP tests pass. |
| [GHSA-h7mg-cq63-vhpq](https://github.com/advisories/GHSA-h7mg-cq63-vhpq) | `hono` — Runtime transitive: MCP SDK and optional Link. | New feed findings: compatible override 4.13.16 in workspace and generated consumer policy; Link/MCP tests pass. |
| [GHSA-3gg2-335m-rxc6](https://github.com/advisories/GHSA-3gg2-335m-rxc6) | `hono` — Runtime transitive: MCP SDK and optional Link. | New feed findings: compatible override 4.13.16 in workspace and generated consumer policy; Link/MCP tests pass. |
| [GHSA-46wx-v44x-9hh2](https://github.com/advisories/GHSA-46wx-v44x-9hh2) | `hono` — Runtime transitive: MCP SDK and optional Link. | New feed findings: compatible override 4.13.16 in workspace and generated consumer policy; Link/MCP tests pass. |
| [GHSA-4h7h-rv7c-7m2v](https://github.com/advisories/GHSA-4h7h-rv7c-7m2v) | `hono` — Runtime transitive: MCP SDK and optional Link. | New feed findings: compatible override 4.13.16 in workspace and generated consumer policy; Link/MCP tests pass. |

## Runtime dependency policy

`src/cli/scaffold-package-json.ts` exports the consumer-owned security resolutions. The generated agent receives only the seven overrides found by walking the installed core’s production dependency graph: `@hono/node-server@2.1.6`, `body-parser@2.4.0`, `fast-uri@3.1.9`, `hono@4.13.16`, `ip-address@10.7.4`, `proxy-addr@2.0.8`, and `qs@6.16.1`. Build-only pins such as PostCSS/source-map-js are excluded. The workspace retains its other previously reviewed pins.

A dependency package’s overrides are not inherited by its consumer. An existing agent must deliberately merge this reviewed policy into its own package manifest, preserve unrelated fields, install against the retained lock, inspect effective versions, and audit the resulting graph. Installing a new core tarball alone cannot override an old consumer-owned pin. The separate retained-lock upgrade acceptance test verifies that boundary; the `0.5.0` A/B tarball test is a local artifact test, not a published version upgrade or a release authorization.

The MCP runtime integration is a client in `src/augments/mcp/sdk-adapter.ts`, using bounded/redirect-rejecting fetch adapters. No production `McpServer` or SDK HTTP server factory was found in `src/` or `packages/`. The server allocation advisory explicitly requires `maxToolInputElements` and request-size limits for applications exposing an SDK server; upgrading alone is insufficient. We do not claim that future SDK server integrations are secured by the version bump. Existing SDK server compatibility import tests are test-only.

## Link: precise open blocker

`@auggy/link@0.1.2` is the latest verified registry release and requires `zod: ^3.23.0`. Its actual nested resolution is 3.25.76. The advisory marks versions below 4.6.6 as affected; the complete official registry list confirms 3.25.76 is the highest stable v3 release, and no newer Link release was verified (`zod@3.26.0` also returned 404). A global Zod 4 override would violate Link’s declared major-version contract and is not applied.

Link is a root development dependency for tests/typechecking, but becomes a customer runtime dependency when the preview Link augment is selected. In `src/augments/link/index.ts`, `importFromAgent` loads the installed Link SDK, `createLinkApp` builds its app, and `Bun.serve` serves it. Therefore this cannot be dismissed as development-only.

The verified inbound path in the published SDK is `POST /a2a/v1` → body-size middleware → bearer authentication → per-peer rate limit → JSON-RPC dispatcher → message/send or message/stream parameter validation. `MessageSendParamsSchema` defines `parts: z.array(PartSchema).min(1)` without a maximum collection size. The byte guard defaults to 1 MiB; `LINK_MAX_REQUEST_BYTES=0` disables it. These protections narrow inbound exposure to authenticated peers under the configured body policy; they do not establish a validation-allocation bound.

The outbound path is separate: a configured address-book peer is fetched by `client/peer.js`; `response.text()` reads its body without an explicit byte limit, then JSON.parse and the result schemas validate it. Request timeout/abort protection is present, but does not impose a response-byte or collection-element limit. A configured or compromised peer can supply that response. The inbound HTTP body guard does not cover this path.

Source inspection of installed Zod 3 shows `ZodArray._parse` maps every element, including after a maximum-length issue, and `addIssueToContext` appends each validation issue without an issue cap. A bounded check with only 1, 4, and 8 ordinary invalid parts produced 1, 4, and 8 issues. No oversized payload, resource-exhaustion attempt, network listener, or exploit was run. This verifies the allocation mechanism; it does not claim a demonstrated crash at the default HTTP limit.

**Required closure:** obtain a reviewed compatible Link fix (including bounded response reading and validation work where needed), or approve a deliberate Link migration/removal in a separate scoped change. Then rerun Link compatibility/authorization tests, full workspace audit, and a Link-selected packed-consumer audit. No package publish, major override, or risk exception is authorized by this work. Until then the strict security gate should remain red, and M3 implementation/merge/release should remain blocked.

## Exact console stylesheet preservation and generator quarantine

The committed lock actually selected `shadcn@4.14.1` despite the manifest range beginning at 4.13.0. `admin/src/vendor/shadcn/tailwind.css` and `LICENSE.md` are copied byte-for-byte from that exact npm tarball, after SHA-512 integrity verification. The CSS contains no imports or URL references. `provenance.json` records source paths, package version, registry/tarball URLs, integrity, hashes, base revision, and zero modifications. CSS SHA-256: `bc7d83425702955b4cb67cb14ede9d603f9d912376d57a2d81d661094d2a782a`. License SHA-256: `1564074e13439397221ffd522e2e504d56561994a23d371aa5e3ad43e4f5423f`.

The import now uses that local CSS, the generator dependency is removed, and the root package files list explicitly carries the upstream MIT notice with the bundled console. Existing generated registry primitives remain owned by the console. Contract tests verify the recorded file hashes, local import, generator absence, and packed license inclusion declaration; an isolated-cache `npm pack --dry-run --ignore-scripts` also confirms that the notice is included. The console build verifies that the unchanged utilities still compile into its actual production bundle.

The current generator remains quarantined, including from ad hoc `bunx shadcn@latest` use. Latest `shadcn@4.23.0` still requests `deepmerge: ^4.3.1` and `ts-morph: ^26.0.0`; no verified generator update closes both chains. For future updates: choose an exact audited generator in a separate maintenance workspace, resolve findings before execution, generate in the sibling `auggy-ui` registry, review generated source, and sync only reviewed output. To update the vendored CSS, verify the new archive integrity, preserve its exact asset and license, update provenance hashes, and run console tests/build. Do not reformat the vendored files.

## Validation and evidence

Evidence is retained outside tracked source at `.worktrees/foundation-evidence-2026-11-12/closure/dependencies/`: `toolchain.json`, registry metadata, 28 official advisory JSON records, integrity-verified upstream archives, install/frozen-install command records, focused test logs, console build/test logs, typecheck/lint records, runtime dependency paths, and `link-bounded-validation.json`. Every gate record contains the exact command, working directory, UTC start time, duration, and exit code. The initial audit preserves the newly discovered Hono findings; `workspace-audit-final.log` preserves the remaining Link/Zod finding.

Confirmed at writing: frozen installation passes; 160 focused provider/scaffold/helper/MCP/Link tests pass; strict TypeScript, owned-file lint, all 360 console tests, and the console production build pass. Whole-workspace lint must be rerun after the concurrent upgrade-harness owner finishes formatting; its in-progress file was the only error in the second lint attempt. The final full-workspace audit fails with the single known Link/Zod advisory. Parent integration owns full runtime/packed tests and exact-commit Linux/PostgreSQL/CodeQL certification; these are not claimed complete here.
