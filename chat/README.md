# `@auggy/chat` — Auggy Local GUI

A Vite/React SPA + Bun proxy server that lets you chat with any running Auggy agent on your machine. Discovers agents via PID manifests, attaches operator bearer tokens, and proxies AG-UI SSE streams from each agent's `/agent/run` endpoint.

> **Operator entry point:** `auggy chat` (from the auggy CLI). Builds + serves this package automatically.
> **Full reference docs:** [`docs/15-chat.md`](../docs/15-chat.md) in the augment-1 root.

## What's here

```
chat/
├── server.ts            Bun.serve proxy: /api/agents discovery + /api/chat/<id>
│                        bearer-attaching forwarder + CSRF guard
├── src/
│   ├── App.tsx          Root composition (picker + ChatWidget, Cmd+K / Esc)
│   ├── main.tsx         React entry
│   ├── components/      AgentPicker, ChatWidget, MessageList, ToolCallView, ErrorBanner
│   ├── adapters/        Source/Connection adapters (localPidSource, httpProxyConnection)
│   ├── lib/             chat-store (localStorage history), parser (AG-UI SSE), bearer
│   └── state/           React state hooks
├── tests/               70 tests (server, adapters, lib, state, integration)
├── index.html           Vite entry HTML
├── vite.config.ts       Vite build config
└── dist/                Build output (gitignored; published as GitHub release artifact)
```

## How it gets distributed

Per [`docs/15-chat.md`](../docs/15-chat.md): the SPA + server is built locally during release, the `dist/` artifact is published as a versioned GitHub release attachment, and `auggy chat` performs a first-run download with SHA256 verification (so end-users don't need to run `bun install` against the chat package separately).

## Development

```bash
# From repo root
bun install                                  # installs root + chat deps
cd chat && bun run dev                       # local dev server with HMR
cd chat && bun test                          # SPA + server tests (70)
cd chat && bun run build                     # produces dist/
```

The proxy server (`server.ts`) is the only runtime piece — the SPA is static after build. Tests cover both layers (mocked PID manifest source for the server; React Testing Library for the components).

## Reference

See [`docs/15-chat.md`](../docs/15-chat.md) for: architecture, AG-UI SSE protocol details, bearer-token security model, PID-manifest discovery contract, and release packaging.
