# Console Login Delivery Hardening Contract

Date: 2026-07-29  
Status: normative implementation contract for draft PR #175  
Initial base: `origin/main` at `8f83b09`  
Working branch: `feat/branded-console-login` in `/private/tmp/auggy-console-login`

## Purpose

This contract defines the delivery and security boundary for the first-party
Console password screen. It replaces environment-dependent behavior with one
deterministic contract across a clean source checkout, a built checkout, and an
isolated install of the packed `auggy` package.

The terms **MUST**, **MUST NOT**, **SHOULD**, and **MAY** are normative.

## Branch and release scope

- All work MUST remain in the dedicated worktree and branch named above, based
  on the latest `main`. It MUST NOT modify or depend on the
  `production/horizontal-replica-readiness` checkout or its uncommitted files.
- Draft PR #175 is the integration vehicle. It MUST remain draft until every
  acceptance gate in this document passes on its exact head commit.
- This work MAY change the Console login presentation, its build artifact,
  pre-authenticated static delivery, focused documentation, tests, and release
  rehearsal coverage.
- This work MUST NOT bump a package version, create a tag, publish an npm
  package, change the supported single-replica topology, or include horizontal
  replica work. Publication requires a separate release PR.
- The existing CLI ticket and Console session security contracts are preserved.
  Any hardening described below is compatibility-preserving unless explicitly
  stated otherwise.

## Canonical request behavior

### Direct Console navigation

- An unauthenticated browser-style `GET /console` MUST return `303 See Other`
  with `Location: /console/login?next=%2Fconsole` and `Cache-Control: no-store`.
- An unauthenticated browser-style `GET` of a Console client route, such as
  `/console/chat`, MUST return a `303` to `/console/login` with only that safe,
  same-Console path encoded in `next`.
- An authenticated request continues to receive the Console SPA. If the main
  SPA is not built, an authenticated request MAY receive the existing explicit
  build-required `503`; this MUST NOT make the login route unavailable.
- API and action requests MUST NOT be converted into HTML login redirects. They
  retain their structured `401` authentication response.

### Login page availability

- `GET /console/login` MUST be available without Console authentication after
  the HTTPS/loopback gate and MUST return an operable HTML form with status
  `200`.
- Login availability MUST NOT depend on `admin/dist` already existing. A clean
  checkout with dependencies installed but no Console build MUST return a
  minimal, semantic, server-owned fallback form rather than `503`.
- When the generated login template and stylesheet are valid and present, the
  route MUST return the branded registry-derived page.
- A missing, unreadable, malformed, or incomplete generated login artifact MUST
  degrade to the server-owned fallback form. It MUST NOT expose a filesystem
  path, stack trace, placeholder, bearer, or build detail to the client.
- The fallback is an operational recovery surface, not a second design system.
  It MUST preserve the same copy, labels, action, accessibility semantics,
  security headers, error status, and password behavior as the branded page.
- `GET /console/login` MUST work with JavaScript disabled in every environment.

### Password submission

- `POST /console/login` MUST accept exactly one URL-encoded `password` value and
  no unexpected form fields, subject to the existing 4 KiB body bound and login
  rate limit.
- A valid password MUST return `303`, set the existing bearer-bound Console
  session cookie, and redirect to the normalized `next` path or `/console`.
  The cookie MUST remain `HttpOnly`, `SameSite=Lax`, `Path=/console`, scoped to
  the existing 12-hour maximum, and `Secure` for HTTPS requests.
- An invalid or missing password MUST return `401` and the operable login page
  with a generic `Invalid console password.` alert. It MUST NOT echo the
  submitted value or distinguish missing from incorrect credentials.
- An oversized body MUST return `413`; a malformed or nonconforming form MUST
  return `400`; a rate-limited attempt MUST return `429` with `Retry-After`.
  These responses MUST be `no-store` and MUST NOT reveal credential details.
- `next` MUST be normalized server-side. Only `/console` and paths below
  `/console/` are valid. An absolute URL, protocol-relative URL, encoded escape,
  or unrelated path MUST fall back to `/console`.
- Methods other than `GET` and `POST` on `/console/login` MUST return `405` with
  `Allow: GET, POST`.

## CLI one-time sign-in contract

### Ticket issue

- `POST /console/api/cli-login` MUST require explicit valid HTTP Basic
  credentials derived from `AUGGY_WEB_TOKEN`. A Console session cookie alone
  MUST NOT authorize ticket issuance.
