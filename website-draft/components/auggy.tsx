/**
 * Auggy-specific components.
 *
 * These extend the OpenHands design system with augment-1 marketing primitives:
 *   - KernelMark / AuggyHeader / AuggyFooter — brand chrome (replaces HandsWordmark)
 *   - SurfaceSwitcher                         — CLI / YAML / SDK tabbed showcase
 *   - KernelDiagram                           — the ASCII kernel-augments-engines wiring
 *   - LayeredMemoryStack                      — L0 → L3 vertical visualization
 *   - AugmentCard                             — catalog tile for one augment
 *   - RunningAgentCard                        — "live on Auggy" status tile
 *
 * They consume the same tokens as the rest of the system (--color-cream,
 * --color-cocoa, --color-highlight) — see app/globals.css for the rebinding
 * to bone / iron / signal.
 */

"use client"

import { useState } from "react"
import { cn } from "@/lib/utils"
import { Container } from "@/components/layout/Container"
import { Button } from "@/components/ui/Button"
import { TerminalCard } from "@/components/ui/TerminalCard"
import { TopoBackground } from "@/components/brand/TopoBackground"

/* ──────────────────────────────────────────────────────────────────────────
 * KernelMark — replaces OpenHands' HandsWordmark
 *
 * A hand-drawn hexagonal kernel ring with three plug-points docking in.
 * Inherits stroke from currentColor so it works on bone and iron surfaces.
 * ────────────────────────────────────────────────────────────────────────── */
export function KernelMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 64 32"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("text-current", className)}
      aria-hidden
    >
      {/* Central hexagonal kernel */}
      <path d="M22 8 L32 4 L42 8 L42 20 L32 24 L22 20 Z" />
      <path d="M27 12 L32 10 L37 12 L37 18 L32 20 L27 18 Z" strokeDasharray="2 2" />

      {/* Plug 1 — top-left augment */}
      <path d="M8 4 L14 4 L14 10 M14 7 L22 11" />
      <circle cx="14" cy="4" r="1.2" />

      {/* Plug 2 — bottom-left augment */}
      <path d="M8 28 L14 28 L14 22 M14 25 L22 19" />
      <circle cx="14" cy="28" r="1.2" />

      {/* Plug 3 — right augment (engine) */}
      <path d="M56 16 L50 16 M42 14 L50 16 L42 18" />
      <circle cx="56" cy="16" r="1.2" />
    </svg>
  )
}

