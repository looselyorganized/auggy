# Storage Layout

Operator reference for where Auggy puts agents on disk.

## Default location

```
~/.auggy/
├── agents/                         # one subdirectory per agent
│   └── <name>/
│       ├── agent.yaml              # source-of-truth config (uses `identity:` shorthand)
│       ├── .auggy-cloud.json       # cloud-deploy record (only present when deployed)
│       ├── identity.md             # who the agent is — security rules + skill manifest
│       ├── learned.md              # mutable learnings
│       ├── memory.sqlite           # SQLite (layeredMemory, default scaffold)
│       ├── budgets.db              # SQLite (budgets)
│       ├── .env                    # secrets (gitignored)
│       ├── skills/                 # bundled-skill copies (one folder per tool-providing augment)
│       │   ├── layered-memory/SKILL.md
│       │   ├── filesystem/SKILL.md (+ references/)
│       │   └── ...                 # web-fetch, org-context, bash, notify, turn-control as configured
│       ├── org-context/            # scaffolded if orgContext is selected (file:// example)
│       ├── workspace/
│       └── augments/
└── <name>.json                     # PID manifest (per running agent)
```

`auggy create <name>` scaffolds at `~/.auggy/agents/<name>/`. The directory IS
the agent — there is no central index file that has to stay in sync with the
filesystem.

### Default-scaffold details

- `agent.yaml` uses the top-level `identity: ./identity.md` shorthand (parsed to a synthetic `fileMemory@placement:system` entry); `augments:` enumerates the rest.
- `identity.md` is rendered from `src/scaffold-templates/identity.md` and ships with four baked-in security rules and a `## Available skills` manifest enumerating each tool-providing augment selected at scaffold time.
- `skills/<augment>/` directories hold byte-for-byte copies of each augment's bundled `src/augments/<augment>/skill/` folder — copied at `auggy create`/`auggy add` time and (re-)installable via `auggy add-skill <augment>`. The boot-time validator warns at startup if a tool-providing augment has no skill folder mounted.
- `memory.sqlite` is the default `layeredMemory` backend (SQLite, namespace-scoped). The scaffold includes the augment by default; remove from `agent.yaml` if not needed.
- `org-context/` is scaffolded only when `orgContext` is selected; the example `manifest` + endpoint files plus `baseUrl: file://./org-context` give a working local config without needing to stand up an HTTP server.

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

`auggy create <name>` writes the scaffold into a sibling
`~/.auggy/agents/.tmp-<uuid>/` staging directory, then renames it into
place. The rename is the atomic publish step — if the process is interrupted
beforehand, the staging dir is swept on the next `auggy create` (or skipped
by `auggy list`, which only enumerates dirs that look like complete agents).

## Inspecting and removing

```bash
auggy list                          # list agents from <auggyDir>/agents/
auggy remove <name>                 # delete the agent dir
auggy remove <name> --yes           # skip the confirmation prompt
auggy remove <name> --cloud         # also destroy the Railway service
```

`auggy remove` refuses if the agent is running — `auggy stop` it first. It
also refuses to delete a directory that lacks `agent.yaml`, as a guard
against accidentally nuking unrelated paths.

If you delete an agent's directory manually (`rm -rf ~/.auggy/agents/zip`),
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

`auggy deploy <name> --to railway` writes the Railway service metadata
(provider, projectId, serviceId, url, volumeId, deployedAt) into
`<agent-dir>/.auggy-cloud.json`. `auggy remove <name> --cloud` reads
that file to destroy the Railway service before removing the local dir
(and the file with it).
