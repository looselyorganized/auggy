#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SMOKE_DIR="$(mktemp -d "${TMPDIR:-/tmp}/auggy-release-smoke.XXXXXX")"
AGENT_NAME="smoke-agent"
PACK_CACHE="$SMOKE_DIR/npm-pack-cache"
INSTALL_CACHE="$SMOKE_DIR/npm-install-cache"
GLOBAL_PREFIX="$SMOKE_DIR/npm-global"
LOG_DIR="$SMOKE_DIR/logs"
PACK_DIR="${AUGGY_RELEASE_ARTIFACT_DIR:-$SMOKE_DIR/packs}"
SMOKE_HOME="$SMOKE_DIR/home"
SMOKE_PORT=""
SERVER_PID=""
FAILED=""

mkdir -p "$LOG_DIR" "$PACK_DIR" "$SMOKE_HOME"

cleanup() {
  local exit_status="$1"
  if [[ -n "$SERVER_PID" ]] && kill -0 "$SERVER_PID" 2>/dev/null; then
    kill "$SERVER_PID" 2>/dev/null || true
    wait "$SERVER_PID" 2>/dev/null || true
  fi
  if [[ -n "$FAILED" ]] || (( exit_status != 0 )); then
    if [[ -z "$FAILED" ]]; then
      printf '\nrelease smoke exited unexpectedly with status %s\n' "$exit_status" >&2
      printf 'logs: %s\n' "$LOG_DIR" >&2
    fi
    return "$exit_status"
  fi
  rm -rf "$SMOKE_DIR"
}
trap 'cleanup $?' EXIT

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
require_cmd git
require_cmd node
require_cmd perl
require_cmd script
require_cmd tar

info "install workspace dependencies"
(cd "$ROOT" && bun install --frozen-lockfile)

info "typecheck"
(cd "$ROOT" && bunx tsc --noEmit)

info "build creator console"
(cd "$ROOT" && bun run build:admin)

pack_release_package() {
  local package_dir="$1"
  local expected_name="$2"
  local expected_version="$3"
  local pack_name
  local tarball
  pack_name="$(
    cd "$ROOT/$package_dir" \
      && npm_config_cache="$PACK_CACHE" npm pack --silent --pack-destination "$PACK_DIR"
  )"
  tarball="$PACK_DIR/$pack_name"
  [[ -f "$tarball" ]] || fail "npm pack did not create $tarball"
  tar -xOf "$tarball" package/package.json \
    | node -e '
        const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        const [expectedName, expectedVersion] = process.argv.slice(1);
        if (manifest.name !== expectedName || manifest.version !== expectedVersion) {
          console.error(`expected ${expectedName}@${expectedVersion}, packed ${manifest.name}@${manifest.version}`);
          process.exit(1);
        }
      ' "$expected_name" "$expected_version" \
    || fail "packed metadata mismatch for $package_dir"
  printf '%s\n' "$tarball"
}

ROOT_VERSION="$(node -p "require('$ROOT/package.json').version")"
info "pack every publishable package"
TARBALL="$(pack_release_package "." "auggy" "$ROOT_VERSION")"
ANTHROPIC_TARBALL="$(pack_release_package "packages/anthropic" "@auggy/anthropic" "$ROOT_VERSION")"
OPENAI_TARBALL="$(pack_release_package "packages/openai" "@auggy/openai" "$ROOT_VERSION")"
OPENROUTER_TARBALL="$(pack_release_package "packages/openrouter" "@auggy/openrouter" "$ROOT_VERSION")"
OLLAMA_TARBALL="$(pack_release_package "packages/ollama" "@auggy/ollama" "$ROOT_VERSION")"
pack_release_package "packages/evals" "@auggy/evals" "$ROOT_VERSION" >/dev/null

verify_adapter_manifest() {
  local tarball="$1"
  local expected_name="$2"
  tar -xOf "$tarball" package/package.json \
    | node -e '
        const manifest = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
        const [expectedName, expectedVersion] = process.argv.slice(1);
        if (manifest.name !== expectedName) {
          throw new Error(`expected ${expectedName}, packed ${manifest.name}`);
        }
        if (manifest.peerDependencies?.auggy !== `^${expectedVersion}`) {
          throw new Error(`${expectedName} does not declare auggy ^${expectedVersion}`);
        }
        if (manifest.peerDependenciesMeta?.auggy?.optional !== true) {
          throw new Error(`${expectedName} may not auto-install the stale registry core`);
        }
      ' "$expected_name" "$ROOT_VERSION" \
    || fail "packed peer contract mismatch for $expected_name"
}

