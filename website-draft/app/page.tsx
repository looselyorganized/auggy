/**
 * augment-1 — homepage draft
 *
 * Modeled on openhands.dev's 13-section flow, retuned to Auggy's reality.
 * Uses the OpenHands design-system primitives unmodified — only the CSS tokens
 * change (see app/globals.css for the Composer's Plate rebinding).
 *
 * To run:
 *   1. `bunx create-next-app@latest augment-1-site --tailwind --app --src-dir`
 *   2. Copy the OpenHands showcase components from
 *      ~/.claude/skills/openhands-design-system/showcase/components/
 *      into src/components/
 *   3. Drop this file into src/app/page.tsx
 *   4. Drop globals.css contents into src/app/globals.css (replacing the OH tokens)
 *   5. Drop components/auggy.tsx and lib/ascii.ts into matching paths
 *   6. `bun dev` and visit http://localhost:3000
 *
 * Verify before launch: see "Open Questions / Decisions Needed" in the spec.
 */

import { Container } from "@/components/layout/Container"
import { Button } from "@/components/ui/Button"
import { Pill } from "@/components/ui/Pill"
import { TerminalCard } from "@/components/ui/TerminalCard"
import { ComparisonTable } from "@/components/ui/ComparisonTable"
import { StatBlock } from "@/components/ui/StatBlock"
import { ASCIIHero } from "@/components/brand/ASCIIHero"
import { ASCIIBackground } from "@/components/brand/ASCIIBackground"
import { TopoBackground } from "@/components/brand/TopoBackground"
import { ArrowRightIcon } from "@/components/ui/icons"

import {
  AuggyHeader,
  AuggyFooter,
  SurfaceSwitcher,
  KernelDiagram,
  LayeredMemoryStack,
  AugmentCard,
  RunningAgentCard,
} from "@/components/auggy"

import { aug1Hero } from "@/lib/ascii"

