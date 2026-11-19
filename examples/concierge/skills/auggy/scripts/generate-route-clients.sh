#!/usr/bin/env bash
set -euo pipefail

cli=./node_modules/.bin/auggy
if [[ ! -x "$cli" ]]; then
  printf '%s\n' "Missing project-local Auggy. Run bun install in the agent project." >&2
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

printf "== browser client: %s ==\n" "$browser_out"
"$cli" routes "$@" --client ts --target browser --out "$browser_out"

printf "\n== server client: %s ==\n" "$server_out"
"$cli" routes "$@" --client ts --target server --out "$server_out"
