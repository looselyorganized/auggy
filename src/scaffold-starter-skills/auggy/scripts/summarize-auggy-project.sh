#!/usr/bin/env bash
set -euo pipefail

dir="${1:-.}"
agent_yaml="$dir/agent.yaml"

if [ ! -f "$agent_yaml" ]; then
  printf "No agent.yaml found at %s\n" "$agent_yaml" >&2
  exit 1
fi

name="$(awk -F': *' '/^name:/ { gsub(/"/, "", $2); print $2; exit }' "$agent_yaml")"
display_name="$(awk -F': *' '/^displayName:/ { gsub(/"/, "", $2); print $2; exit }' "$agent_yaml")"

printf "agent: %s\n" "${name:-unknown}"
if [ -n "${display_name:-}" ]; then
  printf "displayName: %s\n" "$display_name"
fi

printf "\naugments:\n"
awk '
  /^augments:/ { in_augments = 1; next }
  in_augments && /^  - / { sub(/^  - /, ""); print "- " $0; next }
  in_augments && NF == 0 { in_augments = 0 }
' "$agent_yaml"

printf "\ncustom augment folders:\n"
if [ -d "$dir/augments" ]; then
  find "$dir/augments" -mindepth 2 -maxdepth 2 -name augment.yaml -print |
    while IFS= read -r yaml; do
      if grep -Eq '^type:[[:space:]]*custom' "$yaml"; then
        printf "%s\n" "- $(dirname "$yaml" | sed "s#^$dir/##")"
      fi
    done
else
  printf "%s\n" "- none found"
fi

printf "\ngenerated clients:\n"
find "$dir" \
  -path "*/node_modules" -prune -o \
  -type f \( -name "auggy-client.ts" -o -name "auggy-client.server.ts" -o -name "*auggy-client*.ts" \) \
  -print 2>/dev/null |
  sed "s#^$dir/##; s#^#- #"

printf "\nenv keys:\n"
env_file=""
if [ -f "$dir/.env.example" ]; then
  env_file="$dir/.env.example"
elif [ -f "$dir/.env" ]; then
  env_file="$dir/.env"
fi

if [ -n "$env_file" ]; then
  grep -E '^[A-Z0-9_]+=' "$env_file" | sed 's/=.*$//' | sed 's/^/- /'
else
  printf "%s\n" "- none found"
fi
