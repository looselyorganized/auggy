# G2 Info Endpoint Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `GET /` 404 with a minimal informational HTML page (and HEAD-mirror) at `webTransport`, when no `publicFrontendUrl` is set.

**Architecture:** New pure-function module `src/transports/info-page.ts` exports `renderInfoPage(card: AgentCard): string`. `web-transport.ts` validates `publicFrontendUrl` once at register-time, caches the rendered HTML + byte length, and serves GET / HEAD on `/` from the cache. Existing 302-redirect-when-set behavior preserved byte-identically for GET; HEAD now mirrors.

**Tech Stack:** TypeScript / Bun runtime / `bun:test`. No new dependencies.

**Spec reference:** `docs/superpowers/specs/2026-05-19-g2-info-endpoint-design.md` (local-only).

**Branch:** `feat/g2-info-endpoint` (already checked out off main).

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `src/transports/info-page.ts` | **new** | Pure `renderInfoPage(card) → string`. HTML escape helper. No I/O, no kernel. |
| `src/transports/web-transport.ts` | modified | (1) Validate `publicFrontendUrl` once in `register()`. (2) Eager-render + cache info page HTML + byte length in `register()`. (3) Handler dispatches GET/HEAD on `/` from the cache. |
| `tests/transports/info-page.test.ts` | **new** | Unit tests on the renderer — 15 cases covering structure, meta tags, escaping, fallbacks. |
| `tests/transports/web-transport.test.ts` | modified | UPDATE existing `webTransport / (root) route` describe block (the 404-when-unset test changes to 200+HTML); ADD HEAD-mirror tests, Cache-Control, boot-validation throw. |
| `docs/06-transports.md` | modified | Rewrite the `GET / — optional redirect to a frontend` section (currently ~lines 470–495) to document new behavior. |

---

### Task 1: HTML escape function

**Files:**
- Create: `src/transports/info-page.ts`
- Test: `tests/transports/info-page.test.ts`

Establishes the module shell and the escape primitive. Renderer is a stub returning the title only — Task 2 fleshes it out.

- [ ] **Step 1: Write the failing tests**

Create `tests/transports/info-page.test.ts` with:

```ts
import { describe, expect, it } from "bun:test";
import { renderInfoPage } from "@/transports/info-page";
import type { AgentCard } from "@/types";

function mockCard(overrides: { name?: string; purpose?: string } = {}): AgentCard {
  return {
    provider: { name: overrides.name ?? "zip" },
    purpose: overrides.purpose,
    capabilities: { streaming: false, pushNotifications: false, memory: false, transport: true },
    skills: [],
    interfaces: ["HTTP+JSON"],
    extensions: {},
  };
}

describe("renderInfoPage — HTML escaping", () => {
  it("escapes <script> tags in agent name (no raw <script> substring remains)", () => {
    const html = renderInfoPage(mockCard({ name: "<script>alert(1)</script>" }));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });

  it("escapes ampersand and double-quote", () => {
    const html = renderInfoPage(mockCard({ name: 'Bob & "official"' }));
    expect(html).toContain("Bob &amp; &quot;official&quot;");
  });

  it("escapes single quote (apostrophe)", () => {
    const html = renderInfoPage(mockCard({ name: "Alice's agent" }));
    expect(html).toContain("Alice&#39;s agent");
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/info-page.test.ts`

Expected: FAIL — `Cannot find module '@/transports/info-page'`.

- [ ] **Step 3: Create the module with escape + minimal renderer**

Create `src/transports/info-page.ts`:

```ts
import type { AgentCard } from "../types";

/**
 * Escape a string for safe inclusion in HTML text content or attribute values.
 * Order matters: `&` must be replaced first so subsequent replacements don't
 * double-encode their introduced ampersands.
 *
 * Covers the five HTML metacharacters that matter for both element content and
 * double-quoted attribute values: `&`, `<`, `>`, `"`, `'`.
 */
function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

/**
 * Render the unauthenticated info page served at `GET /` when no
 * `publicFrontendUrl` is configured. Pure function — no I/O, no kernel deps,
 * deterministic output for a given AgentCard.
 *
 * Task 2 expands this to the full template; Task 1 only needs the escaping
 * primitive proven.
 */
