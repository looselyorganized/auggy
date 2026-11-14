# Storage Layout

Operator reference for where Auggy puts agent projects and local process state.

## Agent project location

An Auggy agent is a normal project folder wherever the operator creates it:

```text
<name>/
├── agent.yaml               # inline options; application.entrypoint
├── package.json             # project-local runtime/provider and scripts
├── bun.lock                 # after install
├── tsconfig.json
├── README.md
├── .env                     # private secrets, ignored
├── .env.example             # placeholders
├── .gitignore
├── .auggy/models.lock.json  # model metadata
├── .auggy/operations/       # private authoring receipts/backups
├── .auggy-cloud.json        # only after deployment
├── identity.md
├── learned-behaviors.md
├── src/
│   ├── index.ts             # managed startup
│   ├── agent.ts             # central-config composition
│   ├── http.ts              # POST /agent/run
│   ├── turn.ts              # turn recipe
│   └── augments/README.md   # add custom modules here
├── tests/application.test.ts
├── skills/                  # copied instructions owned by the project
├── data/workspace/README.md
└── node_modules/auggy/src/   # installed runtime and built-ins
```

`knowledge/`, additional skill folders, augment state, and custom augment
source appear only after the corresponding augment or capability is added.

`auggy create <name>` scaffolds `./<name>/`. `auggy init` scaffolds the current
directory. The directory IS the agent; there is no central index file that has
to stay in sync with the filesystem.

On POSIX systems, Auggy creates and rewrites the secret-bearing `.env` file
with owner-only permissions (`0600`). Windows deployments must enforce the
equivalent access policy with filesystem ACLs. `.env.example` contains only
variable names and placeholders and remains normally readable.

### Default-scaffold details

- `agent.yaml` uses the top-level `identity: ./identity.md` shorthand; the runtime loads it through fileMemory with `placement: system`, `origin: operator`, and `mutable: false`. `augments:` lists inline declarations in boot order, each with `name`, `type`, and optional `options` or custom `source`. `application.entrypoint` selects `./src/index.ts`.
- `identity.md` is rendered from `src/scaffold-templates/identity.md` and ships with the agent's stable identity, voice, and baked-in security rules. It does **not** contain the skill manifest.
- `learned-behaviors.md` is the scaffolded mutable `fileMemory` store. It is for creator-approved, agent-global operating guidance, not autonomous policy changes, operator identity, authorization facts, or visitor-specific memory. Default writes require runtime-verified creator trust. The former `learned.md` filename is no longer supported; rename the file and update its `fileMemory` source before upgrading.
- With an admitted runtime root, `learned-behaviors.md` is only the immutable
  first-boot seed. The mutable copy is isolated at
  `<runtime-root>/file-memory/<augment-name>.md`; a redeploy never overwrites that
  durable value. Relative `log-to-file` notification destinations use the admitted root for
  the same reason.
- `skills/<augment>/` directories hold copies of each augment's Auggy-provided `src/augments/<augment>/skill/` folder — copied automatically at `auggy create`/`auggy augment add` time. `skills/auggy/` is the canonical starter/build-out guide copied at create time. The runtime `skills` augment emits the model-facing skill manifest from these files. `auggy skill add <name>` refreshes either kind, including `auggy skill add auggy` for the general guide and `auggy skill add layeredMemory` for the peer-memory teaching. Refresh replaces the installed snapshot with Auggy-provided bytes, so preserve intentional local customizations elsewhere. The boot-time validator warns at startup if a tool-providing augment has no skill folder mounted.
- `data/` is the project-local durable-data convention. Core create uses
  `data/workspace`; locally, relative SQLite paths resolve from the agent
  project. On Railway, the resolver roots layered memory, budgets, and visitor
  auth directly under `/app/data`, stores the web idempotency ledger at
  `/app/data/web-idempotency.db`, stores console conversations at
  `/app/data/console-chat.db`, and isolates AgentMail beneath
  `/app/data/agent-mail/<augment-name>`. Only Link retains a legacy
  `/app/link.db` compatibility symlink. Railway admission also holds
  `/app/data/.auggy-runtime-singleton.lock` for the process lifetime; its
  contents are non-authoritative and it is safe to preserve in a stopped
  backup. See [18-deploy.md](./18-deploy.md).
- New `agentMail` declarations use
  `data/agent-mail/<augment-name>/orchestration.db`. Existing configured state
  paths are not relocated by authoring migration. Each mounted instance must
  own a distinct SQLite database; duplicate resolved `dbPath` ownership is a
  startup error. Reconcile unsupported historical state explicitly before
  starting a different mailbox topology.
