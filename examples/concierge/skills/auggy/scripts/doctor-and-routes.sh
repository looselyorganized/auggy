#!/usr/bin/env bash
set -euo pipefail

if ! command -v auggy >/dev/null 2>&1; then
  printf "auggy command not found. Install Auggy or run this from a project with Auggy available.\n" >&2
  exit 127
fi

args=("$@")

printf "== auggy doctor ==\n"
auggy doctor "${args[@]}"

printf "\n== auggy routes ==\n"
auggy routes "${args[@]}"
