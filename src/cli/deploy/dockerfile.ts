/**
 * Dockerfile + entrypoint generator for `auggy deploy`.
 *
 * The deploy command writes these strings into the staging dir before
 * `railway up`. ADR-021 cloud design: admit only the expected Railway volume,
 * keep the external link augment's compatibility symlink, and launch via
 * `auggy dev <name> --config /app/agent.yaml --internal-mode railway`.
 */

import { DEPLOYMENT_MANIFEST_ENV, DEPLOYMENT_TOOLCHAIN, type DeploymentProfile } from "./contracts";
import { validateDeploymentProfile } from "./profile";
import { validateBundleRelativePath } from "./bundle";

const BUN_VERSION = "1.3.14-alpine";

/**
 * External link storage still needs a compatibility path in the agent dir.
 *
 *   /app/<name>.db → /app/data/<name>.db   (volume target)
 *
 * The .db files do NOT exist at boot — they're created by SQLite on first
 * attach, following the symlink. WAL/SHM sibling files are created
 * alongside the resolved symlink target (i.e. on the volume).
 *
 * Core SQLite augments use the runtime-owned /app/data tree directly because
 * hardened storage rejects database symlinks.
 */
const SQLITE_DB_NAMES = ["link.db"];

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
# - Core SQLite augments write directly to /app/data. The external link
#   augment retains one compatibility symlink to its volume-backed database.
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
chmod 0700 /app/data
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

# Resolve only the explicitly installed package's declared executable. Never
# let a command runner install a missing runtime or fall back to a global one.
# The selected CLI performs application/capability preflight before importing it.
runtime_cli="$(bun -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.realpathSync("/app/node_modules/auggy");
  const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.auggy;
  if (pkg.name !== "auggy" || typeof bin !== "string" || !bin || path.isAbsolute(bin)) throw new Error("Invalid local Auggy CLI");
  const entry = fs.realpathSync(path.resolve(root, bin));
  const rel = path.relative(root, entry);
  if (rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) || !fs.statSync(entry).isFile()) throw new Error("Invalid local Auggy CLI");
  process.stdout.write(entry);
')"
exec bun "$runtime_cli" dev "$1" --config /app/agent.yaml --internal-mode railway
`;
}

export interface PortableDockerOptions {
  readonly agentName: string;
  readonly configPath: string;
  readonly profile: DeploymentProfile;
  readonly dependencyTarballs: readonly string[];
}

/** Generic image generation has no Railway bootstrap and never creates a durable root. */
export function generatePortableDockerfile(options: PortableDockerOptions): string {
  return generateProfiledDockerfile(options, true);
}

/** Explicit legacy tarball compatibility: pinned image, but install remains unfrozen. */
export function generateRailwayCompatibilityDockerfile(
  options: Omit<PortableDockerOptions, "dependencyTarballs"> & {
    readonly runtimeTarballName?: string;
  },
): string {
  return generateProfiledDockerfile(
    {
      ...options,
      dependencyTarballs: options.runtimeTarballName ? [options.runtimeTarballName] : [],
    },
    false,
  );
}

function generateProfiledDockerfile(options: PortableDockerOptions, frozen: boolean): string {
  validateDeploymentProfile(options.profile);
  validateBundleRelativePath(options.configPath);
  if (options.configPath.includes("$"))
    throw new Error(
      "[portable-export] Selected config paths containing $ are outside the supported Docker path profile; select a literal filename.",
    );
  const copies = options.dependencyTarballs.map((path) => {
    validateBundleRelativePath(path);
    if (path.includes("$"))
      throw new Error(
        "[portable-export] Dependency archive paths containing $ are unsupported because Docker COPY expands environment variables.",
      );
    // Docker applies Go filepath matching even to JSON-form COPY source operands.
    const literal = path.replace(/[[*?]/g, (character) =>
      character === "[" ? "[[]" : `[${character}]`,
    );
    return `COPY ${JSON.stringify([literal, `/app/${path}`])}`;
  });
  return `FROM ${DEPLOYMENT_TOOLCHAIN.image}@${DEPLOYMENT_TOOLCHAIN.imageDigest}

WORKDIR /app
${frozen ? 'COPY ["package.json", "bun.lock", "/app/"]' : 'COPY ["package.json", "/app/"]\nCOPY bun.loc[k] /app/'}
${copies.length ? `${copies.join("\n")}\n` : ""}${frozen ? "RUN bun install --frozen-lockfile" : "# Legacy external archive compatibility; not a portable frozen-build certification.\nRUN bun install"}

COPY . /app
ENV AUGGY_DATA_DIR=/app/data
${frozen ? `ENV ${DEPLOYMENT_MANIFEST_ENV}=/app/auggy-deployment.json\n` : ""}\
${options.profile.kind === "http" ? `ENV PORT=${options.profile.port}\nEXPOSE ${options.profile.port}\n` : ""}
ENTRYPOINT ${JSON.stringify(["/app/auggy-entrypoint.sh", options.agentName, `/app/${options.configPath}`])}
`;
}

export function generatePortableEntrypoint(): string {
  return generateForegroundEntrypoint("generic");
}

export function generateRailwayEntrypoint(): string {
  return generateForegroundEntrypoint("railway");
}

function generateForegroundEntrypoint(platform: "generic" | "railway"): string {
  return `#!/bin/sh
# Foreground ${platform} launch. Provision durable storage before starting the image.
# Runtime admission validates ownership, identity and leases before any factory.
set -eu
umask 077
runtime_cli="$(bun --no-env-file --no-install --config=/dev/null -e '
  const fs = require("node:fs");
  const path = require("node:path");
  const root = fs.realpathSync("/app/node_modules/auggy");
  const manifest = path.join(root, "package.json");
  if (!fs.lstatSync(manifest).isFile() || fs.statSync(manifest).size > 1048576) throw new Error("Invalid local Auggy manifest");
  const pkg = JSON.parse(fs.readFileSync(manifest, "utf8"));
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.auggy;
  if (pkg.name !== "auggy" || typeof bin !== "string" || !bin || path.isAbsolute(bin)) throw new Error("Invalid local Auggy CLI");
  const declared = path.resolve(root, bin);
  if (!fs.lstatSync(declared).isFile()) throw new Error("Invalid local Auggy CLI");
  const entry = fs.realpathSync(declared);
  const rel = path.relative(root, entry);
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel)) throw new Error("Invalid local Auggy CLI");
  process.stdout.write(entry);
')"
exec bun --no-env-file --no-install --config=/dev/null "$runtime_cli" dev "$1" --config "$2"${platform === "railway" ? " --internal-mode railway" : ""}
`;
}
