# Security Policy

## Supported versions

Only the latest minor release receives security patches.

| Version | Supported          |
| ------- | ------------------ |
| 0.2.x   | :white_check_mark: |
| < 0.2   | :x:                |

Auggy is pre-1.0. Breaking changes between minor versions are possible. Pin to an exact version in production until 1.0.

## Reporting a vulnerability

**Do not open a public GitHub issue for a security vulnerability.**

Use one of these private channels instead:

1. **GitHub Private Vulnerability Reporting** (preferred) — open a report from the [Security tab](https://github.com/looselyorganized/augment-1/security/advisories/new) of this repo.
2. **Email** — `security@lorf.dev`. Encrypt with PGP if the vulnerability is sensitive (key on request).

Please include:

- A description of the vulnerability and its impact.
- The Auggy version (`git rev-parse HEAD` if working from source) and runtime (`bun --version`).
- A reproduction — proof-of-concept code, a failing test, or step-by-step instructions.
- Whether the report is on behalf of an organization, and whether you'd like public credit in the advisory.

## What to expect

| Stage | Target |
| --- | --- |
| Acknowledgement | within 3 business days |
| Initial triage + severity | within 7 business days |
| Fix or mitigation | depends on severity; high/critical issues prioritized over feature work |
| Public disclosure | coordinated — typically within 14 days of fix availability |

This is a small project. We do best-effort response, not a contractual SLA.

## Scope

In scope:

- The Auggy runtime — `src/kernel/`, `src/augments/`, `src/engines/`, `src/transports/`, `src/memory/`, `src/cli/`.
- The CLI tooling and launchd integration.
- The reference docs under `docs/` if they describe a security property the implementation doesn't actually have.

Out of scope:

- Vulnerabilities in upstream dependencies (`@anthropic-ai/sdk`, `openai`, `@supabase/supabase-js`, etc.) — please report those upstream. We will pin or patch a fixed version once one exists.
- LLM-side prompt-injection attacks that don't bypass an explicit Auggy security boundary. (Prompt injection that escalates trust level, exfiltrates `creator`-only memory, or evades the capability table is in scope.)
- Issues that require physical access to the operator's machine.
- Issues in agent identity files (`identity.md`) authored by the operator.

## Hall of fame

Reporters who follow this policy will be credited in the published advisory and the relevant `CHANGELOG.md` entry, unless they request anonymity.
