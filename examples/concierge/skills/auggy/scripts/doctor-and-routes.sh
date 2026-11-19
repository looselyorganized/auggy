#!/usr/bin/env bash
set -euo pipefail

cli=./node_modules/.bin/auggy
if [[ ! -x "$cli" ]]; then
  printf '%s\n' "Missing project-local Auggy. Run bun install in the agent project." >&2
  exit 127
fi

printf "== auggy doctor ==\n"
"$cli" doctor "$@"

printf "\n== auggy routes ==\n"
"$cli" routes "$@"
