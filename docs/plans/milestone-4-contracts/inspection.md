# C3 — passive declarations and installed source navigation

Proposed contract for the [M4 execution plan](../milestone-4-execution-2026-11-13.md).
Inspection answers where declared execution and capabilities live. It does not
pretend to statically discover arbitrary TypeScript factory output.

## Command and import boundary

`auggy inspect [name] --config <path> [--json]` follows existing project selection.
Text is navigable and concise; JSON is schema-versioned. Both use the same pure
report. No `--runtime` option is added: `auggy routes` is the existing explicitly
executing route inspection, with its own manifest/OpenAPI/client guarantees.

Passive project selection must itself use bounded regular-file snapshots. The
current `resolveConfigPath(name)` can read YAML through unbounded `readAgentName`,
and `inspectProjectRuntime` reads package manifests without these bounds and
conflates some missing/corrupt cases. Reuse their selection rules, not an unsafe
pre-read: introduce a passive bounded selector and root-owned snapshot-based
metadata classification where needed. No check-then-unbounded-read wrapper.
Distinguish missing optional package/index files from invalid JSON/schema, and
reject FIFOs/devices, excessive size/depth and symlink escapes before blocking.
Actual CLI controls cover config/name lookup, project manifest, runtime manifest
and source index, not only the final report reader. Root owns any shared helper
edits; M4-06 owns the passive selector and focused tests.

The actual binary must dispatch passive `inspect` and migration document handling
before loading `cli-program.ts`: that program currently imports routes/dev and
the resolver, which eagerly imports built-in code. Root owns the minimal
pre-dispatch integration and shared grammar; M4-06 owns the passive handler.
Do not rewrite the entire CLI or change existing launch delegation. CLI help and
programmatic command registration share the same grammar to prevent divergence.

The invoking CLI can inspect/migrate declarations even when an older local CLI
does not implement those commands. It does not delegate passive inspection into
the local executable. Report inspector CLI version separately from inspected
runtime provenance; all builtin source mappings come from the selected project's
installed metadata, never the invoking CLI's catalog as a fallback. Runtime
launch commands keep M3's project-local selection/capability protocol.

No project application/custom imports, selected runtime/provider/builtin module
evaluation, factories, lifecycle hooks, databases, provider/network calls,
listener binding, env interpolation or mutation of environment values. Read-only
project selection must not call helpers that clean PID registries as a side effect.
Do not call `parseConfig`, `inspectAugmentRoutes` or custom runtime validators.
Migrate preview and its pure loader obey this boundary too; credential setup does
not become a passive command merely because it edits configuration.

