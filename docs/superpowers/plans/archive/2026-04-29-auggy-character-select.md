# Auggy Character Select Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a web component on the LORF platform site that demonstrates Auggy's modular composition through an autoplay-then-interactive configurator at `platform/src/app/auggy/select/`.

**Architecture:** Pure-function loadout state machine in `src/lib`, presentational `AuggyRenderer` that composites transparent-PNG layers per state, `EquipPanel` for the equip UI, `Configurator` wrapper that wires them together, CSS-driven transitions defined as a vocabulary keyed off state diff. Assets start as lightweight placeholder SVGs so component work doesn't block on real renders; final PNGs (produced via GPT Image 2 + optional Nano Banana 2) drop in at the integration milestone.

**Tech Stack:** Next.js 16 App Router, React 19, TypeScript (strict), Tailwind v4, Zustand (already installed; used for the configurator store), Vitest + Testing Library + jsdom for tests.

**Spec reference:** `augment-1/docs/superpowers/specs/2026-04-29-auggy-character-select-design.md`

**Working directory:** All commands assume `cd /Users/bigviking/Documents/github/projects/lo/platform/`. The implementation lives in the platform repo; this plan and the spec live in the augment-1 repo for organizational reasons.

**Test command:** `bun run test` (NOT `bun test` — that invokes Bun's native runner; we use Vitest).

---

### Task 1: Scaffold the route + smoke test

Stand up an empty page at `/auggy/select` so we know the route resolves and we have somewhere to mount the configurator.

**Files:**
- Create: `platform/src/app/auggy/select/page.tsx`
- Create: `platform/src/__tests__/auggy-select-route.test.ts`

- [ ] **Step 1: Write the failing route test**

```ts
// platform/src/__tests__/auggy-select-route.test.ts
import { describe, it, expect } from "vitest";
import fs from "node:fs";
import path from "node:path";

describe("auggy select route", () => {
  it("has a page.tsx file", () => {
    const p = path.resolve(__dirname, "../app/auggy/select/page.tsx");
    expect(fs.existsSync(p)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test, verify it fails**

Run: `bun run test src/__tests__/auggy-select-route.test.ts`
Expected: FAIL with `expected false to be true` (file doesn't exist).

- [ ] **Step 3: Create minimal page**

```tsx
// platform/src/app/auggy/select/page.tsx
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Auggy · character select",
  description: "Configure Auggy — head, transports, memory, tools, budgets.",
};

export default function AuggySelectPage() {
  return (
    <main className="min-h-screen flex items-center justify-center">
      <p className="text-sm text-neutral-500">Auggy character select — under construction</p>
    </main>
  );
}
```

- [ ] **Step 4: Run test, verify it passes**

Run: `bun run test src/__tests__/auggy-select-route.test.ts`
Expected: PASS.

- [ ] **Step 5: Manual smoke test**

Run: `bun dev` and visit `http://localhost:3000/auggy/select`
Expected: page renders the placeholder text without errors.
Stop the dev server before continuing.

- [ ] **Step 6: Commit**

```bash
git add src/app/auggy/select/page.tsx src/__tests__/auggy-select-route.test.ts
git commit -m "feat(auggy): scaffold /auggy/select route"
```

---

### Task 2: Loadout types + state machine (pure functions, fully tested)

Define the typed `AuggyLoadout` shape from the spec and the pure reducer that applies user picks. No React yet — this is the contract the rest of the component leans on.

**Files:**
- Create: `platform/src/lib/auggy-loadout.ts`
- Create: `platform/src/lib/__tests__/auggy-loadout.test.ts`

- [ ] **Step 1: Write failing tests for types and reducer**

```ts
// platform/src/lib/__tests__/auggy-loadout.test.ts
import { describe, it, expect } from "vitest";
import {
  type AuggyLoadout,
  type LoadoutAction,
  initialLoadout,
  applyAction,
  isComplete,
} from "../auggy-loadout";

describe("auggy-loadout", () => {
  it("starts with chassis-only state (no engine, no augments)", () => {
    expect(initialLoadout).toEqual({
      engine: null,
      transports: [],
      memory: null,
      tools: [],
      budgets: null,
    });
  });

  it("equips an engine via SET_ENGINE", () => {
    const next = applyAction(initialLoadout, {
      type: "SET_ENGINE",
      engine: "openai-gpt-5",
    });
    expect(next.engine).toBe("openai-gpt-5");
  });

  it("swaps engine without mutating input", () => {
    const a = applyAction(initialLoadout, { type: "SET_ENGINE", engine: "openai-gpt-5" });
    const b = applyAction(a, { type: "SET_ENGINE", engine: "anthropic-opus-4.6" });
    expect(a.engine).toBe("openai-gpt-5");
    expect(b.engine).toBe("anthropic-opus-4.6");
  });

  it("adds a transport via ADD_TRANSPORT (deduped)", () => {
    const a = applyAction(initialLoadout, { type: "ADD_TRANSPORT", transport: "web" });
    const b = applyAction(a, { type: "ADD_TRANSPORT", transport: "web" });
    expect(b.transports).toEqual(["web"]);
  });

  it("sets memory tier", () => {
    const next = applyAction(initialLoadout, { type: "SET_MEMORY", memory: "layered" });
    expect(next.memory).toBe("layered");
  });

  it("adds a tool", () => {
    const next = applyAction(initialLoadout, { type: "ADD_TOOL", tool: "filesystem" });
    expect(next.tools).toEqual(["filesystem"]);
  });

  it("sets budgets", () => {
    const next = applyAction(initialLoadout, { type: "SET_BUDGETS", budgets: "default" });
    expect(next.budgets).toBe("default");
  });

  it("RESET returns to initialLoadout", () => {
    const a = applyAction(initialLoadout, { type: "SET_ENGINE", engine: "openai-gpt-5" });
    const b = applyAction(a, { type: "RESET" });
    expect(b).toEqual(initialLoadout);
  });

  it("isComplete is true only when all 5 categories are picked", () => {
    const filled: AuggyLoadout = {
      engine: "anthropic-opus-4.6",
      transports: ["web"],
      memory: "layered",
      tools: ["filesystem"],
      budgets: "default",
    };
    expect(isComplete(filled)).toBe(true);
    expect(isComplete(initialLoadout)).toBe(false);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run test src/lib/__tests__/auggy-loadout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement types + reducer**

```ts
// platform/src/lib/auggy-loadout.ts
export type Engine =
  | "anthropic-opus-4.6"
  | "openai-gpt-5"
  | `openrouter-${string}`;

export type Transport = "web" | "telegram";

export type Memory = "file" | "supabase" | "layered";

export type Tool = "filesystem" | "webFetch" | "orgContext" | "bash";

export type Budgets = "default" | "tight" | "generous";

export type AuggyLoadout = {
  engine: Engine | null;
  transports: Transport[];
  memory: Memory | null;
  tools: Tool[];
  budgets: Budgets | null;
};

export type LoadoutAction =
  | { type: "SET_ENGINE"; engine: Engine }
  | { type: "ADD_TRANSPORT"; transport: Transport }
  | { type: "REMOVE_TRANSPORT"; transport: Transport }
  | { type: "SET_MEMORY"; memory: Memory }
  | { type: "ADD_TOOL"; tool: Tool }
  | { type: "REMOVE_TOOL"; tool: Tool }
  | { type: "SET_BUDGETS"; budgets: Budgets }
  | { type: "RESET" };

export const initialLoadout: AuggyLoadout = {
  engine: null,
  transports: [],
  memory: null,
  tools: [],
  budgets: null,
};

export function applyAction(state: AuggyLoadout, action: LoadoutAction): AuggyLoadout {
  switch (action.type) {
    case "SET_ENGINE":
      return { ...state, engine: action.engine };
    case "ADD_TRANSPORT":
      return state.transports.includes(action.transport)
        ? state
        : { ...state, transports: [...state.transports, action.transport] };
    case "REMOVE_TRANSPORT":
      return { ...state, transports: state.transports.filter(t => t !== action.transport) };
    case "SET_MEMORY":
      return { ...state, memory: action.memory };
    case "ADD_TOOL":
      return state.tools.includes(action.tool)
        ? state
        : { ...state, tools: [...state.tools, action.tool] };
    case "REMOVE_TOOL":
      return { ...state, tools: state.tools.filter(t => t !== action.tool) };
    case "SET_BUDGETS":
      return { ...state, budgets: action.budgets };
    case "RESET":
      return initialLoadout;
  }
}

