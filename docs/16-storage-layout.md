# Storage Layout

Operator reference for where Auggy puts agents on disk.

## Default location

```
~/.auggy/
├── agents.json                     # the index — name → localDir → cloud-state
├── agents/                         # default home for scaffolded agents
│   └── <name>/
│       ├── agent.yaml              # source-of-truth config
│       ├── identity.md             # who the agent is
│       ├── learned.md              # mutable learnings
│       ├── memory.db               # SQLite (layeredMemory)
│       ├── budgets.db              # SQLite (budgets)
│       ├── .env                    # secrets (gitignored)
│       ├── .env.example            # template
│       ├── skills/
│       ├── workspace/
│       └── augments/
├── <name>.json                     # PID manifest (per running agent)
└── chat/                           # chat dist cache
```

`auggy create <name>` scaffolds at `~/.auggy/agents/<name>/` by default.

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

Cloud deploys (Railway) are not yet shipped. When they land, the index `cloud` field is populated with provider/projectId/serviceId/url/volumeId. See [ADR-021](../../docs/solutions/architecture/adr-021-agent-storage-and-deployment-locations.md) for the full design.
