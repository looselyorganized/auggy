#!/usr/bin/env bash
set -euo pipefail

if ! command -v auggy >/dev/null 2>&1; then
  printf "auggy command not found. Install Auggy or run this from a project with Auggy available.\n" >&2
  exit 127
fi

browser_out="${1:-src/auggy-client.ts}"
server_out="${2:-src/auggy-client.server.ts}"

if [ "$#" -ge 1 ]; then
  shift
fi
if [ "$#" -ge 1 ]; then
  shift
fi

agent_args=("$@")

printf "== browser client: %s ==\n" "$browser_out"
auggy routes "${agent_args[@]}" --client ts --target browser --out "$browser_out"

printf "\n== server client: %s ==\n" "$server_out"
auggy routes "${agent_args[@]}" --client ts --target server --out "$server_out"