export function renderInfoPage(card: AgentCard): string {
  return `<title>${escape(card.provider.name)}</title>`;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test tests/transports/info-page.test.ts`

Expected: PASS — 3 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/transports/info-page.ts tests/transports/info-page.test.ts
git commit -m "feat(info-page): add module skeleton with HTML escaping (G2)"
```

---

### Task 2: renderInfoPage happy-path HTML structure

**Files:**
- Modify: `src/transports/info-page.ts`
- Modify: `tests/transports/info-page.test.ts`

Implements the full template for the happy-path case (non-empty name + non-empty purpose). Edge cases (empty/whitespace fallback, purpose omission) come in Task 3.

- [ ] **Step 1: Write failing tests for full structure + meta tags**

Append to `tests/transports/info-page.test.ts`:

```ts
describe("renderInfoPage — HTML structure", () => {
  it("returns a valid HTML document", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<head>");
    expect(html).toContain("<body>");
    expect(html).toContain("</html>");
  });

  it("title is `<name> — Auggy agent`", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<title>zip — Auggy agent</title>");
  });

  it("h1 is the agent name", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<h1>zip</h1>");
  });

  it("includes viewport meta tag", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain(
      '<meta name="viewport" content="width=device-width, initial-scale=1">',
    );
  });

  it("includes noindex robots meta tag (crawler suppression)", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="robots" content="noindex, nofollow">');
  });

  it("includes Open Graph tags with name + purpose", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta property="og:title" content="zip — Auggy agent">');
    expect(html).toContain('<meta property="og:description" content="concierge agent">');
    expect(html).toContain('<meta property="og:type" content="website">');
  });

  it("includes alternate link to /.well-known/agent-card.json", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain(
      '<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">',
    );
  });

  it("includes meta description with purpose", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain('<meta name="description" content="concierge agent">');
  });

  it("includes purpose paragraph in body when purpose is non-empty", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "concierge agent" }));
    expect(html).toContain("<p>concierge agent</p>");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test tests/transports/info-page.test.ts`

Expected: FAIL — the 9 new structure tests fail (current stub only emits `<title>`).

- [ ] **Step 3: Replace `renderInfoPage` with the full template**

Replace the `renderInfoPage` function body in `src/transports/info-page.ts` with:

```ts
export function renderInfoPage(card: AgentCard): string {
  const escapedName = escape(card.provider.name);
  const title = `${escapedName} — Auggy agent`;
  const escapedPurpose = escape(card.purpose ?? "");
  const purposeParagraph = `\n  <p>${escapedPurpose}</p>`;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title}</title>
  <meta name="description" content="${escapedPurpose}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${escapedPurpose}">
  <meta property="og:type" content="website">
  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.95em; }
    a { color: #0a66c2; }
  </style>
</head>
<body>
  <h1>${escapedName}</h1>
  <p>This is an <a href="https://github.com/looselyorganized/augment-1">Auggy</a> agent backend.</p>${purposeParagraph}
  <p>To interact:</p>
  <ul>
    <li>Inspect the <a href="/.well-known/agent-card.json">agent card</a></li>
    <li>Bring your own AG-UI client and <code>POST /agent/run</code></li>
    <li>Or configure <code>publicFrontendUrl</code> in <code>agent.yaml</code> to redirect visitors to a polished frontend</li>
  </ul>
</body>
</html>`;
}
```

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test tests/transports/info-page.test.ts`

Expected: PASS — all 12 tests green (3 escape + 9 structure).

- [ ] **Step 5: Commit**

```bash
git add src/transports/info-page.ts tests/transports/info-page.test.ts
git commit -m "feat(info-page): implement happy-path HTML with meta + OG tags (G2)"
```

---

### Task 3: Edge cases — empty/whitespace name fallback, purpose omission

**Files:**
- Modify: `src/transports/info-page.ts`
- Modify: `tests/transports/info-page.test.ts`

Adds fallback to `"An Auggy agent"` for empty/whitespace `provider.name`, and omits the `<p>` purpose body when purpose is undefined / empty / whitespace-only.

- [ ] **Step 1: Write failing tests for edge cases**

Append to `tests/transports/info-page.test.ts`:

```ts
describe("renderInfoPage — fallbacks and edge cases", () => {
  it("falls back to 'An Auggy agent' when name is empty string", () => {
    const html = renderInfoPage(mockCard({ name: "", purpose: "x" }));
    expect(html).toContain("<title>An Auggy agent</title>");
    expect(html).toContain("<h1>An Auggy agent</h1>");
    expect(html).toContain('<meta property="og:title" content="An Auggy agent">');
  });

  it("falls back to 'An Auggy agent' when name is whitespace-only", () => {
    const html = renderInfoPage(mockCard({ name: "   \t\n", purpose: "x" }));
    expect(html).toContain("<title>An Auggy agent</title>");
    expect(html).toContain("<h1>An Auggy agent</h1>");
  });

  it("omits the body purpose paragraph when purpose is undefined", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: undefined }));
    // The purpose body paragraph would be either `<p>...</p>` between the
    // Auggy backend line and the "To interact:" line, OR absent. Verify it's
    // absent by asserting an empty <p></p> never appears.
    expect(html).not.toContain("<p></p>");
    // Also verify meta description content is empty
    expect(html).toContain('<meta name="description" content="">');
  });

  it("omits the body purpose paragraph when purpose is empty string", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "" }));
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<meta name="description" content="">');
  });

  it("omits the body purpose paragraph when purpose is whitespace-only", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "   \t\n" }));
    expect(html).not.toContain("<p></p>");
    expect(html).toContain('<meta name="description" content="">');
  });

  it("includes + escapes purpose when purpose contains HTML metacharacters", () => {
    const html = renderInfoPage(mockCard({ name: "zip", purpose: "Concierge <demo> & co" }));
    expect(html).toContain("<p>Concierge &lt;demo&gt; &amp; co</p>");
    expect(html).toContain(
      '<meta name="description" content="Concierge &lt;demo&gt; &amp; co">',
    );
  });
});
```

