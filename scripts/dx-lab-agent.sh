#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LAB_ROOT="${AUGGY_DX_LAB_ROOT:-$ROOT/.auggy-dx-lab}"
AGENT_NAME="${AUGGY_DX_AGENT_NAME:-dx-lab-agent}"
AGENT_DIR="$LAB_ROOT/$AGENT_NAME"
SECRETS_FILE="${AUGGY_DX_ENV:-$ROOT/.env.dx.local}"
PORT="${AUGGY_DX_PORT:-18080}"
RUN_AGENT=1
RESET=0
WITH_TELEGRAM="${AUGGY_DX_WITH_TELEGRAM:-auto}"
CLI_MODE="${AUGGY_DX_CLI_MODE:-source}"

usage() {
  cat <<USAGE
Usage: bun run dx:agent [--reset] [--no-run] [--agent <name>] [--port <port>]

Creates a disposable full-featured Auggy agent under .auggy-dx-lab/ and runs it.

Secrets are reused from .env.dx.local when present. Useful keys:
  ANTHROPIC_API_KEY=...
  AGENTMAIL_API_KEY=...            # exact runtime key for an existing inbox
  AGENTMAIL_INBOX_ID=...           # required existing inbox for that key
  TELEGRAM_BOT_TOKEN=...
  TELEGRAM_CHAT_ID=...             # notify destination
  TELEGRAM_CREATOR_USER_IDS=...    # telegramTransport creator IDs

Environment knobs:
  AUGGY_DX_CLI_MODE=source          # default; fastest, uses this repo's CLI source
  AUGGY_DX_CLI_MODE=isolated        # slower; npm-installs the packed CLI in .auggy-dx-lab

Options:
  --reset          Delete and recreate the lab agent
  --no-run         Prepare the agent, run doctor, then stop
  --agent <name>   Agent directory/name (default: dx-lab-agent)
  --port <port>    webTransport port (default: 18080)
USAGE
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --reset)
      RESET=1
      shift
      ;;
    --no-run)
      RUN_AGENT=0
      shift
      ;;
    --agent)
      AGENT_NAME="${2:?missing value for --agent}"
      AGENT_DIR="$LAB_ROOT/$AGENT_NAME"
      shift 2
      ;;
    --port)
      PORT="${2:?missing value for --port}"
      shift 2
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "Unknown option: $1" >&2
      usage >&2
      exit 1
      ;;
  esac
done

info() {
  printf '\n==> %s\n' "$1"
}

fail() {
  printf '\nDX agent setup failed: %s\n' "$1" >&2
  exit 1
}

require_cmd() {
  command -v "$1" >/dev/null 2>&1 || fail "missing required command: $1"
}

require_cmd npm
require_cmd bun
require_cmd node
require_cmd script

read_env_value() {
  local key="$1"
  [[ -f "$SECRETS_FILE" ]] || return 0
  bun "$ROOT/scripts/dx-lab-env.ts" "$SECRETS_FILE" "$key"
}

merge_env_file() {
  local source="$1"
  local target="$2"
  [[ -f "$source" ]] || return 0
  node - "$source" "$target" <<'NODE'
const fs = require("node:fs");
const [source, target] = process.argv.slice(2);

function parse(text) {
  const values = new Map();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const idx = line.indexOf("=");
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) continue;
    if (key.startsWith("AGENTMAIL_")) continue;
    if (key.startsWith("AUGGY_DX_")) continue;
    const value = line.slice(idx + 1).trim();
    if (value === "") continue;
    values.set(key, value);
  }
  return values;
}

const values = parse(fs.readFileSync(source, "utf8"));
if (values.size === 0) process.exit(0);

const lines = fs.existsSync(target) ? fs.readFileSync(target, "utf8").split(/\r?\n/) : [];
const seen = new Set();
const out = lines.map((line) => {
  const match = line.match(/^([A-Z0-9_]+)=/);
  if (!match) return line;
  const key = match[1];
  if (!values.has(key)) return line;
  seen.add(key);
  return `${key}=${values.get(key)}`;
});
for (const [key, value] of values) {
  if (!seen.has(key)) out.push(`${key}=${value}`);
}
fs.writeFileSync(target, `${out.join("\n").replace(/\n+$/, "")}\n`);
NODE
}

