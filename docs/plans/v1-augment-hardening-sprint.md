# V1 Augment Hardening Sprint

Status: historical. The hardening sprint has largely landed; remaining
pre-1.0 work should be tracked in [`../ROADMAP.md`](../ROADMAP.md) instead of
this execution plan.

## Baseline

This plan starts after PR #104 and PR #105. The implementation branch should
start from `origin/main` at or after `f4c92c3 feat(identity): canonicalize
creator identity (#105)`.

Recent hardening already merged:

- Canonical creator identity: verified creator surfaces resolve to
  `peer.id = "creator"`; `creator.displayName` is cosmetic only.
- `layeredMemory` uses peer-scoped labels, provenance, explicit memory tools,
  and cautious auto-save defaults.
- `visitorAuth` has magic-link consumption, visitor-token binding, AgentMail
  setup, console-mode deploy gates, and first-verify safeguards.
- AgentMail setup, MCP transport/config handling, and Telegram
  shutdown/failure handling have been hardened recently.

The sprint should not rewrite those systems. It should close the remaining
authority and safety gaps in the built-in augment surface before the v1 DX
walkthrough relies on them.

## Goals

- Keep the default `auggy create` profile safe under the current
  `creator | agent | public` trust model.
- Make side-effecting augment authority structural, not prompt-only.
- Preserve preview status for augments whose trust or deployment model is not
  ready for safer defaults.
- Keep every change PR-sized, testable, and local to the affected augment.

## Non-Goals

- Do not introduce the future granular trust model in this sprint.
- Do not implement staff/multi-operator identity.
- Do not change `examples/concierge/` yet.
- Do not redesign hardened systems that already landed unless a specific
  regression is found.

## Hardening Order

### 1. `fileMemory` learned-memory authority

Risk: the scaffolded learned-memory file is mutable and currently lands as
system-origin preamble context. Self-written memory must not silently become
system-weight context.

Plan:

- Change the built-in learned-memory default to agent-origin context.
- Keep identity memory separate: immutable, operator-origin, system-placement.
- Add CLI scaffold coverage that asserts the generated `fileMemory` learned
  config is not `origin: system`.

Acceptance:

- Fresh agents still create `learned.md`.
- Generated learned memory remains mutable.
- Generated learned memory is not system-origin.
- Existing explicit operator-authored `fileMemory` configs are unchanged.

### 2. `filesystem` mount-root removal guard

Risk: `fs_remove` can reach the empty-directory branch before checking whether
the target is the mount root.

Plan:

- Resolve the mount root before deletion.
- Reject mount-root deletion before file/directory deletion branches.
- Add a focused test for an empty deletable mount root.

Acceptance:

- `fs_remove("mount")` returns a clear error and does not remove the mount.
- Removing child files and empty child directories still works.
- Existing traversal, symlink, and per-trust-level tests continue to pass.

### 3. `notify` destination authority

Risk: destinations are named and rate-limited, but they do not yet declare who
is allowed to use each destination or whether public-originated notifications
are escalation-only.

Plan:

- Add destination-level authority fields, likely `allowedTrustLevels` and an
  escalation policy for public peers.
- Keep creator bypass for rate limits, but not for malformed destination
  config.
- Add admin/diagnostic visibility for destination authority.

Acceptance:

- Public and agent peers can only notify destinations explicitly configured for
  them.
- Public-originated notifications can be constrained to escalation semantics.
- Default local file/log destination remains useful for development.

### 4. `mcp` per-server/per-tool trust enforcement

Status: implemented in this sprint branch.

Risk: MCP is an external tool bridge. Current allow/block policy and caps are
good, but MCP annotations such as destructive/open-world are advisory unless
they become structural policy.

Plan:

- Add per-server and per-tool trust exposure policy.
- Compile MCP tool annotations into default exposure or approval behavior.
- Keep remote tool descriptions/results marked as untrusted external content.

Implementation:

- `.mcp.json` Auggy policy now accepts server-level `allowedTrustLevels`.
- Per-tool `toolPolicies.<tool>.allowedTrustLevels` can narrow or explicitly
  widen one named MCP tool.
- `destructiveHint` and `openWorldHint` tools default to creator-only exposure
  unless that exact tool has an explicit trust override.
- Runtime policy compiles into Auggy `perTrustLevel.neverExpose`, so hidden MCP
  tools are withheld before model selection and denied on fabricated calls.

Acceptance:

- Destructive/open-world MCP tools are not exposed to lower-trust peers by
  default.
- Operators can explicitly opt tools into broader exposure.
- Missing policy fails closed for risky tools.

### 5. `link` remains preview

Risk: admitted peers currently collapse to `trustLevel: "agent"`, and the v1
trust model has no reduced-privilege authenticated peer tier.

Plan:

- Keep `link` preview until the granular trust model lands.
- Strengthen docs and warnings around mesh trust, bearer handling, and tool
  exposure.
- Avoid enabling `link` through future commissioning flows by default.

Acceptance:

- `link` remains absent from the default create profile.
- `auggy augment add link` remains an explicit preview action.

### 6. `bash` remains preview

Risk: bash is process execution, not sandboxing. Allowlist checks and
creator-only defaults reduce exposure but do not make it safe for broad use.

Plan:

- Keep `bash` preview.
- Strengthen add/list warnings and skill language.
- Consider cwd/argument hardening in a later pass if adopter signal requires
  bash in production agents.

Acceptance:

- Public and agent peers remain structurally blocked by default.
- Operators see clear preview/process-execution warnings.

### 7. `budgets` remains preview

Risk: budgets is a promising guardrail, but production semantics depend on
deployment topology, provider hard caps, and multi-process behavior.

Plan:

- Keep `budgets` preview.
- Document single-instance SQLite expectations and provider-cap dependency.
- Revisit default eligibility after the v1 DX walkthrough.

Acceptance:

- The augment remains explicit opt-in.
- Provider-side hard caps stay documented as the true spend backstop.

## Sprint Exit Criteria

- The default create profile no longer gives self-written memory system-origin
  authority.
- `fs_remove` cannot remove a mount root.
- Remaining side-effecting augment gaps are tracked in PR-sized follow-ups.
- Preview augments stay preview unless their structural authority model is
  resolved.
