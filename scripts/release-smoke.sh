#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/auggy-release-smoke.XXXXXX")"
AGENT_NAME="smoke-agent"
PACK_CACHE="$SMOKE_DIR/npm-pack-cache"
INSTALL_CACHE="$SMOKE_DIR/npm-install-cache"
GLOBAL_PREFIX="$SMOKE_DIR/npm-global"
LOG_DIR="$SMOKE_DIR/logs"
SERVER_PID=""
FAILED=""

mkdir -p "$LOG_DIR"

cleanup() {
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$FAILED" ]]; then
    return
  fi
  rm -rf "$SMOKE_DIR"
}
trap cleanup EXIT

info() {
  printf '\n==> %s\n' "$1"
}

fail() {
  FAILED=1
  printf '\nrelease smoke failed: %s\n' "$1" >&2
  printf 'logs: %s\n' "$LOG_DIR" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd npm
require_cmd bun
require_cmd curl
require_cmd script
require_cmd tar

info "typecheck"
(cd "$ROOT" && bunx tsc --noEmit)

info "pack auggy"
PACK_NAME="$(cd "$ROOT" && npm_config_cache="$PACK_CACHE" npm pack --silent)"
TARBALL="$ROOT/$PACK_NAME"
[[ -f "$TARBALL" ]] || fail "npm pack did not create $TARBALL"

info "verify package contents"
PACK_LIST="$LOG_DIR/tarball-files.txt"
tar -tf "$TARBALL" >"$PACK_LIST"

require_pack_entry() {
  grep -qx "package/$1" "$PACK_LIST" || fail "tarball missing package/$1"
}

reject_pack_pattern() {
  if grep -Eq "$1" "$PACK_LIST"; then
    fail "$2"
  fi
}

require_pack_entry "src/cli/index.ts"
require_pack_entry "src/cli/model-registry.ts"
require_pack_entry "src/cli/model-snapshot.ts"
require_pack_entry "admin/dist/index.html"
require_pack_entry "README.md"
require_pack_entry "CHANGELOG.md"
require_pack_entry "LICENSE"
grep -Eq '^package/admin/dist/assets/.+\.js$' "$PACK_LIST" \
  || fail "tarball missing built console JavaScript"
grep -Eq '^package/admin/dist/assets/.+\.css$' "$PACK_LIST" \
  || fail "tarball missing built console CSS"
reject_pack_pattern '\.map$' "tarball includes source maps"
reject_pack_pattern '^package/(\.env|node_modules/|\.git/|\.auggy/|docs/|tests/)' \
  "tarball includes local-only files"

info "install packed CLI"
npm_config_cache="$INSTALL_CACHE" npm install -g --prefix "$GLOBAL_PREFIX" "$TARBALL"
CLI="$GLOBAL_PREFIX/bin/auggy"
"$CLI" --version | grep -qx "$(node -p "require('$ROOT/package.json').version")" \
  || fail "installed CLI version does not match package.json"

info "verify non-TTY create fails clearly"
if "$CLI" create no-tty-agent --skip-install >"$LOG_DIR/no-tty-create.log" 2>&1; then
  fail "non-TTY create unexpectedly succeeded"
fi
grep -q "interactive and needs a terminal" "$LOG_DIR/no-tty-create.log" \
  || fail "non-TTY create did not print the expected error"
[[ ! -e "$SMOKE_DIR/no-tty-agent" ]] || fail "non-TTY create left a directory behind"

info "create agent through PTY"
(
  cd "$SMOKE_DIR"
  (
    sleep 0.2
    printf '\n'
    sleep 0.2
    printf '\n'
    sleep 0.2
    printf '\n'
    sleep 0.2
    printf '\n'
    sleep 0.2
    printf '\n'
    sleep 0.2
    printf '\n'
  ) | script -q /dev/null env \
    AUGGY_SCAFFOLD_AUGGY_SPEC="file:$TARBALL" \
    "$CLI" create "$AGENT_NAME" --skip-install
) >"$LOG_DIR/create.log" 2>&1

AGENT_DIR="$SMOKE_DIR/$AGENT_NAME"
[[ -f "$AGENT_DIR/agent.yaml" ]] || fail "agent.yaml was not created"
grep -q "\"auggy\": \"file:$TARBALL\"" "$AGENT_DIR/package.json" \
  || fail "agent package.json did not pin auggy to the packed tarball"

info "install agent dependencies"
(
  cd "$AGENT_DIR"
  bun install
)

info "fill smoke env"
perl -0pi -e 's/ANTHROPIC_API_KEY=\n/ANTHROPIC_API_KEY=sk-ant-smoke-not-real\n/' "$AGENT_DIR/.env"

info "doctor"
(
  cd "$AGENT_DIR"
  "$CLI" doctor
)

info "run agent and check health"
(
  cd "$AGENT_DIR"
  "$CLI" run --no-open >"$LOG_DIR/run.log" 2>&1
) &
SERVER_PID="$!"

for _ in {1..40}; do
  if curl -fsS http://127.0.0.1:8080/health >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS http://127.0.0.1:8080/health | grep -q '"status":"healthy"' \
  || fail "agent health did not become healthy"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

info "add knowledge and MCP"
(
  cd "$AGENT_DIR"
  "$CLI" augment add knowledge
  "$CLI" augment add mcp --yes
  "$CLI" mcp add-json example-stdio \
    "{\"type\":\"stdio\",\"command\":\"bun\",\"args\":[\"$ROOT/examples/mcp-stdio-server/server.ts\"],\"cwd\":\"$ROOT\"}"
)

info "MCP local doctor passes"
(
  cd "$AGENT_DIR"
  "$CLI" mcp doctor
)

info "cloud preflight blocks local stdio MCP"
if (cd "$AGENT_DIR" && "$CLI" doctor --cloud >"$LOG_DIR/doctor-cloud.log" 2>&1); then
  fail "doctor --cloud unexpectedly passed with stdio MCP"
fi
grep -q "stdio MCP servers do not run safely on Railway" "$LOG_DIR/doctor-cloud.log" \
  || fail "doctor --cloud did not explain stdio MCP cloud risk"

if (cd "$AGENT_DIR" && "$CLI" deploy --yes >"$LOG_DIR/deploy-preflight.log" 2>&1); then
  fail "deploy unexpectedly passed with stdio MCP"
fi
grep -q "Deploy preflight failed" "$LOG_DIR/deploy-preflight.log" \
  || fail "deploy did not stop at preflight"

info "release smoke passed"
