# Storage Layout

Operator reference for where Auggy puts agents on disk.

## Default location

```
~/.auggy/
├── agents.json                     # the index — name → localDir → cloud-state
├── agents/                         # default home for scaffolded agents
│   └── <name>/
│       ├── agent.yaml              # source-of-truth config (uses `identity:` shorthand)
│       ├── identity.md             # who the agent is — security rules + skill manifest
│       ├── learned.md              # mutable learnings
│       ├── memory.sqlite           # SQLite (layeredMemory, default scaffold)
│       ├── budgets.db              # SQLite (budgets)
│       ├── .env                    # secrets (gitignored)
│       ├── .env.example            # template
│       ├── skills/                 # bundled-skill copies (one folder per tool-providing augment)
│       │   ├── layered-memory/SKILL.md
│       │   ├── filesystem/SKILL.md (+ references/)
│       │   └── ...                 # web-fetch, org-context, bash, notify, turn-control as configured
│       ├── org-context/            # scaffolded if orgContext is selected (file:// example)
│       │   ├── manifest            # JSON manifest consumed by orgContext
│       │   ├── mission.md
│       │   ├── team.md
│       │   └── README.md
│       ├── workspace/
│       └── augments/
├── <name>.json                     # PID manifest (per running agent)
└── chat/                           # chat dist cache
```

`auggy create <name>` scaffolds at `~/.auggy/agents/<name>/` by default.

### Default-scaffold details (post-PR α)

- `agent.yaml` uses the top-level `identity: ./identity.md` shorthand (parsed to a synthetic `fileMemory@placement:system` entry); `augments:` enumerates the rest.
- `identity.md` is rendered from `src/scaffold-templates/identity.md` and ships with four baked-in security rules and a `## Available skills` manifest enumerating each tool-providing augment selected at scaffold time.
- `skills/<augment>/` directories hold byte-for-byte copies of each augment's bundled `src/augments/<augment>/skill/` folder — copied at `auggy create`/`auggy add` time and (re-)installable via `auggy add-skill <augment>`. The boot-time validator warns at startup if a tool-providing augment has no skill folder mounted.
- `memory.sqlite` is the default `layeredMemory` backend (SQLite, namespace-scoped). The scaffold includes the augment by default; remove from `agent.yaml` if not needed.
- `org-context/` is scaffolded only when `orgContext` is selected; the example `manifest` + endpoint files plus `baseUrl: file://./org-context` give a working local config without needing to stand up an HTTP server.

## Custom location with `--dir`

For git-tracked agents or project-folder layouts:

```bash
auggy create concierge --dir ~/projects/concierge
```

The agent dir lives wherever you point `--dir`; the index records the absolute path. Subsequent `auggy dev concierge`, `auggy stop concierge`, etc. work from any CWD.

## The index file

`~/.auggy/agents.json` is load-bearing. It maps each registered agent name to its directory and (eventually) its cloud deployment state. Schema:

```json
{
  "version": 1,
  "agents": {
    "<name>": {
      "localDir": "/abs/path",
      "createdAt": "2026-05-01T12:00:00Z",
      "cloud": null
    }
  }
}
```

The CLI writes atomically (temp+rename), recovers from corruption (backs up to `agents.json.corrupt-<timestamp>` and recreates empty), and refuses unknown schema versions.

## Inspecting and removing

```bash
auggy ls                            # list registered agents
auggy remove <name>                 # delete dir + clear index entry
auggy remove <name> --yes           # skip the confirmation prompt
```

`auggy remove` refuses if the agent is running — `auggy stop` it first.

If you delete an agent's directory manually (e.g., `rm -rf ~/.auggy/agents/zip`), the index entry is left orphaned. `auggy ls` flags it as `missing-dir`; `auggy remove zip` will then clean up the index entry without trying to re-delete the dir.

## Cloud (forward-looking)

Cloud deploys (Railway) are on the roadmap for after v1.0 OSS launch — not yet shipped. When they land, the index `cloud` field is populated with provider/projectId/serviceId/url/volumeId. Design captured in ADR-021 (`agent-storage-and-deployment-locations`).
