#!/usr/bin/env bash
set -euo pipefail

has_cmd() {
  command -v "$1" >/dev/null 2>&1
}

version_for() {
  if has_cmd "$1"; then
    "$1" --version 2>/dev/null | head -n 1
  else
    printf "missing"
  fi
}

printf "cwd: %s\n" "$(pwd)"
printf "bun: %s\n" "$(version_for bun)"
printf "node: %s\n" "$(version_for node)"
printf "auggy: %s\n" "$(version_for auggy)"

if [ -f package.json ]; then
  if grep -Eq '"auggy"[[:space:]]*:' package.json; then
    printf "package: auggy dependency present\n"
  else
    printf "package: package.json present, auggy dependency not detected\n"
  fi
else
  printf "package: no package.json in cwd\n"
fi

if [ -f agent.yaml ]; then
  printf "agent: agent.yaml present\n"
elif [ -f augments/agent.yaml ]; then
  printf "agent: unexpected augments/agent.yaml present\n"
else
  printf "agent: no agent.yaml in cwd\n"
fi

if [ -d augments ]; then
  count="$(find augments -mindepth 1 -maxdepth 1 -type d 2>/dev/null | wc -l | tr -d ' ')"
  printf "augments: %s folders\n" "$count"
else
  printf "augments: no augments directory in cwd\n"
fi

printf "\nnext:\n"
if [ -f agent.yaml ]; then
  printf "%s\n" "- run: auggy doctor"
  printf "%s\n" "- run: auggy routes"
else
  printf "%s\n" "- create: auggy create <name>"
  printf "%s\n" "- or enter an existing Auggy agent directory"
fi
