/**
 * Dockerfile + entrypoint generator for `auggy deploy`.
 *
 * The deploy command writes these strings into the staging dir before
 * `railway up`. ADR-021 cloud design: bake-in the volume symlink dance +
 * `auggy run --config /app/agent.yaml --no-open` invocation so `agent.yaml`'s
 * `dbPath: ./<name>.db` paths work unchanged in cloud.
 */

const BUN_VERSION = "1.1-alpine";

/**
 * Known SQLite paths in the agent dir that need to live on the Railway
 * volume across redeploys. Each is symlinked in the entrypoint script:
 *
 *   /app/<name>.db → /app/data/<name>.db   (volume target)
 *
 * The .db files do NOT exist at boot — they're created by SQLite on first
 * attach, following the symlink. WAL/SHM sibling files are created
 * alongside the resolved symlink target (i.e. on the volume).
 *
 * Drift risk (per plan §D2): if a new SQLite-backed augment ships with a
 * non-listed path, its DB falls outside the volume and gets lost on
 * redeploy. Update this list when new augments land. Today's eval suite
 * catches data loss empirically via the cross-session-recall grader.
 */
const SQLITE_DB_NAMES = ["memory.db", "budgets.db", "visitor-auth.db", "link.db"];

export function generateDockerfile(): string {
  return `FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Per-agent install (v0.3.2 package split): the agent's package.json declares
# its own deps — auggy + the chosen engine adapter (@auggy/anthropic|openai|
# openrouter) + any augment-deps (@auggy/link, @supabase/supabase-js, ...).
# Copy the manifest + lockfile first so Docker caches the install layer
# independently of code changes. \`bun.loc[k]\` is a bracket-glob trick that
# silently skips when the lockfile is absent (no failure mode if the agent
# was scaffolded with --skip-install).
COPY package.json /app/
COPY bun.loc[k] /app/
RUN bun install

# Copy the rest of the agent dir (agent.yaml, identity.md, skills/, etc).
# node_modules/ was excluded at staging time so this won't overwrite the
# freshly-installed deps. package.json + bun.lock re-COPY here is a no-op
# (same content) and keeps the agent dir layout intact.
COPY . /app

# Make the entrypoint executable.
RUN chmod +x /app/auggy-entrypoint.sh

# Railway routes traffic to the port declared by the app via PORT env.
EXPOSE 8080

ENTRYPOINT ["/app/auggy-entrypoint.sh"]
`;
}

export function generateEntrypoint(): string {
  const symlinks = SQLITE_DB_NAMES.map((name) => `ln -sf /app/data/${name} /app/${name}`).join(
    "\n",
  );

  return `#!/bin/sh
# Auggy Railway entrypoint.
#
# - The Railway volume is mounted at /app/data (persists across redeploys).
# - SQLite-backed augments (layeredMemory, budgets, visitorAuth, link) write
#   to ./<name>.db; we symlink each name into the volume so paths in
#   agent.yaml stay unchanged between local and cloud.
# - WAL/SHM siblings are created alongside the resolved symlink target by
#   SQLite, i.e. they land on the volume.
# - -f overwrites any prior symlink so redeploys don't fail on the second run.
# - The .db files don't need to exist at boot — SQLite creates them on first
#   attach, following the symlink to the volume.
#
# Drift risk: when a new SQLite-backed augment ships, add its .db name to the
# SQLITE_DB_NAMES list in src/cli/deploy/dockerfile.ts.

set -e

mkdir -p /app/data

${symlinks}

# bunx resolves auggy from the per-agent node_modules/ (installed in the
# Dockerfile via \`bun install\`). v0.3.2 removed the global-install path
# because the agent's pinned auggy version + engine adapter is what the
# image must use, not whatever a stray global has.
exec bunx auggy run --config /app/agent.yaml --no-open
`;
}
