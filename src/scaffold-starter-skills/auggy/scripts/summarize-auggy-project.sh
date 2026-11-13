#!/usr/bin/env bash
set -euo pipefail

project_dir="${1:-.}"
agent_yaml="$project_dir/agent.yaml"
local_cli="$project_dir/node_modules/auggy/src/cli/index.ts"

if [ ! -f "$agent_yaml" ]; then
  printf 'No agent.yaml found at %s\n' "$agent_yaml" >&2
  exit 1
fi
if ! command -v bun >/dev/null 2>&1 || [ ! -f "$local_cli" ]; then
  printf '%s\n' 'Install Bun and the project-local Auggy dependency before inspecting.' >&2
  exit 1
fi

# Disable Bun automatic .env loading as well as using the passive CLI command.
exec bun --no-env-file "$local_cli" inspect --config "$agent_yaml"