export function isComplete(state: AuggyLoadout): boolean {
  return (
    state.engine !== null &&
    state.transports.length > 0 &&
    state.memory !== null &&
    state.tools.length > 0 &&
    state.budgets !== null
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run test src/lib/__tests__/auggy-loadout.test.ts`
Expected: PASS (8 tests).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean (no errors).

- [ ] **Step 6: Commit**

```bash
git add src/lib/auggy-loadout.ts src/lib/__tests__/auggy-loadout.test.ts
git commit -m "feat(auggy): add AuggyLoadout types and pure-function reducer"
```

---

### Task 3: Placeholder asset library (SVG block silhouettes)

Real PNGs come later. For component dev we use lightweight SVG placeholders matching the body-region grammar from the storyboard. Each is a transparent file at `public/auggy-select/`. This unblocks Tasks 4–10 from waiting on render production.

**Files:**
- Create: `platform/public/auggy-select/chassis.svg`
- Create: `platform/public/auggy-select/head-anthropic.svg`
- Create: `platform/public/auggy-select/head-openai.svg`
- Create: `platform/public/auggy-select/head-openrouter.svg`
- Create: `platform/public/auggy-select/memory-layered-overlay.svg`
- Create: `platform/public/auggy-select/transport-antenna.svg`
- Create: `platform/public/auggy-select/tool-wrench.svg`
- Create: `platform/public/auggy-select/budget-meter.svg`
- Create: `platform/src/components/auggy/asset-manifest.ts`

- [ ] **Step 1: Create chassis placeholder**

```svg
<!-- platform/public/auggy-select/chassis.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 280" width="200" height="280">
  <rect x="40" y="80" width="120" height="100" rx="8" fill="#f7f1e2" stroke="#1d1d1f" stroke-width="2"/>
  <circle cx="100" cy="125" r="22" fill="#ff7a45" opacity="0.4"/>
  <polygon points="100,108 116,118 116,134 100,144 84,134 84,118" fill="#ff7a45" stroke="#1d1d1f" stroke-width="1"/>
  <circle cx="65" cy="118" r="6" fill="#1d1d1f"/>
  <rect x="40" y="180" width="120" height="10" fill="#f7f1e2" stroke="#1d1d1f" stroke-width="2"/>
</svg>
```

- [ ] **Step 2: Create the three engine head placeholders**

Each is a hex-mounted head plate with brand color + simplified mark. Use the same SVG skeleton, vary fill + mark + chin tag:

```svg
<!-- platform/public/auggy-select/head-anthropic.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80">
  <rect x="40" y="6" width="120" height="60" rx="6" fill="#d97757" stroke="#1d1d1f" stroke-width="2"/>
  <text x="100" y="48" text-anchor="middle" font-family="Georgia, serif" font-size="38" font-weight="700" fill="#fff">A</text>
  <rect x="70" y="68" width="60" height="8" rx="1" fill="#1d1d1f"/>
  <text x="100" y="74" text-anchor="middle" font-family="ui-monospace, monospace" font-size="6" fill="#fff">OPUS 4.6</text>
</svg>
```

```svg
<!-- platform/public/auggy-select/head-openai.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80">
  <rect x="40" y="6" width="120" height="60" rx="6" fill="#10a37f" stroke="#0a6e54" stroke-width="2"/>
  <g transform="translate(100,36)" stroke="#fff" stroke-width="3" fill="none" stroke-linecap="round">
    <ellipse cx="0" cy="0" rx="18" ry="8"/>
    <ellipse cx="0" cy="0" rx="18" ry="8" transform="rotate(60)"/>
    <ellipse cx="0" cy="0" rx="18" ry="8" transform="rotate(120)"/>
  </g>
  <rect x="70" y="68" width="60" height="8" rx="1" fill="#0a6e54"/>
  <text x="100" y="74" text-anchor="middle" font-family="ui-monospace, monospace" font-size="6" fill="#fff">GPT-5</text>
</svg>
```

```svg
<!-- platform/public/auggy-select/head-openrouter.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80">
  <rect x="40" y="6" width="120" height="60" rx="6" fill="#f5efe2" stroke="#1d1d1f" stroke-width="2"/>
  <g fill="#0a0a0a">
    <path d="M 70 36 C 88 36, 100 18, 118 16 L 118 10 L 138 24 L 118 38 L 118 32 C 104 32, 96 50, 80 50 Z"/>
    <path d="M 70 36 C 88 36, 96 50, 118 56 L 118 62 L 138 50 L 118 38 L 118 44 C 104 44, 92 36, 80 36 Z"/>
  </g>
  <rect x="60" y="68" width="80" height="8" rx="1" fill="#1d1d1f"/>
  <text x="100" y="74" text-anchor="middle" font-family="ui-monospace, monospace" font-size="6" fill="#fff">OR → QWEN-3-72B</text>
</svg>
```

- [ ] **Step 3: Create augment overlay placeholders**

```svg
<!-- platform/public/auggy-select/memory-layered-overlay.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 80" width="200" height="80">
  <line x1="40" y1="26" x2="160" y2="26" stroke="#1d1d1f" stroke-width="1" stroke-dasharray="2,2"/>
  <line x1="40" y1="46" x2="160" y2="46" stroke="#1d1d1f" stroke-width="1" stroke-dasharray="2,2"/>
</svg>
```

```svg
<!-- platform/public/auggy-select/transport-antenna.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 30" width="200" height="30">
  <line x1="100" y1="30" x2="100" y2="6" stroke="#1d1d1f" stroke-width="2"/>
  <circle cx="100" cy="4" r="4" fill="#10a37f"/>
</svg>
```

```svg
<!-- platform/public/auggy-select/tool-wrench.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 12" width="30" height="12">
  <rect x="6" y="4" width="18" height="4" fill="#1d1d1f"/>
  <circle cx="6" cy="6" r="3" fill="#1d1d1f"/>
  <circle cx="24" cy="6" r="3" fill="#1d1d1f"/>
</svg>
```

```svg
<!-- platform/public/auggy-select/budget-meter.svg -->
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 200 280" width="200" height="280">
  <circle cx="100" cy="125" r="32" fill="none" stroke="#10a37f" stroke-width="3" stroke-dasharray="180,30" transform="rotate(-90 100 125)"/>
</svg>
```

- [ ] **Step 4: Create the asset manifest**

```ts
// platform/src/components/auggy/asset-manifest.ts
import type { Engine, Memory, Transport, Tool } from "@/lib/auggy-loadout";

export const ASSETS = {
  chassis: "/auggy-select/chassis.svg",
  head: {
    "anthropic-opus-4.6": "/auggy-select/head-anthropic.svg",
    "openai-gpt-5": "/auggy-select/head-openai.svg",
  } as Partial<Record<Engine, string>>,
  headOpenRouterFallback: "/auggy-select/head-openrouter.svg",
  memoryOverlay: {
    layered: "/auggy-select/memory-layered-overlay.svg",
  } as Partial<Record<Memory, string>>,
  transportLayer: {
    web: "/auggy-select/transport-antenna.svg",
    telegram: "/auggy-select/transport-antenna.svg",
  } as Record<Transport, string>,
  toolLayer: {
    filesystem: "/auggy-select/tool-wrench.svg",
    webFetch: "/auggy-select/tool-wrench.svg",
    orgContext: "/auggy-select/tool-wrench.svg",
    bash: "/auggy-select/tool-wrench.svg",
  } as Record<Tool, string>,
  budgetMeter: "/auggy-select/budget-meter.svg",
} as const;

export function headAsset(engine: Engine | null): string | null {
  if (!engine) return null;
  if (engine in ASSETS.head) return ASSETS.head[engine] ?? null;
  if (engine.startsWith("openrouter-")) return ASSETS.headOpenRouterFallback;
  return null;
}
```

- [ ] **Step 5: Verify assets are reachable**

Run: `bun dev` and visit each asset URL like `http://localhost:3000/auggy-select/chassis.svg`. They should render as SVG. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add public/auggy-select/ src/components/auggy/asset-manifest.ts
git commit -m "feat(auggy): add placeholder SVG asset library + manifest"
```

---

### Task 4: AuggyRenderer component (composites layers from state)

A pure presentational component: takes `AuggyLoadout`, returns a stack of layers. No transitions yet — that's Task 7. Uses absolute positioning over a fixed-aspect cyc.

**Files:**
- Create: `platform/src/components/auggy/AuggyRenderer.tsx`
- Create: `platform/src/components/auggy/__tests__/AuggyRenderer.test.tsx`

- [ ] **Step 1: Write failing render tests**

```tsx
// platform/src/components/auggy/__tests__/AuggyRenderer.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AuggyRenderer } from "../AuggyRenderer";
import { initialLoadout } from "@/lib/auggy-loadout";

describe("AuggyRenderer", () => {
  it("renders chassis layer for initial state", () => {
    const { container } = render(<AuggyRenderer loadout={initialLoadout} />);
    const chassis = container.querySelector('[data-layer="chassis"]');
    expect(chassis).not.toBeNull();
  });

  it("does not render head when no engine equipped", () => {
    const { container } = render(<AuggyRenderer loadout={initialLoadout} />);
    expect(container.querySelector('[data-layer="head"]')).toBeNull();
  });

  it("renders head when engine equipped", () => {
    const { container } = render(
      <AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />
    );
    const head = container.querySelector('[data-layer="head"]');
    expect(head).not.toBeNull();
    expect(head?.getAttribute("data-engine")).toBe("anthropic-opus-4.6");
  });

  it("renders antenna layer when transport added", () => {
    const { container } = render(
      <AuggyRenderer
        loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", transports: ["web"] }}
      />
    );
    expect(container.querySelector('[data-layer="transport-web"]')).not.toBeNull();
  });

  it("renders memory overlay when memory=layered", () => {
    const { container } = render(
      <AuggyRenderer
        loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", memory: "layered" }}
      />
    );
    expect(container.querySelector('[data-layer="memory-overlay"]')).not.toBeNull();
  });

  it("renders tool icon when tool added", () => {
    const { container } = render(
      <AuggyRenderer
        loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", tools: ["filesystem"] }}
      />
    );
    expect(container.querySelector('[data-layer="tool-filesystem"]')).not.toBeNull();
  });

  it("renders budget meter when budgets set", () => {
    const { container } = render(
      <AuggyRenderer
        loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", budgets: "default" }}
      />
    );
    expect(container.querySelector('[data-layer="budget-meter"]')).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

Run: `bun run test src/components/auggy/__tests__/AuggyRenderer.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement AuggyRenderer**

```tsx
// platform/src/components/auggy/AuggyRenderer.tsx
"use client";

import Image from "next/image";
import type { AuggyLoadout } from "@/lib/auggy-loadout";
import { ASSETS, headAsset } from "./asset-manifest";

export type AuggyRendererProps = {
  loadout: AuggyLoadout;
};

export function AuggyRenderer({ loadout }: AuggyRendererProps) {
  const head = headAsset(loadout.engine);
  return (
    <div className="relative w-full aspect-[5/7] bg-[#f5efe2] rounded-lg overflow-hidden">
      <Layer src={ASSETS.chassis} alt="Auggy chassis" name="chassis" />
      {head && loadout.engine && (
        <Layer
          src={head}
          alt={`Engine: ${loadout.engine}`}
          name="head"
          dataAttrs={{ "data-engine": loadout.engine }}
          style={{ top: "5%", left: "10%", width: "80%", height: "auto" }}
        />
      )}
      {loadout.memory === "layered" && (
        <Layer
          src={ASSETS.memoryOverlay.layered ?? ""}
          alt="Memory: layered"
          name="memory-overlay"
          style={{ top: "5%", left: "10%", width: "80%", height: "auto" }}
        />
      )}
      {loadout.transports.map((t) => (
        <Layer
          key={t}
          src={ASSETS.transportLayer[t]}
          alt={`Transport: ${t}`}
          name={`transport-${t}`}
          style={{ top: "0%", left: "10%", width: "80%", height: "auto" }}
        />
      ))}
      {loadout.tools.map((tool) => (
        <Layer
          key={tool}
          src={ASSETS.toolLayer[tool]}
          alt={`Tool: ${tool}`}
          name={`tool-${tool}`}
          style={{ top: "65%", left: "20%", width: "20%", height: "auto" }}
        />
      ))}
      {loadout.budgets && (
        <Layer
          src={ASSETS.budgetMeter}
          alt="Budget meter"
          name="budget-meter"
        />
      )}
    </div>
  );
}

type LayerProps = {
  src: string;
  alt: string;
  name: string;
  style?: React.CSSProperties;
  dataAttrs?: Record<string, string>;
};

function Layer({ src, alt, name, style, dataAttrs }: LayerProps) {
  return (
    <Image
      src={src}
      alt={alt}
      width={400}
      height={560}
      data-layer={name}
      {...dataAttrs}
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={style}
    />
  );
}
```

- [ ] **Step 4: Run tests, verify they pass**

Run: `bun run test src/components/auggy/__tests__/AuggyRenderer.test.tsx`
Expected: PASS (7 tests).

- [ ] **Step 5: Manual smoke**

Update the page to mount the renderer with a non-trivial loadout:

```tsx
// platform/src/app/auggy/select/page.tsx — temporary preview
import { AuggyRenderer } from "@/components/auggy/AuggyRenderer";

export default function AuggySelectPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8">
      <div className="w-full max-w-md">
        <AuggyRenderer
          loadout={{
            engine: "anthropic-opus-4.6",
            transports: ["web"],
            memory: "layered",
            tools: ["filesystem"],
            budgets: "default",
          }}
        />
      </div>
    </main>
  );
}
```

Run: `bun dev` and visit `http://localhost:3000/auggy/select`.
Expected: composited Auggy renders with all layers visible. Stop the dev server.

- [ ] **Step 6: Commit**

```bash
git add src/components/auggy/AuggyRenderer.tsx src/components/auggy/__tests__/AuggyRenderer.test.tsx src/app/auggy/select/page.tsx
git commit -m "feat(auggy): add AuggyRenderer that composites loadout layers"
```

---

### Task 5: EquipPanel component (category nav + option list)

The configurator's left panel. Shows a list of categories (HEAD/ENGINE, TRANSPORTS, MEMORY, TOOLS, BUDGETS), the active category's options, and emits a `LoadoutAction` on user pick.

**Files:**
- Create: `platform/src/components/auggy/EquipPanel.tsx`
- Create: `platform/src/components/auggy/equip-categories.ts`
- Create: `platform/src/components/auggy/__tests__/EquipPanel.test.tsx`

- [ ] **Step 1: Define equip-categories metadata**

```ts
// platform/src/components/auggy/equip-categories.ts
import type { LoadoutAction } from "@/lib/auggy-loadout";

export type CategoryId = "engine" | "transports" | "memory" | "tools" | "budgets";

export type CategoryOption = {
  id: string;
  label: string;
  action: LoadoutAction;
};

export type Category = {
  id: CategoryId;
  label: string;
  options: CategoryOption[];
};

export const CATEGORIES: Category[] = [
  {
    id: "engine",
    label: "HEAD · ENGINE",
    options: [
      { id: "anthropic-opus-4.6", label: "ANTHROPIC · OPUS 4.6", action: { type: "SET_ENGINE", engine: "anthropic-opus-4.6" } },
      { id: "openai-gpt-5", label: "OPENAI · GPT-5", action: { type: "SET_ENGINE", engine: "openai-gpt-5" } },
      { id: "openrouter-qwen", label: "OPENROUTER → QWEN-3-72B", action: { type: "SET_ENGINE", engine: "openrouter-qwen-3-72b" } },
    ],
  },
  {
    id: "transports",
    label: "TRANSPORTS",
    options: [
      { id: "web", label: "WEB", action: { type: "ADD_TRANSPORT", transport: "web" } },
      { id: "telegram", label: "TELEGRAM", action: { type: "ADD_TRANSPORT", transport: "telegram" } },
    ],
  },
  {
    id: "memory",
    label: "MEMORY",
    options: [
      { id: "file", label: "FILE", action: { type: "SET_MEMORY", memory: "file" } },
      { id: "supabase", label: "SUPABASE", action: { type: "SET_MEMORY", memory: "supabase" } },
      { id: "layered", label: "LAYERED", action: { type: "SET_MEMORY", memory: "layered" } },
    ],
  },
  {
    id: "tools",
    label: "TOOLS",
    options: [
      { id: "filesystem", label: "FILESYSTEM", action: { type: "ADD_TOOL", tool: "filesystem" } },
      { id: "webFetch", label: "WEB FETCH", action: { type: "ADD_TOOL", tool: "webFetch" } },
      { id: "orgContext", label: "ORG CONTEXT", action: { type: "ADD_TOOL", tool: "orgContext" } },
      { id: "bash", label: "BASH", action: { type: "ADD_TOOL", tool: "bash" } },
    ],
  },
  {
    id: "budgets",
    label: "BUDGETS",
    options: [
      { id: "tight", label: "TIGHT", action: { type: "SET_BUDGETS", budgets: "tight" } },
      { id: "default", label: "DEFAULT", action: { type: "SET_BUDGETS", budgets: "default" } },
      { id: "generous", label: "GENEROUS", action: { type: "SET_BUDGETS", budgets: "generous" } },
    ],
  },
];
```

- [ ] **Step 2: Write failing tests**

```tsx
// platform/src/components/auggy/__tests__/EquipPanel.test.tsx
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { EquipPanel } from "../EquipPanel";
import { initialLoadout } from "@/lib/auggy-loadout";

describe("EquipPanel", () => {
  it("renders category labels", () => {
    render(<EquipPanel loadout={initialLoadout} activeCategory="engine" onPick={() => {}} onCategoryChange={() => {}} />);
    expect(screen.getByText("HEAD · ENGINE")).toBeInTheDocument();
    expect(screen.getByText("TRANSPORTS")).toBeInTheDocument();
    expect(screen.getByText("MEMORY")).toBeInTheDocument();
    expect(screen.getByText("TOOLS")).toBeInTheDocument();
    expect(screen.getByText("BUDGETS")).toBeInTheDocument();
  });

  it("renders options of the active category", () => {
    render(<EquipPanel loadout={initialLoadout} activeCategory="engine" onPick={() => {}} onCategoryChange={() => {}} />);
    expect(screen.getByText("ANTHROPIC · OPUS 4.6")).toBeInTheDocument();
    expect(screen.getByText("OPENAI · GPT-5")).toBeInTheDocument();
  });

  it("calls onPick with the option's action when clicked", () => {
    const onPick = vi.fn();
    render(<EquipPanel loadout={initialLoadout} activeCategory="engine" onPick={onPick} onCategoryChange={() => {}} />);
    fireEvent.click(screen.getByText("OPENAI · GPT-5"));
    expect(onPick).toHaveBeenCalledWith({ type: "SET_ENGINE", engine: "openai-gpt-5" });
  });

  it("highlights the equipped option", () => {
    render(
      <EquipPanel
        loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }}
        activeCategory="engine"
        onPick={() => {}}
        onCategoryChange={() => {}}
      />
    );
    const equipped = screen.getByText("ANTHROPIC · OPUS 4.6").closest("button");
    expect(equipped?.getAttribute("data-equipped")).toBe("true");
  });

  it("calls onCategoryChange when a category tab is clicked", () => {
    const onCategoryChange = vi.fn();
    render(<EquipPanel loadout={initialLoadout} activeCategory="engine" onPick={() => {}} onCategoryChange={onCategoryChange} />);
    fireEvent.click(screen.getByText("TRANSPORTS"));
    expect(onCategoryChange).toHaveBeenCalledWith("transports");
  });
});
```

- [ ] **Step 3: Run tests, verify they fail**

Run: `bun run test src/components/auggy/__tests__/EquipPanel.test.tsx`
Expected: FAIL.

- [ ] **Step 4: Implement EquipPanel**

```tsx
// platform/src/components/auggy/EquipPanel.tsx
"use client";

import type { AuggyLoadout, LoadoutAction } from "@/lib/auggy-loadout";
import { CATEGORIES, type CategoryId } from "./equip-categories";

export type EquipPanelProps = {
  loadout: AuggyLoadout;
  activeCategory: CategoryId;
  onPick: (action: LoadoutAction) => void;
  onCategoryChange: (id: CategoryId) => void;
};

export function EquipPanel({ loadout, activeCategory, onPick, onCategoryChange }: EquipPanelProps) {
  const active = CATEGORIES.find(c => c.id === activeCategory);
  return (
    <aside className="w-72 bg-white border-r border-[#d4c5a9] p-4 font-mono text-[#5a4a3a] text-sm">
      <nav className="mb-6 flex flex-col gap-1" aria-label="Equip categories">
        {CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => onCategoryChange(c.id)}
            data-active={c.id === activeCategory}
            className="text-left px-2 py-1 rounded data-[active=true]:bg-[#1d1d1f] data-[active=true]:text-white"
          >
            {c.label}
          </button>
        ))}
      </nav>
      <div>
        <h2 className="text-xs uppercase tracking-wider mb-2 opacity-70">{active?.label}</h2>
        <ul className="flex flex-col gap-2">
          {active?.options.map((opt) => {
            const equipped = isEquipped(loadout, activeCategory, opt.id);
            return (
              <li key={opt.id}>
                <button
                  type="button"
                  onClick={() => onPick(opt.action)}
                  data-equipped={equipped}
                  className="w-full text-left px-3 py-2 border border-[#e0d4ba] rounded bg-[#fafaf3] data-[equipped=true]:bg-[#1d1d1f] data-[equipped=true]:text-white data-[equipped=true]:border-[#1d1d1f]"
                >
                  {opt.label}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </aside>
  );
}

function isEquipped(loadout: AuggyLoadout, categoryId: CategoryId, optionId: string): boolean {
  switch (categoryId) {
    case "engine":
      return loadout.engine === optionId;
    case "transports":
      return loadout.transports.includes(optionId as never);
    case "memory":
      return loadout.memory === optionId;
    case "tools":
      return loadout.tools.includes(optionId as never);
    case "budgets":
      return loadout.budgets === optionId;
  }
}
```

- [ ] **Step 5: Run tests, verify they pass**

Run: `bun run test src/components/auggy/__tests__/EquipPanel.test.tsx`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add src/components/auggy/EquipPanel.tsx src/components/auggy/equip-categories.ts src/components/auggy/__tests__/EquipPanel.test.tsx
git commit -m "feat(auggy): add EquipPanel with categories + option picker"
```

---

### Task 6: Configurator wrapper (state + layout)

Wires `AuggyRenderer` and `EquipPanel` together via a Zustand store. Holds the current loadout, active category, and mode (`autoplay` | `interactive`). For now: interactive mode only — autoplay is added in Task 9.

**Files:**
- Create: `platform/src/components/auggy/configurator-store.ts`
- Create: `platform/src/components/auggy/Configurator.tsx`
- Create: `platform/src/components/auggy/__tests__/configurator-store.test.ts`

- [ ] **Step 1: Failing store tests**

```ts
// platform/src/components/auggy/__tests__/configurator-store.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { useConfiguratorStore } from "../configurator-store";
import { initialLoadout } from "@/lib/auggy-loadout";

describe("configurator store", () => {
  beforeEach(() => {
    useConfiguratorStore.getState().reset();
  });

  it("starts in interactive mode with initial loadout and engine category active", () => {
    const s = useConfiguratorStore.getState();
    expect(s.loadout).toEqual(initialLoadout);
    expect(s.activeCategory).toBe("engine");
    expect(s.mode).toBe("interactive");
  });

  it("dispatch applies an action and updates loadout", () => {
    useConfiguratorStore.getState().dispatch({ type: "SET_ENGINE", engine: "anthropic-opus-4.6" });
    expect(useConfiguratorStore.getState().loadout.engine).toBe("anthropic-opus-4.6");
  });

  it("setActiveCategory updates the active category", () => {
    useConfiguratorStore.getState().setActiveCategory("transports");
    expect(useConfiguratorStore.getState().activeCategory).toBe("transports");
  });

  it("setMode updates the mode", () => {
    useConfiguratorStore.getState().setMode("autoplay");
    expect(useConfiguratorStore.getState().mode).toBe("autoplay");
  });

  it("reset returns to fresh state", () => {
    useConfiguratorStore.getState().dispatch({ type: "SET_ENGINE", engine: "openai-gpt-5" });
    useConfiguratorStore.getState().setMode("autoplay");
    useConfiguratorStore.getState().reset();
    const s = useConfiguratorStore.getState();
    expect(s.loadout).toEqual(initialLoadout);
    expect(s.mode).toBe("interactive");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun run test src/components/auggy/__tests__/configurator-store.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement store**

```ts
// platform/src/components/auggy/configurator-store.ts
import { create } from "zustand";
import {
  type AuggyLoadout,
  type LoadoutAction,
  applyAction,
  initialLoadout,
} from "@/lib/auggy-loadout";
import type { CategoryId } from "./equip-categories";

export type ConfiguratorMode = "autoplay" | "interactive";

type ConfiguratorState = {
  loadout: AuggyLoadout;
  activeCategory: CategoryId;
  mode: ConfiguratorMode;
  dispatch: (action: LoadoutAction) => void;
  setActiveCategory: (id: CategoryId) => void;
  setMode: (mode: ConfiguratorMode) => void;
  reset: () => void;
};

export const useConfiguratorStore = create<ConfiguratorState>((set) => ({
  loadout: initialLoadout,
  activeCategory: "engine",
  mode: "interactive",
  dispatch: (action) => set((s) => ({ loadout: applyAction(s.loadout, action) })),
  setActiveCategory: (id) => set({ activeCategory: id }),
  setMode: (mode) => set({ mode }),
  reset: () => set({ loadout: initialLoadout, activeCategory: "engine", mode: "interactive" }),
}));
```

- [ ] **Step 4: Run, verify pass**

Run: `bun run test src/components/auggy/__tests__/configurator-store.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Implement Configurator**

```tsx
// platform/src/components/auggy/Configurator.tsx
"use client";

import { AuggyRenderer } from "./AuggyRenderer";
import { EquipPanel } from "./EquipPanel";
import { useConfiguratorStore } from "./configurator-store";

export function Configurator() {
  const loadout = useConfiguratorStore((s) => s.loadout);
  const activeCategory = useConfiguratorStore((s) => s.activeCategory);
  const dispatch = useConfiguratorStore((s) => s.dispatch);
  const setActiveCategory = useConfiguratorStore((s) => s.setActiveCategory);

  return (
    <div className="flex w-full max-w-5xl mx-auto bg-[#f5efe2] rounded-xl border border-[#d4c5a9] overflow-hidden">
      <EquipPanel
        loadout={loadout}
        activeCategory={activeCategory}
        onPick={dispatch}
        onCategoryChange={setActiveCategory}
      />
      <div className="flex-1 p-8 flex items-center justify-center">
        <div className="w-full max-w-md">
          <AuggyRenderer loadout={loadout} />
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Mount in the page**

```tsx
// platform/src/app/auggy/select/page.tsx
import type { Metadata } from "next";
import { Configurator } from "@/components/auggy/Configurator";

export const metadata: Metadata = {
  title: "Auggy · character select",
  description: "Configure Auggy — head, transports, memory, tools, budgets.",
};

export default function AuggySelectPage() {
  return (
    <main className="min-h-screen flex items-center justify-center p-8 bg-neutral-50 dark:bg-neutral-950">
      <Configurator />
    </main>
  );
}
```

- [ ] **Step 7: Manual smoke test**

Run: `bun dev` and visit `http://localhost:3000/auggy/select`.
Expected: configurator renders. Clicking categories on the left switches the option list. Clicking options updates Auggy on the right. Stop dev server.

- [ ] **Step 8: Commit**

```bash
git add src/components/auggy/configurator-store.ts src/components/auggy/Configurator.tsx src/components/auggy/__tests__/configurator-store.test.ts src/app/auggy/select/page.tsx
git commit -m "feat(auggy): add Configurator with Zustand store wiring renderer + equip panel"
```

---

### Task 7: Transition CSS vocabulary

Define the 8 transitions from the spec as CSS keyframes/transitions. Layers reference them via `data-transition` attributes that the renderer applies based on state diff.

**Files:**
- Create: `platform/src/components/auggy/auggy-transitions.css`
- Modify: `platform/src/app/globals.css` (import the transitions CSS)

- [ ] **Step 1: Add transition CSS**

```css
/* platform/src/components/auggy/auggy-transitions.css */

/* slide-on: head/torso panels enter from offscreen and lock in (~600ms) */
@keyframes auggy-slide-on {
  from { transform: translateY(-30%); opacity: 0; }
  to   { transform: translateY(0); opacity: 1; }
}
[data-transition="slide-on"] { animation: auggy-slide-on 600ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }

/* paint-on: livery fills in over a panel (~400ms) */
@keyframes auggy-paint-on {
  from { opacity: 0; filter: saturate(0); }
  to   { opacity: 1; filter: saturate(1); }
}
[data-transition="paint-on"] { animation: auggy-paint-on 400ms ease-out both; }

/* morph: engine swap — cross-fade 500ms */
@keyframes auggy-morph {
  from { opacity: 0; transform: scale(0.96); }
  to   { opacity: 1; transform: scale(1); }
}
[data-transition="morph"] { animation: auggy-morph 500ms ease-in-out both; }

/* grow: antenna extrudes from origin (~400ms) */
@keyframes auggy-grow {
  from { transform: scaleY(0); transform-origin: bottom; opacity: 0; }
  to   { transform: scaleY(1); transform-origin: bottom; opacity: 1; }
}
[data-transition="grow"] { animation: auggy-grow 400ms ease-out both; }

/* silhouette-shift: head shape changes (~500ms) */
@keyframes auggy-silhouette-shift {
  0%   { opacity: 0; }
  30%  { opacity: 0.4; }
  100% { opacity: 1; }
}
[data-transition="silhouette-shift"] { animation: auggy-silhouette-shift 500ms ease-in-out both; }

/* dock: tool icon flies in, snaps to belt (~350ms with bounce) */
@keyframes auggy-dock {
  0%   { transform: translateY(-40%) scale(1.1); opacity: 0; }
  60%  { transform: translateY(8%)  scale(0.95); opacity: 1; }
  100% { transform: translateY(0)   scale(1); }
}
[data-transition="dock"] { animation: auggy-dock 350ms cubic-bezier(0.34, 1.56, 0.64, 1) both; }

/* etch: meter arc traces (~600ms) */
@keyframes auggy-etch {
  from { stroke-dashoffset: 200; opacity: 0; }
  to   { stroke-dashoffset: 0; opacity: 1; }
}
[data-transition="etch"] { animation: auggy-etch 600ms ease-out both; }

/* flash: confirm flash (~150ms) */
@keyframes auggy-flash {
  0%, 100% { background: transparent; }
  50%      { background: rgba(255, 255, 255, 0.7); }
}
[data-transition="flash"] { animation: auggy-flash 150ms ease-in-out both; }
```

- [ ] **Step 2: Import in globals.css**

```css
/* platform/src/app/globals.css — append at the bottom */
@import "../components/auggy/auggy-transitions.css";
```

- [ ] **Step 3: Manual visual test**

Run: `bun dev`. Open the page and toggle the engine in the picker — at this point no animation will fire because Task 8 wires it up. The CSS being parsed is verified by the build not erroring. Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/auggy/auggy-transitions.css src/app/globals.css
git commit -m "feat(auggy): add CSS transition vocabulary (slide-on, paint-on, morph, grow, silhouette-shift, dock, etch, flash)"
```

---

### Task 8: Wire transitions to layer state changes

Each layer's transition is determined by which state field just changed. Track the previous loadout in the renderer; tag layers with `data-transition` for one render after their state changes.

**Files:**
- Modify: `platform/src/components/auggy/AuggyRenderer.tsx`
- Create: `platform/src/components/auggy/__tests__/AuggyRenderer.transitions.test.tsx`

- [ ] **Step 1: Failing transition tests**

```tsx
// platform/src/components/auggy/__tests__/AuggyRenderer.transitions.test.tsx
import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { AuggyRenderer } from "../AuggyRenderer";
import { initialLoadout } from "@/lib/auggy-loadout";

describe("AuggyRenderer transitions", () => {
  it("applies data-transition='paint-on' to head when engine first appears", () => {
    const { container, rerender } = render(<AuggyRenderer loadout={initialLoadout} />);
    rerender(<AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />);
    const head = container.querySelector('[data-layer="head"]');
    expect(head?.getAttribute("data-transition")).toBe("paint-on");
  });

  it("applies 'morph' when engine swaps from one to another", () => {
    const { container, rerender } = render(
      <AuggyRenderer loadout={{ ...initialLoadout, engine: "openai-gpt-5" }} />
    );
    rerender(<AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />);
    const head = container.querySelector('[data-layer="head"]');
    expect(head?.getAttribute("data-transition")).toBe("morph");
  });

  it("applies 'grow' to a transport antenna when it first appears", () => {
    const { container, rerender } = render(
      <AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />
    );
    rerender(<AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", transports: ["web"] }} />);
    const antenna = container.querySelector('[data-layer="transport-web"]');
    expect(antenna?.getAttribute("data-transition")).toBe("grow");
  });

  it("applies 'dock' to a tool icon when it first appears", () => {
    const { container, rerender } = render(
      <AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />
    );
    rerender(<AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", tools: ["filesystem"] }} />);
    const tool = container.querySelector('[data-layer="tool-filesystem"]');
    expect(tool?.getAttribute("data-transition")).toBe("dock");
  });

  it("applies 'etch' to budget meter when budgets first set", () => {
    const { container, rerender } = render(
      <AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6" }} />
    );
    rerender(<AuggyRenderer loadout={{ ...initialLoadout, engine: "anthropic-opus-4.6", budgets: "default" }} />);
    const meter = container.querySelector('[data-layer="budget-meter"]');
    expect(meter?.getAttribute("data-transition")).toBe("etch");
  });
});
```

- [ ] **Step 2: Run, verify fail**

Run: `bun run test src/components/auggy/__tests__/AuggyRenderer.transitions.test.tsx`
Expected: FAIL — transitions not applied.

- [ ] **Step 3: Update AuggyRenderer to compute transitions from previous loadout**

```tsx
// platform/src/components/auggy/AuggyRenderer.tsx — full replacement
"use client";

import Image from "next/image";
import { useRef } from "react";
import type { AuggyLoadout } from "@/lib/auggy-loadout";
import { ASSETS, headAsset } from "./asset-manifest";

export type AuggyRendererProps = {
  loadout: AuggyLoadout;
};

export function AuggyRenderer({ loadout }: AuggyRendererProps) {
  const prev = useRef<AuggyLoadout | null>(null);
  const previous = prev.current;
  prev.current = loadout;

  const head = headAsset(loadout.engine);
  const headTransition = computeHeadTransition(previous, loadout);

  return (
    <div className="relative w-full aspect-[5/7] bg-[#f5efe2] rounded-lg overflow-hidden">
      <Layer src={ASSETS.chassis} alt="Auggy chassis" name="chassis" />

      {head && loadout.engine && (
        <Layer
          key={loadout.engine}
          src={head}
          alt={`Engine: ${loadout.engine}`}
          name="head"
          dataAttrs={{ "data-engine": loadout.engine, "data-transition": headTransition }}
          style={{ top: "5%", left: "10%", width: "80%", height: "auto" }}
        />
      )}

      {loadout.memory === "layered" && (
        <Layer
          src={ASSETS.memoryOverlay.layered ?? ""}
          alt="Memory: layered"
          name="memory-overlay"
          dataAttrs={previous?.memory !== "layered" ? { "data-transition": "silhouette-shift" } : {}}
          style={{ top: "5%", left: "10%", width: "80%", height: "auto" }}
        />
      )}

      {loadout.transports.map((t) => (
        <Layer
          key={t}
          src={ASSETS.transportLayer[t]}
          alt={`Transport: ${t}`}
          name={`transport-${t}`}
          dataAttrs={!previous?.transports.includes(t) ? { "data-transition": "grow" } : {}}
          style={{ top: "0%", left: "10%", width: "80%", height: "auto" }}
        />
      ))}

      {loadout.tools.map((tool) => (
        <Layer
          key={tool}
          src={ASSETS.toolLayer[tool]}
          alt={`Tool: ${tool}`}
          name={`tool-${tool}`}
          dataAttrs={!previous?.tools.includes(tool) ? { "data-transition": "dock" } : {}}
          style={{ top: "65%", left: "20%", width: "20%", height: "auto" }}
        />
      ))}

      {loadout.budgets && (
        <Layer
          src={ASSETS.budgetMeter}
          alt="Budget meter"
          name="budget-meter"
          dataAttrs={!previous?.budgets ? { "data-transition": "etch" } : {}}
        />
      )}
    </div>
  );
}

function computeHeadTransition(
  previous: AuggyLoadout | null,
  current: AuggyLoadout
): string | undefined {
  if (!current.engine) return undefined;
  if (!previous?.engine) return "paint-on";
  if (previous.engine !== current.engine) return "morph";
  return undefined;
}

type LayerProps = {
  src: string;
  alt: string;
  name: string;
  style?: React.CSSProperties;
  dataAttrs?: Record<string, string | undefined>;
};

function Layer({ src, alt, name, style, dataAttrs }: LayerProps) {
  const cleanedAttrs = Object.fromEntries(
    Object.entries(dataAttrs ?? {}).filter(([, v]) => v !== undefined)
  );
  return (
    <Image
      src={src}
      alt={alt}
      width={400}
      height={560}
      data-layer={name}
      {...cleanedAttrs}
      className="absolute inset-0 w-full h-full object-contain pointer-events-none"
      style={style}
    />
  );
}
```

- [ ] **Step 4: Run all renderer tests, verify pass**

Run: `bun run test src/components/auggy/__tests__/AuggyRenderer`
Expected: PASS for both `AuggyRenderer.test.tsx` and `AuggyRenderer.transitions.test.tsx`.

- [ ] **Step 5: Manual smoke test**

Run: `bun dev`. Visit the page, click engine options. Animations should fire on each pick. Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/components/auggy/AuggyRenderer.tsx src/components/auggy/__tests__/AuggyRenderer.transitions.test.tsx
git commit -m "feat(auggy): wire CSS transitions into AuggyRenderer based on state diff"
```

---

### Task 9: Autoplay walkthrough

A timed sequence that drives the configurator through the 9 beats from the spec. Activated on first page load. Sets `mode: 'autoplay'` while running, switches to `'interactive'` at the end.

**Files:**
- Create: `platform/src/components/auggy/use-autoplay.ts`
- Create: `platform/src/components/auggy/__tests__/use-autoplay.test.ts`
- Modify: `platform/src/components/auggy/Configurator.tsx`

- [ ] **Step 1: Define autoplay beats as data**

```ts
// platform/src/components/auggy/use-autoplay.ts
"use client";

import { useEffect, useRef } from "react";
import type { LoadoutAction } from "@/lib/auggy-loadout";
import type { CategoryId } from "./equip-categories";
import { useConfiguratorStore } from "./configurator-store";

export type AutoplayBeat = {
  atMs: number;
  category?: CategoryId;
  action?: LoadoutAction;
};

export const AUTOPLAY_BEATS: AutoplayBeat[] = [
  { atMs: 0,    category: "engine" }, // beat 1: chassis idle, engine panel ready
  { atMs: 3000, action: { type: "SET_ENGINE", engine: "openai-gpt-5" } }, // beat 2
  { atMs: 8000, action: { type: "SET_ENGINE", engine: "anthropic-opus-4.6" } }, // beat 3 swap
  { atMs: 14000, category: "transports", action: { type: "ADD_TRANSPORT", transport: "web" } }, // beat 4
  { atMs: 17000, category: "memory", action: { type: "SET_MEMORY", memory: "layered" } }, // beat 5
  { atMs: 20000, category: "tools", action: { type: "ADD_TOOL", tool: "filesystem" } }, // beat 6
  { atMs: 23000, category: "budgets", action: { type: "SET_BUDGETS", budgets: "default" } }, // beat 7
];

export const AUTOPLAY_DURATION_MS = 28000;

export function useAutoplay(enabled: boolean) {
  const dispatch = useConfiguratorStore((s) => s.dispatch);
  const setActiveCategory = useConfiguratorStore((s) => s.setActiveCategory);
  const setMode = useConfiguratorStore((s) => s.setMode);
  const reset = useConfiguratorStore((s) => s.reset);
  const timeouts = useRef<ReturnType<typeof setTimeout>[]>([]);

  useEffect(() => {
    if (!enabled) return;
    reset();
    setMode("autoplay");
    timeouts.current = AUTOPLAY_BEATS.map((b) =>
      setTimeout(() => {
        if (b.category) setActiveCategory(b.category);
        if (b.action) dispatch(b.action);
      }, b.atMs)
    );
    const endTimer = setTimeout(() => setMode("interactive"), AUTOPLAY_DURATION_MS);
    timeouts.current.push(endTimer);
    return () => {
      timeouts.current.forEach(clearTimeout);
      timeouts.current = [];
    };
  }, [enabled, dispatch, setActiveCategory, setMode, reset]);
}
```

- [ ] **Step 2: Failing test (verify beats are well-formed and timing is monotonic)**

```ts
// platform/src/components/auggy/__tests__/use-autoplay.test.ts
import { describe, it, expect } from "vitest";
import { AUTOPLAY_BEATS, AUTOPLAY_DURATION_MS } from "../use-autoplay";

describe("autoplay beats", () => {
  it("are monotonic in time", () => {
    for (let i = 1; i < AUTOPLAY_BEATS.length; i++) {
      expect(AUTOPLAY_BEATS[i].atMs).toBeGreaterThan(AUTOPLAY_BEATS[i - 1].atMs);
    }
  });

  it("ends before AUTOPLAY_DURATION_MS", () => {
    const last = AUTOPLAY_BEATS[AUTOPLAY_BEATS.length - 1];
    expect(last.atMs).toBeLessThan(AUTOPLAY_DURATION_MS);
  });

  it("has an engine swap (GPT-5 then Anthropic)", () => {
    const setEngineActions = AUTOPLAY_BEATS
      .filter((b) => b.action?.type === "SET_ENGINE")
      .map((b) => b.action);
    expect(setEngineActions).toEqual([
      { type: "SET_ENGINE", engine: "openai-gpt-5" },
      { type: "SET_ENGINE", engine: "anthropic-opus-4.6" },
    ]);
  });

  it("equips all 5 categories at least once", () => {
    const categories = new Set<string>();
    for (const b of AUTOPLAY_BEATS) {
      if (b.action) {
        switch (b.action.type) {
          case "SET_ENGINE": categories.add("engine"); break;
          case "ADD_TRANSPORT": categories.add("transports"); break;
          case "SET_MEMORY": categories.add("memory"); break;
          case "ADD_TOOL": categories.add("tools"); break;
          case "SET_BUDGETS": categories.add("budgets"); break;
        }
      }
    }
    expect(categories).toEqual(new Set(["engine", "transports", "memory", "tools", "budgets"]));
  });
});
```

- [ ] **Step 3: Run tests, verify pass**

Run: `bun run test src/components/auggy/__tests__/use-autoplay.test.ts`
Expected: PASS (4 tests). The data file already meets the contract.

- [ ] **Step 4: Wire autoplay into Configurator**

```tsx
// platform/src/components/auggy/Configurator.tsx — full replacement
"use client";

import { useState } from "react";
import { AuggyRenderer } from "./AuggyRenderer";
import { EquipPanel } from "./EquipPanel";
import { useConfiguratorStore } from "./configurator-store";
import { useAutoplay } from "./use-autoplay";

export function Configurator() {
  const loadout = useConfiguratorStore((s) => s.loadout);
  const activeCategory = useConfiguratorStore((s) => s.activeCategory);
  const dispatch = useConfiguratorStore((s) => s.dispatch);
  const setActiveCategory = useConfiguratorStore((s) => s.setActiveCategory);
  const mode = useConfiguratorStore((s) => s.mode);
  const [autoplayKey, setAutoplayKey] = useState(0);

  useAutoplay(true);

  const replay = () => setAutoplayKey((k) => k + 1);

  return (
    <div key={autoplayKey} className="flex w-full max-w-5xl mx-auto bg-[#f5efe2] rounded-xl border border-[#d4c5a9] overflow-hidden relative">
      <EquipPanel
        loadout={loadout}
        activeCategory={activeCategory}
        onPick={mode === "interactive" ? dispatch : () => {}}
        onCategoryChange={mode === "interactive" ? setActiveCategory : () => {}}
      />
      <div className="flex-1 p-8 flex items-center justify-center">
        <div className="w-full max-w-md">
          <AuggyRenderer loadout={loadout} />
        </div>
      </div>
      {mode === "interactive" && (
        <button
          type="button"
          onClick={replay}
          className="absolute bottom-4 right-4 text-xs font-mono text-[#5a4a3a] border border-[#d4c5a9] bg-white px-3 py-1 rounded hover:bg-[#fafaf3]"
        >
          ▶ replay
        </button>
      )}
    </div>
  );
}
```

Note: bumping `autoplayKey` remounts the configurator, which re-runs `useAutoplay`. The hook resets the store and replays the beats.

- [ ] **Step 5: Manual smoke test**

Run: `bun dev`. Visit the page. Watch the autoplay sequence run automatically — engine picker opens, GPT-5 equips at 3s, swaps to Anthropic at 8s, augments add through 23s. After ~28s, the replay chip appears and equip panel becomes interactive.

Click `▶ replay` — sequence reruns from scratch.

Stop dev server.

- [ ] **Step 6: Commit**

```bash
git add src/components/auggy/use-autoplay.ts src/components/auggy/__tests__/use-autoplay.test.ts src/components/auggy/Configurator.tsx
git commit -m "feat(auggy): add autoplay walkthrough sequence + replay chip"
```

---

### Task 10: Splash screen

After autoplay finishes, show a brief LORF wordmark splash (beats 8–9). Renders as an overlay that fades in then drops away.

**Files:**
- Create: `platform/src/components/auggy/Splash.tsx`
- Modify: `platform/src/components/auggy/Configurator.tsx`

- [ ] **Step 1: Implement Splash**

```tsx
// platform/src/components/auggy/Splash.tsx
"use client";

import { useEffect, useState } from "react";

export type SplashProps = {
  show: boolean;
  onDone: () => void;
  durationMs?: number;
};

export function Splash({ show, onDone, durationMs = 2000 }: SplashProps) {
  const [visible, setVisible] = useState(show);

  useEffect(() => {
    if (!show) {
      setVisible(false);
      return;
    }
    setVisible(true);
    const t = setTimeout(() => {
      setVisible(false);
      onDone();
    }, durationMs);
    return () => clearTimeout(t);
  }, [show, durationMs, onDone]);

  if (!visible) return null;

  return (
    <div className="absolute inset-0 bg-[#1d1d1f] flex flex-col items-center justify-center z-10 transition-opacity duration-500">
      <div className="font-serif text-3xl font-bold text-[#f5efe2] tracking-wider">LORF</div>
      <div className="font-mono text-xs text-neutral-500 tracking-widest mt-2">AUGGY · 0.2.0</div>
    </div>
  );
}
```

- [ ] **Step 2: Wire splash into autoplay end**

```tsx
// platform/src/components/auggy/Configurator.tsx — extend
"use client";

import { useEffect, useState } from "react";
import { AuggyRenderer } from "./AuggyRenderer";
import { EquipPanel } from "./EquipPanel";
import { Splash } from "./Splash";
import { useConfiguratorStore } from "./configurator-store";
import { useAutoplay, AUTOPLAY_DURATION_MS } from "./use-autoplay";

export function Configurator() {
  const loadout = useConfiguratorStore((s) => s.loadout);
  const activeCategory = useConfiguratorStore((s) => s.activeCategory);
  const dispatch = useConfiguratorStore((s) => s.dispatch);
  const setActiveCategory = useConfiguratorStore((s) => s.setActiveCategory);
  const mode = useConfiguratorStore((s) => s.mode);
  const [autoplayKey, setAutoplayKey] = useState(0);
  const [splashShow, setSplashShow] = useState(false);

  useAutoplay(true);

  // Trigger splash a beat before mode flips to interactive
  useEffect(() => {
    const id = setTimeout(() => setSplashShow(true), AUTOPLAY_DURATION_MS - 2000);
    return () => clearTimeout(id);
  }, [autoplayKey]);

  const replay = () => {
    setSplashShow(false);
    setAutoplayKey((k) => k + 1);
  };

  return (
    <div key={autoplayKey} className="flex w-full max-w-5xl mx-auto bg-[#f5efe2] rounded-xl border border-[#d4c5a9] overflow-hidden relative">
      <EquipPanel
        loadout={loadout}
        activeCategory={activeCategory}
        onPick={mode === "interactive" ? dispatch : () => {}}
        onCategoryChange={mode === "interactive" ? setActiveCategory : () => {}}
      />
      <div className="flex-1 p-8 flex items-center justify-center">
        <div className="w-full max-w-md">
          <AuggyRenderer loadout={loadout} />
        </div>
      </div>
      <Splash show={splashShow} onDone={() => setSplashShow(false)} />
      {mode === "interactive" && !splashShow && (
        <button
          type="button"
          onClick={replay}
          className="absolute bottom-4 right-4 text-xs font-mono text-[#5a4a3a] border border-[#d4c5a9] bg-white px-3 py-1 rounded hover:bg-[#fafaf3]"
        >
          ▶ replay
        </button>
      )}
    </div>
  );
}
```

- [ ] **Step 3: Manual smoke test**

Run: `bun dev`. Visit the page. The autoplay runs to ~26s, then a 2-second LORF splash appears, then drops away to interactive mode with the replay chip visible.

Click replay. Sequence + splash rerun.

Stop dev server.

- [ ] **Step 4: Commit**

```bash
git add src/components/auggy/Splash.tsx src/components/auggy/Configurator.tsx
git commit -m "feat(auggy): add LORF splash screen at the end of autoplay"
```

---

### Task 11: Asset integration milestone

The component is fully functional with placeholder SVG assets. This task swaps in real PNGs once produced. **This task is partially manual** — the rendering work happens in GPT Image 2 outside the codebase. Code changes are limited to filename + dimension updates in `asset-manifest.ts`.

**Files:**
- Modify: `platform/public/auggy-select/*` (replace SVG placeholders with PNGs)
- Modify: `platform/src/components/auggy/asset-manifest.ts` (point to new file extensions)

- [ ] **Step 1: Produce real stills** *(manual workflow, executed by Michael)*

Render targets, one per asset slot in the manifest:
- `chassis.png` — torso shell, no head, chest hex faintly glowing, on cream cyc
- `head-anthropic.png` — orange head with "A" mark and `OPUS 4.6` chin tag
- `head-openai.png` — green head with white knot and `GPT-5` chin tag
- `head-openrouter.png` — cream head with splitting-arrows mark, chin tag with destination model
- `memory-layered-overlay.png` — head silhouette as 3 stacked plates (transparent overlay matched to head dimensions)
- `transport-antenna.png` — antenna grown from top of head
- `tool-wrench.png` — wrench icon for belt slot
- `budget-meter.png` — green arc meter ring around chest hex

Use GPT Image 2 with consistent prompt scaffolding. Optional Nano Banana 2 pass for higher 3D fidelity. Export each as transparent PNG at 2× the displayed size (Retina).

- [ ] **Step 2: Replace placeholders in `public/auggy-select/`**

Drop new PNG files into `platform/public/auggy-select/`. Keep the SVG files alongside (or delete them) — the manifest controls which is used.

- [ ] **Step 3: Update asset-manifest.ts paths**

```ts
// platform/src/components/auggy/asset-manifest.ts — update extensions
export const ASSETS = {
  chassis: "/auggy-select/chassis.png",
  head: {
    "anthropic-opus-4.6": "/auggy-select/head-anthropic.png",
    "openai-gpt-5": "/auggy-select/head-openai.png",
  } as Partial<Record<Engine, string>>,
  headOpenRouterFallback: "/auggy-select/head-openrouter.png",
  memoryOverlay: {
    layered: "/auggy-select/memory-layered-overlay.png",
  } as Partial<Record<Memory, string>>,
  transportLayer: {
    web: "/auggy-select/transport-antenna.png",
    telegram: "/auggy-select/transport-antenna.png",
  } as Record<Transport, string>,
  toolLayer: {
    filesystem: "/auggy-select/tool-wrench.png",
    webFetch: "/auggy-select/tool-wrench.png",
    orgContext: "/auggy-select/tool-wrench.png",
    bash: "/auggy-select/tool-wrench.png",
  } as Record<Tool, string>,
  budgetMeter: "/auggy-select/budget-meter.png",
} as const;
```

- [ ] **Step 4: Run all tests**

Run: `bun run test`
Expected: PASS (no test changes; assertions key off `data-layer` attributes which are unchanged).

- [ ] **Step 5: Manual smoke test**

Run: `bun dev`. Visit the page. Assets should render with the new fidelity. Layer stacking should still align — if alignment is off, adjust the `style` props in `AuggyRenderer.tsx` (top/left/width percentages) until layers compose correctly.

- [ ] **Step 6: Internal viewing checkpoint**

This is the **decision point** from the spec. Watch the autoplay end-to-end with real assets. Verify:

- Body-region states read clearly (chassis-only vs paneled vs with-augment-attached)
- Body-to-augment mapping is intuitive without labels
- Configurator pacing feels right
- Visual fidelity matches Ink reference's polish bar

If yes → proceed to Task 12.
If no → revise storyboard (return to brainstorm) or regenerate stills, no code change required.

- [ ] **Step 7: Commit**

```bash
git add public/auggy-select/ src/components/auggy/asset-manifest.ts
git commit -m "feat(auggy): integrate cinematic-fidelity stills"
```

---

### Task 12: QA polish + final cleanup

End-of-build pass: typecheck, lint, full test suite, manual final review.

**Files:** none new; modifications only as needed.

- [ ] **Step 1: Typecheck**

Run: `bunx tsc --noEmit`
Expected: clean.

- [ ] **Step 2: Lint**

Run: `bun run lint`
Expected: clean (or fix what comes up).

- [ ] **Step 3: Full test suite**

Run: `bun run test`
Expected: PASS — all auggy-related test files plus existing tests untouched.

- [ ] **Step 4: Production build**

Run: `bun run build`
Expected: build succeeds with no warnings about the new route.

- [ ] **Step 5: Manual final review on dev server**

Run: `bun dev`. Visit the page. Run through:

- Initial autoplay end-to-end
- Replay chip works
- Interactive mode: pick each category, swap engines back and forth, add/remove transports
- All animations fire on first state change for each layer
- No console errors

Stop dev server.

- [ ] **Step 6: Commit (only if changes were made during polish)**

```bash
git status  # check if anything was changed
# If yes:
git add -A
git commit -m "chore(auggy): QA polish pass"
```

---

## Self-Review

Spec coverage check (mapping spec sections → tasks):

| Spec section | Implemented in |
|---|---|
| § 1 Vision (web component on `platform/src/app/auggy/select/`) | Tasks 1, 6 |
| § 1 Success criteria — layered assets | Tasks 3, 11 |
| § 1 Success criteria — extensible state machine | Task 2 |
| § 2 Body-region mapping → renderer composes layers | Task 4 |
| § 2 Engine livery (3 brands) | Task 3 (placeholders), Task 5 (categories), Task 11 (real assets) |
| § 2 Chest hex meter independent of brand | Task 4 (separate `budget-meter` layer), Task 11 (asset) |
| § 3 Storyboard 9 beats | Task 9 (autoplay sequence), Task 10 (splash) |
| § 3 Modes (autoplay + interactive + replay) | Task 9 (autoplay + replay), Task 6 (interactive base) |
| § 3 Transition vocabulary (8 transitions) | Task 7 (CSS), Task 8 (state-diff wiring) |
| § 4 Production pipeline (placeholders → real stills) | Tasks 3, 11 |
| § 5 Reusable state shape (Phase 3 wiring delta) | Task 2 |
| § 6 In/out scope | All tasks scope to in-scope items only |
| § 7 Open decisions | Tracked separately in spec; no plan tasks needed |

No gaps identified.

Placeholder scan: searched for "TBD", "TODO", "implement later", "fill in" — none present.

Type consistency: `AuggyLoadout`, `LoadoutAction`, and `applyAction` are referenced consistently from Task 2 onward. `CategoryId` is consistent across Tasks 5–9. Asset manifest keys (`head`, `headOpenRouterFallback`, `memoryOverlay`, `transportLayer`, `toolLayer`, `budgetMeter`, `chassis`) are consistent between Tasks 3, 4, 11.
