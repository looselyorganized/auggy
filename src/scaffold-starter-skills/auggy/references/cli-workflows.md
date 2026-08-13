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

Create the inbox and runtime API key in the AgentMail Console first. Then
install the canonical augment and connect that existing inbox:

```bash
auggy augment add agentMail
auggy augment setup agentMail --mode connect
```

AgentMail setup exposes only two modes:

| Mode | Use when | Behavior |
| --- | --- | --- |
| `connect` | An AgentMail inbox and runtime key already exist | Collects the inbox ID and exact key, verifies read access, and writes canonical local bindings without changing AgentMail resources |
| `env` | Complete `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` credentials are already in `.env` | Reuses the exact stored values without creating an inbox or key |

Interactive `connect` uses a masked key prompt. Automation may provide the
canonical environment variable and inbox ID:

```bash
AGENTMAIL_API_KEY="$AGENTMAIL_API_KEY" \
  auggy augment setup agentMail --mode connect \
  --inbox-id "$AGENTMAIL_INBOX_ID"
```

Do not put a key in chat or a command argument. Auggy persists the exact
supplied key and uses it at runtime. It never creates or adopts an inbox, or
creates, narrows, rotates, or revokes API keys. To change
credentials, update the operator-owned local or deployment secret source and
run `connect` for the new explicit inbox/key pair.

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
instead of guessing. Automatic setup also refuses inline, renamed, or
additional AgentMail consumers.

Setup is not an inbound on/off switch. After credentials are configured, enable
inbound processing and reviewed replies in
`augments/agentMail/augment.yaml`, confirm that the same runtime key has the
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

The helpers should not replace explaining the direct `auggy` commands to the
creator.
