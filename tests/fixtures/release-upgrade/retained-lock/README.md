# Retained-lock upgrade fixture

This is a real Bun 1.3.14 consumer lock created from the exact `29147df` core and Anthropic adapter source. The baseline package is packed with lifecycle scripts disabled and never executed. The fixture represents a recreated historical dependency graph, not a claim that this installation was captured on the original commit date.

The initial generation temporarily declared MCP 1.29.0, Zod 4.3.6 and Hono 4.12.34 as direct seed dependencies. Removing those three declarations and running `bun install --ignore-scripts` retained their transitive versions. A subsequent `bun install --ignore-scripts --frozen-lockfile` passed. The final application manifest contains only the two Auggy packages and the original generated `@hono/node-server: 2.0.11` override. `provenance.json` records file/artifact hashes and this history.

Regenerate deliberately with Bun 1.3.14, then review all fixture changes:

```sh
bun scripts/release-smoke/upgrade-consumer.ts --repo-root "$PWD" --regenerate-fixture
```

Ordinary smoke never regenerates the dependency graph. It rebuilds baseline artifacts from the recorded Git commit, verifies their package metadata against that source, copies this lock, and performs a frozen install. If npm's portable tar encoding differs across environments, only the two local artifact SHA-512 integrity entries are rebound. All registry package versions, integrity values, dependency edges and workspace declarations remain unchanged. Both original and materialized lock hashes are recorded.

The test preserves the lock and installed `node_modules` directory through a content-different candidate upgrade. For the foundation candidate this exercises same-version artifact replacement; later versioned releases use the same path and record that distinction. Downgrades are rejected. It first proves that the old application-owned override remains unsafe. The positive migration merges the candidate's `SCAFFOLD_SECURITY_OVERRIDES` into the consumer manifest and runs an ordinary scripts-disabled install; it does not delete the lock, dependencies or user source. Candidate code is hashed against its tarball before the upgraded consumer's own local CLI runs the seven packed execution scenarios.

Link uses a separate consumer copied from this unchanged historical fixture. Before upgrading, it installs exact Link 0.1.2 with scripts disabled, selects Link in old-compatible YAML, and records application/configuration/workspace hashes and installed-directory identity. Neither the old core nor old Link executes. The subsequent installation updates core, provider, Link and the reviewed override policy together while retaining that consumer's lock and installed directory. Installed core files are compared with both artifacts, including files that distinguish same-version A from B.

The candidate Link range comes from the installed candidate core's augment catalog. Both the upgraded Link-selected consumer and an independent fresh selected consumer must pass a full dependency audit and real installed Link listener/PeerClient/provider/tool checks. Temporary acceptance wiring is restored and the retained source hashes are rechecked; this proves configuration preservation and runtime interoperability, not execution of the original fixture's placeholder settings. Synchronous Link Message responses are not claimed to provide durable task replay. The seven web transport scenarios remain separate.

An optional `--candidate-link /absolute/reviewed-link.tgz` permits an explicitly labeled local artifact experiment before registry publication. Its package name/version must satisfy the candidate catalog, and installed implementation hashes must match the archive. This is not registry-release acceptance: normal release smoke omits the option and installs the catalog's registry range. No audit exemption or cross-major Zod override is applied; any selected-consumer audit failure still fails the gate.
