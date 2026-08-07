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
| `signup` | The creator is new to AgentMail | Creates an account and first inbox through email verification, then stores only an inbox-scoped runtime key locally |
| `existing` | The creator already has an AgentMail account | Uses a masked account-key prompt to create or recover this agent's stable inbox, then stores only a scoped runtime key locally |
| `manual` | The creator already has an inbox and scoped runtime key | Connects the exact inbox ID and runtime key without provisioning provider resources |
| `env` | Complete `AGENTMAIL_API_KEY` and `AGENTMAIL_INBOX_ID` credentials are already in `.env` | Reuses them without provisioning another inbox or key |

For an existing account, the direct command is:

```bash
auggy agentmail setup agentMail --mode existing
```

Use the masked prompt or an ephemeral `AGENTMAIL_ACCOUNT_API_KEY`; do not put an
account-level key in chat. The account key is used only for provisioning and is
not written to the project. Existing-account retries derive one provider-valid
`client_id` from the immutable agent ID and target, so the same logical setup
recovers the same inbox instead of creating duplicates.

Setup never silently rotates credentials that are already assigned to the
agent. Reuse them with `--mode env`. To attach a replacement inbox or key,
first have the creator revoke the old scoped key in AgentMail, then remove the
old `AGENTMAIL_*` values from `.env` and unset exported copies before running
`signup`, `existing`, or `manual`. Never delete the local key before its
provider credential is revoked.

If signup reports that the owner email already has an account, switch to
`existing` mode. The failed signup does not adopt an arbitrary inbox or change
local credentials. For non-interactive automation, pass an explicit mode and
its required inputs; `signup` remains interactive because it requires the
verification code issued during the flow.

`agentMail` and `visitorAuth` use the same `AGENTMAIL_*` credentials. When both
canonical augments are installed, preserve that boundary with this sequence:

```bash
auggy agentmail setup agentMail
auggy agentmail setup visitorAuth --mode env
```

The first command establishes the provider-confirmed inbox address and scoped
runtime key. The second updates `visitorAuth` to reuse them without creating or
replacing provider resources. Omitting the target when both are installed
fails closed instead of guessing. Automatic setup also refuses inline,
custom-named, or additional AgentMail consumers; configure those topologies
manually. Automatic credential mutation requires macOS or Linux; on Windows,
configure `.env` and the referenced augment YAML with ordinary project tooling.

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