- A request containing an `Origin` header MUST be rejected with `401`, even if
  its Basic credential is valid. This endpoint is for the CLI, not browser
  JavaScript.
- The request MUST have no body. A body MUST return `400`; other methods MUST
  return `405` with `Allow: POST`.
- Success MUST return `200 application/json` with only a login path and an
  integer expiry no greater than 30 seconds. It MUST set
  `Cache-Control: no-store`.
- The token MUST contain 256 bits from a cryptographically secure random source
  and use the existing 43-character unpadded base64url representation. The
  process-local store MUST retain only a digest of the token, a digest bound to
  the current bearer, the exact effective origin, and the expiry.
- The store MUST remain bounded to 64 pending tickets by default. Store absence,
  exhaustion, or generation failure MUST return a generic `503` without
  exposing internal state.

### Ticket consume and replay

- `GET /console/cli-login/<ticket>` MUST be the only consume shape. Any other
  method MUST return `405`; malformed paths MUST be rejected and MUST NOT be
  treated as SPA routes or static assets.
- A valid, unexpired ticket presented at its exact bound origin with the current
  bearer MUST be consumed once, return `303`, set the same HttpOnly Console
  session cookie as password login, and redirect to `/console/chat`.
- Consumption MUST atomically delete the pending ticket before validating its
  expiry, origin, or bearer binding. A presentation at the wrong origin or
  under a rotated bearer therefore burns the ticket.
- An invalid, expired, wrong-origin, wrong-bearer, or replayed ticket MUST return
  `401` with the operable login page and the generic alert `This automatic
  sign-in link is invalid or expired.` It MUST NOT reveal which condition
  failed.
- Issuance, consumption, redirects, errors, and session responses MUST be
  `no-store`.

## Credential and transport boundary

- The value of `AUGGY_WEB_TOKEN` MUST NEVER appear in HTML, CSS, JavaScript,
  data attributes, response JSON, redirect locations, browser URLs, log
  messages, thrown errors, snapshots, or generated assets. The literal
  environment variable name MAY appear as operator guidance.
- The one-time ticket is a short-lived bearer capability. It MAY appear in the
  successful issue response's `loginPath` and in its single consume path. It
  MUST NOT appear in query strings, fragments, any later response body, or
  application logs.
- The CLI MAY send the permanent bearer to an arbitrary `https:` origin or to a
  direct loopback `http:` origin (`localhost`, `127.0.0.0/8`, or `::1`). It MUST
  reject userinfo, queries, fragments, non-HTTP schemes, and non-loopback plain
  HTTP before making a request.
- The server MUST require validated HTTPS for non-loopback login pages, login
  assets, ticket issue, and ticket consumption. Direct loopback HTTP is the only
  exception. Untrusted forwarding headers MUST NOT grant either exception.
- A rejected non-loopback HTTP request MUST use the existing `426 Upgrade
  Required` behavior before authentication or asset delivery.

## Registry-first, no-JavaScript source contract

- The branded page MUST be authored by composing the generated Auggy component
  registry primitives and shared theme tokens already owned under
  `admin/src/components/ui/`. Card, input, button, typography, spacing, and
  brand colors MUST come from that registry output before local primitives or
  one-off styling are introduced.
- If a required primitive or token does not exist, it MUST first be added to the
  Auggy registry and then generated into this consumer. The registry service is
  a development-time source only; login MUST have no runtime network dependency
  on it.
- The build MUST statically render the registry-composed login markup and emit a
  dedicated, fingerprinted stylesheet. It MUST NOT emit or require a login
  JavaScript bundle. The native HTML form is the complete interaction model.
- The built page MUST use first-party or system resources only. It MUST NOT load
  remote fonts, analytics, images, scripts, styles, or other third-party
  resources before authentication.
- The minimal fallback MUST use semantic markup and browser defaults so it does
  not require an inline style exception or unavailable static asset. It MUST
  NOT grow into a parallel component library. Product UI changes are made in
  the registry-composed source and regenerated.

## Static variant integrity and escaping

- The build MUST render three complete, fixed documents from the same component:
  `default`, `invalid-password`, and `invalid-ticket`. Runtime input MUST NOT be
  interpolated into generated HTML.
- The native form MUST omit its `action` attribute so the browser posts to the
  current same-origin login URL and preserves `next` for server-side
  normalization. Raw query text MUST NOT be copied into the document body or an
  HTML attribute.
