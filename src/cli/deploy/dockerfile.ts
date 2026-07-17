/**
 * Dockerfile + entrypoint generator for `auggy deploy`.
 *
 * The deploy command writes these strings into the staging dir before
 * `railway up`. ADR-021 cloud design: admit only the expected Railway volume,
 * keep compatibility symlinks for legacy SQLite augments, and launch via
 * `auggy dev <name> --config /app/agent.yaml --internal-mode railway`.
 */

const BUN_VERSION = "1.2.14-alpine";

/**
 * Legacy SQLite paths in the agent dir that need to live on the Railway
 * volume across redeploys. Each is symlinked in the entrypoint script:
 *
 *   /app/<name>.db → /app/data/<name>.db   (volume target)
 *
 * The .db files do NOT exist at boot — they're created by SQLite on first
 * attach, following the symlink. WAL/SHM sibling files are created
 * alongside the resolved symlink target (i.e. on the volume).
 *
 * New stateful augments must use the runtime-owned /app/data tree directly;
 * do not extend this compatibility list. AgentMail deliberately does not use
 * a symlink because its hardened storage rejects them.
 */
const SQLITE_DB_NAMES = ["memory.db", "budgets.db", "visitor-auth.db", "link.db"];

interface DockerfileOptions {
  agentName: string;
  runtimeTarballName?: string;
}

export function generateDockerfile(opts: DockerfileOptions): string {
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
${opts.runtimeTarballName ? `COPY ${opts.runtimeTarballName} /app/\n` : ""}\
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

ENTRYPOINT ["/app/auggy-entrypoint.sh", "${opts.agentName}"]
`;
}

export function generateEntrypoint(): string {
  const sqliteNames = SQLITE_DB_NAMES.join(" ");

  return `#!/bin/sh
# Auggy Railway entrypoint.
#
# - Refuse startup unless Railway reports the expected /app/data mount and the
#   mount already exists. Never create the mount point: a missing volume must
#   not silently degrade to the container's ephemeral filesystem.
# - AgentMail writes directly below /app/data/agent-mail with private modes.
# - Legacy SQLite augments (layeredMemory, budgets, visitorAuth, link) still
#   write to ./<name>.db; compatibility symlinks keep those files on-volume.
# - WAL/SHM siblings are created alongside the resolved symlink target by
#   SQLite, i.e. they land on the volume.
# - -f overwrites any prior symlink so redeploys don't fail on the second run.
# - The .db files don't need to exist at boot — SQLite creates them on first
#   attach, following the symlink to the volume.
#
# New durable state must use /app/data directly rather than adding symlinks.

set -e

if [ "\${RAILWAY_VOLUME_MOUNT_PATH:-}" != "/app/data" ]; then
  echo "Auggy Railway startup refused: RAILWAY_VOLUME_MOUNT_PATH must equal /app/data." >&2
  exit 1
fi

if [ ! -d /app/data ] || [ -L /app/data ]; then
  echo "Auggy Railway startup refused: /app/data is not a mounted directory." >&2
  exit 1
fi

umask 077
if [ -L /app/data/agent-mail ]; then
  echo "Auggy Railway startup refused: /app/data/agent-mail must not be a symlink." >&2
  exit 1
fi
mkdir -p -m 0700 /app/data/agent-mail
chmod 0700 /app/data/agent-mail

for db_name in ${sqliteNames}; do
  volume_db="/app/data/$db_name"
  app_db="/app/$db_name"

  # Refuse links, directories, devices, and sockets at every SQLite artifact
  # name before either SQLite or chmod can follow them.
  for artifact in "$volume_db" "$volume_db-wal" "$volume_db-shm" "$volume_db-journal"; do
    if [ -L "$artifact" ]; then
      echo "Auggy Railway startup refused: $artifact must not be a symlink." >&2
      exit 1
    fi
    if [ -e "$artifact" ] && [ ! -f "$artifact" ]; then
      echo "Auggy Railway startup refused: $artifact must be a regular file." >&2
      exit 1
    fi
    if [ -f "$artifact" ]; then
      chmod 0600 "$artifact"
    fi
  done

  if [ -e "$app_db" ] && [ ! -L "$app_db" ]; then
    echo "Auggy Railway startup refused: $app_db must be a compatibility symlink." >&2
    exit 1
  fi
  ln -sfn "$volume_db" "$app_db"
done

# bunx resolves auggy from the per-agent node_modules/ (installed in the
# Dockerfile via \`bun install\`). v0.3.2 removed the global-install path
# because the agent's pinned auggy version + engine adapter is what the
# image must use, not whatever a stray global has.
#
# $1 keeps compatibility with auggy versions whose dev command requires a
# positional name. --config remains authoritative, so cloud boot does not
# rely on local agent discovery under ~/.auggy.
exec bunx auggy dev "$1" --config /app/agent.yaml --internal-mode railway
`;
}
