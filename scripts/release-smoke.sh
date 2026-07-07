#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/auggy-release-smoke.XXXXXX")"
AGENT_NAME="smoke-agent"
PACK_CACHE="$SMOKE_DIR/npm-pack-cache"
INSTALL_CACHE="$SMOKE_DIR/npm-install-cache"
GLOBAL_PREFIX="$SMOKE_DIR/npm-global"
LOG_DIR="$SMOKE_DIR/logs"
PACK_DIR="$SMOKE_DIR/packs"
SMOKE_HOME="$SMOKE_DIR/home"
SMOKE_PORT=""
SERVER_PID=""
FAILED=""

mkdir -p "$LOG_DIR" "$PACK_DIR" "$SMOKE_HOME"

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
require_cmd node
require_cmd script
require_cmd tar

info "typecheck"
(cd "$ROOT" && bunx tsc --noEmit)

info "pack auggy"
PACK_NAME="$(cd "$ROOT" && npm_config_cache="$PACK_CACHE" npm pack --silent --pack-destination "$PACK_DIR")"
TARBALL="$PACK_DIR/$PACK_NAME"
[[ -f "$TARBALL" ]] || fail "npm pack did not create $TARBALL"

info "pack default engine adapter"
ANTHROPIC_PACK_NAME="$(
  cd "$ROOT/packages/anthropic" && npm_config_cache="$PACK_CACHE" npm pack --silent --pack-destination "$PACK_DIR"
)"
ANTHROPIC_TARBALL="$PACK_DIR/$ANTHROPIC_PACK_NAME"
[[ -f "$ANTHROPIC_TARBALL" ]] || fail "npm pack did not create $ANTHROPIC_TARBALL"

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
require_pack_entry "SECURITY.md"
grep -Eq '^package/admin/dist/assets/.+\.js$' "$PACK_LIST" \
  || fail "tarball missing built console JavaScript"
grep -Eq '^package/admin/dist/assets/.+\.css$' "$PACK_LIST" \
  || fail "tarball missing built console CSS"
reject_pack_pattern '\.map$' "tarball includes source maps"
reject_pack_pattern '^package/(\.env|node_modules/|\.git/|\.auggy/|docs/|tests/)' \
  "tarball includes local-only files"

assert_augment_metadata() {
  local id="$1"
  local file="$AGENT_DIR/augments/$id/augment.yaml"
  [[ -f "$file" ]] || fail "missing augment metadata: augments/$id/augment.yaml"
  grep -qx "type: $id" "$file" || fail "augment metadata for $id missing type: $id"
}

assert_agent_uses_folder_backed_augments() {
  local id
  for id in "$@"; do
    grep -qx "  - $id" "$AGENT_DIR/agent.yaml" || fail "agent.yaml missing augment id: $id"
    assert_augment_metadata "$id"
  done
  if awk '/^augments:/{inside=1; next} /^[^[:space:]]/{inside=0} inside && /type:|name:|options:|config:|kind:|runtime:|configType:/{found=1} END{exit found ? 0 : 1}' "$AGENT_DIR/agent.yaml"; then
    fail "agent.yaml contains inline augment object fields"
  fi
  if grep -R -nE '^(name|kind|runtime|configType):' "$AGENT_DIR/augments" >"$LOG_DIR/stale-augment-metadata.log"; then
    fail "augment metadata contains stale v1 fields; see $LOG_DIR/stale-augment-metadata.log"
  fi
}

info "install packed CLI"
npm_config_cache="$INSTALL_CACHE" npm install -g --prefix "$GLOBAL_PREFIX" "$TARBALL"
CLI="$GLOBAL_PREFIX/bin/auggy"
"$CLI" --version | grep -qx "$(node -p "require('$ROOT/package.json').version")" \
  || fail "installed CLI version does not match package.json"

info "verify non-TTY create fails clearly"
if HOME="$SMOKE_HOME" "$CLI" create no-tty-agent --skip-install >"$LOG_DIR/no-tty-create.log" 2>&1; then
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
    HOME="$SMOKE_HOME" \
    AUGGY_SCAFFOLD_AUGGY_SPEC="file:$TARBALL" \
    "$CLI" create "$AGENT_NAME" --skip-install
) >"$LOG_DIR/create.log" 2>&1

