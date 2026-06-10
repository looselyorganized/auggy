# Auggy Character Select — Design Spec

| | |
|---|---|
| **Status** | Draft (awaiting user review) |
| **Date** | 2026-04-29 |
| **Phase** | Phase 1 of phased path A → B → C |
| **Owner** | Michael Hofweller |
| **Related repo** | `lo/platform/` (Next.js 16 site) — deliverable lives here |
| **Brainstorm artifacts** | `augment-1/.superpowers/brainstorm/34485-1777485303/content/` (preserved) |

## 1. Vision & Purpose

A **web component on the LORF platform site** that demonstrates Auggy's modular composition through a configurator-driven assembly sequence. Users land on the page, watch a ~30s autoplay walkthrough showing Auggy being assembled from a chassis through engine + 4 augments, then drop into an interactive mode where they can re-pick options.

### What we're making

A new route — `platform/app/auggy/select/` — rendering a configurator UI:
- Equip panel on the left (categories: HEAD/ENGINE, TRANSPORTS, MEMORY, TOOLS, BUDGETS).
- Auggy on a cream cyc on the right, dimensional / Ink-reference-style.
- ~9 high-fidelity stills produced via GPT Image 2 (+ optional Nano Banana 2 pass) composited as transparent-PNG layers.
- Pure CSS + a small JS state machine for transitions. No video runtime.

### Why we're making it

- **Internal validation.** Test whether the body-region → Auggy-primitive metaphor (head=engine, antennas=transports, chest hex=budget meter, etc.) lands in cinematic form before committing to external use.
- **Reusable foundation.** The web component's state shape and composition logic are direct inputs to Phase 3's real config builder. Not a throwaway prop.
- **Phase position.** Phase 1 of the phased path. The pivot from "concept video" to "web component" effectively pulled Phase 2 (interactive prototype) into Phase 1. Phase 3 (real `aug1.yml` emission) remains the end goal.

### Success criteria

- Body-region states read clearly across all beats (chassis-only vs. paneled vs. with-augment-attached).
- Body-to-augment mapping is intuitive without voiceover or labels.
- Configurator pacing feels right — punchy but legible.
- Visual fidelity matches Ink reference's polish bar at high-fidelity setting.
- Asset library is **layered** (transparent PNG per body region per state) so Phase 3 can recombine in real time.
- The component's state machine cleanly accepts extension to real config emission in Phase 3.

### Explicitly out of scope (Phase 1)

- Real `aug1.yml` emission (→ Phase 3).
- Mobile responsive layout.
- Accessibility deep work (keyboard nav, screen reader) beyond basic semantics.
- IDENTITY / BELT-SLOTS / SKILLS as visible categories (deferred).
- Sound design / voiceover.
- Live agent boot — clicking confirm doesn't actually start anything.
- Distribution / marketing decisions — happen *after* internal viewing.

## 2. Visual System

### Render style

Cinematic 3D matching the Ink Industries reference: clean cream cyc background, soft studio shadows, dimensional materiality. Brushed steel, polished cream paneling, warm amber glow at the kernel core, slight wear (working machine, not fresh-from-factory). Stills produced via GPT Image 2 with optional Nano Banana 2 pass for 3D-styling.

### Body-region → Auggy primitive

| Body region | Maps to |
|---|---|
| Head color + brand logo | **Engine** (Anthropic / OpenAI / OpenRouter) |
| Head shape + size | **Memory** tier (file = cube · supabase = rack-paneled · layered = stacked plates) |
| Chin tag (monospaced) | **Model variant** (`OPUS 4.6`, `GPT-5`, `OR → …`) |
| Temple slot | **Identity** (SIM-style card, glows when online) — *not visible Phase 1* |
| Antenna(s) on head/back | **Transports** (one per transport, distinct shape per kind) |
| Chest hex window | Kernel core visible inside · **budget meter** on the rim (color tracks fuel state, *independent of engine brand*) |
| Belt items | **Tools** (recognizable physical icons; active tool floats off belt) |
| Belt slots | **Extra augments** (hex tokens; finite sockets = visual loadout cap) — *not visible Phase 1* |
| — (invisible) | **Skills** (filesystem library, on-demand, no body cue) |

### Engine livery

| Engine | Head color | Logo mark | Notes |
|---|---|---|---|
| Anthropic | Warm orange (`#d97757`) | White "A" | Default for first reel: Opus 4.6 |
| OpenAI | OpenAI green (`#10a37f`) | White interlocking knot | Initial engine in autoplay (gets swapped *from*) |
| OpenRouter | Cream / parchment | Black splitting-arrows mark | Chin tag shows destination model |

Brand marks are SVG approximations during storyboard; **final renders use proper brand assets under correct usage** (legal review required for external distribution; OK for internal viewing).

### Kernel anatomy

