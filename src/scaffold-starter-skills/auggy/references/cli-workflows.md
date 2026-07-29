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