Be precise about `.env`: application inspection code must not explicitly read it
or use its values. Bun itself can load `.env` before JavaScript executes under the
current `#!/usr/bin/env bun` launcher. Do not promise that ordinary invocation
prevents Bun's startup read. Test the stronger no-read property under
`bun --no-env-file <installed-cli> inspect`, and normal invocation's no-use/no-leak
property separately. The supported switch is documented in
[Bun environment variables](https://bun.sh/docs/runtime/environment-variables).
Changing every command's environment-loading behavior is outside M4.

## Report schema 1

M4-00 freezes the TypeScript interface plus example JSON for these fields:

| Field | Meaning |
| --- | --- |
| `schemaVersion`, `status` | Version 1; `complete`, `partial` or `invalid` |
| `inspector` | CLI package version used to read the declaration |
| `project` | Selected config path, declared name/identity reference, inline/referenced/mixed format |
| `application` | Declared entrypoint/contract, validated path or explicit unavailable reason; legacy mode when absent |
| `runtime` | Selected local package root/version/manifest digest and capability availability; never global fallback |
| `execution` | Project startup/HTTP/turn paths where known from the generated layout; installed runtime landmarks from its index |
| `augments` | Declaration order, instance name/type, config provenance, option key names, environment reference names, source ownership/path/status |
| `runtimeDiscovery` | Explicit `not-evaluated` for tools/routes/hooks/synthetic augments; directs to runtime route inspection |
| `diagnostics` | Bounded codes, relevant path/field and actionable remedy; no raw secret-bearing values |

Application declaration proves the entrypoint, not the existence of arbitrary
`http.ts`/`turn.ts` imports. For standard generated siblings, label the map
`conventional-project-files`; verify existence but do not claim AST/dataflow
analysis. An edited/custom application can have unknown composition/HTTP/turn
locations. Runtime behavior is demonstrated by C4, not inferred from filenames.

Do not print raw options, resolved env values, auth configuration, request bodies
or parser source excerpts. Names, source locations and placeholder variable names
are deliberate navigation data; sanitize/control-bound output and redact URL
credentials. Invalid source representations receive codes, not raw strings.
Do not hash or expose credentials as provenance.

Sources may be unresolved when their path contains environment placeholders.
Report the raw declaration as a placeholder reference where safe; do not expand
it. Existing external custom source references are supported read-only and marked
external/nonportable, not mistaken for package-owned code. Never import or copy
that source. Application paths retain M3's containment constraints; builtin index
paths must remain inside the exact installed package.

Declared config is not the entire runtime inventory. The runtime may synthesize
skills, self-guidance, memory buses or notification surfaces; actual tools/routes
also depend on factories. Label this honestly and do not add another static
tool/route definition DSL simply to make inspection look complete.

## Installed source index

Ship data-only `src/metadata/source-index.json` inside the actual core tarball:

```json
{
  "schemaVersion": 1,
  "runtime": {
    "application": "src/application/runner.ts",
    "host": "src/application/host.ts",
    "turn": "src/kernel/turn-session.ts"
  },
  "augments": [
    {
      "type": "layeredMemory",
      "entrypoint": "src/augments/layeredMemory/index.ts",
      "directory": "src/augments/layeredMemory"
    },
    {
      "type": "webTransport",
      "entrypoint": "src/transports/web-transport.ts"
    }
  ]
}
```

This fragment illustrates shape, not complete coverage. M4-00 verifies each
landmark against main. Index generation uses explicit source metadata next to
the catalog plus supported non-picker types. The parity fixture must cover every
resolver-supported declarable built-in except `custom`, including `skills` and
`supabaseMemory`. A catalog picker alone is not that set. For wrappers such as
Link, identify the installed Auggy adapter accurately; do not call it the complete
external package implementation.

The index never enables an augment or supplies options/security decisions. Do not
add fields to strict `auggyRuntime` metadata. A separate versioned JSON file avoids
changing the M3 launcher schema. Root integrates generation/validation in prepack;
the inspection specialist owns metadata and parity tests.

Use metadata-only project package selection rooted at
`<project>/node_modules/auggy`. Read the selected package's index with bounded
regular-file JSON reads, not imports. Validate schema, duplicate types, path kinds,
relative paths, realpath containment and actual file/directory existence. Reject
index paths that escape through traversal or symlinks. Do not synthesize paths
from augment names or use the global installation when local metadata is absent.
Package version/root/manifest digest is sufficient navigation provenance; C4
separately hashes installed artifacts and verifies the packed index.

## Incomplete versus invalid

- Valid declaration with missing local dependencies/index, an older index schema,
  unsupported application capability, unresolved placeholder source, unknown type
  mapping, or missing custom source: `partial`, exit 0, explicit unavailable fields
  and remedies. This is not a readiness verdict. Users can inspect broken projects.
- Malformed/oversized/ambiguous YAML, missing referenced metadata needed to read
  the graph, invalid field types, corrupt/duplicate known-schema index records,
  invalid selected-package metadata or unsafe contained paths: `invalid`, exit 1.
- CLI syntax: established nonzero grammar error. JSON mode emits a schema-shaped
  diagnostic without secret-bearing stack/source excerpts; stdout contains one
  report only. Unknown future index schema is unavailable, not guessed compatible.

Negative controls must exercise the installed executable, not just the pure
function: imported module sentinels throw/write/contact a trap endpoint if reached;
missing secrets, malformed env, alternate global/local indexes, missing package,
legacy/mixed graphs, stale source metadata and path escapes are covered. Record
zero provider/factory/lifecycle calls and no project/store writes.