verify_adapter_consumer() {
  local slug="$1"
  local package_name="$2"
  local factory_name="$3"
  local adapter_tarball="$4"
  local consumer_dir="$SMOKE_DIR/provider-consumers/$slug"
  shift 4

  mkdir -p "$consumer_dir"
  node - "$consumer_dir/package.json" <<'NODE'
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.argv[2],
  `${JSON.stringify({
    name: "packed-provider-consumer",
    private: true,
    type: "module",
    overrides: {
      "@hono/node-server": "2.0.11",
      "body-parser": "2.3.0",
      "fast-uri": "3.1.4",
      "hono": "4.12.31",
    },
  }, null, 2)}\n`,
);
NODE
  (
    cd "$consumer_dir"
    # Install the required runtime peer first so package managers never try to
    # satisfy it from the stale published registry version.
    bun add --offline --no-summary "$TARBALL"
    bun add --offline --no-summary "$adapter_tarball" "$@"
    bun -e '
      const [packageName, factoryName] = process.argv.slice(1);
      const provider = await import(packageName);
      if (typeof provider[factoryName] !== "function") {
        throw new Error(`${packageName} does not export ${factoryName}`);
      }
    ' "$package_name" "$factory_name"
    bun -e '
      import { existsSync, readFileSync } from "node:fs";
      import { dirname, join } from "node:path";

      const expected = {
        "@hono/node-server": "2.0.11",
        "body-parser": "2.3.0",
        "fast-uri": "3.1.4",
        hono: "4.12.31",
      };
      for (const [name, version] of Object.entries(expected)) {
        let directory = dirname(Bun.resolveSync(name, process.cwd()));
        let manifest;
        for (let depth = 0; depth < 8; depth += 1) {
          const candidate = join(directory, "package.json");
          if (existsSync(candidate)) {
            const parsed = JSON.parse(readFileSync(candidate, "utf8"));
            if (parsed.name === name) {
              manifest = parsed;
              break;
            }
          }
          directory = dirname(directory);
        }
        if (manifest?.version !== version) {
          throw new Error(
            `${name} resolved to ${manifest?.version ?? "unknown"}, expected ${version}`,
          );
        }
      }
    '
  ) >"$LOG_DIR/provider-$slug.log" 2>&1 \
    || fail "packed provider consumer failed for $package_name"
}

info "verify packed provider contracts and isolated imports"
verify_adapter_manifest "$ANTHROPIC_TARBALL" "@auggy/anthropic"
verify_adapter_manifest "$OPENAI_TARBALL" "@auggy/openai"
verify_adapter_manifest "$OPENROUTER_TARBALL" "@auggy/openrouter"
verify_adapter_manifest "$OLLAMA_TARBALL" "@auggy/ollama"
verify_adapter_consumer \
  "anthropic" "@auggy/anthropic" "createAnthropicEngine" "$ANTHROPIC_TARBALL"
verify_adapter_consumer \
  "openai" "@auggy/openai" "createOpenAIEngine" "$OPENAI_TARBALL"
verify_adapter_consumer \
  "openrouter" "@auggy/openrouter" "createOpenRouterEngine" \
  "$OPENROUTER_TARBALL" "$OPENAI_TARBALL"
verify_adapter_consumer \
  "ollama" "@auggy/ollama" "createOllamaEngine" "$OLLAMA_TARBALL"

info "verify package contents"
PACK_LIST="$LOG_DIR/tarball-files.txt"
tar -tf "$TARBALL" >"$PACK_LIST"

require_pack_entry() {
  grep -Fqx "package/$1" "$PACK_LIST" || fail "tarball missing package/$1"
}

reject_pack_pattern() {
  if grep -Eq "$1" "$PACK_LIST"; then
    fail "$2"
  fi
}

