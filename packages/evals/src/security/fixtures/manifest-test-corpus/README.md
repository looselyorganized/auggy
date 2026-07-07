# manifest test corpus

This directory is a synthetic org-knowledge corpus consumed by the security
eval fixture via the manifest augment's `file://` baseUrl scheme.

The corpus is generic — it contains no LORF-specific content and no
references to any real organization. It exists solely to give the eval
suite a concrete `manifest_fetch` surface to test against (benign-suite cases
that exercise legitimate org-info questions, plus any future adversarial
cases that probe the manifest attack surface).

## Layout

- `manifest` — JSON listing of advertised endpoints (no extension; the
  manifest file:// scheme reads this file literally as `manifest`)
- `about.md`, `products.md`, `team.md` — top-level endpoint targets
- `policies/return-policy.md`, `policies/pricing-policy.md` — nested-path
  endpoints, exercising the `.md` fallback path the augment uses for file://

## Maintenance

If you regenerate or modify this corpus, update the matching benign-suite
cases in `packages/evals/src/security/benign.yaml` so the `response_contains_any`
needles still hit. The synthetic terms intentionally include distinctive
phrases ("Acme Test Foundry", "Standard Widget", "Premium Gizmo",
"Training Kit") so the graders have a reliable signal that the agent
actually consulted org content rather than hallucinating.

## Portability

This corpus contains no operator-specific information. Forks that ship
their own org content can either replace these files or point manifest
at a different `baseUrl` in `agent.yaml`.
