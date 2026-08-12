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
EVALS_TARBALL="$(pack_release_package "packages/evals" "@auggy/evals" "$ROOT_VERSION")"

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
      "brace-expansion": "5.0.9",
      "fast-uri": "3.1.5",
      "hono": "4.12.34",
      "ip-address": "10.4.0",
      "postcss": "8.5.25",
      "undici": "7.29.0",
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
      const core = await import("auggy");
      if (typeof core.defineAgent !== "function") {
        throw new Error("packed Auggy core does not export defineAgent");
      }
      const jobs = await import("auggy/jobs");
      if (
        typeof jobs.createSqliteDurableJobStore !== "function" ||
        typeof jobs.createDurableJobRuntime !== "function"
      ) {
        throw new Error("packed Auggy core does not export the durable jobs contract");
      }
      const store = jobs.createSqliteDurableJobStore({
        dbPath: "./packed-durable-jobs.sqlite",
        maxTotalRecords: 2,
        maxQueuedRecords: 1,
      });
      const submitted = store.submit({
        idempotencyKey: "packed-consumer",
        binding: { consumer: packageName },
        payload: { version: 1, value: { kind: "release-smoke" } },
      });
      if (submitted.status !== "created" || store.list().length !== 1) {
        throw new Error("packed durable jobs store failed its consumer contract");
      }
      store.close();
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
        "brace-expansion": "5.0.9",
        "fast-uri": "3.1.5",
        hono: "4.12.34",
        "ip-address": "10.4.0",
        postcss: "8.5.25",
        undici: "7.29.0",
      };
      const coreDirectory = dirname(Bun.resolveSync("auggy", process.cwd()));
      for (const [name, version] of Object.entries(expected)) {
        let directory = dirname(Bun.resolveSync(name, coreDirectory));
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
    bun audit --json | node -e '
      const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (Object.keys(result).length !== 0) {
        throw new Error(`packed consumer has advisories: ${Object.keys(result).join(", ")}`);
      }
    '
  ) >"$LOG_DIR/provider-$slug.log" 2>&1 \
    || fail "packed provider consumer failed for $package_name"
}

verify_evals_consumer() {
  local consumer_dir="$SMOKE_DIR/evals-consumer"
  mkdir -p "$consumer_dir"
  node - "$consumer_dir/package.json" <<'NODE'
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.argv[2],
  `${JSON.stringify({
    name: "packed-evals-consumer",
    private: true,
    type: "module",
    overrides: {
      "@hono/node-server": "2.0.11",
      "body-parser": "2.3.0",
      "brace-expansion": "5.0.9",
      "fast-uri": "3.1.5",
      "hono": "4.12.34",
      "ip-address": "10.4.0",
      "postcss": "8.5.25",
      "undici": "7.29.0",
    },
  }, null, 2)}\n`,
);
NODE
  (
    cd "$consumer_dir"
    bun add --offline --no-summary "$TARBALL"
    bun add --offline --no-summary "$EVALS_TARBALL"
    bun -e '
      import { existsSync } from "node:fs";
      const security = await import("@auggy/evals/security/run");
      const autoSave = await import("@auggy/evals/auto-save/run");
      if (
        typeof security.runEvalSuite !== "function" ||
        typeof security.getDefaultFixtureConfigPath !== "function" ||
        typeof autoSave.runAutoSaveEval !== "function"
      ) {
        throw new Error("packed @auggy/evals exports are incomplete");
      }
      if (!existsSync(security.getDefaultFixtureConfigPath())) {
        throw new Error("packed @auggy/evals omitted its default security fixture");
      }
    '
    bun ./node_modules/auggy/src/cli/index.ts eval auto-save --dry-run
    bun audit --json | node -e '
      const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
      if (Object.keys(result).length !== 0) {
        throw new Error(`packed eval consumer has advisories: ${Object.keys(result).join(", ")}`);
      }
    '
  ) >"$LOG_DIR/evals-consumer.log" 2>&1 \
    || fail "packed @auggy/evals consumer failed"
}

