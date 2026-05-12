/**
 * Dockerfile + entrypoint generator for `auggy deploy`.
 *
 * The deploy command writes these strings into the staging dir before
 * `railway up`. ADR-021 cloud design: bake-in the volume symlink dance +
 * `auggy dev --internal-mode railway` invocation so `agent.yaml`'s
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

interface DockerfileOptions {
  agentName: string;
}

export function generateDockerfile(opts: DockerfileOptions): string {
  return `FROM oven/bun:${BUN_VERSION}

WORKDIR /app

# Install auggy globally so the entrypoint can call \`auggy dev\`.
# (Phase 3 of the deploy plan: package will be published as @auggy/cli;
# update this to "@auggy/cli" once published. Until then, build images
# from a workspace clone.)
RUN bun install -g auggy

COPY . /app

# Make the entrypoint executable.
RUN chmod +x /app/auggy-entrypoint.sh

# Railway mounts the persistent volume here.
VOLUME ["/app/data"]

# Railway routes traffic to the port declared by the app via PORT env.
EXPOSE 8080

ENTRYPOINT ["/app/auggy-entrypoint.sh", "${opts.agentName}"]
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

# $1 is the agent name passed by ENTRYPOINT.
exec auggy dev "$1" --internal-mode railway
`;
}
