# CLI Workflows

Use CLI commands before hand-editing generated or scaffolded state.

Optional helper scripts for coding-agent workspaces live under
`skills/auggy/scripts/`. They wrap the commands below; they are conveniences,
not a separate Auggy interface.

## Install And Create

For a new project, use the package manager the creator prefers. Common path:

```bash
bunx auggy create my-agent
cd my-agent
```

If Auggy is already installed locally:

```bash
auggy create my-agent
```

If the creator is inside an existing agent project, prefer project-local
commands such as:

```bash
auggy doctor
auggy run
```

The generated application owns `src/index.ts`, `src/agent.ts`, `src/http.ts`
and `src/turn.ts`. `agent.yaml` is the sole enabled graph. The global CLI is a
convenience; execution selects the project-local Auggy dependency. Pin matching
core/provider versions and verify the installed package supports application
contract 1. These authoring changes are unreleased; a published 0.5 package
with the same version number is not this development implementation.

For files-only automated creation, provide both provider and model:

```bash
auggy create my-agent --provider anthropic --model claude-sonnet-4-6 --yes --skip-install
```

This does not discover or pull models. An unpriced selection also needs explicit
`--allow-unpriced-model`; `--yes` is not that acknowledgement. `auggy init` uses
the same contract in the current directory and fails on generated-file collisions.
Install the selected dependencies and configure private secrets before execution.

## Inspect And Migrate

`auggy inspect` reports declared entrypoints and installed built-in source paths
without importing project code. A partial result is not a readiness check and
custom path hints are not a proven TypeScript call graph. Use the project-local binary explicitly to disable Bun environment loading,
automatic installation and local configuration preloads:

```bash
./node_modules/.bin/auggy inspect
```

Legacy run and read commands remain supported. Graph-changing commands require
inline configuration. Preview conversion with `auggy migrate`, then use
`auggy migrate --apply` after reviewing the result. Add `--application` separately
to preview or adopt the owned source layout. Adoption requires a compatible local
runtime already installed, refuses output collisions, and introduces the default
15-minute managed application deadline. Config-only conversion retains legacy
execution and does not move custom source. These commands do not install packages
or hot-reload a running process; changes take effect on the next launch.

Private recovery records under `.auggy/operations/` may include original inline
secrets. Keep them ignored and out of deployment/model-visible content. Preview
recovery with `auggy migrate --project-dir . --rollback <operation-id>`, then add
`--apply`; changed outputs are not overwritten. This recovery selector works even
when `agent.yaml` is absent. Dependency upgrades update managed runtime/built-ins
without regenerating owned source or skills.

## Configure Provider Keys

Provider keys belong in `.env` or provider-owned secret stores. Never put them
in `identity.md`, `skills/`, `knowledge/`, generated browser clients, or chat
messages.

Typical local checks:

```bash
auggy doctor
```

If `doctor` reports a missing provider key, help the creator identify the env
var name. Do not ask them to paste the secret value into chat.

## Configure AgentMail

Install the canonical augment, then let its interactive setup menu select the
appropriate provider operation:

```bash
auggy augment add agentMail
auggy augment setup agentMail
```

AgentMail setup supports these modes:

| Mode | Use when | Behavior |
| --- | --- | --- |
| `signup` | The operator needs a new AgentMail account | Creates the initial account and inbox, verifies the email code in an interactive terminal, and saves the initial key |
| `existing` | The operator has an account key and wants a new inbox | Creates the inbox and stores that exact same account key for runtime use |
| `manual` | An inbox and runtime key already exist | Verifies the inbox ID and exact key, then writes local bindings without creating provider resources |
| `env` | Complete `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` credentials are already in `.env` | Revalidates and reuses those exact values |

`connect` remains an alias for `manual`. Interactive creation asks for operator
confirmation. `signup` requires an interactive terminal for email verification;
never collect verification codes or API keys in chat. The operator enters those
directly into the CLI. Automated provider creation uses the dedicated
`auggy agentmail setup` command; the generic `auggy augment setup` wrapper does
not expose `--username` or `--yes`. With an account key supplied through the
private `AGENTMAIL_API_KEY` environment variable:

```bash
auggy agentmail setup agentMail --mode existing --username my-agent --yes
```

Choose `--yes` only after the operator authorizes inbox creation. Manual
connection can use the canonical environment variables:

```bash
auggy augment setup agentMail --mode manual
```

Supply `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` through the operator's
private process environment or the secure CLI prompt. Do not put a key in chat
or a command argument. Auggy uses the selected key unchanged: it never exchanges
it for a narrower runtime key, rotates it, or revokes it. `signup` saves its
initial provider-issued key; `existing` and `manual` save the exact supplied key.
To change configured credentials deliberately, update the private secret source
and use manual connection or environment reuse.

Before writing local files, setup verifies the configured inbox identity with
`inbox_read`. When inbound or reviewed replies are enabled, it also performs
bounded `message_read` and `draft_read` probes. Success output lists every
permission the policy requires. Write permissions such as `message_send`,
`draft_create`, `draft_update`, and `draft_send` are requirements, not verified
claims: setup does not send mail or mutate drafts.