require_pack_entry "src/cli/index.ts"
require_pack_entry "src/cli/model-registry.ts"
require_pack_entry "src/cli/model-snapshot.ts"
require_pack_entry "src/scaffold-starter-skills/auggy/assets/templates/nextjs-server-client/admin-reindex-route.ts.txt"
require_pack_entry "admin/dist/index.html"
require_pack_entry "README.md"
require_pack_entry "CHANGELOG.md"
require_pack_entry "LICENSE"
require_pack_entry "SECURITY.md"
BUILT_ADMIN_DIST="$LOG_DIR/built-admin-dist.txt"
(cd "$ROOT" && find admin/dist -type f -print | LC_ALL=C sort) >"$BUILT_ADMIN_DIST"
[[ -s "$BUILT_ADMIN_DIST" ]] || fail "creator console build produced no files"
while IFS= read -r dist_path; do
  [[ -n "$dist_path" ]] || continue
  require_pack_entry "$dist_path"
done <"$BUILT_ADMIN_DIST"
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
PTY_RUNNER="$SMOKE_DIR/create-agent.sh"
cat >"$PTY_RUNNER" <<'SH'
#!/usr/bin/env bash
set -euo pipefail
env \
  HOME="$AUGGY_SMOKE_HOME" \
  AUGGY_SCAFFOLD_AUGGY_SPEC="file:$AUGGY_SMOKE_TARBALL" \
  AUGGY_SCAFFOLD_ENGINE_SPEC="file:$AUGGY_SMOKE_ANTHROPIC_TARBALL" \
  "$AUGGY_SMOKE_CLI" create "$AUGGY_SMOKE_AGENT_NAME" --skip-install
: >"$AUGGY_SMOKE_CREATE_SENTINEL"
SH
chmod +x "$PTY_RUNNER"
export AUGGY_SMOKE_HOME="$SMOKE_HOME"
export AUGGY_SMOKE_TARBALL="$TARBALL"
export AUGGY_SMOKE_ANTHROPIC_TARBALL="$ANTHROPIC_TARBALL"
export AUGGY_SMOKE_CLI="$CLI"
export AUGGY_SMOKE_AGENT_NAME="$AGENT_NAME"
export AUGGY_SMOKE_CREATE_SENTINEL="$SMOKE_DIR/create-agent.succeeded"
(
  cd "$SMOKE_DIR"
  answer_create_prompts() {
    local _
    # Inquirer switches raw-mode listeners between prompts. Space the
    # defaults out so keystrokes cannot be consumed during those transitions.
    for _ in {1..12}; do
      sleep 0.5
      printf '\n' || return 0
    done
  }
  set +e
  if script --version 2>&1 | grep -qi 'util-linux'; then
    { answer_create_prompts || true; } | script -q -e -c ./create-agent.sh /dev/null
  else
    { answer_create_prompts || true; } | script -q /dev/null ./create-agent.sh
  fi
  pty_status=$?
  set -e
  # The feeder may receive SIGPIPE after the wizard exits. The wrapper writes
  # this sentinel only after `auggy create` itself completes successfully.
  if [[ -f "$AUGGY_SMOKE_CREATE_SENTINEL" ]]; then
    exit 0
  fi
  (( pty_status != 0 )) || pty_status=1
  exit "$pty_status"
) >"$LOG_DIR/create.log" 2>&1
[[ -f "$AUGGY_SMOKE_CREATE_SENTINEL" ]] \
  || fail "PTY agent creation did not complete successfully"

AGENT_DIR="$SMOKE_DIR/$AGENT_NAME"
[[ -f "$AGENT_DIR/agent.yaml" ]] || fail "agent.yaml was not created"
grep -q "\"auggy\": \"file:$TARBALL\"" "$AGENT_DIR/package.json" \
  || fail "agent package.json did not pin auggy to the packed tarball"
grep -q "\"@auggy/anthropic\": \"file:$ANTHROPIC_TARBALL\"" "$AGENT_DIR/package.json" \
  || fail "agent package.json did not pin @auggy/anthropic to the packed adapter"
assert_agent_uses_folder_backed_augments fileMemory filesystem webTransport webFetch turnControl
ADMIN_TEMPLATE="$AGENT_DIR/skills/auggy/assets/templates/nextjs-server-client/admin-reindex-route.ts.txt"
[[ -f "$ADMIN_TEMPLATE" ]] || fail "scaffold missing hardened admin route template"
grep -Fq 'import "server-only";' "$ADMIN_TEMPLATE" \
  || fail "scaffold admin route template is not server-only"