export function KernelWordmark({
  size = "md",
  className,
  href = "/",
}: {
  size?: "sm" | "md" | "lg"
  className?: string
  href?: string
}) {
  const dims = { sm: "h-6", md: "h-8", lg: "h-12" }[size]
  const text = { sm: "text-base", md: "text-lg", lg: "text-3xl" }[size]
  return (
    <a href={href} className={cn("inline-flex items-center gap-2.5 text-cocoa", className)}>
      <KernelMark className={dims} />
      <span className={cn("font-mono font-medium tracking-tight", text)}>aug1</span>
    </a>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * AuggyHeader
 * ────────────────────────────────────────────────────────────────────────── */
export function AuggyHeader() {
  return (
    <header>
      <div className="h-1.5 bg-highlight" />
      <Container>
        <nav className="flex items-center justify-between py-5">
          <KernelWordmark size="md" />

          <div className="hidden md:flex items-center gap-7">
            <a href="/product" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Product</a>
            <a href="/augments" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Augments</a>
            <a href="/engines" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Engines</a>
            <a href="/memory" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Memory</a>
            <a href="/pricing" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Pricing</a>
            <a href="/changelog" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Changelog</a>
            <a href="/manifesto" className="text-sm font-medium text-cocoa hover:text-cocoa/70">Manifesto</a>
          </div>

          <div className="flex items-center gap-3">
            <a
              href="https://github.com/looselyorganized/augment-1"
              className="text-xs font-mono text-cocoa border border-cocoa rounded-lg px-2.5 py-1 hover:bg-cocoa hover:text-cream transition-colors"
            >
              ★ 0
            </a>
            <Button variant="secondary" size="sm" href="/docs">Docs</Button>
            <Button variant="primary" size="sm" href="/docs/quickstart">Get started</Button>
          </div>
        </nav>
      </Container>
    </header>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * AuggyFooter — signal-soft band + topo + footer link grid + giant wordmark
 * ────────────────────────────────────────────────────────────────────────── */
export function AuggyFooter() {
  return (
    <footer>
      {/* CTA band */}
      <section className="relative bg-highlight-soft py-20 overflow-hidden">
        <TopoBackground variant="dense" surface="highlight" className="pointer-events-none" />
        <Container className="relative z-10 text-center">
          <h2 className="font-display font-medium text-3xl md:text-4xl text-cocoa mb-3">
            Compose an agent in three files.
          </h2>
          <p className="text-base text-cocoa max-w-2xl mx-auto mb-8">
            Apache-2.0. Bun. Zero infrastructure to start. Yours to self-host.
          </p>
          <div className="flex gap-3 justify-center mb-12">
            <Button variant="secondary" href="https://github.com/looselyorganized/augment-1">★ Star on GitHub</Button>
            <Button variant="primary" href="/docs/quickstart">Get started</Button>
          </div>
          <div className="flex justify-center gap-4">
            {[
              { label: "GH", href: "https://github.com/looselyorganized/augment-1" },
              { label: "X",  href: "#" },
              { label: "RSS", href: "/changelog/rss.xml" },
            ].map(s => (
              <a
                key={s.label}
                href={s.href}
                className="w-9 h-9 rounded-full border border-cocoa flex items-center justify-center text-xs font-mono text-cocoa hover:bg-cocoa hover:text-cream transition-colors"
              >
                {s.label}
              </a>
            ))}
          </div>
        </Container>
      </section>

      {/* Link grid */}
      <div className="bg-cream py-12 border-t border-contour">
        <Container>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-8 text-sm">
            {[
              { title: "Product",   links: [["Kernel","/product"], ["Augments","/augments"], ["Engines","/engines"], ["Memory","/memory"]] },
              { title: "Resources", links: [["Docs","/docs"], ["Changelog","/changelog"], ["Manifesto","/manifesto"], ["Blog","/blog"]] },
              { title: "Project",   links: [["About","/about"], ["Roadmap","/roadmap"], ["Contributing","/contributing"], ["License","/license"]] },
              { title: "Connect",   links: [["GitHub","https://github.com/looselyorganized/augment-1"], ["X","#"], ["Email","mailto:hello@aug1.dev"]] },
            ].map(col => (
              <div key={col.title}>
                <p className="font-display font-medium text-cocoa mb-3">{col.title}</p>
                <ul className="flex flex-col gap-2">
                  {col.links.map(([label, href]) => (
                    <li key={label}>
                      <a href={href} className="text-cocoa/80 hover:text-cocoa">{label}</a>
                    </li>
                  ))}
                </ul>
              </div>
            ))}
          </div>
        </Container>
      </div>

      {/* Bottom bar */}
      <div className="bg-cream border-t border-contour py-6">
        <Container>
          <div className="flex flex-col md:flex-row justify-between items-center gap-4">
            <p className="text-xs text-muted">© 2026 LORF — Released under Apache-2.0.</p>
            <a href="/privacy" className="text-xs text-muted hover:text-cocoa">Privacy Policy</a>
          </div>
        </Container>
      </div>

      {/* Giant kernel wordmark watermark */}
      <div className="bg-cream py-12 flex justify-center">
        <div className="flex items-center gap-4 text-cocoa">
          <KernelMark className="h-16" />
          <span className="font-mono font-medium text-5xl md:text-6xl tracking-tight">aug1</span>
        </div>
      </div>
    </footer>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * SurfaceSwitcher — CLI / YAML / SDK tab control + terminal preview
 * ────────────────────────────────────────────────────────────────────────── */
type Surface = "cli" | "yaml" | "sdk"

const surfaceContent: Record<Surface, { title: string; body: string; tagline: string }> = {
  cli: {
    title: "aug1 create zip",
    body: `$ aug1 create zip
? pick augments (space to toggle, enter to confirm)
  ▸ ◉ identity        (file-backed, immutable)
    ◉ layeredMemory   (L3 + L1 episodic, sqlite-first)
    ◉ filesystem      (scoped read/write, 6 tools)
    ◉ webTransport    (HTTP + SSE, AG-UI native)
    ◯ webFetch        (URL → markdown)
    ◯ orgContext      (org_fetch, org_escalate)
    ◯ bash            (allowlisted shell)
✓ scaffolded ./zip — try it: aug1 dev zip`,
    tagline: "Interactive scaffolder. Pick your augments, ship a running agent.",
  },
  yaml: {
    title: "agent.yaml",
    body: `id: aug1_fa625ba1
name: zip
engine:
  provider: anthropic         # or: openai, openrouter
  model: claude-sonnet-4-6

augments:
  - name: identity
    type: fileMemory
    options:
      source: ./identity.md
      mutable: false
      origin: operator

  - name: files
    type: filesystem
    options:
      mounts:
        - { name: skills, path: ./skills, writable: false }

  - name: web
    type: webTransport
    options:
      port: 8080
      auth: { type: bearer, token: \${AUGGY_WEB_TOKEN} }`,
    tagline: "Declarative config. Swap engines without touching code.",
  },
  sdk: {
    title: "agent.ts",
    body: `import {
  defineAgent,
  fileMemory,
  webTransport,
  createAnthropicEngine,
} from "augment-1"

const engine = createAnthropicEngine({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-6",
})

const identity = fileMemory({
  source: "./identity.md",
  origin: "operator",
  placement: "system",
})

const agent = defineAgent(
  { name: "hello", augments: [identity, webTransport({ port: 8080 })] },
  engine,
)

await agent.start()`,
    tagline: "Programmatic. Same primitives — agent objects, not framework hooks.",
  },
}

export function SurfaceSwitcher() {
  const [active, setActive] = useState<Surface>("cli")
  const tabs: { id: Surface; label: string }[] = [
    { id: "cli",  label: "CLI"  },
    { id: "yaml", label: "YAML" },
    { id: "sdk",  label: "SDK"  },
  ]
  const content = surfaceContent[active]

  return (
    <div>
      <div role="tablist" className="inline-flex bg-parchment border border-contour rounded-lg p-1 mb-6">
        {tabs.map(t => (
          <button
            key={t.id}
            role="tab"
            aria-selected={active === t.id}
            onClick={() => setActive(t.id)}
            className={cn(
              "px-4 py-1.5 text-sm font-mono rounded-md transition-colors",
              active === t.id
                ? "bg-highlight text-cocoa"
                : "text-cocoa/70 hover:text-cocoa",
            )}
          >
            {t.label}
          </button>
        ))}
      </div>

      <TerminalCard title={content.title}>
        <pre className="text-cream/95 whitespace-pre">{content.body}</pre>
      </TerminalCard>

      <p className="mt-4 text-sm text-muted">
        {content.tagline} <a href="/docs" className="text-cocoa underline underline-offset-2 hover:no-underline">Read the docs →</a>
      </p>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * KernelDiagram — the ASCII kernel-augments-engines wiring (Section 7)
 * ────────────────────────────────────────────────────────────────────────── */
export function KernelDiagram() {
  return (
    <pre
      aria-label="Kernel + augments + engines wiring diagram"
      className={cn(
        "font-mono text-cream text-[12px] md:text-[13px] leading-tight",
        "whitespace-pre overflow-x-auto select-none",
      )}
    >
{`            ┌───────────────── augments ─────────────────┐
            │                                            │
   identity ●──┐                                  ┌──● filesystem
   layered  ●──┤                                  ├──● webTransport
   org      ●──┤        ┌──────────────┐          ├──● webFetch
   bash     ●──┤        │   KERNEL     │          ├──● ...
            ●──┘        │   ~1k LOC    │          └──● write-your-own
                        └──────┬───────┘
                               │
            ┌──────────────────┴──────────────────┐
            │              engines                 │
            │    anthropic   ·   openai   ·   openrouter
            └──────────────────────────────────────┘`}
    </pre>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * LayeredMemoryStack — L0 → L3 vertical viz (Section 8)
 * ────────────────────────────────────────────────────────────────────────── */
const LAYERS = [
  { id: "L3", name: "Identity",   role: "Operator-authored rules. Immutable.", lifetime: "never evicted",   active: true  },
  { id: "L2", name: "Semantic",   role: "Consolidated facts.",                  lifetime: "TTL by class",    active: false },
  { id: "L1", name: "Episodic",   role: "Per-peer conversation facts.",         lifetime: "peer-scoped TTL", active: false },
  { id: "L0", name: "Scratch",    role: "Per-turn working memory.",              lifetime: "turn end",        active: false },
]

export function LayeredMemoryStack() {
  return (
    <div className="flex flex-col gap-2">
      {LAYERS.map(l => (
        <div
          key={l.id}
          className={cn(
            "border rounded-md px-5 py-4 flex items-center gap-5",
            l.active
              ? "bg-parchment border-cocoa border-l-4 border-l-highlight"
              : "bg-parchment border-contour",
          )}
        >
          <span className="font-mono text-sm text-cocoa w-10">{l.id}</span>
          <div className="flex-1">
            <p className="font-display font-medium text-cocoa">{l.name}</p>
            <p className="text-sm text-muted">{l.role}</p>
          </div>
          <span className="hidden md:inline text-xs font-mono text-muted whitespace-nowrap">
            {l.lifetime}
          </span>
        </div>
      ))}
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * AugmentCard — used in the "what you can compose" grid
 * ────────────────────────────────────────────────────────────────────────── */
export function AugmentCard({
  name,
  capabilities,
  description,
  status,
}: {
  name: string
  capabilities: string[]
  description: string
  status?: "stable" | "beta" | "frozen"
}) {
  return (
    <div className="bg-parchment border border-dashed border-contour rounded-md p-5 flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <span className="font-mono text-cocoa">{name}</span>
        {status && (
          <span className="text-[10px] font-mono uppercase tracking-[0.12em] text-muted">
            {status}
          </span>
        )}
      </div>
      <p className="text-sm text-muted leading-relaxed">{description}</p>
      <div className="flex flex-wrap gap-1.5 mt-auto">
        {capabilities.map(c => (
          <span
            key={c}
            className="text-[11px] font-mono bg-cream-soft border border-contour rounded-sm px-1.5 py-0.5 text-cocoa"
          >
            {c}
          </span>
        ))}
      </div>
    </div>
  )
}

/* ──────────────────────────────────────────────────────────────────────────
 * RunningAgentCard — "live on Auggy" tile (Section 11)
 * ────────────────────────────────────────────────────────────────────────── */
export function RunningAgentCard({
  name,
  role,
  augments,
  href,
}: {
  name: string
  role: string
  augments: string[]
  href: string
}) {
  return (
    <a
      href={href}
      className="block bg-parchment border border-contour rounded-md p-6 hover:bg-cream-soft transition-colors"
    >
      <div className="flex items-center gap-2 mb-3">
        <span className="w-2 h-2 rounded-full bg-highlight" aria-hidden />
        <span className="text-xs font-mono uppercase tracking-[0.12em] text-muted">live</span>
      </div>
      <p className="font-display font-medium text-2xl text-cocoa mb-2">{name}</p>
      <p className="text-sm text-muted mb-5 leading-relaxed">{role}</p>
      <div className="flex flex-wrap gap-1.5">
        {augments.map(a => (
          <span
            key={a}
            className="text-[11px] font-mono bg-cream border border-contour rounded-sm px-1.5 py-0.5 text-cocoa"
          >
            {a}
          </span>
        ))}
      </div>
      <p className="mt-5 text-sm text-cocoa font-medium">Watch it think →</p>
    </a>
  )
}