`agentMail` and `visitorAuth` use the same `AGENTMAIL_*` credentials. When both
canonical augments are being added interactively, one command coordinates the
connection regardless of selection order:

```bash
auggy augment add agentMail visitorAuth
```

The CLI uses one shared confirmation and credential flow, connects `agentMail`,
and attaches `visitorAuth` through environment reuse without asking twice.
`--yes` skips optional post-add setup. For standalone adds, automation, skipped
setup, or recovery, preserve the same boundary with this sequence:

```bash
auggy augment setup agentMail --mode connect
auggy augment setup visitorAuth --mode env
```

The second command verifies and reuses the same stored values without changing
provider resources. Omitting the target when both are installed fails closed
instead of guessing. Automatic setup requires canonical inline declarations in `agent.yaml` and
refuses legacy, renamed, custom, or additional same-type consumers. Migrate a
legacy graph before setup; the migration itself does not contact AgentMail.

`manual` and `env` only read from AgentMail. `signup` and `existing` can leave a
remote account or inbox behind if a later step fails; inspect the AgentMail
Console before retrying an ambiguous creation. Local activation checks that the
configuration has not changed while setup was running. Do not assume a provider
operation can be rolled back with local files.

Setup is not an inbound on/off switch. After credentials are configured, enable
inbound processing and reviewed replies in
the `agentMail` entry in `agent.yaml`, confirm that the same runtime key has the
reported permissions, and restart:

```bash
auggy restart <agent-name>
```

With `inbound.mode: websocket`, a live AgentMail event wakes a running Auggy.
On boot and periodically while running, bounded provider catch-up recovers mail
missed during downtime or a connection gap. The official AgentMail skill and
MCP server do not provide that lifecycle behavior.

With `replies.mode: review`, Auggy generates a plain-text reply and creates it
as a provider-native draft in AgentMail. The verified creator can review and
iterate on that draft in Auggy with `list_mail_drafts`, `show_mail_draft`, and
`revise_mail_draft`, or edit it in AgentMail. Draft creation or revision never
authorizes delivery. Sending through Auggy requires a separate exact creator
command—`send it` after showing the draft or `send draft <draftId>`—and a fresh
provider version check. A draft sent in AgentMail is provider-owned and is no
longer available as a draft afterward.

The official AgentMail skill teaches compatible coding agents how to call the
provider, and the hosted MCP exposes broad inbox, message, thread, draft,
attachment, and organization tools. Treat either as supplemental capability
for explicit operator work. Installing either does not connect provider events
to Auggy turns, persist Auggy's recovery checkpoint, apply its sender/rate
policy, or enforce its creator-review workflow. Do not add broad direct
mutation tools to the same managed inbox as a substitute for this augment;
that would create a path around Auggy's authorization and review controls.

Removing either shared augment retains the remote inbox/key and local
`AGENTMAIL_*` values. Keep them while the other consumer remains. After
removing the last consumer, separately revoke a truly unused key in AgentMail
before removing its local value. Auggy never revokes it for you.

## Run Locally

```bash
auggy run
```

The CLI opens the Console chat already signed in. If automatic sign-in is
unavailable, use `AUGGY_WEB_TOKEN` from the agent's `.env` on the password
screen.

If the agent is a named project outside the current directory:

```bash
auggy run <name>
```

To open an already-running local agent or its saved Railway deployment without
starting it:

```bash
auggy console <name>
```

## Inspect Routes

Run this after route-owning augment changes:

```bash
auggy routes
auggy routes --json
auggy routes --openapi
```

Use route reports to confirm:

- expected method and path
- auth posture
- route policy metadata
- request schemas
- response schemas
- omitted browser/server generated client routes

## Generate Route Clients

```bash
auggy routes --client ts --target browser --out src/auggy-client.ts
auggy routes --client ts --target server --out src/auggy-client.server.ts
```

Use the browser target for browser-safe public and visitor routes. Use the
server target for trusted server code, SSR/server actions, jobs, bearer/creator
routes, agent routes, and webhook-policy routes.

## Deploy

Run local checks first:

```bash
auggy doctor
```

Then:

```bash
auggy deploy
```

For cloud-specific readiness:

```bash
auggy doctor --cloud
```

Do not deploy until required secrets are configured in the deployment provider.
Do not print secret values.

## Helper Scripts

Use these only when shell access is available:

```bash
bash skills/auggy/scripts/detect-auggy-env.sh
bash skills/auggy/scripts/summarize-auggy-project.sh .
bash skills/auggy/scripts/doctor-and-routes.sh
bash skills/auggy/scripts/generate-route-clients.sh src/auggy-client.ts src/auggy-client.server.ts
```

`summarize-auggy-project.sh` requires the project-local Auggy installation and
runs passive inspection with Bun environment-file loading disabled. Other helpers
that run `doctor` or `routes` execute configuration and augment code. Trust the
project before using those. Explain the direct commands as well as the helpers.