verify_agentmail_packed_runtime_consumer() {
  local consumer_dir="$SMOKE_DIR/agentmail-runtime-consumer"
  mkdir -p "$consumer_dir"
  node - "$consumer_dir/package.json" <<'NODE'
const { writeFileSync } = require("node:fs");
writeFileSync(
  process.argv[2],
  `${JSON.stringify({
    name: "packed-agentmail-runtime-consumer",
    private: true,
    type: "module",
  }, null, 2)}\n`,
);
NODE
  cp "$ROOT/scripts/release-smoke-agentmail-packed-runtime.ts" "$consumer_dir/contract.ts"
  (
    cd "$consumer_dir"
    bun add --offline --no-summary "$TARBALL"
    AUGGY_PACKED_CONSUMER_ROOT="$consumer_dir" \
      AUGGY_SOURCE_ROOT="$ROOT" \
      bun contract.ts
  ) >"$LOG_DIR/agentmail-packed-runtime.log" 2>&1 \
    || fail "packed AgentMail runtime WebSocket contract failed"
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
verify_evals_consumer
verify_agentmail_packed_runtime_consumer

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
require_pack_entry "src/cli/agentmail-capabilities.ts"
require_pack_entry "src/cli/commands/agentmail.ts"
require_pack_entry "src/augments/agentMail/index.ts"
require_pack_entry "src/augments/agentMail/config.ts"
require_pack_entry "src/augments/agentMail/provider.ts"
require_pack_entry "src/augments/agentMail/inbound.ts"
require_pack_entry "src/augments/agentMail/policy.ts"
require_pack_entry "src/augments/agentMail/runtime.ts"
require_pack_entry "src/augments/agentMail/store.ts"
require_pack_entry "src/augments/agentMail/skill/SKILL.md"
require_pack_entry "src/jobs/index.ts"
require_pack_entry "src/jobs/runtime.ts"
require_pack_entry "src/jobs/sqlite-store.ts"
require_pack_entry "src/cli/model-registry.ts"
require_pack_entry "src/cli/model-snapshot.ts"
require_pack_entry "src/scaffold-starter-skills/auggy/assets/templates/nextjs-server-client/admin-reindex-route.ts.txt"
require_pack_entry "admin/dist/index.html"
require_pack_entry "admin/dist/login/default.html"
require_pack_entry "admin/dist/login/invalid-password.html"
require_pack_entry "admin/dist/login/invalid-ticket.html"
require_pack_entry "admin/dist/login/manifest.json"
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
reject_pack_pattern '^package/admin/dist/login/.*\.(js|mjs|cjs|map)$' \
  "tarball includes executable Console login output or source maps"
reject_pack_pattern '^package/src/cli/agentmail-provisioning\.ts$' \
  "tarball includes removed AgentMail provisioning implementation"
reject_pack_pattern '^package/src/augments/agentMail/(creator-attention|creator-digest-bridge|creator-digest-policy|creator-digest|inbound-ledger|inbound-policy|inbound-worker|outbound|persist-state|rate-limit|review-queue|sdk-provider|types|webhook-provider)\.ts$' \
  "tarball includes a removed pre-rebuild AgentMail runtime module"
reject_pack_pattern '\.map$' "tarball includes source maps"
reject_pack_pattern '^package/(\.env|node_modules/|\.git/|\.auggy/|docs/|tests/)' \
  "tarball includes local-only files"

PACKED_LOGIN_ROOT="$SMOKE_DIR/packed-login"
mkdir -p "$PACKED_LOGIN_ROOT"
tar -xf "$TARBALL" -C "$PACKED_LOGIN_ROOT"
PACKED_LOGIN_DIR="$PACKED_LOGIN_ROOT/package/admin/dist/login"
if grep -R -F -l "$ROOT" "$PACKED_LOGIN_ROOT/package" >"$LOG_DIR/packed-source-paths.txt"; then
  fail "packed Auggy artifact embeds the source checkout path"
fi
PACKED_LOGIN_STYLESHEET_PATH="$(
  cd "$ROOT/admin"
  bun -e '
    import { verifyLoginArtifactDirectory } from "./scripts/login-artifacts";
    const manifest = verifyLoginArtifactDirectory(process.argv[1]);
    const stylesheet = manifest.artifacts.find((entry) => entry.logicalName === "stylesheet");
    if (!stylesheet) throw new Error("packed login stylesheet is missing");
    process.stdout.write(stylesheet.path);
  ' "$PACKED_LOGIN_DIR"
)" || fail "packed Console login artifact verification failed"
[[ "$PACKED_LOGIN_STYLESHEET_PATH" =~ ^assets/login-[A-Za-z0-9_-]{6,64}\.css$ ]] \
  || fail "packed Console login manifest has an invalid stylesheet path"