grep -Fq 'createAdminReindexHandler' "$ADMIN_TEMPLATE" \
  || fail "scaffold admin route template lacks the fail-closed authorization boundary"

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
  if curl --connect-timeout 1 --max-time 2 -fsS \
    "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then
    break
  fi
  sleep 0.25
done
curl --connect-timeout 1 --max-time 2 -fsS \
  "http://127.0.0.1:$SMOKE_PORT/health" | grep -q '"status":"healthy"' \
  || fail "agent health did not become healthy"

info "verify packed console shell and assets"
WEB_TOKEN="$(sed -n 's/^AUGGY_WEB_TOKEN=//p' "$AGENT_DIR/.env")"
[[ ${#WEB_TOKEN} -eq 64 ]] || fail "generated AUGGY_WEB_TOKEN is not 64 characters"
case "$WEB_TOKEN" in
  *[!0-9a-f]*) fail "generated AUGGY_WEB_TOKEN is not lowercase hexadecimal" ;;
esac

HTTP_STATUS=""
HTTP_CONTENT_TYPE=""
HTTP_BODY=""
fetch_console_resource() {
  local resource_path="$1"
  local log_name="$2"
  local metadata
  HTTP_BODY="$LOG_DIR/$log_name.body"
  if ! metadata="$(
    curl --silent --show-error \
      --connect-timeout 2 \
      --max-time 10 \
      --user ":$WEB_TOKEN" \
      --dump-header "$LOG_DIR/$log_name.headers" \
      --output "$HTTP_BODY" \
      --write-out $'%{http_code}\t%{content_type}' \
      "http://127.0.0.1:$SMOKE_PORT$resource_path"
  )"; then
    fail "could not fetch packed console resource: $resource_path"
  fi
  IFS=$'\t' read -r HTTP_STATUS HTTP_CONTENT_TYPE <<<"$metadata"
}

assert_console_response() {
  local resource_path="$1"
  local expected_content_type="$2"
  [[ "$HTTP_STATUS" == "200" ]] \
    || fail "packed console resource returned HTTP $HTTP_STATUS: $resource_path"
  case "$HTTP_CONTENT_TYPE" in
    "$expected_content_type"*) ;;
    *)
      fail "packed console resource returned $HTTP_CONTENT_TYPE, expected $expected_content_type: $resource_path"
      ;;
  esac
}

fetch_console_resource "/console/chat" "console-chat"
assert_console_response "/console/chat" "text/html"
CONSOLE_HTML="$HTTP_BODY"
CONSOLE_ASSETS="$LOG_DIR/console-assets.txt"
node - "$CONSOLE_HTML" >"$CONSOLE_ASSETS" <<'NODE'
const { readFileSync } = require("node:fs");
const html = readFileSync(process.argv[2], "utf8");
const assets = new Set();
for (const match of html.matchAll(/\b(?:src|href)=["'](\/console\/assets\/[^"']+\.(?:js|css))["']/g)) {
  assets.add(match[1]);
}
process.stdout.write([...assets].sort().join("\n"));
if (assets.size > 0) process.stdout.write("\n");
NODE
grep -Eq '\.js$' "$CONSOLE_ASSETS" || fail "served console HTML does not reference JavaScript"
grep -Eq '\.css$' "$CONSOLE_ASSETS" || fail "served console HTML does not reference CSS"

asset_index=0
while IFS= read -r asset_path; do
  [[ -n "$asset_path" ]] || continue
  asset_index=$((asset_index + 1))
  fetch_console_resource "$asset_path" "console-asset-$asset_index"
  case "$asset_path" in
    *.js) assert_console_response "$asset_path" "application/javascript" ;;
    *.css) assert_console_response "$asset_path" "text/css" ;;
    *) fail "served console HTML referenced an unexpected asset type: $asset_path" ;;
  esac
done <"$CONSOLE_ASSETS"

brand_index=0
for brand_path in "/console/brand/auggy-wave.png" "/console/brand/auggy-white.png"; do
  brand_index=$((brand_index + 1))
  fetch_console_resource "$brand_path" "console-brand-$brand_index"
  assert_console_response "$brand_path" "image/png"
done

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
