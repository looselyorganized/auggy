# `@auggy/admin` — Per-agent creator console

The `/console` SPA. Vite + React + Tailwind 4 + local Auggy registry output. Served by
`src/transports/admin/` from `admin/dist/` on each agent's own port at
`GET /console`. The first-party password screen is a separate registry-based
React entry under `dist/login/`; only its `/console/login-assets/*` bundle is
served before authentication. The main Console assets remain protected.

> See [`docs/21-console.md`](../docs/21-console.md) for the full spec, server-side API, and v1 → v1.1 roadmap.

## Development

```bash
bun install                          # from repo root
cd admin && bun run dev              # dev server on http://localhost:5174/console/
cd admin && bun run build            # produces dist/
cd admin && bun test                 # tests
```

The dev server proxies `/console/api/*` to a local agent when one is running.
Without an agent backend, the shell loads but live Chat/Integrations/Capabilities
calls fail normally.

Chat exercises the same-process `/agent/run` proxy, renders GitHub-flavored
Markdown without raw HTML or remote images, and can copy the visible conversation
as a Markdown transcript for debugging. Integrations reads the dashboard payload
for built-in endpoints, web posture, and the live augment route manifest.
Capabilities reads the same payload as a runtime map of augments, routes, tools,
memory, auth posture, and warnings.

## Layout

```
admin/
├── index.html                  Vite entry HTML with pre-paint theme apply
├── login.html                  Unauthenticated Console sign-in entry
├── package.json
├── tsconfig.json
├── vite.config.ts              base: '/console/', port 5174
├── vite.login.config.ts        isolated '/console/login-assets/' build
└── src/
    ├── main.tsx                React bootstrap, BrowserRouter basename="/console"
    ├── login-main.tsx          Sign-in bootstrap and native form action
    ├── LoginPage.tsx           Registry-composed password screen
    ├── App.tsx                 Shell composition: Header + console routes
    ├── index.css               Imports local Auggy Tailwind 4 tokens
    ├── components/
    │   ├── ui/                 Generated Auggy registry primitives
    │   └── layout/             Header
    ├── lib/
    │   ├── utils.ts            cn() — clsx + tailwind-merge
    │   └── theme.ts            light/dark/system theme manager
    └── routes/                 Live Chat, Integrations, and Capabilities surfaces
```

## Shared UI Registry

Shared primitives and Tailwind 4 tokens live in the standalone sibling registry
`../../auggy-ui`. This app owns generated source under `src/components/ui`.

```bash
cd ../../auggy-ui
bunx shadcn@latest add dialog tooltip separator
bun run build

cd ../augment-1/admin
bunx shadcn@latest add @auggy/dialog @auggy/tooltip @auggy/separator
```