- Error variants MUST contain only the fixed server-owned messages in this
  contract. No submitted value, query value, ticket, or credential may be
  interpolated into them.
- The generator MUST verify each document's expected variant marker, exactly one
  password form, and expected alert count. A document with an unresolved
  placeholder, script, inline event handler, or missing native form MUST make
  the build fail.
- The template and CSS MUST be read only from the resolved login artifact root.
  Symlinks, traversal, percent-encoded separators, dot segments, null bytes,
  mixed separators, and paths resolving outside that root MUST fail closed.

## Pre-authenticated asset boundary

- The only pre-authenticated static namespace is
  `/console/login-assets/<fingerprinted-name>.css`.
- Only regular files in the resolved login artifact root that are explicitly
  present in the generated login asset manifest MAY be served. A prefix match
  alone is insufficient authorization.
- The manifest MUST use a versioned schema with sorted safe relative paths,
  logical entries for all three HTML variants and the sole public stylesheet,
  plus each file's byte size and SHA-256 digest. It MUST contain no timestamps
  or absolute local paths and MUST be written only after every artifact passes
  verification.
- Only `GET` and `HEAD` are allowed for an allowlisted asset. Other methods MUST
  return `405` with `Allow: GET, HEAD`. The namespace root, unknown files,
  nested arbitrary paths, traversal attempts, and unsupported file types MUST
  return `404` or `400` without revealing filesystem details.
- Login delivery MUST NOT make `/console/assets/*`, `/console/brand/*`, source
  maps, manifests containing local paths, the main SPA shell, or any other
  Console file public before authentication.
- No JavaScript MIME type is allowlisted in the login namespace. A request for
  `.js`, even if a stray file exists on disk, MUST fail.

## Response headers

Every login HTML response, including fallback and error pages, MUST include:

```text
Content-Type: text/html; charset=utf-8
Cache-Control: no-store
Content-Security-Policy: default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'
X-Frame-Options: DENY
Referrer-Policy: no-referrer
X-Content-Type-Options: nosniff
X-Robots-Tag: noindex, nofollow
```

- No inline style or script is permitted by this CSP. The fallback MUST remain
  functional without either.
- A fingerprinted allowlisted stylesheet SHOULD use `Cache-Control: public,
  max-age=31536000, immutable`; every non-success asset response MUST use
  `Cache-Control: no-store`.
- Asset responses MUST also include `X-Content-Type-Options: nosniff`,
  `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer`, and a CSP that denies
  framing. They MUST report the exact stylesheet MIME type.
- Security headers MUST be applied by the outer Console response boundary so
  that early errors, redirects, fallback responses, and assets cannot bypass
  them. Route-specific CSP MAY strengthen but MUST NOT weaken that boundary.

## Environment contract

### Clean checkout, not built

- After `bun install --frozen-lockfile`, before any admin build, focused route
  tests and the tracked full suite MUST pass.
- `GET /console/login` MUST return the functional semantic fallback with `200`.
  Invalid password and invalid ticket pages MUST return the same fallback with
  `401`. Valid password and ticket flows MUST still set sessions and redirect.
- No test MAY accept either `200` or `503`; status and body contracts are exact.

### Built checkout

- `bun run build:admin` MUST emit the three static login variants, a
  fingerprinted CSS file, and a constrained asset manifest under
  `admin/dist/login/`.
- It MUST NOT emit login JavaScript, source maps, secrets, absolute local paths,
  or unresolved placeholders.
- The route MUST serve branded HTML and the allowlisted CSS while preserving all
  clean-checkout auth and status behavior.
- Removing or corrupting any required login artifact after the build MUST
  exercise the fallback path deterministically, not return an environment-
  dependent status.

### Packed and isolated install

- The release build MUST run before `npm pack`. The tarball MUST contain the
  exact generated login template, stylesheet, and manifest and MUST contain no
  login JavaScript or source maps.
- Release smoke MUST install the tarball in an empty consumer, boot the packed
  runtime, and verify direct login, invalid password, ticket issue, ticket
  consume, replay rejection, stylesheet delivery, asset confinement, headers,
  and no-JavaScript form markup over direct loopback HTTP.
- The packed branded path, not the fallback, MUST be proven by asserting a
  registry-specific stable marker and fetching the exact manifest-listed CSS.
