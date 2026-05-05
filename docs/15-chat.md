# `auggy chat` — Operator chat surface (Local GUI)

The polished chat UI for talking to local agents. Boots a Bun-served Vite/React app on `localhost`, discovers running auggies via PID manifests, and proxies messages through to each agent's `/agent/run` with the agent's bearer token attached server-side.

> **Mental model:** `auggy dev <name>` runs an agent. `auggy chat` lets you talk to it. They are separate processes — you can boot the GUI any time after the agent is up.

## Quick start

```bash
auggy dev zip            # one terminal: boots the agent
auggy chat               # another terminal: opens the chat UI in your browser
```

The GUI appears on `http://localhost:8090` with `zip` listed in the picker. Click `zip`, type a message, get streamed AG-UI events back.

## Command surface

```
auggy chat [options]

Options:
  -p, --port <port>   GUI server port (default: 8090)
  --no-open           Don't auto-open the browser on boot
  --rebuild           Rebuild chat/dist from source (requires Bun + Vite)
  -h, --help          Show help
```

## What it does

| | |
|---|---|
| **Discovers agents** | Reads `~/.auggy/<name>.json` PID manifests; live agents appear in the picker |
| **Proxies chat** | Browser POSTs to GUI server's `/api/chat/<id>`; server attaches bearer and forwards to agent's `/agent/run` |
| **Streams responses** | AG-UI SSE events flow through the proxy to the chat widget |
| **Persists history** | Per-agent threadId + message history kept in browser `localStorage`, keyed by `agent@source` |
| **Loopback only** | Server binds to `127.0.0.1`. The browser-side CSRF guard rejects cross-origin requests |

## Architecture

The chat package lives at `augment-1/chat/` — Vite/React SPA with a Bun.serve server. v1 ships one source (`localPidSource` reading PID manifests on the server, exposed to the browser as `/api/agents`) and one connection (`httpProxyConnection` posting to the GUI proxy). When spine ships, a `spineRegistrySource` + `spineRoutedConnection` pair plug into the same UI without rewrite.

```
[browser]  →  [auggy chat server, 127.0.0.1:8090]  →  [auggy webTransport, 127.0.0.1:8080]
              GET /api/agents → discovery               GET /.well-known/agent-card.json
              POST /api/chat/<id> → proxy               POST /agent/run (Authorization: Bearer ...)
```

Bearer tokens are read fresh from each agent's `.env` (the `WEB_BEARER_TOKEN` value) on every chat call. **The browser never sees a bearer.**

## Per-agent chat history

Each agent's conversation is keyed by `<agent-name>@<source-name>` and persisted in browser `localStorage`. Switch agents via the picker; switch back; history is right where you left it.

- "Clear conversation" button per agent — drops the local copy, starts a new threadId
- Restarting the agent process (different PID) does NOT clear browser history; you keep the same threadId
- ~200 messages per agent are retained; older messages are evicted
- Tool-call args/results are truncated at 10KB each in storage; full content remains in the live session

## Operator security model

- **Loopback-only.** The GUI server binds to `127.0.0.1`. Anyone with shell access to your machine already has filesystem access to `~/.auggy/` and your agents' `.env` files; the GUI is a thin presentation layer over what you already control.
- **CSRF guard.** Any tab from a non-loopback origin posting to `/api/chat/*` gets `403`. Requests must also have `Content-Type: application/json`.
- **Bearers stay server-side.** Browser fetches go to `/api/chat/<id>`; the server attaches `Authorization: Bearer <token>` before forwarding.
- **Bearers are read fresh** on every chat call (no cache staleness window for `.env` edits).

## Distribution

The `chat/dist/` build is published as a GitHub release artifact (`chat-dist-vX.Y.Z.tar.gz` + `.sha256`). On first run, `auggy chat`:

1. Looks for `augment-1/chat/dist/` (developer working copy)
2. Then `~/.auggy/chat/<version>/dist/` (downloaded cache)
3. Then downloads the release artifact for the current package version, verifies SHA256 checksum, extracts to the cache

Use `--rebuild` to build from source (developer mode; requires Bun + Vite).

## Limitations / out-of-scope at v1

- **Single machine.** Cross-LAN agent discovery is a follow-on; manually add remote agents via env when that ships.
- **Operator only.** No anonymous-visitor mode; this is a laptop tool, not a public-facing chat. Visitor-facing chat ships as a per-spine artifact when spine lands.
- **Desktop only.** No mobile responsive layout.
- **No launchd integration.** Foreground only; Ctrl-C to stop.

## Troubleshooting

- **"No agents detected on this machine"** — run `auggy dev <name>` first; check `auggy status` for live PIDs
- **"agent not found" (404)** — the PID manifest exists but the PID is dead; restart the agent
- **"no WEB_BEARER_TOKEN in <agentDir>/.env" (412)** — set `WEB_BEARER_TOKEN=…` in the agent's `.env` and run `auggy dev` again
- **"upstream connect failed" (502)** — agent is alive per PID but unreachable on its port; check the agent's logs
- **Port 8090 in use** — pass `--port` with a free port

## Cross-references

- Built-in transport: [`docs/06-transports.md`](./06-transports.md) (specifically the `publicFrontendUrl` redirect option that points visitors to your chosen frontend)
- ADR: [`docs/solutions/architecture/adr-020-runtime-presentation-separation.md`](../../docs/solutions/architecture/adr-020-runtime-presentation-separation.md)
- Spec: [`lo/docs/superpowers/specs/2026-04-29-auggy-chat-design.md`](../../docs/superpowers/specs/2026-04-29-auggy-chat-design.md)