patch_agent_port() {
  perl -0pi -e "s/AUGGY_PUBLIC_URL=http:\/\/localhost:\d+/AUGGY_PUBLIC_URL=http:\/\/localhost:$PORT/" "$AGENT_DIR/.env"
  perl -0pi -e "s/(^[[:space:]]*port: )[0-9]+/\${1}$PORT/m" "$AGENT_DIR/augments/webTransport/augment.yaml"
}

patch_notify_for_telegram() {
  local chat_id
  chat_id="$(read_env_value TELEGRAM_CHAT_ID)"
  [[ -n "$chat_id" ]] || return 0
  cat >"$AGENT_DIR/augments/notify/augment.yaml" <<'YAML'
type: notify
config:
  destinations:
    - name: creator
      transport: telegram
      botToken: ${TELEGRAM_BOT_TOKEN}
      chatId: ${TELEGRAM_CHAT_ID}
  rateLimit:
    cooldownMs: 120000
    globalMaxPerHour: 5
    dedupWindowMs: 300000
    dedupThreshold: 0.6
    perPeerCooldownMs: 30000
YAML
}

add_augment_if_missing() {
  local augment="$1"
  if grep -qx "  - $augment" "$AGENT_DIR/agent.yaml"; then
    return 0
  fi
  (
    cd "$AGENT_DIR"
    "$CLI" augment add "$augment" --skip-install --yes
  )
}

configure_agentmail_if_possible() {
  local api_key inbox_id
  api_key="$(read_env_value AGENTMAIL_API_KEY)"
  inbox_id="$(read_env_value AGENTMAIL_INBOX_ID)"

  if [[ -n "$api_key" && -n "$inbox_id" ]]; then
    info "connect agentMail to the supplied existing inbox"
    (
      cd "$AGENT_DIR"
      AGENTMAIL_API_KEY="$api_key" "$CLI" augment setup agentMail \
        --mode connect \
        --inbox-id "$inbox_id"
      "$CLI" augment setup visitorAuth --mode env
    )
    return 0
  fi

  if [[ -n "$api_key" || -n "$inbox_id" ]]; then
    fail "AgentMail DX setup requires both AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID for one existing inbox"
  fi

  info "skip AgentMail setup (no AGENTMAIL_* credentials in $SECRETS_FILE)"
}

has_agentmail_credentials() {
  [[ -n "$(read_env_value AGENTMAIL_API_KEY)" && -n "$(read_env_value AGENTMAIL_INBOX_ID)" ]]
}

mkdir -p "$LAB_ROOT/home" "$LAB_ROOT/npm-global" "$LAB_ROOT/npm-cache" "$LAB_ROOT/bun-cache" "$LAB_ROOT/packs" "$LAB_ROOT/tmp"
export TMPDIR="$LAB_ROOT/tmp"

info "pack Auggy"
PACK_NAME="$(cd "$ROOT" && npm_config_cache="$LAB_ROOT/npm-cache" npm pack --silent)"
PACKED_TARBALL="$ROOT/$PACK_NAME"
[[ -f "$PACKED_TARBALL" ]] || fail "npm pack did not create $PACKED_TARBALL"
TARBALL="$LAB_ROOT/packs/auggy-$(date +%Y%m%d%H%M%S)-$$.tgz"
mv "$PACKED_TARBALL" "$TARBALL"
find "$LAB_ROOT/packs" -name 'auggy-*.tgz' -type f -mtime +2 -delete

info "prepare CLI ($CLI_MODE)"
if [[ "$CLI_MODE" == "isolated" ]]; then
  npm_config_cache="$LAB_ROOT/npm-cache" npm install -g --prefix "$LAB_ROOT/npm-global" "$TARBALL" >/dev/null
  CLI="$LAB_ROOT/npm-global/bin/auggy"
elif [[ "$CLI_MODE" == "source" ]]; then
  CLI="$LAB_ROOT/auggy-source"
  cat >"$CLI" <<SH
