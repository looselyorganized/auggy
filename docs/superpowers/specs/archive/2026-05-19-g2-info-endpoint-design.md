---
title: "G2 — Minimal info endpoint at GET /"
type: design
category: feature
date: 2026-05-19
status: approved
domain:
  - transports
  - web-transport
  - oss-launch
relates_to:
  - lo/docs/superpowers/specs/2026-04-29-auggy-chat-design
roadmap_phase: pre-v0
---

## Context

When `publicFrontendUrl` is unset, `webTransport`'s `GET /` currently returns `404 Not Found` (`src/transports/web-transport.ts:937–942`). This means a visitor who lands on the agent's bare URL — e.g. typing `https://my-agent.example/` into a browser — sees a generic "Not Found" with no signal that they've actually reached a working agent backend.

This spec replaces the 404 with a minimal informational HTML page. Self-contained, unauthenticated, ~1.5 KB, no JS, no external assets.

### Reversal record — what this is NOT

The earlier scope (`docs/todos.md` G2, filed 2026-05-14) was *"bake a minimal /chat HTML page into webTransport"* — a bundled visitor chat UI. That scope was reconsidered + rejected on 2026-05-19 after a head-of-product landscape scan; the reasoning is captured in PR #55's body. Two arguments drove the reversal:

1. **It contradicted the 2026-04-29 chat-design spec.** Line 44 of [`lo/docs/superpowers/specs/2026-04-29-auggy-chat-design.md`](../../../../docs/superpowers/specs/2026-04-29-auggy-chat-design.md) had already decided *"`/` simplifies to '404 default + optional redirect.'"* The 2026-05-14 filing reversed that decision without citing it.
2. **None of the leading OSS agent runtimes ship bundled public-visitor HTTP chat.** Hermes, OpenClaw, OpenHands (OSS), Letta, CrewAI, OpenAI Agents SDK — all ship either messaging adapters (Telegram/Discord/Slack) or BYO-UI (API + bring-your-own-frontend). Shipping bundled chat would make Auggy the lone exception.

The current scope is much smaller: an info endpoint, ~1-2 hours. Auggy's real OSS differentiators (`visitorAuth`, `budgets`, augment composability) carry the v1.0 OSS pitch — not bundled UI.

## Goals

1. Replace `GET / → 404` with a small HTML response that tells a visitor: *this is an Auggy agent backend*, what its name is, and how to interact with it.
2. Add `HEAD /` as a spec-compliant mirror of `GET /` (same status + headers, no body). Fixes a latent spec violation where `HEAD /` currently returns 404 while `GET /` returns 302 when `publicFrontendUrl` is set.
3. Preserve the existing 302-redirect-when-`publicFrontendUrl`-is-set behavior byte-identically.
4. Keep the implementation testable in isolation from the transport.

## Non-goals

- **No bundled chat UI.** Visitors who want to talk to the agent either use a chat surface the operator deployed (set `publicFrontendUrl`), or come in via `telegramTransport`, or hit `/agent/run` with their own AG-UI client.
- **No content negotiation.** HTML only. Programmatic clients use the existing `/.well-known/agent-card.json`; serving JSON at `/` would duplicate that endpoint.
- **No external assets** (no JS, no remote CSS, no fonts, no images). The page is one self-contained HTTP response.
- **No CSP/CORS hardening beyond what `webTransport` already does** for static GET responses.

## Auth posture and visibility

### Auth posture

The info page is **unauthenticated regardless of `webTransport.allowAnonymous`**. Rationale:

- The same fields (`provider.name`, `purpose`) are already served unauthenticated at `/.well-known/agent-card.json`. No new exposure surface vs the pre-G2 baseline.
- The operator's mental model is that `/` is for visitor discoverability — same audience that hits the agent-card endpoint.
- Per-request auth on a discovery endpoint would force every link preview, monitor, and browser navigation through visitor-auth, which is operator-hostile.

This is a deliberate choice; if a future design needs auth-gated `/`, it should ride alongside the G36 `/admin` work, not on the info endpoint.

### Crawler / scraper / unfurl behavior — behavioral change vs today

Going from `404` → `200 + HTML` changes the externally-visible surface. Two propagation channels:

