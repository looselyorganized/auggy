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

Install the canonical target before setup:

```bash
auggy augment add agentMail
auggy agentmail setup agentMail
```

With an interactive terminal, the second command offers four explicit modes:

| Mode | Use when | Behavior |
| --- | --- | --- |
| `signup` | The creator is new to AgentMail | Creates an account and first inbox through email verification, then stores the API key returned by that flow unchanged |
| `existing` | The creator already has AgentMail and the supplied key can create inboxes | Creates or recovers this agent's stable inbox, then stores the exact supplied key for runtime use |
| `manual` | The creator already has an inbox and a key that can access it | Connects the exact inbox ID and supplied key without creating provider resources |
| `env` | Complete `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` credentials are already in `.env` | Reuses the exact stored values without creating an inbox or key |

For an existing account, the direct command is:

```bash
auggy agentmail setup agentMail --mode existing
```

Use the masked prompt or canonical process environment `AGENTMAIL_API_KEY`; do
not put a key in chat. Auggy persists that exact selected value and uses it at
runtime. It does not mint a child key, narrow its permissions, rotate it, or
revoke it. Existing-account retries derive one provider-valid `client_id` from
the immutable agent ID and target, so the same logical setup recovers the same
inbox instead of creating duplicates.

`AGENTMAIL_ACCOUNT_API_KEY` remains a deprecated compatibility alias for one RC.
It is accepted only from the setup process environment. Project `.env`,
`.env.local`, and environment-specific dotenv files containing it are rejected
before provider access. Auggy never persists or deploys the legacy variable
name; when accepted, its exact value is stored under canonical
`AGENTMAIL_API_KEY`. Rename the input variable now and do not use it for new
setup.

Every setup mode verifies that the selected key can read the configured inbox
identity (`inbox_read`) before changing local files. The success output also
lists capabilities required by the configured policy, such as `message_send`
or `message_read`; those additional capabilities are requirements, not claims
that setup exercised or verified them.

Setup never silently replaces credentials already assigned to the agent. Reuse
them with `--mode env`. To replace only the stored key while preserving the
existing inbox ID and email, use:

```bash
auggy agentmail setup agentMail --mode manual --replace-key
```

Interactive use reads the new key through a masked prompt and asks for
confirmation. Non-interactive automation must supply the new key through an
explicit setup source and add `--yes`. Auggy verifies the new key's access to
the existing inbox before atomically writing it. It does not create, rotate, or
revoke any provider key; after setup succeeds, the creator may separately
revoke the previous key in AgentMail if nothing else uses it. A no-op key or an
attempt to change the inbox fails before provider access.

If signup reports that the owner email already has an account, switch to
`existing` mode. The failed signup does not adopt an arbitrary inbox or change
local credentials. For non-interactive automation, pass an explicit mode and
its required inputs; `signup` remains interactive because it requires the
verification code issued during the flow.

If AgentMail returns a definitive `403 resource_taken`, reuse is safe only
when the exact inbox address and compatible Auggy `client_id` prove one owned
match; interactive setup still asks for confirmation. Otherwise it offers a
different username for at most three create attempts total. Non-interactive
setup fails without adopting the collision; pass another `--username` or use
`--mode manual` with a verified inbox and supplied API key. Confirmed reuse
keeps the exact selected key; it does not create or revoke provider keys.

`agentMail` and `visitorAuth` use the same `AGENTMAIL_*` credentials. When both
canonical augments are being added interactively, one command coordinates the
complete flow regardless of selection order:

```bash
auggy augment add agentMail visitorAuth
```

The CLI uses one shared setup confirmation and credential flow, provisions
`agentMail`, and attaches `visitorAuth` through environment reuse without
asking for credentials again. `--yes` skips optional post-add setup. For
standalone adds, automation, skipped setup, or recovery, preserve the same
boundary with this sequence:

```bash
auggy agentmail setup agentMail
auggy agentmail setup visitorAuth --mode env
```

The first command establishes the provider-confirmed inbox address and exact
supplied API key. The second updates `visitorAuth` to reuse them without
creating or replacing provider resources. Omitting the target when both are
installed fails closed instead of guessing. Automatic setup also refuses
inline, custom-named, or additional AgentMail consumers; configure those
topologies manually. Automatic credential mutation requires macOS or Linux; on
Windows, configure `.env` and the referenced augment YAML with ordinary
project tooling.

Setup is not an inbound on/off switch. After credentials are configured, enable
inbound processing in `augments/agentMail/augment.yaml`, confirm that the same
`AGENTMAIL_API_KEY` has the required inbound capabilities, and restart:

```bash
auggy restart <agent-name>
```

Do not run AgentMail setup again merely because `inbound.mode` changed. Setup
is needed again only when credentials are missing, invalid, or intentionally
being replaced through the explicit key-replacement flow.

Removing either shared augment retains the remote inbox/key and local
`AGENTMAIL_*` values. Keep them while the other consumer remains. After
removing the last consumer, separately revoke a truly unused key in AgentMail
before removing its local value. Auggy never revokes it for you.
`AGENTMAIL_WEBHOOK_SECRET` is optional and belongs only to Svix webhook inbound
mode; default outbound, polling, and WebSocket use do not require it.

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