Small precision core (not a humanoid skeleton). Sits in the chest cavity, visible through the chest hex window after the torso panel attaches. Material: brushed steel housing, warm amber glow at center, polished hex sockets at the perimeter. Idle: ~1.6s heartbeat pulse. The exact mechanical detail is at the renderer's discretion — what matters is *small, beautiful, mysterious, mechanical, alive*.

### Brand-coherence rule

UI around Auggy (configurator panels) uses **OpenHands design tokens** — cream / cocoa / yellow palette, monospaced type, thin pen-and-ink hairlines. Auggy himself is rendered cinematically. The split — *flat UI, sculpted subject* — keeps the reel brand-coherent with the platform site even though the character has 3D fidelity.

### Chest hex / budget meter rule

The chest hex window's **fill color** tracks budget state (green → yellow → red), *independent of engine brand color*. This prevents orange-on-orange clash with the Anthropic head and keeps the meter readable at a glance regardless of which engine is equipped.

## 3. Narrative & Beats

### Storyboard (locked)

9 states / beats. Same timing in autoplay mode:

| Beat | Time | State |
|---|---|---|
| 1 | 0:00–0:03 | Chassis idle (torso only, chest hex glowing softly) |
| 2 | 0:03–0:07 | GPT-5 head equips (green livery, knot, chin tag `GPT-5`) |
| 3 | 0:08–0:13 | Engine swap → Anthropic Opus 4.6 (head morphs green→orange, knot dissolves into "A", chin tag flips to `OPUS 4.6`, chest hex pulses) |
| 4 | 0:14–0:17 | + Transports — antenna grows from top of head, tip blinks once |
| 5 | 0:17–0:20 | + Memory — head silhouette morphs to layered (3 stacked plates with staggered glow) |
| 6 | 0:20–0:23 | + Tools — wrench icon flies in, docks to belt slot, small bounce |
| 7 | 0:23–0:26 | + Budgets — green meter arc etches around chest hex, frames the kernel window |
| 8 | 0:26–0:28 | Confirm — `COMMIT CHANGES` clicked, brief flash, budget arc completes its circle |
| 9 | 0:28–0:30 | LORF wordmark splash (`LORF` / `AUGGY · 0.2.0`), fade |

### Modes

- **Autoplay (first load).** Plays beats 1→9 sequentially on a timer. Configurator panel slides in on appropriate beats showing what's being "picked" by the autopilot.
- **Interactive (after autoplay or on replay).** User can pick any equip category and any option. Auggy re-renders to that state via the same transitions. Visible categories: HEAD/ENGINE, TRANSPORTS, MEMORY, TOOLS, BUDGETS.
- **Replay.** A small `▶ replay` chip reruns the autoplay sequence.

### Transition vocabulary

Each transition gets a defined CSS curve, not freely improvised:

| Transition | Use | Approx duration |
|---|---|---|
| `slide-on` | Head/torso panels enter from offscreen and lock in | ~600ms ease-out |
| `paint-on` | Engine livery fills in over the panel | ~400ms |
| `morph` | Engine swap (color + mark + chin tag together) | ~500ms cross-fade |
| `grow` | Antenna extrudes from origin point | ~400ms |
| `silhouette-shift` | Head shape changes (cube → layered) | ~500ms with staggered plate-glow |
| `dock` | Tool icon flies in, snaps to belt slot | ~350ms with bounce |
| `etch` | Meter arc traces around chest hex | ~600ms drawing |
| `flash` | Confirm flash | ~150ms |

### Equip-order rule

In **autoplay** the order is fixed (beats above). In **interactive** mode, the user can pick categories in any order — there are no blocking dependencies between augments. The only enforced sequence is *torso must be on before anything else* (which is true by definition since the chassis-idle frame already shows torso).

### Closer

End on the LORF splash; **no first-message ping / wave** for this cut. Pings + character idle gestures are deferred to a longer follow-on.

### Sound

Out of scope for the concept reel. UI is muted by default; can be added later without re-rendering anything.

## 4. Production Pipeline

### Stack

- **Stills**: GPT Image 2 (consistent across states), optional Nano Banana 2 pass for higher 3D fidelity.
- **Layering**: each body region exported as a transparent PNG so the web component composites them per state. ~10–15 layered assets total (chassis base + 3 engine livery heads × 2 memory shapes + antenna + belt+wrench + budget meter ring + splash). This avoids re-rendering ~30+ full composites for every loadout combo.
- **Web component**: lives in `platform/app/auggy/select/`. Server component for the page shell, client component for the configurator + transitions.
- **Transitions**: pure CSS + a small JS state machine. No heavy animation library; Framer Motion acceptable if the state machine grows.
- **Seedance**: not used. Dropped from pipeline.

### Workflow loop