1. **Search-engine indexing.** Spec ships with `<meta name="robots" content="noindex, nofollow">` so well-behaved crawlers (Google, Bing) skip indexing. Passive accumulation of agent URLs in search results is suppressed by default.
2. **Link unfurls** (Slack, Discord, iMessage, Twitter) — these ignore `robots` meta and pull Open Graph tags directly. Unfurls **will** render `og:title` + `og:description`. This is desired UX in the common case: the operator shared the URL in a chat, they want a useful preview.

Operators who want zero externally-visible metadata can:
- Set `publicFrontendUrl` — the 302 redirect path bypasses the info page entirely.
- OR deploy on a non-public URL / behind an IP allow-list at the network layer.

A future `webTransport.publicAgentMetadata: false` opt-in to suppress Open Graph tags is captured as out-of-scope below. File when adopter feedback drives the need.

### Boot-time `allowAnonymous` warning

This spec does not modify the boot-time `console.warn` behavior in [`docs/06-transports.md` § Anonymous posture](../../../06-transports.md#anonymous-posture). The info-page handler is independent of `allowAnonymous`; no new warnings, no warning-suppression interactions.

## Architecture

| File | Status | Purpose |
|---|---|---|
| `src/transports/info-page.ts` | **new** | Pure function `renderInfoPage(card: AgentCard): string`. No I/O, no kernel deps. |
| `src/transports/web-transport.ts` | modified | Handler condition expands to GET *and* HEAD on `/`; HEAD strips body; calls `renderInfoPage` when `publicFrontendUrl` is unset. |
| `tests/transports/info-page.test.ts` | **new** | Unit tests on the pure renderer. |
| `tests/transports/web-transport.test.ts` | modified | Integration tests for GET / + HEAD / × (publicFrontendUrl set / unset). |
| `docs/06-transports.md` | modified | Update the `GET /` section (currently lines 470–495) to document new behavior + HEAD support. |

The split into a separate `info-page.ts` module follows the existing pattern of slicing one concern per file in `src/transports/` — `ag-ui-events.ts` (kernel→AG-UI translator) and `visitor-token.ts` (token sign/verify) are precedents. The shapes aren't identical to `ag-ui-events.ts` (which exports types + helpers + a translator); `info-page.ts` is a single pure renderer. `web-transport.ts` is already the largest file in the codebase (~1060 LOC); adding ~50 lines of HTML there would worsen a known pressure point. The pure-function shape lets us unit-test the template (escaping, meta tag presence, link rel="alternate", `noindex` directive) without spinning up an HTTP server.

## `renderInfoPage` contract

```ts
// src/transports/info-page.ts
import type { AgentCard } from "../types";

export function renderInfoPage(card: AgentCard): string;
```

**Inputs read from the card** (sourced via `kernel.getAgentCard()` in `web-transport.ts`). Types verified against `src/types.ts:518–544`:

| Field | TS type | Usage | Fallback |
|---|---|---|---|
| `card.provider.name` | `string` (required, could be empty per TS type) | `<title>`, `<h1>`, Open Graph `og:title` | If `name.trim() === ""`, use the literal `"An Auggy agent"` in `<title>` and `<h1>` (drops the name slot entirely; reads cleaner than `"this agent — Auggy agent"`). |
| `card.purpose` | `string \| undefined` | `<meta description>`, `og:description`, body `<p>` | If `undefined` or empty after `.trim()`, omit the body paragraph AND emit empty-string `content=""` on the meta tags |

The empty-`provider.name` case is defensive — in practice the agent-card factory at `src/agent-card.ts:26` always pulls from `config.name` which is a required string per `src/types.ts:846`. The fallback exists so a hand-constructed `AgentCard` (e.g., in tests) doesn't render a blank `<h1>`. Trim coverage extends to whitespace-only names (`"   "`, `"\t"`) so an operator typo doesn't produce a visually-empty header.

Other card fields (`capabilities`, `skills`, `interfaces`, `extensions`) are intentionally NOT surfaced on the info page — they remain available via `/.well-known/agent-card.json`. Duplicating them invites sync drift.

### HTML escaping

Tiny inline function in `info-page.ts`:

```ts
function escape(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
```

Applied to every interpolated string. Order matters — `&` must be replaced first. Tests cover adversarial inputs: `<script>alert(1)</script>`, `Bob & "official"`, names containing `'` or angle brackets.

## HTML output

Approximate template (final wording is implementation-time discretion; structure is the contract):

```html
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>{title}</title>
  <meta name="description" content="{purpose}">
  <meta property="og:title" content="{title}">
  <meta property="og:description" content="{purpose}">
  <meta property="og:type" content="website">
  <link rel="alternate" type="application/json" href="/.well-known/agent-card.json">
  <style>
    body { font-family: system-ui, sans-serif; max-width: 40rem; margin: 3rem auto; padding: 0 1rem; color: #222; line-height: 1.5; }
    code { background: #f4f4f4; padding: 0.15rem 0.4rem; border-radius: 3px; font-size: 0.95em; }
    a { color: #0a66c2; }
  </style>
</head>
<body>
  <h1>{heading}</h1>
  <p>This is an <a href="https://github.com/looselyorganized/augment-1">Auggy</a> agent backend.</p>
  <p>{purpose}</p>  <!-- omitted entirely when purpose is empty / undefined / whitespace-only -->
  <p>To interact:</p>
  <ul>
    <li>Inspect the <a href="/.well-known/agent-card.json">agent card</a></li>
    <li>Bring your own AG-UI client and <code>POST /agent/run</code></li>
    <li>Or configure <code>publicFrontendUrl</code> in <code>agent.yaml</code> to redirect visitors to a polished frontend</li>
  </ul>
</body>
</html>
```

Placeholder semantics:

| Token | Resolves to | When |
|---|---|---|
| `{title}` | `"${escape(name)} — Auggy agent"` | when `name.trim() !== ""` |
| `{title}` | `"An Auggy agent"` | when `name.trim() === ""` (defensive fallback) |
| `{heading}` | `escape(name)` | when `name.trim() !== ""` |
| `{heading}` | `"An Auggy agent"` | when `name.trim() === ""` |
| `{purpose}` | `escape(purpose)` | when `purpose?.trim()` is non-empty |
| `{purpose}` | `""` (meta tags emit empty `content`; body `<p>` omitted) | when `purpose` is undefined / empty / whitespace-only |

Total size: ~1.6 KB after `noindex` addition. Inline CSS (~3 lines) provides basic readability — system fonts, max-width, link color — without committing to a UI framework. No JS. No remote assets. No CORS headers (this is a public document, not a programmatic endpoint).

Hardcoded constants — risks acknowledged in [Risks + open questions](#risks--open-questions):

- `https://github.com/looselyorganized/augment-1` — repo URL. Currently private per `docs/RELEASING.md`; goes public on v1.0 OSS ship. If the repo ever moves, this link goes stale and needs a one-line edit.
- `#0a66c2` link color — arbitrary readable blue. No load-bearing brand decision; can change at any time.

## `web-transport.ts` handler change

The current handler block in `src/transports/web-transport.ts` (the `if (req.method === "GET" && url.pathname === "/")` block — ~lines 936-942 at the time of writing, but reference by content since line drift is plausible):

```ts
// Current
if (req.method === "GET" && url.pathname === "/") {
  if (opts.publicFrontendUrl) {
    return Response.redirect(opts.publicFrontendUrl, 302);
  }
  return new Response("Not Found", { status: 404 });
}
```

### Boot-time setup (in `register()`)

Two operations move to `register()` to fail-fast and amortize per-request cost:

```ts
// Validate publicFrontendUrl ONCE at register-time — fail fast on garbage config
// instead of throwing at first request. Matches the validation discipline used
// for visitorTokens.signingKey + agentBinding earlier in this file.
let validatedPublicFrontendUrl: string | undefined = undefined;
if (opts.publicFrontendUrl !== undefined) {
  try {
    new URL(opts.publicFrontendUrl);
  } catch (err) {
    throw new Error(
      `[web-transport] publicFrontendUrl is not a valid URL: ${JSON.stringify(opts.publicFrontendUrl)}. ${(err as Error).message}`,
    );
  }
  validatedPublicFrontendUrl = opts.publicFrontendUrl;
}

// Cache the info page once. The agent card is built at defineAgent time and
// doesn't change; rendering once means HEAD and GET share the same byte string,
// and HEAD can report an accurate Content-Length without re-rendering per
// request.
let infoPageHtml: string | null = null;
let infoPageByteLength = 0;
if (validatedPublicFrontendUrl === undefined) {
  infoPageHtml = renderInfoPage(k.getAgentCard());
  infoPageByteLength = new TextEncoder().encode(infoPageHtml).byteLength;
}
```

Captured in closures over the request handler. The `k.getAgentCard()` call is safe in `register()` because `register()` is invoked AFTER the kernel constructs the cached card.

### Request handler

```ts
// After G2
if ((req.method === "GET" || req.method === "HEAD") && url.pathname === "/") {
  if (validatedPublicFrontendUrl !== undefined) {
    const redirectHeaders = { location: validatedPublicFrontendUrl };
    return req.method === "HEAD"
      ? new Response(null, { status: 302, headers: redirectHeaders })
      : new Response(null, { status: 302, headers: redirectHeaders });
      // ^ HEAD and GET symmetric on the 302 path; both use manual construction
      //   so URL validation happens at register-time (above), not per-request.
  }
  // Info page path. infoPageHtml is non-null here by construction
  // (set in register when publicFrontendUrl is undefined).
  if (infoPageHtml === null) return new Response(null, { status: 404 });  // defensive
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "public, max-age=300",
  });
  // Explicit Content-Length so HEAD's headers match GET's per RFC 9110 §9.3.2.
  // Bun may set Content-Length: 0 on null-body responses by default; setting it
  // explicitly via Headers should override. Verify in integration test; if Bun
  // overrides, file as Bun bug + accept the spec deviation as known minor limit.
  headers.set("content-length", String(infoPageByteLength));
  return new Response(req.method === "HEAD" ? null : infoPageHtml, {
    status: 200,
    headers,
  });
}
```

Decisions encoded:

1. **GET and HEAD share the path.** Method check is OR'd.
2. **HEAD strips body.** Pass `null` as body to `new Response(null, ...)`.
3. **URL validation moved to register-time.** Closes the GET-vs-HEAD divergence where the original spec had GET going through `Response.redirect` (URL-validating) and HEAD going through manual construction (no validation). Now both branches use manual construction; validation runs once at register, throws if `publicFrontendUrl` is garbage. Operator sees the error at agent boot, not at first visitor.
4. **Info page rendered + cached at register-time.** Eliminates per-request render cost and gives HEAD an accurate byte length for `Content-Length`.
5. **`Cache-Control: public, max-age=300`.** 5-minute browser/CDN cache. Prevents thundering from uptime monitors / link-preview refreshes; doesn't lock operators into stale content for long.
6. **Explicit `Content-Length` header.** Set via `Headers.set()` before `Response` construction. Bun's behavior on null-body + explicit Content-Length should be the explicit value; integration test verifies. Known limit if Bun overrides.
7. **Defensive `infoPageHtml === null` guard.** Should never fire in practice (set in `register()` when no `publicFrontendUrl`). Belt-and-suspenders against future refactor breakage.
8. **Other methods on `/`.** `POST /`, `OPTIONS /`, `PUT /`, `DELETE /` continue falling through to the existing 404 default at the end of the handler — no change. CORS preflight for `/` (OPTIONS) is unchanged.

## Tests

### Unit tests — `tests/transports/info-page.test.ts` (new)

All tests use `bun:test` (the project standard — never `vitest`, per `CLAUDE.md` rule 6).

1. Returns valid HTML (starts with `<!doctype html>`, contains `<html lang="en">`, `<head>`, `<body>`, `</html>`)
2. Title contains the escaped agent name from `card.provider.name`
3. `<link rel="alternate" type="application/json" href="/.well-known/agent-card.json">` present
4. Open Graph tags present (`og:title`, `og:description`, `og:type`)
5. `<meta name="viewport" content="width=device-width, initial-scale=1">` present (mobile rendering)
6. **`<meta name="robots" content="noindex, nofollow">` present** (crawler suppression default)
7. HTML-escapes agent name: `<script>alert(1)</script>` → escape output contains `&lt;script&gt;alert(1)&lt;/script&gt;` and no raw `<script>` substring
8. HTML-escapes special chars: `Bob & "official"` → `Bob &amp; &quot;official&quot;`
9. HTML-escapes single quote: `Alice's agent` → `Alice&#39;s agent`
10. Purpose paragraph omitted when `card.purpose` is `undefined`
11. Purpose paragraph omitted when `card.purpose` is empty string `""`
12. **Purpose paragraph omitted when `card.purpose` is whitespace-only (`"   "`, `"\t\n"`)**
13. Purpose paragraph included + escaped when `card.purpose` is non-empty
14. **Title + heading fall back to `"An Auggy agent"` when `card.provider.name` is empty string** (defensive)
15. **Title + heading fall back to `"An Auggy agent"` when `card.provider.name` is whitespace-only** (`"   "`, `"\t"`)

### Integration tests — `tests/transports/web-transport.test.ts` (modified)

Add these cases alongside the existing tests:

1. `GET /` with `publicFrontendUrl` unset → 200, `Content-Type: text/html; charset=utf-8`, `Cache-Control: public, max-age=300`, body contains the agent name in `<title>`
2. `GET /` with `publicFrontendUrl` set → 302, `Location: <publicFrontendUrl>` (regression — existing behavior preserved)
3. `HEAD /` with `publicFrontendUrl` unset → 200, `Content-Type: text/html; charset=utf-8`, body is empty, `Content-Length` matches the byte length of the GET body (verify the actual byte length, not just non-zero)
4. `HEAD /` with `publicFrontendUrl` set → 302, `Location: <publicFrontendUrl>`, body is empty
5. `POST /` → 404 (regression — existing behavior preserved)
6. **Boot-time validation: register-with-malformed-publicFrontendUrl throws** (e.g. `publicFrontendUrl: "not a url"`) — test that `defineAgent.start()` (or the equivalent kernel boot path used by other tests) rejects with the validation error before serving any request. If Bun's `new URL()` accepts the input (it's somewhat permissive — `"not a url"` parses as a relative URL against the page URL, which doesn't exist in Node/Bun standalone — verify the actual throw behavior and pick an unambiguously-bad input like `"://bad"` or `"http://[invalid"`).

The existing `webTransport allowAnonymous (G3)` block and `webTransport / publicFrontendUrl` block (if present) stay untouched.

### Test 3 nuance — Bun's Content-Length behavior on null-body responses

The expectation is that explicitly setting `Content-Length` via `Headers.set()` before `new Response(null, { headers })` produces the explicit value in the response. If Bun overrides this (e.g., always sets `Content-Length: 0` for null bodies), the test fails. Two acceptable outcomes:

- **Bun honors the explicit value** → ship as designed; test asserts byte-length match.
- **Bun overrides to 0** → file a Bun bug; downgrade test 3 to assert `Content-Length: 0` and accept the spec deviation as a known limit. Document in the acceptance criteria below.

This nuance is implementation-time discovery, not a spec gap.

## Docs update — `docs/06-transports.md`

The existing `GET / — optional redirect to a frontend` section (lines 470–495) is rewritten to:

- Headline: *`GET /` and `HEAD /` — agent info endpoint + optional frontend redirect*
- Describe the two branches: `publicFrontendUrl` set → 302; unset → 200 + info page
- Include the rough HTML structure (link to `info-page.ts` for the canonical source)
- Note that other methods on `/` (POST, PUT, DELETE) continue to 404
- Cross-link to this spec from the section

## Acceptance criteria

- [ ] `src/transports/info-page.ts` exists and exports `renderInfoPage(card: AgentCard): string`
- [ ] `bun test` passes — full suite (1988+ tests root, 83 chat) with the new unit + integration tests added
- [ ] `bunx tsc --noEmit` clean
- [ ] `bun run lint` baseline preserved (0 errors, ~29 warnings + 1 info; new code adds no warnings)
- [ ] Manual smoke: `auggy create test-g2 && auggy dev test-g2` → `curl http://localhost:8080/` returns the HTML; opening in a browser renders correctly
- [ ] Manual smoke: same agent with `publicFrontendUrl: https://example.com` set in agent.yaml → `curl -I http://localhost:8080/` returns 302 with correct Location
- [ ] Manual smoke: agent with malformed `publicFrontendUrl` (e.g. `"://bad"`) fails to boot with a clear validation error — never reaches first-request
- [ ] Manual smoke: `curl -I http://localhost:8080/` (HEAD on info page) returns 200 + `Content-Type: text/html` + `Cache-Control: public, max-age=300` + (verify) `Content-Length` matching the GET body
- [ ] `docs/06-transports.md` updated; section reflects new behavior, the `noindex` default, and the `Cache-Control` posture

## Out of scope (defer)

- **`Allow:` header on the 404 fall-through for POST /.** Not strictly required; revisit if it becomes confusing in practice.
- **`ETag` / conditional GET.** `Cache-Control: max-age=300` ships in scope; `ETag` adds revalidation machinery we don't need at v1.0 — the info page changes per-deploy at most, and 5 min is short enough.
- **`webTransport.publicAgentMetadata: false` opt-in to suppress Open Graph tags entirely.** The current spec ships `noindex` by default + always-on OG tags (link unfurls remain useful for the common case of operator-shared URLs). If adopter feedback shows OG leakage is a real problem, file a Tier-2 ticket then.
- **Customization hooks** (operator overrides the info page content). YAGNI — operators wanting customization set `publicFrontendUrl` instead.
- **i18n / locale negotiation.** Single-language (English) for v1.0 OSS launch. Operators who need localized content set `publicFrontendUrl` to their own page; the bundled fallback is intentionally not the localization point.
- **Accessibility audit beyond browser defaults.** The page uses semantic `<h1>`, `<p>`, `<ul>`, plain `<a>` — screen-readers handle these natively, but there's no explicit a11y review (aria labels, contrast ratios beyond defaults, alt text — none of those are needed at this surface).
- **Reading `package.json` `repository.url` for the GitHub link.** Hardcoded for v1.0; one-line edit if the repo moves. Adding a build-time read for a hardcoded link is more code than the staleness risk warrants.
- **Visitor-auth hint on the page.** Operator-side configuration concern; info page isn't the right teaching surface.
- **`auggy chat` mention on the page.** `auggy chat` is for the operator's own machine, not visitors. Different audience.
- **Request logging beyond `webTransport`'s existing path.** Info endpoint hits aren't more interesting than any other GET.

## Risks + open questions

- **Risk: scope creep.** Someone wants to add a logo, then a stylesheet, then a small JS for "type a message here." Mitigation: this spec hard-codes "no JS, no external assets" and the inline CSS is capped at ~3 lines. PR review enforces.
- **Risk: Bun overrides explicit `Content-Length` on null-body responses.** If this happens, test 3's strict `Content-Length` match fails and we ship a known minor RFC 9110 §9.3.2 deviation (HEAD reports `Content-Length: 0` instead of matching GET body length). Mitigation: discover at implementation time; downgrade test + document in release notes if needed. Most clients don't care; some strict link-checkers might.
- **Risk: hardcoded GitHub link goes stale.** Auggy's repo is private until v1.0 ships; if the org/name changes between now and ship, the link 404s. Mitigation: one-line edit in `info-page.ts` if the repo moves. Captured in [Out of scope](#out-of-scope-defer).
- **Semantic loose-end: `<link rel="alternate" type="application/json">`.** Per HTML spec, `rel="alternate"` is for "alternate representations of the same document." agent-card.json is a structured peer, not a translation. `rel="describedby"` would be technically more accurate but isn't recognized by major scrapers (Google, Bing) for JSON descriptors. Keeping `rel="alternate"` follows common practice. Flag as known semantic loose-end.
- **Open: Open Graph default behavior for private/internal agents.** Today (pre-G2): `404` reveals nothing. After G2: link unfurls reveal `og:title` + `og:description`. The `noindex` meta blocks search-engine accumulation but not Slack/Discord previews. Decision: ship as is; future opt-in `publicAgentMetadata: false` if adopter feedback drives the need. Operators wanting zero metadata leak today should set `publicFrontendUrl`.
- **Open: whether the boot-time `allowAnonymous` warning should ALSO mention G2's info page.** The warning currently says: "anonymous visitors have no documented upgrade path to recognized identity. Consider `auggy add visitor-auth`." After G2, anonymous visitors landing on `/` see useful info (vs the old 404). Should the warning copy reflect this? Probably not — the warning is about the *interaction* gate (POST /agent/run), not the discovery surface. Leave the warning untouched.