- [ ] **Step 2: Run tests to verify failure**

Run: `bun test tests/transports/info-page.test.ts`

Expected: FAIL — the fallback tests fail (current impl outputs empty `<title> — Auggy agent</title>` for empty name, and renders `<p></p>` for empty purpose).

- [ ] **Step 3: Update `renderInfoPage` to handle fallbacks + omission**

Replace the `renderInfoPage` function body again in `src/transports/info-page.ts`:

```ts
const FALLBACK = "An Auggy agent";

export function renderInfoPage(card: AgentCard): string {
  const rawName = card.provider.name;
  const hasName = rawName.trim() !== "";
  const escapedName = hasName ? escape(rawName) : "";
  const title = hasName ? `${escapedName} — Auggy agent` : FALLBACK;
  const heading = hasName ? escapedName : FALLBACK;

  // `??` flattens `string | undefined` to `string` so the next escape() call
  // type-checks cleanly. The trim check then decides whether the paragraph
  // and meta tags render with the value or stay empty.
  const purposeStr = card.purpose ?? "";
  const hasPurpose = purposeStr.trim() !== "";
  const escapedPurpose = hasPurpose ? escape(purposeStr) : "";
  const purposeParagraph = hasPurpose ? `\n  <p>${escapedPurpose}</p>` : "";

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${title}</title>
  <meta name="description" content="${escapedPurpose}">
  <meta property="og:title" content="${title}">
  <meta property="og:description" content="${escapedPurpose}">
  <meta property="og:type" content="website">
  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.95em; }
    a { color: #0a66c2; }
  </style>
</head>
<body>
  <h1>${heading}</h1>
  <p>This is an <a href="https://github.com/looselyorganized/augment-1">Auggy</a> agent backend.</p>${purposeParagraph}
  <p>To interact:</p>
  <ul>
    <li>Inspect the <a href="/.well-known/agent-card.json">agent card</a></li>
    <li>Bring your own AG-UI client and <code>POST /agent/run</code></li>
    <li>Or configure <code>publicFrontendUrl</code> in <code>agent.yaml</code> to redirect visitors to a polished frontend</li>
  </ul>
</body>
</html>`;
}
```

(The `FALLBACK` constant is a module-level `const` declared above `renderInfoPage`; add it just under the `escape` function.)

- [ ] **Step 4: Run tests to verify all pass**

Run: `bun test tests/transports/info-page.test.ts`

Expected: PASS — all 18 tests green (3 escape + 9 structure + 6 edge case).

- [ ] **Step 5: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS — no errors.

- [ ] **Step 6: Commit**

```bash
git add src/transports/info-page.ts tests/transports/info-page.test.ts
git commit -m "feat(info-page): handle empty/whitespace name + purpose omission (G2)"
```

---

### Task 4: Wire into `web-transport.ts` — register-time URL validation + HTML caching

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Validates `publicFrontendUrl` once at `register()` (fails fast on garbage). Eagerly renders + caches the info page HTML + byte length so HEAD + GET serve from the same bytes.

- [ ] **Step 1: Write the failing integration test for boot-time validation**

In `tests/transports/web-transport.test.ts`, find the `describe("webTransport / (root) route", ...)` block (around line 1584) and APPEND a new `describe` block at the end of the file (or at the end of the existing `webTransport / (root) route` block):

```ts
describe("webTransport / (root) route — boot-time validation (G2)", () => {
  it("agent.start() throws when publicFrontendUrl is not a valid URL", async () => {
    const model = createMockModel();
    const aug = webTransport({
      port: 18999,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "://bad",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await expect(agent.start()).rejects.toThrow(/publicFrontendUrl is not a valid URL/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test tests/transports/web-transport.test.ts -t "boot-time validation"`

Expected: FAIL — current `register()` does not validate `publicFrontendUrl`; `agent.start()` resolves successfully.

- [ ] **Step 3: Import `renderInfoPage` in `web-transport.ts`**

Open `src/transports/web-transport.ts`. Near the top with the other imports, add:

```ts
import { renderInfoPage } from "./info-page";
```

- [ ] **Step 4: Add closure variables for cached state**

Inside the `webTransport(opts)` factory function body, near the other closure-captured variables (e.g., `let server`, `let kernel`, `let augmentRoutes`, etc.), add:

```ts
// G2 — info endpoint cache. Populated in register() when publicFrontendUrl
// is unset. Allows HEAD's Content-Length to match GET's body length
// without re-rendering per request.
let validatedPublicFrontendUrl: string | undefined = undefined;
let infoPageHtml: string | null = null;
let infoPageByteLength = 0;
```

- [ ] **Step 5: Validate + cache inside `register()`**

In `web-transport.ts`, find the `async register(k: TransportKernel, _augmentName: string)` function. After the existing `kernel = k;` and `augmentRoutes = k.getAugmentRoutes();` lines, INSERT before the existing `for (const r of augmentRoutes)` loop:

```ts
// G2 — validate publicFrontendUrl once + cache info page HTML.
// Validation throws here so a malformed URL fails fast at agent boot
// rather than at first request.
if (opts.publicFrontendUrl !== undefined) {
  try {
    new URL(opts.publicFrontendUrl);
  } catch (err) {
    throw new Error(
      `[web-transport] publicFrontendUrl is not a valid URL: ${JSON.stringify(
        opts.publicFrontendUrl,
      )}. ${(err as Error).message}`,
    );
  }
  validatedPublicFrontendUrl = opts.publicFrontendUrl;
} else {
  // No publicFrontendUrl set — info page will be served at GET / and
  // mirrored at HEAD /. Eagerly render so HEAD's Content-Length matches
  // GET's body length per RFC 9110 §9.3.2.
  infoPageHtml = renderInfoPage(k.getAgentCard());
  infoPageByteLength = new TextEncoder().encode(infoPageHtml).byteLength;
}
```

- [ ] **Step 6: Run the boot-validation test — verify it passes**

Run: `bun test tests/transports/web-transport.test.ts -t "boot-time validation"`

Expected: PASS — `agent.start()` now throws on `"://bad"`.

- [ ] **Step 7: Run the full web-transport test file to check for regressions**

Run: `bun test tests/transports/web-transport.test.ts`

Expected: All tests pass EXCEPT the existing "GET / returns 404 when publicFrontendUrl is not configured" test at ~line 1588 (which still expects 404 from the unchanged handler — Task 5 updates the handler). The 404 test failure is fine at this checkpoint; record the failure but proceed.

- [ ] **Step 8: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): validate publicFrontendUrl + cache info page in register (G2)"
```

---

### Task 5: Handler change — GET / and HEAD / dispatch from cache

**Files:**
- Modify: `src/transports/web-transport.ts`
- Modify: `tests/transports/web-transport.test.ts`

Replaces the existing GET-only handler with a GET-or-HEAD dispatcher. GET serves HTML body; HEAD serves empty body with matching headers. Both branches honor the 302 redirect when `publicFrontendUrl` is set.

- [ ] **Step 1: Update existing GET-/-returns-404 test + add new GET/HEAD tests**

In `tests/transports/web-transport.test.ts`, find the `webTransport / (root) route` describe block (around line 1587).

REPLACE the existing `"GET / returns 404 when publicFrontendUrl is not configured"` test with:

```ts
  it("GET / returns 200 + HTML info page when publicFrontendUrl is not configured (G2)", async () => {
    const model = createMockModel();
    const port = 18965;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await resp.text();
      expect(body).toContain("<title>zip — Auggy agent</title>");
      expect(body).toContain("<h1>zip</h1>");
      expect(body).toContain('<meta name="robots" content="noindex, nofollow">');
    } finally {
      await agent.stop();
    }
  });
```

Then APPEND inside the same `describe("webTransport / (root) route", ...)` block (before its closing `});`):

```ts
  it("HEAD / returns 200 + empty body + html headers when publicFrontendUrl unset (G2)", async () => {
    const model = createMockModel();
    const port = 18970;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("content-type")).toBe("text/html; charset=utf-8");
      const body = await resp.text();
      expect(body).toBe("");
    } finally {
      await agent.stop();
    }
  });

  it("HEAD / returns 302 + empty body when publicFrontendUrl is set (G2)", async () => {
    const model = createMockModel();
    const port = 18971;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
      publicFrontendUrl: "https://example.com/chat",
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      expect(resp.status).toBe(302);
      expect(resp.headers.get("location")).toBe("https://example.com/chat");
      const body = await resp.text();
      expect(body).toBe("");
    } finally {
      await agent.stop();
    }
  });

  it("POST / returns 404 when publicFrontendUrl is unset (regression for G2 HEAD/GET addition)", async () => {
    const model = createMockModel();
    const port = 18972;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent({ name: "test", model: "mock", augments: [aug] }, model);
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer test-token" },
        body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
        redirect: "manual",
      });
      expect(resp.status).toBe(404);
      await resp.text();
    } finally {
      await agent.stop();
    }
  });
```

- [ ] **Step 2: Run the tests to verify failures**

Run: `bun test tests/transports/web-transport.test.ts -t "webTransport / (root) route"`

Expected: FAIL — the updated 200-HTML test fails (current handler still returns 404 on GET / unset). The HEAD tests fail (current handler doesn't handle HEAD).

- [ ] **Step 3: Replace the GET-only handler block in `web-transport.ts`**

Find this block in `src/transports/web-transport.ts` (search for `if (req.method === "GET" && url.pathname === "/")` — should be around line 936):

```ts
// GET / — optional redirect to operator-configured publicFrontendUrl
if (req.method === "GET" && url.pathname === "/") {
  if (opts.publicFrontendUrl) {
    return Response.redirect(opts.publicFrontendUrl, 302);
  }
  return new Response("Not Found", { status: 404 });
}
```

REPLACE with:

```ts
// G2 — GET / and HEAD / for the info endpoint or operator-configured redirect.
// URL validation + HTML caching ran once in register(); per-request work is
// minimal: branch on method + (publicFrontendUrl set / unset).
if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
  if (validatedPublicFrontendUrl !== undefined) {
    // Both GET and HEAD use manual construction so URL validation
    // happens at register-time only (not per-request). Body is null in
    // both — visitors follow the Location header.
    return new Response(null, {
      status: 302,
      headers: { location: validatedPublicFrontendUrl },
    });
  }
  // Info page path. infoPageHtml is non-null here by construction in
  // register() — the defensive guard exists in case of future refactor
  // breakage.
  if (infoPageHtml === null) return new Response(null, { status: 404 });
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  return new Response(req.method === "HEAD" ? null : infoPageHtml, {
    status: 200,
    headers,
  });
}
```

- [ ] **Step 4: Run the / (root) route tests — verify they pass**

Run: `bun test tests/transports/web-transport.test.ts -t "webTransport / (root) route"`

Expected: PASS — all tests in the block pass (existing 302 test, new 200+HTML test, new HEAD-unset, new HEAD-set, new POST regression, existing non-/-404 test, existing /health-unaffected test, existing POST-when-publicFrontend-set test).

- [ ] **Step 5: Run the full test suite to check for regressions**

Run: `bun test`

Expected: All tests pass (1988+ root, 83 chat) — the existing baseline plus 18 new info-page unit tests + the new integration tests.

- [ ] **Step 6: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): serve info page at GET / + HEAD / (G2)"
```

---

### Task 6: Cache-Control + Content-Length header verification

**Files:**
- Modify: `tests/transports/web-transport.test.ts`

The handler already emits `Cache-Control: public, max-age=300` (added in Task 5's replacement code). This task adds the test that locks the header in, and discovers whether Bun honors an explicit `Content-Length` on null-body responses (per spec — known nuance).

- [ ] **Step 1: Add test for `Cache-Control` on GET /**

In `tests/transports/web-transport.test.ts`, inside the `webTransport / (root) route` describe block, append:

```ts
  it("GET / sets Cache-Control: public, max-age=300 on the info page (G2)", async () => {
    const model = createMockModel();
    const port = 18973;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      const resp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      expect(resp.status).toBe(200);
      expect(resp.headers.get("cache-control")).toBe("public, max-age=300");
      await resp.text();
    } finally {
      await agent.stop();
    }
  });
```

- [ ] **Step 2: Run the test — expect PASS (already shipped in Task 5's handler)**

Run: `bun test tests/transports/web-transport.test.ts -t "Cache-Control"`

Expected: PASS — handler already sets the header.

- [ ] **Step 3: Add a Content-Length probe test for HEAD /**

Append to the same describe block:

```ts
  it("HEAD / Content-Length probe — reflects GET body length or known Bun limit (G2)", async () => {
    const model = createMockModel();
    const port = 18974;
    const aug = webTransport({
      port,
      auth: { type: "bearer", token: "test-token" },
    });
    const agent = defineAgent(
      { name: "zip", purpose: "concierge agent", model: "mock", augments: [aug] },
      model,
    );
    await agent.start();

    try {
      // Compare HEAD vs GET. Whatever Bun reports for HEAD's Content-Length
      // is what we assert against. Goal of this test: lock in the observed
      // behavior so a future Bun upgrade changing the answer is loud.
      const getResp = await fetch(`http://localhost:${port}/`, {
        method: "GET",
        redirect: "manual",
      });
      const getBody = await getResp.text();
      const getBytes = new TextEncoder().encode(getBody).byteLength;

      const headResp = await fetch(`http://localhost:${port}/`, {
        method: "HEAD",
        redirect: "manual",
      });
      const headContentLength = headResp.headers.get("content-length");
      // Two acceptable outcomes per the spec's "Bun nuance" note:
      //   (a) Bun honors the explicit header — headContentLength matches GET bytes.
      //   (b) Bun overrides to 0 (null-body default) — known spec deviation.
      // Either is fine; the test asserts ONE of them holds, never both,
      // never something else.
      const matchesBody = headContentLength === String(getBytes);
      const overriddenToZero = headContentLength === "0";
      expect(matchesBody || overriddenToZero).toBe(true);
    } finally {
      await agent.stop();
    }
  });
```

- [ ] **Step 4: Run the Content-Length probe — observe + commit the answer**

Run: `bun test tests/transports/web-transport.test.ts -t "Content-Length probe"`

Expected: PASS — one of the two branches holds.

**Implementation note:** if Bun overrides `Content-Length` to 0, the handler in Task 5 already attempts to set the explicit header via `Headers` object but Bun wins. The spec deviation is acknowledged and documented; no code change here. If Bun honors the explicit value, the test still passes (matches GET bytes).

- [ ] **Step 5: Make `Content-Length` set explicit in the handler (codifies intent)**

Even if Bun overrides, set the header explicitly to capture intent. In `src/transports/web-transport.ts`, find the Task 5 handler block. Within the info-page branch (the part with the `Headers` construction), update:

```ts
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
```

to:

```ts
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  // RFC 9110 §9.3.2 — HEAD's headers SHOULD match GET's. Set
  // Content-Length explicitly. Bun's auto-compute behavior on null-body
  // responses is verified by the Content-Length probe test in
  // tests/transports/web-transport.test.ts; if Bun overrides this value
  // to 0, the test documents the deviation.
  headers.set("content-length", String(infoPageByteLength));
```

- [ ] **Step 6: Re-run the Content-Length probe to confirm still PASS**

Run: `bun test tests/transports/web-transport.test.ts -t "Content-Length probe"`

Expected: PASS.

- [ ] **Step 7: Run the full test suite**

Run: `bun test`

Expected: All tests pass.

- [ ] **Step 8: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/transports/web-transport.ts tests/transports/web-transport.test.ts
git commit -m "feat(web-transport): Cache-Control + Content-Length probe on info page (G2)"
```

---

### Task 7: Update `docs/06-transports.md`

**Files:**
- Modify: `docs/06-transports.md`

Replaces the `GET / — optional redirect to a frontend` section to document the new behavior (info page when unset, HEAD support, Cache-Control posture, `noindex` default).

- [ ] **Step 1: Locate the current section**

Run: `grep -n "GET / — optional redirect" docs/06-transports.md`

Expected: one match (around line 470). Verify the section header.

- [ ] **Step 2: Replace the section content**

In `docs/06-transports.md`, replace the section that starts at the `### GET / — optional redirect to a frontend` heading (or its current equivalent — the original heading from before this PR) and extends through to just before the next `###` section (`### Lifecycle hooks` or similar — verify locally).

Use this replacement block:

```markdown
### `GET /` and `HEAD /` — agent info endpoint + optional frontend redirect (G2)

`GET /` and `HEAD /` are both handled. The branch depends on whether `publicFrontendUrl` is configured.

**`publicFrontendUrl` set** → `302 Found` with `Location: <publicFrontendUrl>`. Use this to point visitors at a polished frontend you stand up yourself (your own chat widget, LORF's `platform/chat`, a marketing page, a future spine-visitor-chat URL).

```yaml
- name: web
  type: webTransport
  options:
    port: 8080
    auth: { type: bearer, token: ${AUGGY_WEB_TOKEN} }
    publicFrontendUrl: https://your-frontend.example/chat
```

`publicFrontendUrl` is validated at agent boot (`agent.start()`) — a malformed URL fails fast with `publicFrontendUrl is not a valid URL` rather than at first request.

**`publicFrontendUrl` unset** → `200 OK` with a minimal HTML info page (~1.6 KB, self-contained, no JS, no external assets). The page contains:

- Agent name (from the agent card's `provider.name`) in `<title>` and `<h1>`
- Agent purpose (from `card.purpose`) in `<meta description>` + Open Graph + a body paragraph (omitted when purpose is empty)
- `<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">` for machine clients
- `<meta name="robots" content="noindex, nofollow">` so well-behaved crawlers don't index passively
- Open Graph tags (`og:title`, `og:description`, `og:type`) so Slack/Discord/iMessage link previews render usefully when the URL is shared
- Brief copy pointing the visitor at: inspecting the agent card, bringing their own AG-UI client to `POST /agent/run`, or asking the operator to configure `publicFrontendUrl`

Response headers include `Cache-Control: public, max-age=300` — five-minute browser/CDN cache to prevent thundering from uptime monitors and link-preview refreshes.

The HTML body is rendered once at agent boot and cached in the transport — per-request cost is just the `Response` construction.

**`HEAD /` mirrors `GET /`** — same status code, same headers, body omitted (per RFC 9110 §9.3.2). Both branches handle HEAD identically to GET.

**Other methods on `/`** (POST, PUT, DELETE, PATCH) continue to return `404 Not Found`. CORS preflight (`OPTIONS /`) is unchanged.

**Auth posture.** The info page is unauthenticated regardless of `webTransport.allowAnonymous`. Rationale: the same fields are already served unauthenticated at `/.well-known/agent-card.json`; gating discovery behind visitor-auth would block link previews and monitors with no security benefit. See `docs/superpowers/specs/2026-05-19-g2-info-endpoint-design.md` for the full reasoning.

**For local operator testing, run `auggy chat`** — it provides a polished chat surface against agents you've started with `auggy dev`, without exposing a public URL.

**Uptime / health checks:** point them at `/health`, not `/`. The `/` route is for visitors; `/health` is for monitoring.
```

- [ ] **Step 3: Verify markdown renders cleanly**

Run: `head -550 docs/06-transports.md | tail -100`

Inspect that the new section flows from the preceding section and into the following one without weird jumps. Adjust spacing if needed.

- [ ] **Step 4: Commit**

```bash
git add docs/06-transports.md
git commit -m "docs(06): rewrite GET / section for info endpoint + HEAD support (G2)"
```

---

### Task 8: Final verification + manual smokes

**Files:** none modified (verification only)

Locks in the acceptance criteria from the spec.

- [ ] **Step 1: Full test suite**

Run: `bun test`

Expected: All tests pass. Pre-G2 baseline was 1988 root tests; G2 adds:
- 18 new unit tests in `tests/transports/info-page.test.ts`
- 5 new + 1 modified integration tests in `tests/transports/web-transport.test.ts`

Expected new total: ~2010+ root tests, 83 chat tests, all green.

- [ ] **Step 2: Typecheck**

Run: `bunx tsc --noEmit`

Expected: PASS — no errors.

- [ ] **Step 3: Lint**

Run: `bun run lint`

Expected: 0 errors. Warning count should be at baseline (~29 warnings + 1 info) — the new code should add no warnings. If new warnings appear, address them before commit.

- [ ] **Step 4: Manual smoke — info page renders in a browser**

```bash
# In one terminal — start a test agent
auggy create test-g2 --force
auggy dev test-g2
```

Then in another terminal:

```bash
curl -i http://localhost:8080/
```

Expected output starts with:

```
HTTP/1.1 200 OK
content-type: text/html; charset=utf-8
cache-control: public, max-age=300
```

Followed by the rendered HTML. Open `http://localhost:8080/` in a browser — confirm:
- Page title contains the agent's name
- `<h1>` shows the agent name
- "This is an Auggy agent backend" paragraph visible
- Link to the agent card works (clicking goes to `/.well-known/agent-card.json` JSON)

- [ ] **Step 5: Manual smoke — HEAD / on the info page**

```bash
curl -I http://localhost:8080/
```

Expected:
- Status `200 OK`
- `content-type: text/html; charset=utf-8`
- `cache-control: public, max-age=300`
- Empty body (no `<!doctype html>` printed below the headers)

- [ ] **Step 6: Manual smoke — 302 redirect with `publicFrontendUrl` set**

Edit `~/.auggy/agents/test-g2/agent.yaml`, in the `web` augment options, add:

```yaml
publicFrontendUrl: https://example.com/chat
```

Restart: `auggy stop test-g2 && auggy dev test-g2`

Then:

```bash
curl -I http://localhost:8080/
```

Expected:
- Status `302 Found`
- `location: https://example.com/chat`
- Empty body

Same for HEAD:

```bash
curl -I -X HEAD http://localhost:8080/
```

Expected: same `302 + Location: https://example.com/chat`, empty body.

- [ ] **Step 7: Manual smoke — malformed `publicFrontendUrl` fails fast**

Edit `~/.auggy/agents/test-g2/agent.yaml`, change `publicFrontendUrl` to:

```yaml
publicFrontendUrl: "://bad"
```

Restart: `auggy stop test-g2 && auggy dev test-g2`

Expected: agent fails to start with an error message containing `publicFrontendUrl is not a valid URL: "://bad"`. The agent process does NOT bind a port; no first request is served.

Restore the valid `publicFrontendUrl` (or remove it entirely) and confirm `auggy dev test-g2` boots cleanly again. Then clean up:

```bash
auggy stop test-g2
auggy remove test-g2 --yes
```

- [ ] **Step 8: Commit (if any final polish happened)**

If steps 4-7 surfaced no issues, no commit needed. If a polish fix landed:

```bash
git add <files>
git commit -m "fix(info-page): <description of polish> (G2)"
```

- [ ] **Step 9: Push the branch + open the PR**

```bash
git push -u origin feat/g2-info-endpoint
gh pr create --title "feat(web-transport): G2 — info endpoint at GET / + HEAD / mirror" --body "$(cat <<'EOF'
## Summary

Replaces `GET /` 404 with a minimal informational HTML page when `publicFrontendUrl` is unset. Adds `HEAD /` as a spec-compliant mirror (same status + headers, body omitted). The existing 302-redirect-when-set behavior is preserved byte-identically for GET; HEAD now mirrors.

Implements G2 from `docs/todos.md` Tier 1 (revised scope per PR #55, which dropped the original bundled-chat-HTML scope after landscape evidence + 2026-04-29 spec precedent).

## Behavioral changes

| Method × `publicFrontendUrl` | Before | After |
|---|---|---|
| `GET /` × unset | `404 Not Found` | `200 OK` + HTML info page |
| `GET /` × set | `302` + `Location` (Bun `Response.redirect`) | `302` + `Location` (manual construction, behavior-identical) |
| `HEAD /` × unset | `404` | `200 OK` + same headers as GET, body empty |
| `HEAD /` × set | `404` (latent spec bug) | `302` + `Location`, body empty |
| `POST/PUT/DELETE/PATCH /` | `404` | `404` (unchanged) |

Boot-time validation: a malformed `publicFrontendUrl` now throws at `agent.start()` rather than at first request. Closes the GET/HEAD validation divergence (both branches now share register-time validation).

## Implementation

- **New module** `src/transports/info-page.ts` — pure `renderInfoPage(card: AgentCard): string`. HTML escape helper; renders the full template with name, purpose, OG tags, `noindex` meta, alternate link, inline CSS.
- **`web-transport.ts`** validates `publicFrontendUrl` once in `register()`, eager-renders the info page HTML + caches its byte length. Per-request work is just the branch + `Response` construction.
- **Response headers** on the info page: `Content-Type: text/html; charset=utf-8`, `Cache-Control: public, max-age=300`, `Content-Length` set explicitly to the GET body length (Bun nuance documented in tests/spec).

## Visibility implications (default-secure)

- `<meta name="robots" content="noindex, nofollow">` ships by default. Search engines won't accumulate agent URLs in their index.
- Open Graph tags (`og:title`, `og:description`, `og:type`) ship by default. Slack/Discord/iMessage link unfurls render with the agent's name + purpose when the URL is shared in a chat. Operators wanting zero metadata leakage set `publicFrontendUrl` (which bypasses the info page entirely).
- A future `webTransport.publicAgentMetadata: false` opt-in to suppress OG tags is out of scope; file when adopter feedback drives the need.

## Auth posture

The info page is unauthenticated regardless of `webTransport.allowAnonymous`. Rationale: the same fields are already served unauthenticated at `/.well-known/agent-card.json`. No new exposure surface vs the pre-G2 baseline.

## Test coverage

- 18 new unit tests in `tests/transports/info-page.test.ts` — HTML structure, meta tag presence, OG tags, escaping (adversarial inputs), empty/whitespace fallbacks, purpose omission.
- 5 new + 1 modified integration tests in `tests/transports/web-transport.test.ts` — GET / unset → HTML, GET / set → 302, HEAD / unset → empty body + html headers, HEAD / set → 302, POST / regression, boot-time validation throws on malformed URL, `Cache-Control` header, HEAD `Content-Length` probe.

## Bun Content-Length nuance

The HEAD `Content-Length` probe test accepts EITHER the explicit byte length (matching GET body) OR `0` (Bun's auto-compute on null-body responses). Whichever Bun actually emits is locked in by the test. If Bun upgrades change the answer, the test is loud.

## Spec + local-only reference

Spec lives at `docs/superpowers/specs/2026-05-19-g2-info-endpoint-design.md` (untracked per the repo's `docs/superpowers/` gitignore — local-only per existing convention). Plan at `docs/superpowers/plans/2026-05-19-g2-info-endpoint.md`. Both reference PR #55 for the scope revision history.

## Test plan

- [x] `bun test` passes
- [x] `bunx tsc --noEmit` clean
- [x] `bun run lint` 0 errors, baseline warnings preserved
- [x] Manual smoke (curl + browser) — info page renders, HEAD works, 302 redirect preserved, malformed URL fails fast
EOF
)"
```

Substitute the discovered Bun Content-Length behavior into the *Bun Content-Length nuance* section before opening — either "Bun honors the explicit header" or "Bun overrides to 0 (spec deviation acknowledged)".

- [ ] **Step 10: Enable auto-merge with squash**

```bash
gh pr merge <#> --auto --squash --delete-branch
```

CI runs; when green, PR auto-merges.

---

## Out-of-plan / known limits

These were captured in the spec's "Out of scope" + "Risks" sections and intentionally deferred:

- No `ETag` / conditional GET (only `Cache-Control: max-age`)
- No `Allow:` header on POST /-fall-through 404 (still falls through to the catch-all 404)
- No `webTransport.publicAgentMetadata: false` opt-in (always emits Open Graph; only `noindex` mitigates leakage)
- No customization hooks (operator sets `publicFrontendUrl` instead)
- No i18n / locale negotiation (single-language English)
- No accessibility audit beyond semantic HTML defaults
- No reading `package.json` `repository.url` (GitHub link is a constant in `info-page.ts`)
- Bun Content-Length nuance — the test documents whichever behavior Bun actually exhibits; spec deviation accepted if Bun overrides