- The filesystem augment catalogs bounded metadata from `data/workspace` on
  creator and agent turns. This makes durable artifacts visible without
  automatically loading their contents; the model still uses `fs_search`,
  `fs_list`, and `fs_read` to inspect relevant evidence.
- `knowledge/` is scaffolded by `auggy augment add knowledge`; the example `sources.json`, `local/manifest`, and endpoint files give a working local config without needing to stand up an HTTP server.

## Explicit runtime data root

`AUGGY_DATA_DIR` selects durable runtime storage independently of the source
checkout. It must be an absolute path to an existing ordinary directory, owned
by the runtime user and private (`0700` on the supported POSIX profile):

```bash
# From the agent project: create a NEW dedicated sibling directory once.
mkdir -m 700 ../support-agent-state
export AUGGY_DATA_DIR="$(cd ../support-agent-state && pwd)"
auggy state inventory --config agent.yaml
auggy run
```

Unset preserves existing project-local storage behavior. Setting the variable is
an explicit storage selection; it does not migrate an existing local database.
Inventory the paths and complete offline recovery before switching an existing
agent to a new root. An empty value, missing root, wrong owner, unsafe mode,
symlink, mismatched agent identity or unresolved restore fence causes refusal
before runtime providers, augments and ingress start. User-written top-level
module effects can run before host preparation; keep application imports free of
such effects.

Managed local/global CLI, generated application, legacy and macOS service launches
use the same admission checks. Generic startup never creates or repairs the root.
Only explicit Railway mode may initialize permissions on an existing owned,
empty advertised `/app/data` mount. A generic container using the pathname
`/app/data` does not thereby become Railway or trust its proxy headers.

Configured relative stores are resolved beneath the admitted root; paths already
inside it retain their location. For example, with project `/app` and root
`/app/data`, `./data/memory.db` is `/app/data/memory.db`. With an unrelated root,
that same relative spelling can become `<root>/data/memory.db`. Use
`auggy state inventory` to inspect the actual relative inventory before moving
storage. Absolute stores must remain inside the admitted root. Custom augments
must declare and honor their own state/recovery boundary.

Mutable file memory uses `file-memory/<augment-name>.md` beneath the admitted
root, and AgentMail uses `agent-mail/<augment-name>/`. Managed assertion replay
requires this admission and records its own SQLite store. The root also owns its
agent-identity file, restore control state, and process-lifetime singleton lock.
The lock prevents overlapping processes on the same filesystem inode; cloned or
separate volumes cannot coordinate it. Keep one active replica per logical agent.

Recovery copies state into a physical destination that may have a different path.
Use `state restore --root <recovery-directory> --runtime-root <final-mount>` to
validate the final runtime layout without relocating the stored files; keep the
compatible project at its runtime path in the recovery container. Follow the
[backup, restore and reconciliation procedure](./27-runtime-state-recovery.md).

## Model snapshot

`<agent-dir>/.auggy/models.lock.json` records what Auggy knew about the selected
engine model when the agent was scaffolded. `agent.yaml` remains the source of
truth; the snapshot is local metadata for diagnostics, pricing visibility, and
future model recommendations.

The file contains no secrets. It is intentionally not needed at runtime and is
excluded from Railway deploy bundles.

Separately, `auggy create` can fetch live provider models after the operator
enters a provider API key, and `auggy models list <provider> --refresh` can do
the same explicitly. Both store a machine-local provider cache at
`~/.auggy/model-registry-cache.json`. That cache helps future `auggy create`
runs offer recently fetched provider models without another network call. It is
not copied into agent projects and is not deployed.

## Runtime source

Agent projects install Auggy as a package dependency. The runtime source is
inspectable at `node_modules/auggy/src` after `bun install`.

The project owns the visible execution recipe in `src/`, while installed code
owns guarded runtime operations and built-in implementations. There are no
copied built-in modules or separate built-in configuration files. New custom
augments use `src/augments/<name>/`; migration preserves existing custom source
locations rather than relocating them.

Use `auggy inspect` for passive declared execution and installed source navigation.
A partial report can mean dependencies or an index are unavailable; it does not
certify readiness. `auggy doctor --verbose` provides runtime diagnostics. Use the
`auggy` executable so its startup flags disable Bun environment loading, automatic
installation and local configuration preloads during inspection.
No option values or secret values are included in the inspection report.

## Cloud-deploy state

`<agent-dir>/.auggy-cloud.json` exists **only when the agent has been
deployed**. The file's presence carries the information; its absence is
the "not-deployed" state (no null sentinel).

