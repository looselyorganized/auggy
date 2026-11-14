#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source "$repository_root/scripts/ci-chromium-userns.sh"
trap auggy_ci_userns_exit EXIT
trap 'exit 129' HUP
trap 'exit 130' INT
trap 'exit 143' TERM
build_directory="$(mktemp -d "${TMPDIR:-/tmp}/auggy-m5-build.XXXXXX")"
mkdir -m 700 "$build_directory/packs"
if [[ -n "${AUGGY_INTEGRATION_EVIDENCE_DIR:-}" ]]; then
  evidence_directory="$AUGGY_INTEGRATION_EVIDENCE_DIR"
else
  evidence_parent="$(mktemp -d "${TMPDIR:-/tmp}/auggy-m5-evidence.XXXXXX")"
  evidence_directory="$evidence_parent/result"
fi

cd "$repository_root"
bun install --frozen-lockfile --ignore-scripts
core_archive="$(npm pack --silent --pack-destination "$build_directory/packs")"
anthropic_archive="$(cd packages/anthropic && npm pack --silent --pack-destination "$build_directory/packs")"
openai_archive="$(cd packages/openai && npm pack --silent --pack-destination "$build_directory/packs")"
openrouter_archive="$(cd packages/openrouter && npm pack --silent --pack-destination "$build_directory/packs")"
ollama_archive="$(cd packages/ollama && npm pack --silent --pack-destination "$build_directory/packs")"

cd "$repository_root/examples/company-app"
bun install --frozen-lockfile --ignore-scripts
export PLAYWRIGHT_BROWSERS_PATH="$build_directory/browsers"
browser_options=(chromium --no-shell --no-progress --no-remove)
if [[ "${CI:-}" == "true" && "$(uname -s)" == "Linux" ]]; then
  browser_options+=(--with-deps)
fi
bun node_modules/playwright/cli.js install "${browser_options[@]}"
chromium_path="$(bun -e 'import { chromium } from "playwright"; console.log(chromium.executablePath());')"
chromium_sha256="$(bun -e 'console.log(new Bun.CryptoHasher("sha256").update(await Bun.file(process.argv[1]).arrayBuffer()).digest("hex"));' "$chromium_path")"
auggy_ci_userns_prepare "$build_directory" "$chromium_path" "$chromium_sha256"

cd "$repository_root"
bun scripts/release-smoke/integration-suite.ts \
  --repo-root "$repository_root" \
  --evidence-dir "$evidence_directory" \
  --core "$build_directory/packs/$core_archive" \
  --anthropic "$build_directory/packs/$anthropic_archive" \
  --openai "$build_directory/packs/$openai_archive" \
  --openrouter "$build_directory/packs/$openrouter_archive" \
  --ollama "$build_directory/packs/$ollama_archive" \
  --chromium-path "$chromium_path" \
  --chromium-sha256 "$chromium_sha256" \
  --stage all

# Successful suite evidence contains the exact archives. Failed runs retain build
# inputs for inspection; the suite owns and reports runtime resource cleanup.
auggy_ci_userns_cleanup
rm -rf "$build_directory"