- The tarball inspection and isolated runtime checks MUST fail the release if a
  branded login artifact is missing or malformed, even though the operational
  runtime fallback remains available.

## Implementation slices

Every slice follows the same control loop: the orchestrator rechecks this whole
contract and the slice boundary, assigns disjoint specialist work, reviews the
returned diff and attack surface, fixes defects, runs the slice's focused tests
plus root typecheck and lint, commits one scoped Conventional Commit, and only
then starts the next slice. Generated output and ignored files MUST be removed
or recreated explicitly whenever their presence could influence a test.

### Slice 1 — Containment and normative contract

- Keep PR #175 draft and prove the worktree's exact `origin/main` ancestry.
- Record the clean/built/packed behavior, security invariants, non-goals, and
  acceptance matrix in this document.
- Remove every assertion that accepts environment-dependent status unions.
- Exit gate: only this contract differs from the already-pushed draft head;
  `git diff --check`, root typecheck, and root lint pass.
- Commit: `docs(console): define hardened login delivery contract`.

### Slice 2 — Registry-authored static artifact pipeline

- Keep `LoginPage.tsx` as the presentation source and compose the local Auggy
  registry Card, Input, and Button with native no-JavaScript form semantics.
- Replace the hydrated login entry and second Vite application with a
  deterministic build-time server render of the three fixed variants.
- Compile only the login's registry/theme CSS to one fingerprinted stylesheet;
  do not copy `admin/public`, emit JavaScript, or download build tools at build
  time.
- Generate and verify the versioned size-and-digest manifest, writing it last.
- Exit gate: component, generator, manifest, deterministic rebuild, and actual
  built-file inventory tests pass; root/admin typecheck and lint pass.
- Commit: `build(console): generate static login artifacts`.

### Slice 3 — Fail-closed runtime delivery

- Add a server-owned semantic fallback for default and fixed error states.
- Resolve and validate the generated manifest and artifacts without making
  authentication outcomes depend on their availability.
- Select only fixed generated variants; serve only the exact manifest-listed
  fingerprinted CSS via GET/HEAD; apply strict headers and method handling.
- Preserve the existing safe-next, session, HTTPS/loopback, and single-use CLI
  ticket contracts while tightening malformed password submissions.
- Exit gate: focused route/static/ticket tests cover clean, valid, partial,
  corrupt, traversal, wrong-method, and replay cases with exact statuses;
  typecheck and lint pass before and after a clean admin build.
- Commit: `feat(console): harden no-js login delivery`.

### Slice 4 — Clean-room and packed-release proof

- Make web transport tests use manual redirects where presentation is not the
  subject and explicit fixtures where branded rendering is the subject.
- Add a post-build artifact verifier and expand release smoke to inspect the
  tarball and exercise the installed package's password, session, ticket,
  replay, CSS, header, and confinement behavior.
- Preserve runtime-before-build workflow ordering so ignored or stale local
  output cannot mask a clean-checkout defect.
- Exit gate: clean no-build focused/full tests, root typecheck/lint, clean admin
  test/build/verification, rebuilt focused/full tests, and `smoke:release` all
  pass from the same commit.
- Commit: `test(release): prove packed console login flows`.

### Slice 5 — Operator experience and release-facing guidance

- Review the page at desktop and narrow mobile widths with JavaScript disabled,
  including default, password-error, and ticket-error states.
- Validate keyboard navigation, visible focus, label/control association,
  alert semantics, contrast, password-manager compatibility, and no horizontal
  overflow. Fix presentation only through the registry-authored source/tokens.
- Align CLI and operator documentation with password fallback and one-time
  ticket behavior without documenting secret values.
- Exit gate: accessibility/component/docs tests, root/admin typecheck and lint,
  production build, screenshots without secrets, and diff/secret checks pass.
- Commit: `docs(console): finalize secure sign-in guidance` (or a scoped
  `fix(console)` commit if review requires product code changes).

### Final adversarial pass and PR gate

- Assign fresh read-only reviewers to security/protocol behavior, build/package
  determinism, and UI/accessibility. Reviewers MUST inspect the aggregate diff
  from `origin/main`, not only individual slice commits.
- Reproduce the clean/built/packed matrix from empty output, investigate every
  discrepancy, and commit any fixes with focused regression tests.
