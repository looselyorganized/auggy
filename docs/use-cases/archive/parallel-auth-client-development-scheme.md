# Parallel Auth and Client Development Scheme

> Archived 2026-07-06. This documented a completed branch/worktree coordination
> scheme for the route-auth and generated-client tracks. It is retained for
> process history only, not as product guidance.

> Coordination protocol for route-auth and generated-client work while both
> surfaces are moving.

## Why this exists

Route auth and generated clients touch the same contract from opposite sides:

- Auth changes define what a route means and how the runtime admits a request.
- Client changes decide which callers can see or call each route.

That makes some slices safe to run in parallel and others unsafe. The goal is
small commits without windows moving ahead of each other on different versions
of the route contract.

## Branch roles

Use three roles, not two long-lived branches trying to absorb each other ad hoc.

### Track branches

Track branches are where implementation happens:

- Auth track: route auth types, web transport authorization, identity/context
  mapping, auth docs, auth-focused tests.
- Client track: generated TypeScript client, OpenAPI export, route manifest
  presentation, client fixtures, client-focused tests.

Track branches should produce small commits and stop at explicit integration
points.

### Integration branch

`integration/routes-auth-client` is the convergence branch.

It should be clean between slices. It is the branch both windows compare
against before starting work that touches shared route contracts.

Do not treat an older track branch as canonical once integration has newer auth
or client commits. Either create a fresh track branch from integration or merge
integration before continuing.

### Archive branches

Older branches such as `routes-client-targets` can remain useful history, but
they should not receive new contract-dependent work after integration has moved
past them unless they first ingest the integration branch.

## Sync rules

Before a new slice:

1. Both worktrees must be clean.
2. Run `git log --left-right --cherry-pick --oneline A...B` between the active
   track branch and `integration/routes-auth-client`.
3. If integration has shared-contract commits not present on the track branch,
   update the track branch before starting.
4. If the slice changes `AugmentHttpRouteAuth`, `RouteAuthContext`,
   `RouteManifestEntry.auth`, generated client target filtering, or OpenAPI
   security, it is a serialization point. Do it on integration, then fan out.

After a slice:

1. Report the commit SHA.
2. Report changed files by surface: auth runtime, client generation, docs,
   tests.
3. Report verification commands.
4. Say whether the other window can proceed, must merge integration, or should
   wait.

## File ownership by default

Auth track usually owns:

- `src/types.ts`
- `src/auth/**`
- `src/transports/web-transport.ts`
- `src/helpers.ts`
- `tests/auth/**`
- auth sections of `tests/transports/web-transport.test.ts`
- `docs/use-cases/auth-strategy.md`
- auth sections of `docs/06-transports.md`

Client track usually owns:

- `src/cli/routes-client.ts`
- `src/cli/routes-openapi.ts`
- route manifest presentation when no runtime auth semantics change
- `tests/cli/routes-client.test.ts`
- `tests/cli/routes-openapi.test.ts`
- generated-client fixtures

Shared-contract files require explicit coordination:

- `src/types.ts`
- `src/kernel/route-collector.ts`
- `src/kernel/route-manifest.ts`
- `src/cli/commands/routes.ts`
- `tests/kernel/route-collector.test.ts`
- `tests/kernel/route-manifest.test.ts`
- `tests/cli/commands/routes.test.ts`

## Current state

As of this document:

- `integration/routes-auth-client` contains the client target/version work plus
  external auth assertions, creator route alias, exposed external claims, and
  safe matching-visitor claim merge. The active serialized contract slice is
  `agent.required` route auth.
- `routes-client-targets` does not contain the latest auth commits unless it
  merges or restarts from integration.

The client window should not continue contract-sensitive work from
`routes-client-targets` until it ingests `integration/routes-auth-client` or
creates a fresh continuation branch from integration.

## Serialized split: `agent.required`

`agent.required` is a serialization point.

Reason: it changes the route auth union, runtime authorization, route manifest,
generated client target filtering, and OpenAPI security. If auth adds the mode
without client handling, browser clients can accidentally include an agent-only
route or generated unions can drift. If client prepares support without the
runtime type, fixtures become artificial.

This must land as one integration slice:

1. Add `agent.required` to route auth types and route collection validation.
2. Resolve agent route credentials with the existing `x-agent-id` and
   `x-agent-secret` mechanism.
3. Add an agent route principal/context shape.
4. Classify `agent.required` as private in manifests and doctor output.
5. Make generated browser clients omit `agent.required`.
6. Make generated server clients include `agent.required` only if server config
   has agent credentials.
7. Export OpenAPI security for agent credentials, likely `apiKey` headers for
   `x-agent-id` and `x-agent-secret`.
8. Add focused runtime, manifest, client, and OpenAPI tests.

After this lands on integration, the client track can safely continue with
client ergonomics or response-schema work from the updated contract, after
merging or restarting from integration.

## Handoff wording

Use this shape when passing work between windows:

```text
Branch:
Commit:
Changed surfaces:
Verification:
Other window:
Next safe slice:
Stop condition:
```

The important line is `Other window`. It should be one of:

- `can proceed without syncing`
- `must merge integration first`
- `wait for integration slice`
- `pause, shared contract is changing`
