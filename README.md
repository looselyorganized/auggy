<p align="center">
  <img src="assets/auggy.png" alt="Auggy — a hand-drawn modular robot waving" width="220" />
</p>

<h1 align="center">Auggy</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/auggy"><img src="https://img.shields.io/npm/v/auggy?label=npm" alt="npm" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-green" alt="Apache-2.0 license" /></a>
  <img src="https://img.shields.io/badge/runtime-Bun-black?logo=bun" alt="Bun runtime" />
  <img src="https://img.shields.io/badge/language-TypeScript-3178C6?logo=typescript" alt="TypeScript" />
</p>

**Turn business operations into agent-ready capabilities.**

Auggy is a self-hosted TypeScript runtime that gives an agent access to
operations your application already supports. An **augment** defines the tools
or HTTP routes for an operation, validates inputs, checks who can act, and calls
your service.

For example, a customer asks to change a shipping address. Your application
verifies the customer. The order-support augment checks that the order belongs
to them, asks them to confirm the new address, and submits the change to your
order service.

This guide covers Auggy **v0.6.1**, a public preview. Pin exact package versions
for production-like evaluation.

## Quick Start

Install **Bun 1.3.14 or newer** on macOS or Linux. Choose Anthropic, OpenAI,
or OpenRouter and supply its API key, or connect to a running Ollama instance.
[Install Bun](https://bun.com/docs/installation) · [Native Windows PowerShell support](https://github.com/looselyorganized/auggy/issues/244)

```bash
bunx auggy@0.6.1 create my-agent
cd my-agent
bun run auggy run
```

The wizard installs the runtime and provider in `my-agent`. The last command
starts the agent and opens local operator chat at `/console/chat`. If you
skipped the provider key in the wizard, add it to the generated `.env` before
starting. Leave the agent running and use a second terminal in `my-agent` for
the commands below, or stop it with Ctrl+C. For startup problems, run
`bun run auggy doctor`.

## Follow the execution

Open these three files in the generated project to trace a message from your
frontend to a tool and back.

| File | What to look for |
| --- | --- |
| `src/main.ts` | Creates the model and augments, passes `turnProgram` to `createAgent`, binds the transports, and starts the service. |
| `src/http.ts` | Mounts `POST /agent/run` and passes the original request to `web.agentRun(request)`. The HTTP adapter authenticates the caller, validates the request, and admits the turn. |
| `src/turn.ts` | Prepares the prompt, calls the model with `turn.infer()`, runs requested tools with `turn.executeTools(step)`, and returns the completed turn. |

These files are yours to edit. The installed runtime enforces tool
authorization, cancellation, execution limits, and accounting around the
guarded operations. Each augment also checks whether the caller may act on the
specific resource, such as the order being changed.

Run `bun run auggy inspect` to locate the entrypoint, custom augments, and
installed source without starting the service. The generated `bun start` and
`bun run dev` scripts run the same application main. You can attach an
`onTurnFinalized` observer at `createAgent`. [Worked turn program](examples/inspectable-agent/README.md)

## Write a custom augment

Run this from `my-agent` to scaffold the order-support capability and test it.
Restart the agent to load the new capability.

```bash
bun run auggy augment create order-support
bun test tests/augments/order-support.test.ts
```

```text
src/augments/order-support/
  index.ts      # registers the sample tool and HTTP route
  schemas.ts    # defines the shared input and response shapes
  service.ts    # looks up a sample record
  README.md
tests/augments/order-support.test.ts
```

The CLI appends this entry to the existing `augments` list in the root
`agent.yaml`.

```yaml
  - name: order-support
    type: custom
    source: ./src/augments/order-support/index.ts
    options: {}
```

The generated `order_support_lookup_record` tool and
`GET /order-support/records/:id` route both require a creator and call the same
read-only sample service. Here is how to extend it for a shipping-address
change.

1. Replace the sample lookup in `service.ts` with your order-service adapter.
   Use the verified caller identity and order ID to check ownership on every
   exposed tool and route.
2. Prepare the proposed address change and ask the customer to confirm it.
   Bind the pending change to the caller, order, and conversation, and check
   the customer's confirmation in a later message before calling the write.
3. Have your order service apply the confirmed change and record the outcome.
   The application owns persistence, audit records, and how a retried request
   is handled.

In the company application example, you supply your backend's session verifier.
Its `read_order` tool requires the `orders.read` scope and a grant for the
requested order ID. The handler checks the caller again before calling the
order service. [Application walkthrough](examples/company-app/README.md) · [Orders augment](examples/company-app/agent-integration/orders/index.ts)

Tool names must be unique across the agent. The generator normalizes hyphens to
underscores, so `crm-lookup` and `crm_lookup` would reserve the same sample
tool name. Use `--with-skill` during creation to add
`skills/order-support/SKILL.md`. Removing an augment unregisters it and retains
its source, data, dependencies, and skills. Retained skills stay visible to the
model until explicitly removed.

## Operator Console

With the starter web transport, `/console` opens the operator's chat. Use
**Chat** to inspect conversations and tool calls, **Capabilities** to see mounted
tools, routes, skills, and safeguards, and **Integrations** to see how callers
can connect. **Mail** appears when AgentMail supplies mailbox metadata.

Customer-facing frontends call the agent through an authenticated interface.
Keep the Console credential with operators. [Console guide](docs/21-console.md)

## Deploy and integrate

Each operator runs an Auggy service with its own credentials and persistent
state. An HTTP service can accept requests from your frontend. A polling worker
can run without a public URL. Run one replica per logical agent with its
SQLite state. PostgreSQL coordination is disabled in ordinary startup.
A durable job schedules or retries one complete trusted turn. The application
owns its business data and any multi-step workflows.

### Export a Docker build context

From the order-support project, export to a new directory outside the project,
then build the image on your infrastructure.

```bash
bun run auggy export docker --config agent.yaml --out ../my-agent-image --ingress http --port 8080
docker build -t my-agent:local ../my-agent-image
```

Custom augments require an explicit ingress profile. This project uses the
starter web transport on port 8080. For a worker without a listener, use
`--ingress none`. An unmodified starter can infer its HTTP profile. The
exported context includes the manifest and lockfile for a frozen install.
Supply secrets and mount private persistent storage at runtime.
[Docker and storage setup](docs/18-deploy.md)

### Deploy to Railway

Install the Railway CLI, run `railway login`, then deploy the same order-support
project with its HTTP profile.

```bash
bun run auggy deploy --ingress http --port 8080
```

The guided deployment configures the service and its `/app/data` volume. HTTP
services get a domain and Auggy checks the configured health endpoint when
present. After deployment, open the operator Console for a Console-enabled
HTTP service or inspect deployment logs.

```bash
bun run auggy console --cloud
bun run auggy logs
```

Back up the stopped runtime volume separately and coordinate recovery with
your downstream systems. [Single-replica backup and recovery](docs/27-runtime-state-recovery.md)

## What Gets Created

```text
my-agent/
  agent.yaml                  # inline configuration and application entrypoint
  package.json
  bun.lock                    # after dependency installation
  tsconfig.json
  README.md
  AGENTS.md                   # development instructions for coding assistants
  .env                        # private, ignored secrets
  .env.example
  .gitignore
  .auggy/                     # ignored model snapshot and private operation receipts
  identity.md
  learned-behaviors.md
  src/
    main.ts                   # startup, turn-program binding and optional observer
    http.ts                   # editable POST /agent/run mount
    turn.ts                   # actual turn orchestration
    augments/README.md        # custom capability authoring guide
  tests/application.test.ts
  skills/
    auggy/                    # builder guide and reference assets
    filesystem/
    webFetch/
    turnControl/
  data/workspace/README.md
  node_modules/auggy/src/     # after install; maintained runtime and built-ins
```

`agent.yaml` selects the engine, settings and enabled augments in boot order.
Built-in options live directly in those declarations:

```yaml
# Fragment of agent.yaml; retain the other generated fields.
application:
  entrypoint: ./src/main.ts
  contractVersion: 2
augments:
  - name: layeredMemory
    type: layeredMemory
    options:
      dbPath: ./data/memory.db
```

The installed `auggy` package supplies the built-in implementations. Your
application owns `agent.yaml`, the generated TypeScript, custom augments, and
copied skills. Updating the dependency leaves those files in place. Separately
installed capabilities such as `@auggy/link` and provider adapters follow the
project's manifest and lockfile.

`identity.md` holds operator-authored guidance. `learned-behaviors.md` holds
creator-approved guidance, and `skills/` contains instructions the model can
read. Keep credentials in the ignored `.env` and runtime state in `data/`.

For deterministic automation, provide the provider and model explicitly:

```bash
bunx auggy@0.6.1 create my-agent --provider anthropic --model claude-sonnet-4-6 --yes --skip-install
cd my-agent
bun install
bun run typecheck
bun test
bun start
```

Fill the private `.env` before startup. `--skip-install` creates files only;
a successful install must select an application-contract-2 capable local runtime.
Automated creation does not discover or download models. An unknown-price model
requires explicit `--allow-unpriced-model`; `--yes` does not waive budget policy.
`auggy init` uses the current directory and refuses occupied generated files,
including `package.json`, `.env`, README and application source.

### Existing projects

Existing contract-1 applications keep their source and continue to run on
the compatible runtime. Commands that change enabled augments require inline
configuration in the root `agent.yaml`. Preview the conversion before applying it.

```bash
bun run auggy migrate --config agent.yaml
```

After reviewing the preview, repeat the command with `--apply`. Config-only
conversion keeps the current execution mode, option values, source locations,
skills, credentials, and durable state. To also adopt the generated execution
files, preview that change separately.

```bash
bun run auggy migrate --config agent.yaml --application
```

Apply the reviewed adoption plan by adding `--apply` to that command.
Adoption requires an already installed compatible runtime. It refuses conflicting
source, README, TypeScript configuration, scripts or dependency requirements;
config-only conversion remains available. It never installs dependencies for you.
The generated recipe retains configured inference limits, but the omitted
application timeout means a 15-minute deadline; legacy execution has no equivalent
application deadline. Changes affect the next managed launch, not a running turn.

Apply reports a private operation ID. Preview guarded recovery with
`bun run auggy migrate --project-dir . --rollback <operation-id>` and add `--apply` only
after reviewing that plan. Recovery requires unchanged owned outputs; it does not
erase subsequent edits. Private receipts below `.auggy/operations/` can contain
configuration secrets and must not be shared.

## Built-In Augments

### The default agent

| Augment | What it adds |
| --- | --- |
| `fileMemory` | Loads identity and creator-approved learned behavior |
| `filesystem` | Provides scoped access to skills and the agent workspace |
| `webTransport` | Serves HTTP chat, the operator Console, and health and home endpoints |
| `webFetch` | Fetches public URLs and APIs with SSRF protection |
| `turnControl` | Lets the agent pause a turn to request missing input |

The runtime discovers instructions in `skills/` when that directory exists.
Use the project-local CLI to list available capabilities or enable one in
`agent.yaml`.

```bash
bun run auggy augment list
bun run auggy augment add layeredMemory
```

### Stable add-ons

| Augment | Add it when you need... |
| --- | --- |
| `knowledge` | Local Markdown or API-backed reference material |
| `layeredMemory` | Peer-scoped episodic memory backed by SQLite |
| `visitorAuth` | Email magic-link recognition for returning visitors |
| `agentMail` | Provider-native mailbox tools, direct delivery, durable inbound catch-up, and creator-reviewed drafts |
| `notify` | Outbound alerts through file, webhook, Telegram, or AgentMail |
| `telegramTransport` | Bidirectional Telegram conversations |
| `mcp` | Tools exposed by local or remote MCP servers |

### Preview add-ons

Preview augments require deliberate setup and may still change before `1.0`.

| Augment | Status |
| --- | --- |
| `bash` | Scoped host execution; not a security sandbox |
| `budgets` | Turn and spend guardrails; not billing control |
| `link` | Configured agent-to-agent traffic; not an open agent mesh |

## Identity, Skills, And Memory

Identity is durable operator-authored guidance. Skills teach the model how and
when to use capabilities. Memory stores information learned while operating.
Auggy keeps those concepts separate so retrieved or peer-derived content does
not silently become system authority.

Create a skill:

```bash
bun run auggy skill create order-support
```

Add peer-scoped memory:

```bash
bun run auggy augment add layeredMemory
```

Pair it with `visitorAuth` when returning browser visitors should retain a
recognized identity across sessions:

```bash
bun run auggy augment add visitorAuth
bun run auggy agentmail setup visitorAuth
```

Choose account creation, a new inbox in an existing account, or manual
connection to an existing inbox. Auggy stores the selected key unchanged; it
never exchanges it for a narrower runtime key and never rotates or revokes it. See the
[`visitorAuth` operator reference](./docs/19-visitor-auth.md#agentmail-setup)
for inputs, permissions, shared-inbox sequencing, and recovery.

When the agent also needs its own mailbox, add both canonical augments in one
interactive command:

```bash
bun run auggy augment add agentMail visitorAuth
```

The post-add flow uses one shared setup confirmation. It configures `agentMail`
with one inbox and exact API key, then configures `visitorAuth` to reuse
the same environment values without asking again. The result is independent
of argument or picker order. `--yes` skips optional post-add setup, so use the
explicit sequence in the operator references when automating installation.

## Connect External Tools With MCP

```bash
bun run auggy augment add mcp
```

MCP server definitions live in `.mcp.json` at the agent root. Local stdio
servers work during local development; deployed agents should use remote HTTPS
servers or explicitly disable local-only servers in cloud environments.

```json
{
  "mcpServers": {
    "github": {
      "type": "streamable-http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "Authorization": "Bearer ${GITHUB_MCP_TOKEN}"
      }
    }
  }
}
```

Check the boundary before running or deploying:

```bash
bun run auggy mcp doctor
bun run auggy mcp doctor --cloud
```

Auggy fails a server closed on missing environment variables, duplicate exposed
tool names, invalid configuration, or cloud-unsafe stdio usage.

## Channels And Notifications

Talk to the same agent through Telegram:

```bash
bun run auggy augment add telegramTransport
```

Send bounded outbound alerts:

```bash
bun run auggy augment add notify
```

The default notification destination writes JSON Lines locally with no secrets.
Configure a webhook, Telegram, or AgentMail destination when you need real
delivery.

For creator-authorized email and drafts, install AgentMail and connect an
inbox. Incoming mail processing is opt-in.

```bash
bun run auggy augment add agentMail
bun run auggy agentmail setup agentMail
```

See the [`agentMail` operator reference](./docs/22-agent-mail.md) for the exact
key, mailbox controls, direct delivery, inbound policy, provider-draft review,
and recovery configuration.
Run one live Auggy consumer per logical inbox. WebSocket delivery wakes a live
agent; paginated catch-up reconciles messages missed while it was offline.

Removing `agentMail` or `visitorAuth` never revokes AgentMail resources or
deletes shared `AGENTMAIL_*` values automatically. Confirm every shared
consumer before removing local values, and revoke an unused key directly in
AgentMail when your own credential policy requires it.

## Advanced Preview: Routes And App Integration

Custom augments can register small policy-aware `GET` and `POST` routes beside
the agent runtime. Auggy can inspect their manifests, export an OpenAPI-shaped
description, and generate TypeScript clients. Route contracts can declare
ordered request and response media types; generated clients select the preferred
representation, serialize JSON, text, URL-encoded, or multipart request bodies,
and parse JSON or text responses accordingly.

```bash
bun run auggy routes
bun run auggy routes --openapi
bun run auggy routes --client ts --target browser --out client.ts
```

Apps with an existing authentication provider can mint short-lived assertions
with explicit scopes and resource grants. Auggy can enforce those grants on
both routes and model-callable tools; the model never decides whether a caller
is authorized.

This surface is useful when an agent needs a small deterministic API boundary.
It does not make Auggy a general application backend or durable workflow
system. Treat generated clients and delegated app authorization as preview
capabilities while their APIs settle.

For trusted background turns, restart recovery, and bounded UTC schedules, see
[Durable Jobs](./docs/33-durable-jobs.md). For multi-step business workflows,
human approvals, and compensation, keep a workflow engine outside Auggy and
call the agent as one activity.

See the [generated route client guide](docs/25-generated-route-clients.md),
[delegated authorization guide](docs/26-delegated-authorization.md), and
[runnable examples](examples/README.md).

## CLI Reference

The table uses CLI shorthand. Inside an agent project, run each command as
`bun run auggy <command>`. For a persistent
`auggy` command on your PATH, optionally install `bun add --global auggy@0.6.1`.

| Command | What it does |
| --- | --- |
| `auggy create <name>` | Scaffold inline configuration and owned execution source |
| `auggy inspect [name]` | Passively locate declared execution and installed source |
| `auggy migrate [name]` | Preview config conversion; opt into apply or application adoption |
| `auggy init [name]` | Initialize the current directory as an agent |
| `auggy run [name]` | Run locally and open chat with a one-time Console sign-in |
| `auggy console [name]` | Open a running local or Railway Console with a one-time sign-in or password fallback |
| `auggy dev [name]` | Run in the foreground without opening a browser |
| `auggy doctor [name]` | Check configuration, environment, dependencies, port, and skills |
| `auggy list` / `auggy status [name]` | Discover agent projects and inspect local process state |
| `auggy state inventory/backup/verify/restore/restore-resume/reconcile` | Inventory and rehearse fenced offline single-replica runtime-volume recovery |
| `auggy jobs list/inspect/cancel/retry/reconcile/prune/prune-audit` | Inspect and recover redacted single-replica durable job state |
| `auggy jobs schedules list/pause/resume` | Inspect and compare-and-set configured UTC schedules |
| `auggy chat [name]` | Open a running agent's browser chat |
| `auggy augment list` | Show core, stable, and preview augments |
| `auggy augment add [name...]` | Select or add built-in augments |
| `auggy augment remove <name>` | Remove an augment from the current agent |
| `auggy agentmail setup [target]` | Guided account/inbox creation, manual connection, or exact-key reuse for `agentMail` or `visitorAuth` |
| `auggy augment setup <name>` | Run a supported augment setup recipe |
| `auggy augment create <name>` | Create and register a custom augment in the current agent |
| `auggy augment install <agent> <path>` | Import a custom augment authored elsewhere |
| `auggy augment test <path>` | Validate a custom augment folder |
| `auggy skill create <name>` | Create a skill folder |
| `auggy skill add <name>` | Install or refresh an Auggy-provided skill |
| `auggy skill list` / `auggy skill remove <name>` | List installed skills or remove one |
| `auggy routes [name]` | Inspect preview routes and generate clients |
| `auggy mcp init/list/show/add-json/remove/doctor` | Manage MCP servers |
| `auggy models list [provider] --refresh` | Refresh the provider model list |
| `auggy models doctor [name]` | Check the configured provider and model for an agent |
| `auggy visitors <name>` | List verified visitors for an agent |
| `auggy export docker` | Write a portable Docker build context for an installed project |
| `auggy deploy` | Deploy the current agent to Railway |
| `auggy logs` | Open Railway logs for a deployed agent |
| `auggy start` / `stop` / `restart` | Manage a background local agent |
| `auggy remove [name]` | Remove a local agent project, with an explicit cloud option |
| `auggy eval` | Run eval suites when `@auggy/evals` is installed |

## Direct library installation

Generated agents own an audited root-level dependency override for
`@hono/node-server` v2. Direct library consumers must copy the `overrides`
block from Auggy's `package.json` into their application root because package
managers do not inherit overrides from dependencies. This temporary boundary
remains necessary until `@modelcontextprotocol/sdk` accepts the fixed v2 range.
Provider adapters mark this peer optional only at the installer layer so a
package manager cannot silently fetch the stale registry core. The local core
is still a runtime requirement and must be installed explicitly.

## Requirements

- Node.js >= 20.17 is recommended for the npm dependency chain.
- Bun >= 1.3.14 is required at runtime.
- Console static assets require opened-descriptor paths (`/proc/self/fd` on Linux or
  `/dev/fd` on macOS); runtimes without either fail closed while APIs remain available.
- Railway deployment requires the Railway CLI and `railway login`.

```bash
curl -fsSL https://bun.sh/install | bash
```

## Development

```bash
git clone https://github.com/looselyorganized/auggy.git
cd auggy
bun install
bun run typecheck
bun run lint
bun run test
```

This repository is a Bun workspace; the root install includes the console and
provider packages. The core runtime and CLI live in `src/`,
provider adapters live in `packages/{anthropic,openai,openrouter,ollama}`, tests
live in `tests/`, and runnable integrations live in `examples/`. The React/Vite
operator console is developed in `admin/`; its production bundle is checked in
under `admin/dist/` because the published runtime serves those static files.

When changing the console, verify and rebuild it from its workspace:

```bash
cd admin
bun test
bun run build
```

For a local CLI install from this checkout:

```bash
bun link
auggy --version
```

## Documentation

- [Runtime documentation index](docs/README.md)
- [Built-in augment reference](docs/07-built-in-augments.md)
- [Deployment profiles and persistent storage](docs/18-deploy.md)
- [Runtime state recovery](docs/27-runtime-state-recovery.md)
- [Delivery and operator recovery](docs/28-delivery-and-operator-recovery.md)
- [Provider resilience](docs/29-provider-resilience.md)
- [Compatibility, migrations, and rollback](docs/31-compatibility-migrations-and-rollback.md)
- [Independent agent isolation](docs/32-independent-agent-isolation.md)
- [Durable Jobs](docs/33-durable-jobs.md)
- [Contributor instructions](AGENTS.md)

## License

Apache-2.0
