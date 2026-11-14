#!/usr/bin/env bash
# Sourced only by the portable integration entry. No host-wide policy changes.
auggy_ci_userns_policy=""
auggy_ci_userns_hash=""
auggy_ci_userns_name=""
auggy_ci_userns_attempted=0

auggy_ci_userns_list() {
  local listing status LC_ALL=C
  # Bound both privileged execution and the pseudo-file's returned bytes.
  # A sentinel preserves trailing newlines through command substitution; C locale
  # makes the length check count bytes, including non-ASCII profile names.
  listing="$(
    sudo -n -- timeout --kill-after=2s 15s head -c 2097153 /sys/kernel/security/apparmor/profiles
    status=$?
    printf '\001'
    exit "$status"
  )" || return 1
  listing="${listing%$'\001'}"
  if [[ ${#listing} -gt 2097152 ]]; then
    echo "AppArmor profile inventory exceeded its bound." >&2
    return 1
  fi
  printf '%s\n' "$listing"
}

auggy_ci_userns_present() {
  local listing="$1" line
  while IFS= read -r line; do
    case "$line" in
      "$auggy_ci_userns_name ("*")") return 0 ;;
    esac
  done <<< "$listing"
  return 1
}

auggy_ci_userns_prepare() {
  if [[ "${AUGGY_INTEGRATION_CI_USERNS:-}" != "1" ]]; then
    return 0
  fi
  if [[ "${CI:-}" != "true" || "${GITHUB_ACTIONS:-}" != "true" || "$(uname -s)" != "Linux" ]]; then
    echo "The CI browser AppArmor allowance requires an explicit Linux GitHub Actions job." >&2
    return 1
  fi
  local command policy listing
  for command in sudo timeout head apparmor_parser; do
    command -v "$command" >/dev/null || {
      echo "CI browser AppArmor support is unavailable: $command" >&2
      return 1
    }
  done
  policy="$(bun --no-env-file --no-install --config=/dev/null "$repository_root/scripts/release-smoke/ci-chromium-userns.ts" prepare "$1" "$2" "$3")" || return 1
  auggy_ci_userns_policy="${policy%$'\n'*}"
  auggy_ci_userns_hash="${policy##*$'\n'}"
  auggy_ci_userns_name="${auggy_ci_userns_policy##*/}"
  if [[ ! "$auggy_ci_userns_name" =~ ^auggy-m5-chromium-[a-f0-9-]{36}$ || ! "$auggy_ci_userns_hash" =~ ^[a-f0-9]{64}$ ]]; then
    echo "Invalid owned AppArmor policy identity." >&2
    return 1
  fi
  listing="$(auggy_ci_userns_list)" || return 1
  if auggy_ci_userns_present "$listing"; then
    echo "Refusing to replace an existing AppArmor profile." >&2
    return 1
  fi
  bun --no-env-file --no-install --config=/dev/null "$repository_root/scripts/release-smoke/ci-chromium-userns.ts" verify "$auggy_ci_userns_policy" "$auggy_ci_userns_hash" || return 1
  # Mark the unique, previously absent name before loading: a parser error or
  # interruption may occur after installation. Cleanup verifies actual state.
  auggy_ci_userns_attempted=1
  sudo -n -- timeout --kill-after=2s 15s apparmor_parser --add --skip-cache "$auggy_ci_userns_policy" || return 1
  listing="$(auggy_ci_userns_list)" || return 1
  if ! auggy_ci_userns_present "$listing"; then
    echo "CI browser AppArmor profile installation was not confirmed." >&2
    return 1
  fi
}

auggy_ci_userns_cleanup() {
  local listing
  if [[ "$auggy_ci_userns_attempted" == "1" ]]; then
    listing="$(auggy_ci_userns_list)" || return 1
    if auggy_ci_userns_present "$listing"; then
      bun --no-env-file --no-install --config=/dev/null "$repository_root/scripts/release-smoke/ci-chromium-userns.ts" verify "$auggy_ci_userns_policy" "$auggy_ci_userns_hash" || return 1
      sudo -n -- timeout --kill-after=2s 15s apparmor_parser --remove --skip-cache "$auggy_ci_userns_policy" || return 1
    fi
    listing="$(auggy_ci_userns_list)" || return 1
    if auggy_ci_userns_present "$listing"; then
      echo "CI browser AppArmor profile cleanup was not confirmed." >&2
      return 1
    fi
    auggy_ci_userns_attempted=0
  fi
  if [[ -n "$auggy_ci_userns_policy" ]]; then
    bun --no-env-file --no-install --config=/dev/null "$repository_root/scripts/release-smoke/ci-chromium-userns.ts" verify "$auggy_ci_userns_policy" "$auggy_ci_userns_hash" || return 1
    rm -- "$auggy_ci_userns_policy" || return 1
    auggy_ci_userns_policy=""
  fi
}

auggy_ci_userns_exit() {
  local status=$?
  trap - EXIT
  trap '' HUP INT TERM
  if ! auggy_ci_userns_cleanup; then
    echo "CI browser AppArmor cleanup failed; the owned build inputs were retained." >&2
    if [[ "$status" == "0" ]]; then status=1; fi
  fi
  exit "$status"
}