- Run all required verification gates below on one exact head, push the branch,
  update draft PR #175 with the contract, security effects, screenshots, and
  commands, then mark it ready only after required hosted checks pass. The
  orchestrator MUST NOT merge the PR as part of this plan.

## Acceptance matrix

| Environment | Request / condition | Required result |
| --- | --- | --- |
| Clean, no build | Unauthenticated `GET /console` | `303` to safe login URL |
| Clean, no build | `GET /console/login` | `200` semantic no-JS fallback |
| Clean, no build | Invalid login password | `401` generic fallback alert |
| Clean, no build | Valid login password | `303`, valid session cookie, safe next path |
| Clean, no build | Invalid or replayed CLI ticket | `401` generic fallback alert |
| Clean, no build | Valid CLI ticket | `303` to `/console/chat`, valid session cookie |
| Built | `GET /console/login` | `200` registry marker, native form, CSS only |
| Built | Manifest-listed login CSS | `200 text/css`, immutable cache, security headers |
| Built | Login JavaScript request | Rejected; never served pre-auth |
| Built | Missing/corrupt template, CSS, or manifest | Exact fallback behavior, no `503` |
| Built | Main Console asset without authentication | Redirect or `401`; never public |
| Packed | Tarball inspection | Template/CSS/manifest present; login JS/maps absent |
| Packed | Isolated runtime direct password flow | Same statuses, cookie, headers, and redirects |
| Packed | Isolated runtime CLI flow and replay | One success, deterministic `401` replay |
| Any | Browser-origin ticket issue | `401` even with credential/cookie |
| Any | Ticket issue with body | `400` |
| Any | Wrong method on login/ticket/asset | Exact `405` and `Allow` header |
| Any | Traversal, unknown, or non-CSS login asset | Rejected without filesystem disclosure |
| Any | Non-loopback HTTP | `426` before login/auth/asset delivery |
| Any | Direct loopback HTTP or validated HTTPS | Login flows allowed |
| Any | HTML inspection, logs, snapshots, packed bytes | No `AUGGY_WEB_TOKEN` value or ticket leakage |
| Any | JavaScript disabled | Password form and error recovery remain operable |

## Required verification gates

The following MUST pass on the same final commit, in this order where state can
otherwise mask defects:

1. Clean ignored build output and run focused admin route, ticket-store, CLI
   login, and LoginPage/static-render tests before building.
2. `bun run typecheck`, `bun run lint`, and the complete tracked `bun run test`.
3. `bun run build:admin`, followed by the focused route tests again against the
   built artifact and the admin production build checks.
4. `bun run smoke:release` with the packed login assertions in this contract.
5. A browser-level no-JavaScript password submission and visual review at
   desktop and narrow mobile widths. The screenshot MUST contain no real
   credential or ticket.
6. `git diff --check`, a secret scan of the diff and built asset strings, and
   review of the actual `npm pack` file list.
7. Exact-head hosted CI, CodeQL, PostgreSQL, Console, transport, and release
   rehearsal checks. Draft PR #175 MUST not be marked ready or merged until all
   required checks are green.

## Non-goals

- Replacing `AUGGY_WEB_TOKEN` with OAuth, passkeys, accounts, password reset, or
  a hosted identity provider.
- Changing the ticket TTL, pending-ticket bound, session lifetime, bearer
  derivation, or `auggy console` target resolution.
- Adding client-side validation, hydration, analytics, telemetry, remote fonts,
  or a JavaScript enhancement layer to the login form.
- Making the authenticated Console SPA or its assets public.
- Redesigning the authenticated Console, the marketing site, deployment
  topology, or Railway credential management.
- Publishing another release candidate or stable package from this branch.

## Assumptions and resolved decisions

- The authoritative UI source is the generated local Auggy registry output
  already configured as `@auggy` in `admin/components.json`; the registry itself
  is not a production dependency.
- Operational access to the password form is more important than the presence
  of branded assets. Therefore missing login assets resolve to a functional
  fallback, while release rehearsal separately guarantees that shipped
  tarballs contain and exercise the branded assets.
- The login page requires no JavaScript. Registry reuse describes its authored
  components and tokens, not a requirement to ship React to unauthenticated
  browsers.
- Existing `303`, cookie, HTTPS, Basic-auth, ticket, and safe-next semantics from
  `main` are compatibility constraints.
- There are no unresolved product or security decisions required to begin
  implementation. A later visual review may adjust copy or spacing without
  weakening this contract.
