# Storage Layout

Operator reference for where Auggy puts agent projects and local process state.

## Agent project location

An Auggy agent is a normal project folder wherever the operator creates it:

```
<name>/
├── agent.yaml              # source-of-truth config (uses `identity:` shorthand)
├── .auggy/models.lock.json # model metadata snapshot from create/refresh
├── .auggy-cloud.json       # cloud-deploy record (only present when deployed)
├── identity.md             # who the agent is — operator-authored rules + voice
├── .env                    # secrets (gitignored)
├── .env.example            # required secret names, no values
├── package.json            # agent-local runtime and augment dependencies
├── skills/                 # bundled and user-authored skills
│   ├── filesystem/SKILL.md (+ references/)
│   └── ...                 # webFetch, turnControl, and added augments
├── knowledge/              # scaffolded by `auggy augment add knowledge`
├── data/
└── augments/               # installed augment config and custom augment source
    ├── filesystem/augment.yaml
    ├── webFetch/augment.yaml
    └── ...
```

`auggy create <name>` scaffolds `./<name>/`. `auggy init` scaffolds the current
directory. The directory IS the agent; there is no central index file that has
to stay in sync with the filesystem.

### Default-scaffold details

- `agent.yaml` uses the top-level `identity: ./identity.md` shorthand; the runtime loads it through fileMemory with `placement: system`, `origin: operator`, and `mutable: false`. `augments:` lists enabled augment ids in boot order. Per-augment config lives in `augments/<id>/augment.yaml`.
- `identity.md` is rendered from `src/scaffold-templates/identity.md` and ships with the agent's stable identity, voice, and baked-in security rules. It does **not** contain the skill manifest.
- `skills/<augment>/` directories hold byte-for-byte copies of each augment's bundled `src/augments/<augment>/skill/` folder — copied automatically at `auggy create`/`auggy augment add` time. `skills/auggy/` is the canonical starter/build-out guide copied at create time. The runtime `skills` augment emits the model-facing skill manifest from these files. `auggy skill add <name>` refreshes either kind, including `auggy skill add auggy` for the general guide and `auggy skill add layeredMemory` for the peer-memory teaching. Refresh overwrites that bundled skill's installed snapshot, so preserve intentional local customizations elsewhere. The boot-time validator warns at startup if a tool-providing augment has no skill folder mounted.
- `data/` is the project-local durable-data convention. Core create uses
  `data/workspace`; locally, relative SQLite paths resolve from the agent
  project. On Railway, the resolver roots layered memory, budgets, and visitor
  auth directly under `/app/data` and isolates AgentMail beneath
  `/app/data/agent-mail/<augment-name>`. Only Link retains a legacy
  `/app/link.db` compatibility symlink. See [18-deploy.md](./18-deploy.md).
- The filesystem augment catalogs bounded metadata from `data/workspace` on
  creator and agent turns. This makes durable artifacts visible without
  automatically loading their contents; the model still uses `fs_search`,
  `fs_list`, and `fs_read` to inspect relevant evidence.
- `knowledge/` is scaffolded by `auggy augment add knowledge`; the example `sources.json`, `local/manifest`, and endpoint files give a working local config without needing to stand up an HTTP server.

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

Auggy does not copy its runtime TypeScript source into every generated agent
project. Keeping the runtime in `node_modules` means agents receive runtime and
security updates through the normal package manager path instead of carrying a
vendored copy that can drift from the published runtime. Built-in augment
folders contain project-owned config only. Custom augments are the exception:
they live as local source under `augments/<name>/` because they belong to the
agent project.

Use `auggy doctor --verbose` to show the installed runtime source path.

## Cloud-deploy state

`<agent-dir>/.auggy-cloud.json` exists **only when the agent has been
deployed**. The file's presence carries the information; its absence is
the "not-deployed" state (no null sentinel).

```json
{
  "provider": "railway",
  "projectId": "proj_abc",
  "serviceId": "svc_def",
  "url": "https://zip.up.railway.app",
  "volumeId": "zip-data",
  "deployedAt": "2026-05-15T12:00:00.000Z"
}
```

`auggy deploy` writes it; `auggy remove --cloud` (and `clearCloud`)
deletes it. There is no central index — each agent carries its own
deploy record beside its config.

`createdAt` is **not stored**; the CLI derives it from the directory's
filesystem birthtime (or mtime as a fallback) wherever it surfaces a
timestamp.

## Atomic creation

`auggy create <name>` writes the scaffold into a temp staging directory, then
renames it into `./<name>`. `auggy init` stages the same scaffold and copies it
into the current directory. If the process is interrupted beforehand, the temp
directory is removed or left outside the agent project.

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

`auggy deploy` writes the Railway service metadata
(provider, projectId, serviceId, url, volumeId, deployedAt) into
`<agent-dir>/.auggy-cloud.json`. `auggy logs` reads the same file to stream
Railway logs for the saved project/service. `auggy remove --cloud` reads that
file to destroy the Railway service before removing the local dir (and the file
with it).
