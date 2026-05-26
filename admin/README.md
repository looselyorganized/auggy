# `@auggy/admin` — Per-agent operator workbench

The `/console` SPA. Vite + React + Tailwind + shadcn. Served by `src/transports/admin/` from `admin/dist/` on each agent's own port at `GET /admin`.

> See [`docs/21-console.md`](../docs/21-console.md) for the full spec, server-side API, and v1 → v1.1 roadmap.

## Development

```bash
bun install                          # from repo root
cd admin && bun run dev              # dev server on http://localhost:5174/console/
cd admin && bun run build            # produces dist/
cd admin && bun test                 # tests
```

The dev server runs standalone (no agent backend). Tabs hit `/console/api/*` which only exists in production; in dev they fall back to inline mocks until step 3 of the build wires the JSON endpoints into `src/transports/admin/`.

## Layout

```
admin/
├── index.html                  Vite entry HTML with pre-paint theme apply
├── package.json
├── tailwind.config.ts          shadcn token theme
├── postcss.config.js
├── components.json             shadcn CLI config (for future `bunx shadcn add ...`)
├── tsconfig.json
├── vite.config.ts              base: '/console/', port 5174
└── src/
    ├── main.tsx                React bootstrap, BrowserRouter basename="/admin"
    ├── App.tsx                 Shell composition: Sidebar + Header + <Routes>
    ├── index.css               Tailwind directives + shadcn CSS vars (light + .dark)
    ├── components/
    │   ├── ui/                 shadcn primitives (Button, Card, …)
    │   └── layout/             Sidebar, Header
    ├── lib/
    │   ├── utils.ts            cn() — clsx + tailwind-merge
    │   └── theme.ts            light/dark/system theme manager
    └── routes/                 One file per tab; currently placeholders
```

## Adding shadcn components

```bash
cd admin
bunx shadcn@latest add dialog tooltip toast separator
```

Generated files land in `src/components/ui/`.