1. Storyboard sketch — ✓ done (`12-storyboard-final` in brainstorm artifacts).
2. Produce ~9 stills via GPT Image 2 at **medium fidelity** first (per "adaptive" decision).
3. Scaffold the web component with placeholder PNGs (block silhouettes from the storyboard SVGs).
4. Drop in real stills, tune transitions.
5. Internal viewing → decide if the metaphor lands.
6. If yes → upgrade fidelity (re-prompt GPT Image 2 for higher polish, optional Nano Banana 2 pass) and tune.
7. If no → revise storyboard and regenerate.

### Iteration cost

The point of stills + CSS over baked video is iteration speed. Tweaking a transition curve is a code edit; re-rendering a video clip is a 5+ minute pipeline run. Lock the storyboard early, iterate the rendering cheap.

### Where it lives

- Page route: `platform/app/auggy/select/page.tsx`
- Configurator client component: `platform/app/auggy/select/_components/configurator.tsx`
- Auggy renderer client component: `platform/app/auggy/select/_components/auggy-renderer.tsx`
- State machine: `platform/app/auggy/select/_lib/loadout-machine.ts`
- Assets: `platform/public/auggy-select/` (transparent PNGs by region + state)

These paths are recommendations for the implementation plan to refine; what's fixed is that the deliverable lives at `platform/app/auggy/select/`.

## 5. Phase 2/3 Reusability Strategy

The web component built in Phase 1 is **the foundation**, not a prototype to throw away.

### What Phase 1 produces that Phase 3 reuses directly

- **Layered asset library** (transparent PNGs by body region × state) — direct input to Phase 3's real config builder.
- **State machine** for the configurator — extensible from "state → composite render" to "state → composite render + valid `aug1.yml` emission."
- **Component code** in `platform/app/auggy/` is the surface Phase 3 wires into. No rewrite.

### Concrete state shape

Phase 1 state:

```ts
type AuggyLoadout = {
  engine: 'anthropic-opus-4.6' | 'openai-gpt-5' | 'openrouter-{model}'
  transports: ('web' | 'telegram')[]
  memory: 'file' | 'supabase' | 'layered'
  tools: ('filesystem' | 'webFetch' | 'orgContext' | 'bash')[]
  budgets: 'default' | 'tight' | 'generous'
}
```

Phase 3 adds:

```ts
function emitAug1Yml(loadout: AuggyLoadout): string { /* ... */ }
```

That's the entire Phase-3 wiring delta from a code perspective — same UI, same state, plus an emit function and a download/copy affordance.

## 6. Scope Boundaries

### In scope (Phase 1)

- Web component on `platform/app/auggy/select/`
- Autoplay walkthrough + interactive mode
- 5 visible categories: HEAD/ENGINE, TRANSPORTS, MEMORY, TOOLS, BUDGETS
- 3 engine livery options (Anthropic / OpenAI / OpenRouter), default Anthropic Opus 4.6
- Asset library produced as layered PNGs (one per body region × state)
- Desktop-only layout for v1 (~1024px+ designed)

### Out of scope (Phase 1)

- Real `aug1.yml` emission (→ Phase 3)
- Mobile responsive layout (Phase 1.5)
- Accessibility — keyboard nav, screen reader (Phase 1.5)
- IDENTITY / BELT-SLOTS / SKILLS as visible categories
- Sound design / voiceover
- Live agent boot
- Distribution / placement decisions beyond `platform/`

## 7. Open Decisions / Deferred

| Decision | Status | Owner | When to revisit |
|---|---|---|---|
| Torso semantics (multiple options vs. single `STANDARD`) | Single `STANDARD` for now | Michael | Phase 3 (when there's actual `aug1.yml` to map to) |
| Identity card visualization | Deferred — too small to read in this cut | Michael | Phase 1.5 |
| Distribution / placement beyond `platform/` | Deferred | Michael | Post-internal-viewing |
| Brand asset usage rights (Anthropic / OpenAI / OpenRouter logos) | Internal-viewing OK; legal review for production | Michael | Before any external publish |
| Mobile + accessibility | Deferred | Michael | Phase 1.5 |
| Sound / voiceover | Deferred (out for v1) | Michael | Phase 2 |

## 8. Anchors (brainstorm artifacts)

Visual companion screens are preserved in `augment-1/.superpowers/brainstorm/34485-1777485303/content/`. Key references:

- `01-context-anchor-v2.html` — reference frames + Auggy + body-part mapping
- `04-engine-livery-v2.html` — three engine heads (corrected: white knot on green, splitting-arrows on cream)
- `05-locked-so-far.html` — locked field guide
- `09-kernel-cinematic-reset.html` — render style direction
- `11-configurator-v1.html` — configurator format reset (kernel-as-core, user is the actor)
- `12-storyboard-final.html` — final 9-beat storyboard

These are sketches for shared-context purposes; the spec above is authoritative.