export default function HomePage() {
  return (
    <>
      {/* ── Section 1 — Announcement banner ── */}
      <div className="bg-cocoa text-cream text-center py-2 text-xs font-mono">
        <Container>
          <span className="text-cream/60">v0.1.0</span>{" "}
          <span className="mx-2">·</span>
          Zip is the first agent in production.{" "}
          <a href="/changelog/v0-1-0" className="text-highlight underline underline-offset-2 hover:no-underline">
            Read the launch notes →
          </a>
        </Container>
      </div>

      <AuggyHeader />

      <main>
        {/* ── Section 2 — Hero ── */}
        <section className="relative bg-cream pt-24 md:pt-28 pb-24 overflow-hidden min-h-[680px]">
          <ASCIIBackground intensity="soft" />
          <Container className="relative z-10 text-center">
            <ASCIIHero art={aug1Hero} className="mx-auto mb-8 opacity-90" />

            <Pill variant="highlight">v0.1.0 — built on the LORF kernel</Pill>

            <h1 className="font-display font-medium text-5xl md:text-6xl lg:text-7xl tracking-tight text-cocoa mt-6 mb-5">
              The modular agent runtime.
            </h1>

            <p className="text-lg md:text-xl text-cocoa/85 max-w-[42rem] mx-auto mb-8 leading-relaxed">
              A 1,000-line kernel and{" "}
              <span className="bg-highlight px-1 text-cocoa">eight composable augments</span>.
              Multi-engine. SQLite-first memory. Self-host on a Mac mini or a fleet — same binary.
            </p>

            <div className="flex flex-wrap gap-3 justify-center">
              <Button variant="primary" href="/docs/quickstart">
                Get started in 60 seconds
              </Button>
              <Button variant="secondary" href="/manifesto">
                Read the manifesto
              </Button>
            </div>

            <p className="mt-6 text-sm text-muted font-mono">
              apache-2.0 · bun runtime · works offline
            </p>
          </Container>
        </section>

        {/* ── Section 3 — Workflow picker ── */}
        <section className="py-20 md:py-24 border-t border-contour">
          <Container>
            <div className="flex flex-col md:flex-row md:items-end justify-between mb-10 gap-4">
              <div>
                <Pill variant="outline" className="mb-3">Recipes</Pill>
                <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa">
                  Start with a recipe.
                </h2>
              </div>
              <a href="/recipes" className="text-sm font-medium text-cocoa hover:text-cocoa/70 inline-flex items-center gap-1">
                See all recipes <ArrowRightIcon className="w-4 h-4" />
              </a>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 lg:gap-5">
              {[
                {
                  title: "Front-door agent",
                  desc: "Greet visitors, answer questions, escalate to a human via Telegram. (This is Zip.)",
                  href: "/recipes/front-door",
                },
                {
                  title: "Research assistant",
                  desc: "Pull from your fact store, cite sources, never hallucinate the org chart.",
                  href: "/recipes/research",
                },
                {
                  title: "Coding agent",
                  desc: "Read the repo, run tests, open PRs — scoped filesystem, scoped bash.",
                  href: "/recipes/coding",
                },
                {
                  title: "Internal ops agent",
                  desc: "Wire it into Slack and let it triage tickets with org context.",
                  href: "/recipes/ops",
                },
              ].map(r => (
                <a
                  key={r.title}
                  href={r.href}
                  className="bg-parchment border border-dashed border-contour rounded-md p-5 flex flex-col gap-3 hover:bg-cream-soft transition-colors"
                >
                  <div className="w-8 h-8 border border-cocoa rounded-sm flex items-center justify-center text-cocoa font-mono text-xs">
                    ▢
                  </div>
                  <h3 className="font-display font-medium text-lg text-cocoa">{r.title}</h3>
                  <p className="text-sm text-muted leading-relaxed flex-1">{r.desc}</p>
                  <p className="text-sm text-cocoa font-medium inline-flex items-center gap-1">
                    Launch recipe <ArrowRightIcon className="w-4 h-4" />
                  </p>
                </a>
              ))}
            </div>
          </Container>
        </section>

        {/* ── Section 4 — Social proof (stat row) ── */}
        <section className="py-16 md:py-20 bg-cream">
          <Container>
            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6">
              <StatBlock surface="parchment" value="406+" label="passing tests across kernel, augments, and CLI" />
              <StatBlock surface="parchment" value="8 + 3" label="built-in augments + reasoning engines, day one" />
              <StatBlock surface="parchment" value="60s"   label="from `aug1 create` to a running, web-reachable agent" />
            </div>
            <p className="text-center text-sm text-muted mt-6 font-mono">
              v0.1.0 shipped 2026-04-14 · live on Zip · open-source under apache-2.0
            </p>
          </Container>
        </section>

        {/* ── Section 5 — Surface switcher ── */}
        <section className="py-20 md:py-24 border-t border-contour">
          <Container>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-10 items-start">
              <div className="lg:col-span-5">
                <Pill variant="outline" className="mb-3">Three surfaces, one runtime</Pill>
                <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa mb-4">
                  Whichever way you build, the agent is the same artifact.
                </h2>
                <p className="text-base text-muted leading-relaxed mb-6">
                  Scaffold from the CLI. Edit a YAML file. Drop into TypeScript when
                  you need real composition. Each surface produces the identical
                  agent definition under the hood — pick the one that matches your
                  step.
                </p>
                <Button variant="outline" href="/docs">Read the docs</Button>
              </div>

              <div className="lg:col-span-7">
                <SurfaceSwitcher />
              </div>
            </div>
          </Container>
        </section>

        {/* ── Section 6 — Why teams choose Auggy (2×3 grid) ── */}
        <section className="py-20 md:py-28 border-t border-contour bg-cream">
          <Container>
            <div className="max-w-2xl mb-14">
              <Pill variant="outline" className="mb-3">Differentiators</Pill>
              <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa mb-3">
                Why teams pick a runtime over a framework.
              </h2>
              <p className="text-base text-muted leading-relaxed">
                Auggy isn't a wrapper around the SDKs. It's a kernel with composable
                primitives — and the surface stays small because every capability
                is the same shape underneath.
              </p>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-x-10 gap-y-12">
              {[
                {
                  title: "Augments, not plugins.",
                  desc: "Memory, transport, tools — every part is the same primitive. You compose; you don't subclass.",
                },
                {
                  title: "Multi-engine, day one.",
                  desc: "Anthropic, OpenAI, OpenRouter. Swap providers in YAML. No code change.",
                },
                {
                  title: "Memory without infrastructure.",
                  desc: "SQLite-first. Episodic memory per peer. Supabase optional, never required.",
                },
                {
                  title: "Trust is structural.",
                  desc: "Every context block carries an origin. [PEER-DERIVED] markers are visible to the model — not a prompt-engineering afterthought.",
                },
                {
                  title: "Framework-agnostic at the wire.",
                  desc: "A2A types. AG-UI transport. HTTP + SSE. Anything that speaks JSON can integrate.",
                },
                {
                  title: "Built to self-host.",
                  desc: "macOS launchd. Linux systemd. Docker. Same binary, same config.",
                },
              ].map(f => (
                <div key={f.title} className="flex flex-col gap-2">
                  <div className="w-8 h-px bg-cocoa mb-2" aria-hidden />
                  <h3 className="font-display font-medium text-lg text-cocoa">{f.title}</h3>
                  <p className="text-sm text-muted leading-relaxed">{f.desc}</p>
                </div>
              ))}
            </div>
          </Container>
        </section>

        {/* ── Section 7 — ASCII architecture diagram ── */}
        <section className="py-20 md:py-28 bg-cocoa text-cream">
          <Container>
            <div className="text-center max-w-2xl mx-auto mb-10">
              <p className="text-xs font-mono uppercase tracking-[0.12em] text-cream/60 mb-3">
                Inside the kernel
              </p>
              <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cream mb-4">
                Eight augments. Three engines. One ~1,000-line kernel.
              </h2>
              <p className="text-base text-cream/70 leading-relaxed">
                The kernel doesn't grow. The capabilities do.
              </p>
            </div>

            <div className="border border-cocoa-soft rounded-md p-6 md:p-10 bg-cocoa">
              <KernelDiagram />
            </div>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mt-10">
              <AugmentCard
                name="identity"
                description="File-backed identity facts. Immutable, operator-authored."
                capabilities={["system-prompt", "memory"]}
                status="stable"
              />
              <AugmentCard
                name="layeredMemory"
                description="L3 + L1 episodic memory. SQLite-first, peer-scoped, trust-tagged."
                capabilities={["memory", "tools"]}
                status="stable"
              />
              <AugmentCard
                name="filesystem"
                description="Six file tools with realpath sandboxing. Loads skills on demand."
                capabilities={["tools"]}
                status="stable"
              />
              <AugmentCard
                name="webTransport"
                description="HTTP + SSE chat. AG-UI native. Bearer auth, per-peer rate limits."
                capabilities={["transport"]}
                status="stable"
              />
            </div>

            <div className="text-center mt-8">
              <Button variant="primary" href="/augments">See all augments</Button>
            </div>
          </Container>
        </section>

        {/* ── Section 8 — Layered memory ── */}
        <section className="py-20 md:py-28 border-t border-contour">
          <Container>
            <div className="grid grid-cols-1 lg:grid-cols-12 gap-12 items-start">
              <div className="lg:col-span-5">
                <Pill variant="outline" className="mb-3">Memory by construction</Pill>
                <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa mb-4">
                  Most frameworks ship a vector store and call it memory.
                </h2>
                <p className="text-base text-muted leading-relaxed mb-4">
                  Auggy ships a layered model with provenance, supersession, and
                  trust gates — because we got it wrong the first time and rebuilt
                  it.
                </p>
                <p className="text-base text-muted leading-relaxed mb-6">
                  Identity is operator-authored and immutable. Episodic facts are
                  peer-scoped and tagged <span className="font-mono text-cocoa">[PEER-DERIVED]</span> in
                  the system prompt — adversarial input is visible to the model,
                  not laundered into ground truth.
                </p>
                <div className="flex gap-3">
                  <Button variant="primary" href="/memory">Layered memory page</Button>
                  <Button variant="outline" href="/docs/adr/018-layered-memory">Read ADR-018</Button>
                </div>
              </div>

              <div className="lg:col-span-7 lg:pl-6">
                <LayeredMemoryStack />
              </div>
            </div>
          </Container>
        </section>

        {/* ── Section 9 — Code/config showcase (3 snippets stacked) ── */}
        <section className="py-20 md:py-28 bg-cream border-t border-contour">
          <Container>
            <div className="max-w-2xl mb-12">
              <Pill variant="outline" className="mb-3">Three files</Pill>
              <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa mb-3">
                You don't need a tutorial — read the source.
              </h2>
              <p className="text-base text-muted leading-relaxed">
                A working agent in three files: a YAML manifest, an identity
                markdown, and an entrypoint. Every other file you add is opt-in.
              </p>
            </div>

            <div className="flex flex-col gap-6">
              <TerminalCard title="agent.yaml">
                <pre className="text-cream/95 whitespace-pre">{`id: aug1_fa625ba1
name: zip
engine:
  provider: anthropic
  model: claude-sonnet-4-6

augments:
  - { name: identity, type: fileMemory, options: { source: ./identity.md, origin: operator } }
  - { name: files,    type: filesystem,  options: { mounts: [{ name: skills, path: ./skills }] } }
  - { name: web,      type: webTransport, options: { port: 8080 } }`}</pre>
              </TerminalCard>

              <TerminalCard title="agent.ts">
                <pre className="text-cream/95 whitespace-pre">{`import {
  defineAgent,
  fileMemory,
  webTransport,
  createAnthropicEngine,
} from "augment-1"

const engine = createAnthropicEngine({
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: "claude-sonnet-4-6",
})

const agent = defineAgent(
  {
    name: "hello",
    augments: [
      fileMemory({ source: "./identity.md", origin: "operator", placement: "system" }),
      webTransport({ port: 8080 }),
    ],
  },
  engine,
)

await agent.start()
console.log("agent on http://localhost:8080")`}</pre>
              </TerminalCard>

              <TerminalCard title="my-augment.ts">
                <pre className="text-cream/95 whitespace-pre">{`import { defineAugment, defineTool } from "augment-1"
import { z } from "zod"

export default function myAugment(opts: { apiUrl: string }) {
  return defineAugment({
    name: "my-augment",
    capabilities: ["tools"],
    tools: [
      defineTool({
        name: "my_tool",
        description: "Does something useful.",
        input: z.object({ query: z.string() }),
        execute: async ({ query }) => {
          const r = await fetch(\`\${opts.apiUrl}?q=\${query}\`)
          return await r.text()
        },
      }),
    ],
  })
}`}</pre>
              </TerminalCard>
            </div>
          </Container>
        </section>

        {/* ── Section 10 — Comparison table ── */}
        <section className="py-20 md:py-28 border-t border-contour">
          <Container>
            <div className="max-w-2xl mb-10">
              <Pill variant="outline" className="mb-3">How it compares</Pill>
              <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa mb-3">
                The runtime where the kernel is small and the surface is yours.
              </h2>
              <p className="text-base text-muted leading-relaxed">
                Auggy is a runtime. Its peers aren't agents — they're other ways
                of writing agents. Each ✓/✗ is auditable; if any of these are
                wrong, open a PR.
              </p>
            </div>

            <ComparisonTable
              columns={["augment-1", "Claude Agent SDK", "Mastra", "LangChain", "OpenHands"]}
              rows={[
                { label: "Composable augment primitive (memory = transport = tools)", values: [true,  false, false, false, false] },
                { label: "Multi-engine in core (Anthropic + OpenAI + OpenRouter)",     values: [true,  false, true,  true,  true ] },
                { label: "Built-in episodic memory (no external DB required)",          values: [true,  false, false, false, false] },
                { label: "Trust-tagged context by construction",                        values: [true,  false, false, false, false] },
                { label: "Self-host without rewriting",                                 values: [true,  true,  true,  true,  true ] },
                { label: "<1,500-line kernel",                                          values: [true,  false, false, false, false] },
                { label: "Apache-2.0 + community-extensible",                           values: [true,  false, true,  true,  true ] },
              ]}
            />

            <p className="text-xs text-muted font-mono mt-4 text-center">
              audited 2026-04-27 · corrections welcome at github.com/looselyorganized/augment-1
            </p>
          </Container>
        </section>

        {/* ── Section 11 — Live agents ── */}
        <section className="py-20 md:py-28 bg-cream border-t border-contour">
          <Container>
            <div className="max-w-2xl mb-10">
              <Pill variant="outline" className="mb-3">Running on Auggy</Pill>
              <h2 className="font-display font-medium text-3xl md:text-4xl tracking-tight text-cocoa">
                Real agents, in production.
              </h2>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-3 gap-4 lg:gap-6">
              <RunningAgentCard
                name="Zip"
                role="The front door of LORF. First agent in production. Layered memory, web fetch, Telegram escalation."
                augments={["identity", "layeredMemory", "webFetch", "orgContext", "webTransport"]}
                href="https://lorf.dev/zip"
              />
              <div className="bg-parchment border border-dashed border-contour rounded-md p-6 flex flex-col items-center justify-center text-center gap-3">
                <p className="font-mono text-sm text-muted">slot reserved</p>
                <p className="text-sm text-muted leading-relaxed">
                  Building something on Auggy? We'd love to feature it.
                </p>
                <Button variant="outline" href="mailto:hello@aug1.dev" size="sm">Get in touch</Button>
              </div>
              <div className="bg-parchment border border-dashed border-contour rounded-md p-6 flex flex-col items-center justify-center text-center gap-3">
                <p className="font-mono text-sm text-muted">slot reserved</p>
                <p className="text-sm text-muted leading-relaxed">
                  More LORF agents shipping in v0.2.0 — coding agent, ops agent.
                </p>
                <Button variant="outline" href="/roadmap" size="sm">See the roadmap</Button>
              </div>
            </div>
          </Container>
        </section>

        {/* ── Section 12 — Pre-footer CTA ── */}
        {/* (Lives inside <AuggyFooter />.) */}
      </main>

      <AuggyFooter />
    </>
  )
}