```json
{
  "version": 2,
  "agentId": "aug1_00000000-0000-4000-8000-000000000001",
  "provider": "railway",
  "projectId": "proj_abc",
  "serviceId": "svc_def",
  "url": "https://zip.up.railway.app",
  "volumeId": "zip-data",
  "profile": {
    "kind": "http",
    "port": 8080,
    "healthPath": "/health",
    "consolePath": "/console"
  },
  "deployedAt": "2026-05-15T12:00:00.000Z"
}
```

`auggy deploy` writes it; `auggy remove --cloud` (and `clearCloud`)
deletes it. There is no central index — each agent carries its own
deploy record beside its config.

`createdAt` is **not stored**; the CLI derives it from the directory's
filesystem birthtime (or mtime as a fallback) wherever it surfaces a
timestamp.

## Creation, migration and recovery

`auggy create <name>` reserves a new target directory exclusively. `auggy init`
preflights every generated destination in the current directory and refuses
collisions. Both publish support files before the central `agent.yaml` activation;
this is not a promise of an invisible or atomic whole-directory install. A failed
dependency install leaves the generated files available for an explicit retry.

`auggy migrate` previews conversion from referenced or mixed YAML to inline
configuration. `--apply` recomputes and publishes the current plan. It preserves
IDs, literal environment placeholders, custom source locations, option path bases,
credentials, skills and durable state. Config-only conversion preserves execution
mode. `--application` separately adopts owned execution source and refuses existing
files or conflicting package fields; it requires a compatible runtime already
installed. Its omitted turn timeout is 900000 ms (15 minutes), while legacy mode
has no application deadline.

Cooperating writers serialize through the private stable project lease. Inputs
and owned outputs are rechecked, but the lease does not control arbitrary editors.
Changes activate on the next managed launch; migration never stops or reloads an
in-flight agent. Apply records an operation ID below `.auggy/operations/`.
Receipts and backups can contain inline configuration secrets: `.auggy/` is
private, ignored and deployment-excluded.

```bash
auggy migrate --config agent.yaml                         # preview
auggy migrate --config agent.yaml --apply                 # config only
auggy migrate --config agent.yaml --application            # adoption preview
auggy migrate --config agent.yaml --application --apply
auggy migrate --project-dir . --rollback <operation-id>    # recovery preview
auggy migrate --project-dir . --rollback <operation-id> --apply
```

Rollback checks ownership and refuses changed outputs. The directory selector
works even if `agent.yaml` is absent or malformed. It does not restore existing
credentials from backups. An init-created `.env` can be removed only while it
still matches that operation's owned output. Preserve a recovery-required receipt
for review; do not publish its contents or force-delete conflicting files.

## Inspecting and removing

```bash
auggy list                          # list agent projects below the current directory
auggy remove --yes                  # delete the current agent project
auggy remove <name>                 # delete the agent dir
auggy remove <name> --yes           # skip the confirmation prompt
auggy remove <name> --cloud         # also destroy the Railway service
```

`auggy remove` refuses if the agent is running — `auggy stop` it first. It
also refuses to delete a directory that lacks `agent.yaml`, as a guard
against accidentally nuking unrelated paths.

If you delete an agent's directory manually (`rm -rf ./zip`),
that's the entire removal — there is no separate index entry to clean up.

## Migration from the legacy index

Pre-filesystem-as-truth builds kept a central `~/.auggy/agents.json`
mapping each name to a `localDir`. The first call into the new store on
an upgraded installation:

- distributes any non-null `cloud` records into the corresponding
  agent's `.auggy-cloud.json`,
- renames `agents.json` to `agents.json.migrated-<ISO timestamp>` so
  the operator can recover from backup if needed.

A short-lived in-progress shape (`.auggy-meta.json`, never released) is
also forward-migrated: cloud records inside it move to
`.auggy-cloud.json` and the meta file is deleted.

Migration is idempotent and best-effort — failures are logged, not
fatal.

## Cloud

`auggy deploy` writes `.auggy-cloud.json` version 2 with the immutable agent ID,
provider, actual project/service/volume IDs, deployment time and ingress profile.
HTTP profiles include a URL and declared port/health/Console paths; workers store
`url: null`. Valid version 1 records remain readable as the historical port-8080
HTTP profile without a read-time rewrite. A successful explicit deployment writes
the current format.

`auggy logs` uses the saved target for HTTP and worker services.
`auggy console --cloud` requires an HTTP profile with a Console path.
`auggy remove --cloud` uses the record to target service removal. The local record
is operator metadata, not a backup or a shared service registry. See
[deployment](./18-deploy.md) for profile validation and volume-binding checks.
