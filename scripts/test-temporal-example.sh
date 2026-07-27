#!/usr/bin/env bash
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
EXAMPLE_DIR="$REPO_ROOT/examples/temporal-order-support"

cd "$EXAMPLE_DIR"
bun install --frozen-lockfile
bun run test
bun run typecheck
bun audit --json