AGENT_DIR="$SMOKE_DIR/$AGENT_NAME"
[[ -f "$AGENT_DIR/agent.yaml" ]] || fail "agent.yaml was not created"
grep -q "\"auggy\": \"file:$TARBALL\"" "$AGENT_DIR/package.json" \
  || fail "agent package.json did not pin auggy to the packed tarball"
grep -q "\"@auggy/anthropic\": \"^$(node -p "require('$ROOT/package.json').version")\"" "$AGENT_DIR/package.json" \
  || fail "agent package.json did not caret-pin @auggy/anthropic to the package version"
node - "$AGENT_DIR/package.json" "$ANTHROPIC_TARBALL" <<'NODE'
const { readFileSync, writeFileSync } = require("node:fs");
const [manifestPath, tarball] = process.argv.slice(2);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
manifest.dependencies["@auggy/anthropic"] = `file:${tarball}`;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
NODE
assert_agent_uses_folder_backed_augments fileMemory filesystem webTransport webFetch turnControl

SMOKE_PORT="$(
  node -e 'const net=require("net"); const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port); server.close();});'
)"
[[ -n "$SMOKE_PORT" ]] || fail "could not allocate smoke port"
perl -0pi -e "s/AUGGY_PUBLIC_URL=http:\/\/localhost:\d+/AUGGY_PUBLIC_URL=http:\/\/localhost:$SMOKE_PORT/" "$AGENT_DIR/.env"
perl -0pi -e "s/(^[[:space:]]*port: )[0-9]+/\${1}$SMOKE_PORT/m" "$AGENT_DIR/augments/webTransport/augment.yaml"

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
  HOME="$SMOKE_HOME" "$CLI" doctor
)

info "run agent and check health"
(
  cd "$AGENT_DIR"
  HOME="$SMOKE_HOME" "$CLI" run --no-open >"$LOG_DIR/run.log" 2>&1
) &
SERVER_PID="$!"

for _ in {1..40}; do
  if curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl -fsS "http://127.0.0.1:$SMOKE_PORT/health" | grep -q '"status":"healthy"' \
  || fail "agent health did not become healthy"
kill "$SERVER_PID" 2>/dev/null || true
wait "$SERVER_PID" 2>/dev/null || true
SERVER_PID=""

info "add knowledge and MCP"
(
  cd "$AGENT_DIR"
  HOME="$SMOKE_HOME" "$CLI" augment add knowledge
  HOME="$SMOKE_HOME" "$CLI" augment add mcp --yes
  HOME="$SMOKE_HOME" "$CLI" mcp add-json example-stdio \
    "{\"type\":\"stdio\",\"command\":\"bun\",\"args\":[\"$ROOT/examples/mcp-stdio-server/server.ts\"],\"cwd\":\"$ROOT\"}"
)
assert_agent_uses_folder_backed_augments fileMemory filesystem webTransport webFetch turnControl knowledge mcp

info "MCP local doctor passes"
(
  cd "$AGENT_DIR"
  HOME="$SMOKE_HOME" "$CLI" mcp doctor
)

info "cloud preflight blocks local stdio MCP"
if (cd "$AGENT_DIR" && HOME="$SMOKE_HOME" "$CLI" doctor --cloud >"$LOG_DIR/doctor-cloud.log" 2>&1); then
  fail "doctor --cloud unexpectedly passed with stdio MCP"
fi
grep -q "stdio MCP servers do not run safely on Railway" "$LOG_DIR/doctor-cloud.log" \
  || fail "doctor --cloud did not explain stdio MCP cloud risk"

if (cd "$AGENT_DIR" && HOME="$SMOKE_HOME" "$CLI" deploy --yes >"$LOG_DIR/deploy-preflight.log" 2>&1); then
  fail "deploy unexpectedly passed with stdio MCP"
fi
grep -q "Deploy preflight failed" "$LOG_DIR/deploy-preflight.log" \
  || fail "deploy did not stop at preflight"

info "release smoke passed"
