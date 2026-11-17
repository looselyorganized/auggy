#!/usr/bin/env bash
set -euo pipefail

repository_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
example_directory="$repository_root/examples/company-app"

cd "$example_directory"
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun x tsc -p tsconfig.tests.json --noEmit
bun run test
bun x next build --webpack
bun "$repository_root/scripts/audit-dependencies.ts" --evidence "${AUDIT_EVIDENCE:-$example_directory/.next/dependency-audit.json}"