#!/usr/bin/env bash
exec bun "$ROOT/src/cli/index.ts" "\$@"
SH
  chmod +x "$CLI"
else
  fail "invalid AUGGY_DX_CLI_MODE=$CLI_MODE (use source or isolated)"
fi
"$CLI" --version >/dev/null

if [[ "$RESET" == "1" ]]; then
  info "reset lab agent"
  rm -rf "$AGENT_DIR"
fi

if [[ ! -f "$AGENT_DIR/agent.yaml" ]]; then
  info "create $AGENT_NAME"
  mkdir -p "$LAB_ROOT"
  (
    cd "$LAB_ROOT"
    (
      sleep 0.1; printf '\n'
      sleep 0.1; printf '\n'
      sleep 0.1; printf '\n'
      sleep 0.1; printf '\n'
      sleep 0.1; printf '\n'
      sleep 0.1; printf '\n'
    ) | script -q /dev/null env \
      HOME="$LAB_ROOT/home" \
      AUGGY_SCAFFOLD_AUGGY_SPEC="file:$TARBALL" \
      "$CLI" create "$AGENT_NAME" --skip-install
  )
else
  info "refresh $AGENT_NAME package spec"
  node - "$AGENT_DIR/package.json" "$TARBALL" <<'NODE'
const fs = require("node:fs");
const [pkgPath, tarball] = process.argv.slice(2);
const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
pkg.dependencies ??= {};
pkg.dependencies.auggy = `file:${tarball}`;
fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`);
NODE
fi

patch_agent_port
merge_env_file "$SECRETS_FILE" "$AGENT_DIR/.env"

info "install test augments"
add_augment_if_missing knowledge
add_augment_if_missing notify
add_augment_if_missing layeredMemory
add_augment_if_missing visitorAuth
add_augment_if_missing mcp

if has_agentmail_credentials; then
  add_augment_if_missing agentMail
else
  info "skip agentMail augment (no AgentMail credentials in $SECRETS_FILE)"
fi

if [[ "$WITH_TELEGRAM" == "1" || ( "$WITH_TELEGRAM" == "auto" && -n "$(read_env_value TELEGRAM_BOT_TOKEN)" && -n "$(read_env_value TELEGRAM_CREATOR_USER_IDS)" ) ]]; then
  add_augment_if_missing telegramTransport
  patch_notify_for_telegram
fi

if [[ ! -f "$AGENT_DIR/.mcp.json" ]] || ! grep -q '"example-stdio"' "$AGENT_DIR/.mcp.json"; then
  info "add local MCP smoke server"
  (
    cd "$AGENT_DIR"
    "$CLI" mcp add-json example-stdio \
      "{\"type\":\"stdio\",\"command\":\"bun\",\"args\":[\"$ROOT/examples/mcp-stdio-server/server.ts\"],\"cwd\":\"$ROOT\",\"auggy\":{\"cloud\":\"disabled\"}}"
  )
fi

merge_env_file "$SECRETS_FILE" "$AGENT_DIR/.env"
configure_agentmail_if_possible
merge_env_file "$SECRETS_FILE" "$AGENT_DIR/.env"

info "install agent dependencies"
(
  cd "$AGENT_DIR"
  TMPDIR="$LAB_ROOT/tmp" bun install --cache-dir "$LAB_ROOT/bun-cache"
)

info "doctor"
(
  cd "$AGENT_DIR"
  HOME="$LAB_ROOT/home" "$CLI" doctor
)

printf '\nDX lab agent ready.\n'
printf '  Agent:   %s\n' "$AGENT_DIR"
printf '  CLI:     %s\n' "$CLI"
printf '  Chat:    http://localhost:%s/console/chat\n' "$PORT"
printf '  Console: http://localhost:%s/console\n' "$PORT"

if [[ "$RUN_AGENT" == "0" ]]; then
  printf '\nRun it later:\n  cd %s && HOME=%s %s run --no-open\n' "$AGENT_DIR" "$LAB_ROOT/home" "$CLI"
  exit 0
fi

info "run $AGENT_NAME"
cd "$AGENT_DIR"
exec env HOME="$LAB_ROOT/home" "$CLI" run --no-open
