# Retained-lock upgrade fixture

This is a real Bun 1.3.14 consumer lock created from the exact `29147df` core and Anthropic adapter source. The baseline package is packed with lifecycle scripts disabled and never executed. The fixture represents a recreated historical dependency graph, not a claim that this installation was captured on the original commit date.

The initial generation temporarily declared MCP 1.29.0, Zod 4.3.6 and Hono 4.12.34 as direct seed dependencies. Removing those three declarations and running `bun install --ignore-scripts` retained their transitive versions. A subsequent `bun install --ignore-scripts --frozen-lockfile` passed. The final application manifest contains only the two Auggy packages and the original generated `@hono/node-server: 2.0.11` override. `provenance.json` records file/artifact hashes and this history.

Regenerate deliberately with Bun 1.3.14, then review all fixture changes:

```sh
bun scripts/release-smoke/upgrade-consumer.ts --repo-root "$PWD" --regenerate-fixture
```

Ordinary smoke never regenerates the dependency graph. It rebuilds baseline artifacts from the recorded Git commit, verifies their package metadata against that source, copies this lock, and performs a frozen install. If npm's portable tar encoding differs across environments, only the two local artifact SHA-512 integrity entries are rebound. All registry package versions, integrity values, dependency edges and workspace declarations remain unchanged. Both original and materialized lock hashes are recorded.

The test preserves the lock and installed `node_modules` directory through a content-different candidate upgrade. For the foundation candidate this exercises same-version artifact replacement; later versioned releases use the same path and record that distinction. Downgrades are rejected. It first proves that the old application-owned override remains unsafe. The positive migration merges the candidate's `SCAFFOLD_SECURITY_OVERRIDES` into the consumer manifest and runs an ordinary scripts-disabled install; it does not delete the lock, dependencies or user source. Candidate code is hashed against its tarball before the upgraded consumer's own local CLI runs the seven packed execution scenarios.

Finally, selecting `@auggy/link` produces a separate complete-graph audit. An unresolved Link advisory is a failing result, even if the core upgrade and execution scenarios pass. No audit exemption or cross-major Zod override is applied.
