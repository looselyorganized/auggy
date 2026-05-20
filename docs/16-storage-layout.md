# Storage Layout

Operator reference for where Auggy puts agents on disk.

## Default location

```
~/.auggy/
├── agents/                         # one subdirectory per agent
│   └── <name>/
│       ├── agent.yaml              # source-of-truth config (uses `identity:` shorthand)
│       ├── .auggy-meta.json        # per-agent metadata (createdAt, cloud record)
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
├── <name>.json                     # PID manifest (per running agent)
└── chat/                           # chat dist cache
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

## Per-agent metadata

`<agent-dir>/.auggy-meta.json` carries:

```json
{
  "version": 1,
  "createdAt": "2026-05-01T12:00:00.000Z",
  "cloud": null
}
```

`createdAt` is set at `auggy create` time. `cloud` is populated by `auggy
deploy` and cleared by `auggy remove --cloud`. If the file is missing (e.g.
older agents pre-dating the schema), the CLI falls back to the directory's
filesystem mtime and treats `cloud` as `null`.

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

Pre-`feat/filesystem-as-truth` builds kept a central `~/.auggy/agents.json`
mapping each name to a `localDir`. The first call into the new store on an
upgraded installation migrates each entry into a per-agent
`.auggy-meta.json` (preserving `createdAt` and any `cloud` record), then
renames the legacy file to `agents.json.migrated-<ISO timestamp>` so the
operator can recover from backup if needed. Migration is idempotent and
runs at most once per directory.

## Cloud

`auggy deploy <name> --to railway` writes the Railway service metadata
(provider, projectId, serviceId, url, volumeId, deployedAt) into the
agent's `.auggy-meta.json`. `auggy remove <name> --cloud` reads the same
record to destroy the Railway service before removing the local dir.
