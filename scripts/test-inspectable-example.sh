#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_DIR="$REPO_ROOT/examples/inspectable-agent"

cd "$EXAMPLE_DIR"
bun install --frozen-lockfile --ignore-scripts
bun run typecheck
bun run test
bun "$REPO_ROOT/scripts/audit-dependencies.ts" --evidence "${AUDIT_EVIDENCE:-$EXAMPLE_DIR/data/verification/dependency-audit.json}"