require_pack_entry "admin/dist/login/$PACKED_LOGIN_STYLESHEET_PATH"

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

info "verify packed AgentMail CLI contract"
bun "$ROOT/scripts/release-smoke-agentmail-cli.ts" \
  "$CLI" \
  "$GLOBAL_PREFIX/lib/node_modules/auggy" \
  "$SMOKE_DIR/packed-agentmail-cli" \
  "$SMOKE_HOME" \
  "$TARBALL" \
  "$ANTHROPIC_TARBALL" \
  >"$LOG_DIR/packed-agentmail-cli.log" 2>&1 \
  || fail "packed AgentMail CLI contract failed"

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

info "install agent dependencies"
(
  cd "$AGENT_DIR"
  bun install
)
PACKED_AUGGY_REALPATH="$(
  cd "$AGENT_DIR"
  node -e 'process.stdout.write(require("node:fs").realpathSync("node_modules/auggy"))'
)"
PACKED_AGENT_REALPATH="$(
  cd "$AGENT_DIR"
  node -e 'process.stdout.write(require("node:fs").realpathSync("."))'
)"
case "$PACKED_AUGGY_REALPATH" in
  "$PACKED_AGENT_REALPATH"/node_modules/*) ;;
  *) fail "generated agent resolved auggy outside its isolated node_modules" ;;
esac

info "audit installed agent"
(
  cd "$AGENT_DIR"
  bun audit --json | node -e '
    const result = JSON.parse(require("node:fs").readFileSync(0, "utf8"));
    if (Object.keys(result).length !== 0) {
      throw new Error(`generated agent has advisories: ${Object.keys(result).join(", ")}`);
    }
  '
)

info "fill smoke env"
perl -0pi -e 's/ANTHROPIC_API_KEY=\n/ANTHROPIC_API_KEY=sk-ant-smoke-not-real\n/' "$AGENT_DIR/.env"

configure_smoke_port() {
  SMOKE_PORT="$(
    node -e 'const net=require("net"); const server=net.createServer(); server.listen(0,"127.0.0.1",()=>{console.log(server.address().port); server.close();});'
  )"
  [[ -n "$SMOKE_PORT" ]] || fail "could not allocate smoke port"
  perl -0pi -e "s/AUGGY_PUBLIC_URL=http:\/\/localhost:\d+/AUGGY_PUBLIC_URL=http:\/\/localhost:$SMOKE_PORT/" "$AGENT_DIR/.env"
  perl -0pi -e "s/(^[[:space:]]*port: )[0-9]+/\${1}$SMOKE_PORT/m" "$AGENT_DIR/augments/webTransport/augment.yaml"
}

# Doctor checks listener availability, so isolate it from legitimate services
# using the scaffold's default port before running any verification command.
configure_smoke_port

info "doctor"
(
  cd "$AGENT_DIR"
  HOME="$SMOKE_HOME" "$CLI" doctor
)

info "run agent and check health"
HEALTHY=""
for attempt in {1..3}; do
  if (( attempt > 1 )); then
    configure_smoke_port
  fi

  (
    cd "$AGENT_DIR"
    HOME="$SMOKE_HOME" "$CLI" run --no-open >"$LOG_DIR/run.log" 2>&1
  ) &
  SERVER_PID="$!"

  for _ in {1..40}; do
    if kill -0 "$SERVER_PID" 2>/dev/null \
      && curl --connect-timeout 1 --max-time 2 -fsS \
        "http://127.0.0.1:$SMOKE_PORT/health" >/dev/null 2>&1; then
      HEALTHY=1
      break
    fi
    if ! kill -0 "$SERVER_PID" 2>/dev/null; then
      break
    fi
    sleep 0.25
  done
  if [[ -n "$HEALTHY" ]]; then
    break
  fi

  if kill -0 "$SERVER_PID" 2>/dev/null; then
    fail "agent health did not become healthy"
  fi
  wait "$SERVER_PID" 2>/dev/null || true
  SERVER_PID=""
  if grep -Eq 'EADDRINUSE|address already in use' "$LOG_DIR/run.log" && (( attempt < 3 )); then
    info "retry smoke agent after a port collision"
    continue
  fi
  fail "smoke agent exited before health became ready"
done
[[ -n "$HEALTHY" ]] || fail "agent health did not become healthy after port retries"
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
HTTP_HEADERS=""
capture_console_request() {
  local resource_path="$1"
  local log_name="$2"
  shift 2
  local metadata
  HTTP_BODY="$LOG_DIR/$log_name.body"
  HTTP_HEADERS="$LOG_DIR/$log_name.headers"
  if ! metadata="$(
    curl --silent --show-error \
      --connect-timeout 2 \
      --max-time 10 \
      --dump-header "$HTTP_HEADERS" \
      --output "$HTTP_BODY" \
      --write-out $'%{http_code}\t%{content_type}' \
      "$@" \
      "http://127.0.0.1:$SMOKE_PORT$resource_path"
  )"; then
    fail "could not fetch packed console resource: $resource_path"
  fi
  IFS=$'\t' read -r HTTP_STATUS HTTP_CONTENT_TYPE <<<"$metadata"
}

fetch_console_resource() {
  local resource_path="$1"
  local log_name="$2"
  capture_console_request "$resource_path" "$log_name" --user ":$WEB_TOKEN"
}

response_header_value() {
  local header_name="$1"
  node - "$HTTP_HEADERS" "$header_name" <<'NODE'
const { readFileSync } = require("node:fs");
const [file, expectedName] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split(/\r?\n/);
for (let index = lines.length - 1; index >= 0; index -= 1) {
  const line = lines[index];
  const separator = line.indexOf(":");
  if (separator < 0) continue;
  if (line.slice(0, separator).toLowerCase() !== expectedName.toLowerCase()) continue;
  process.stdout.write(line.slice(separator + 1).trim());
  process.exit(0);
}
NODE
}

assert_status() {
  local expected_status="$1"
  local description="$2"
  [[ "$HTTP_STATUS" == "$expected_status" ]] \
    || fail "$description returned HTTP $HTTP_STATUS, expected $expected_status"
}

assert_header_exact() {
  local header_name="$1"
  local expected_value="$2"
  local description="$3"
  local actual_value
  actual_value="$(response_header_value "$header_name")"
  [[ "$actual_value" == "$expected_value" ]] \
    || fail "$description returned $header_name '$actual_value', expected '$expected_value'"
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

LOGIN_CSP="default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

capture_console_request "/console" "console-unauthenticated"
assert_status "303" "unauthenticated Console navigation"
assert_header_exact "location" "/console/login?next=%2Fconsole" \
  "unauthenticated Console navigation"
assert_header_exact "cache-control" "no-store" "unauthenticated Console navigation"

capture_console_request "/console/login?next=%2Fconsole" "console-login-default"
assert_status "200" "packed Console login"
[[ "$HTTP_CONTENT_TYPE" == text/html* ]] \
  || fail "packed Console login returned $HTTP_CONTENT_TYPE, expected text/html"
assert_header_exact "content-security-policy" "$LOGIN_CSP" "packed Console login"
assert_header_exact "cache-control" "no-store" "packed Console login"
LOGIN_HTML="$HTTP_BODY"
grep -Fq 'data-auggy-login-source="registry"' "$LOGIN_HTML" \
  || fail "packed Console login did not serve the registry-authored document"
grep -Fq 'data-auggy-login-variant="default"' "$LOGIN_HTML" \
  || fail "packed Console login did not serve the default fixed variant"
grep -Eq '<form[^>]*method="post"' "$LOGIN_HTML" \
  || fail "packed Console login does not contain a native POST form"
grep -Eq '<input[^>]*name="password"' "$LOGIN_HTML" \
  || fail "packed Console login does not contain a named password control"
grep -Eq '<input[^>]*type="password"' "$LOGIN_HTML" \
  || fail "packed Console login does not contain the password control"
if grep -Eqi '<script([[:space:]>])|[[:space:]]on[a-z]+=' "$LOGIN_HTML"; then
  fail "packed Console login contains executable browser content"
fi
LOGIN_STYLESHEET_URL="/console/login-assets/$PACKED_LOGIN_STYLESHEET_PATH"
grep -Fq "href=\"$LOGIN_STYLESHEET_URL\"" "$LOGIN_HTML" \
  || fail "packed Console login does not reference the manifest-listed stylesheet"
if grep -Fq "$WEB_TOKEN" "$LOGIN_HTML"; then
  fail "packed Console login leaked AUGGY_WEB_TOKEN"
fi

capture_console_request "$LOGIN_STYLESHEET_URL" "console-login-stylesheet"
assert_status "200" "packed Console login stylesheet"
[[ "$HTTP_CONTENT_TYPE" == text/css* ]] \
  || fail "packed Console login stylesheet returned $HTTP_CONTENT_TYPE, expected text/css"
assert_header_exact "cache-control" "public, max-age=31536000, immutable" \
  "packed Console login stylesheet"
assert_header_exact "content-security-policy" "frame-ancestors 'none'" \
  "packed Console login stylesheet"
assert_header_exact "x-content-type-options" "nosniff" \
  "packed Console login stylesheet"

capture_console_request "$LOGIN_STYLESHEET_URL" "console-login-stylesheet-head" \
  --request HEAD
assert_status "200" "packed Console login stylesheet HEAD"
[[ "$HTTP_CONTENT_TYPE" == text/css* ]] \
  || fail "packed Console login stylesheet HEAD returned $HTTP_CONTENT_TYPE, expected text/css"
assert_header_exact "cache-control" "public, max-age=31536000, immutable" \
  "packed Console login stylesheet HEAD"
[[ ! -s "$HTTP_BODY" ]] || fail "packed Console login stylesheet HEAD returned a body"

LOGIN_JAVASCRIPT_URL="${LOGIN_STYLESHEET_URL%.css}.js"
negative_login_asset_index=0
for rejected_login_path in \
  "/console/login-assets/manifest.json" \
  "/console/login-assets/default.html" \
  "$LOGIN_JAVASCRIPT_URL" \
  "/console/login-assets/assets/unknown.css" \
  "/console/login-assets/%2e%2e%2Fdefault.html"; do
  negative_login_asset_index=$((negative_login_asset_index + 1))
  capture_console_request "$rejected_login_path" \
    "console-login-rejected-$negative_login_asset_index"
  assert_status "404" "rejected pre-auth Console login asset $rejected_login_path"
  assert_header_exact "cache-control" "no-store" \
    "rejected pre-auth Console login asset $rejected_login_path"
done

capture_console_request "/console/login" "console-login-invalid-password" \
  --request POST \
  --header "origin: http://127.0.0.1:$SMOKE_PORT" \
  --header "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "password=definitely-not-the-console-password"
assert_status "401" "invalid Console password"
assert_header_exact "content-security-policy" "$LOGIN_CSP" "invalid Console password"
grep -Fq 'data-auggy-login-variant="invalid-password"' "$HTTP_BODY" \
  || fail "invalid Console password did not serve the fixed branded error variant"
grep -Fq "Invalid console password." "$HTTP_BODY" \
  || fail "invalid Console password did not return the generic error"
if grep -Fq "definitely-not-the-console-password" "$HTTP_BODY"; then
  fail "invalid Console password response echoed the submitted value"
fi

CONSOLE_PASSWORD_COOKIE_JAR="$SMOKE_DIR/console-password.cookies"
capture_console_request "/console/login?next=%2Fconsole%2Fchat" \
  "console-login-valid-password" \
  --request POST \
  --header "origin: http://127.0.0.1:$SMOKE_PORT" \
  --header "content-type: application/x-www-form-urlencoded" \
  --data-urlencode "password=$WEB_TOKEN" \
  --cookie-jar "$CONSOLE_PASSWORD_COOKIE_JAR"
assert_status "303" "valid Console password"
assert_header_exact "location" "/console/chat" "valid Console password"
PASSWORD_SET_COOKIE="$(response_header_value "set-cookie")"
[[ "$PASSWORD_SET_COOKIE" == *HttpOnly* && "$PASSWORD_SET_COOKIE" == *SameSite=Lax* \
  && "$PASSWORD_SET_COOKIE" == *Path=/console* ]] \
  || fail "valid Console password did not establish the hardened HttpOnly session"

capture_console_request "/console/chat" "console-password-session" \
  --cookie "$CONSOLE_PASSWORD_COOKIE_JAR"
assert_status "200" "password-authenticated Console session"
[[ "$HTTP_CONTENT_TYPE" == text/html* ]] \
  || fail "password-authenticated Console session did not receive HTML"

capture_console_request "/console/api/cli-login" "console-cli-ticket-issue" \
  --request POST \
  --user ":$WEB_TOKEN"
assert_status "200" "Console CLI ticket issue"
assert_header_exact "cache-control" "no-store, must-revalidate" "Console CLI ticket issue"
CLI_LOGIN_PATH="$(node - "$HTTP_BODY" <<'NODE'
const { readFileSync } = require("node:fs");
const value = JSON.parse(readFileSync(process.argv[2], "utf8"));
if (
  !value ||
  typeof value !== "object" ||
  Array.isArray(value) ||
  Object.keys(value).sort().join(",") !== "expiresInSeconds,loginPath" ||
  typeof value.loginPath !== "string" ||
  !/^\/console\/cli-login\/[A-Za-z0-9_-]{43}$/.test(value.loginPath) ||
  !Number.isInteger(value.expiresInSeconds) ||
  value.expiresInSeconds < 1 ||
  value.expiresInSeconds > 30
) {
  throw new Error("packed Console CLI ticket response is malformed");
}
process.stdout.write(value.loginPath);
NODE
)" || fail "packed Console CLI ticket response validation failed"

CONSOLE_TICKET_COOKIE_JAR="$SMOKE_DIR/console-ticket.cookies"
capture_console_request "$CLI_LOGIN_PATH" "console-cli-ticket-consume" \
  --cookie-jar "$CONSOLE_TICKET_COOKIE_JAR"
assert_status "303" "Console CLI ticket consume"
assert_header_exact "location" "/console/chat" "Console CLI ticket consume"
TICKET_SET_COOKIE="$(response_header_value "set-cookie")"
[[ "$TICKET_SET_COOKIE" == *HttpOnly* && "$TICKET_SET_COOKIE" == *SameSite=Lax* \
  && "$TICKET_SET_COOKIE" == *Path=/console* ]] \
  || fail "Console CLI ticket did not establish the hardened HttpOnly session"

capture_console_request "/console/chat" "console-cli-ticket-session" \
  --cookie "$CONSOLE_TICKET_COOKIE_JAR"
assert_status "200" "CLI-ticket-authenticated Console session"
[[ "$HTTP_CONTENT_TYPE" == text/html* ]] \
  || fail "CLI-ticket-authenticated Console session did not receive HTML"

for sustained_request in {1..72}; do
  capture_console_request "/console/api/dashboard" \
    "console-sustained-dashboard-$sustained_request" \
    --cookie "$CONSOLE_PASSWORD_COOKIE_JAR"
  assert_status "200" "sustained authenticated Console request $sustained_request"
  [[ "$HTTP_CONTENT_TYPE" == application/json* ]] \
    || fail "sustained authenticated Console request returned $HTTP_CONTENT_TYPE"
done

capture_console_request "$CLI_LOGIN_PATH" "console-cli-ticket-replay"
assert_status "401" "Console CLI ticket replay"
assert_header_exact "content-security-policy" "$LOGIN_CSP" "Console CLI ticket replay"
grep -Fq 'data-auggy-login-variant="invalid-ticket"' "$HTTP_BODY" \
  || fail "Console CLI ticket replay did not serve the fixed branded error variant"
grep -Fq "This automatic sign-in link is invalid or expired." "$HTTP_BODY" \
  || fail "Console CLI ticket replay did not return the generic error"
if grep -Fq "$CLI_LOGIN_PATH" "$HTTP_BODY"; then
  fail "Console CLI ticket replay response leaked the one-time path"
fi

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

PREAUTH_CONSOLE_ASSET="$(sed -n '1p' "$CONSOLE_ASSETS")"
[[ -n "$PREAUTH_CONSOLE_ASSET" ]] || fail "served console HTML has no asset to test pre-auth isolation"
capture_console_request "$PREAUTH_CONSOLE_ASSET" "console-asset-preauth"
assert_status "303" "unauthenticated main Console asset"
PREAUTH_ASSET_LOCATION="$(response_header_value "location")"
[[ "$PREAUTH_ASSET_LOCATION" == /console/login\?next=* ]] \
  || fail "unauthenticated main Console asset did not redirect to first-party login"
assert_header_exact "cache-control" "no-store" "unauthenticated main Console asset"

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

if grep -Fq "$CLI_LOGIN_PATH" "$LOG_DIR/console-cli-ticket-replay.headers"; then
  fail "Console CLI ticket replay headers leaked the one-time path"
fi
if grep -R -Fq "$WEB_TOKEN" "$LOG_DIR"; then
  fail "packed runtime responses or logs leaked AUGGY_WEB_TOKEN"
fi

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
