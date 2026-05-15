# Auggy — Backlog

Running list of known bugs, UX issues, and small improvements discovered during real use. Not a roadmap — roadmap lives at `lo/docs/auggy-plans-detail.md`. This is the "grab one when you have a spare hour" list.

Format: `- [ ] [category] description (context: where/when found)`

---

## Bugs

- [x] ~~**[engine+transport] Token streaming in Anthropic engine + AG-UI delta events.**~~ — shipped: `messages.stream()` in Anthropic adapter with `onDelta` callback, `text_message_start`/`text_message_delta`/`text_message_end` KernelEvents, AG-UI translator routes deltas 1:1 to `TEXT_MESSAGE_CONTENT`. Turn loop emits start/delta/end with error cleanup (closes stream on error). Non-streaming engines backward compat via existing `text_message` triple.
- [x] ~~**[webTransport] Bun.serve idleTimeout.**~~ — shipped: `idleTimeout: 120` in `Bun.serve()`. Streaming keeps the pipe warm; this is the safety net for long tool executions.
- [x] ~~**[notify] Rate limiting + deduplication for outbound escalations.** Prevent operator-attention DoS. Per-peer/session cooldown on `notify` calls, deduplication window for similar summaries, circuit breaker on repeated abuse from the same peer. Tool-level rate limit, not transport-level. Surfaced during red-team session (2026-04-16). Shipped in Phase A (feat/notify-and-telegram-transport): `src/augments/notify.ts` rate-limits per peer with sliding window + dedup key.~~

## UX

- [ ] **[CLI]** Scaffold should create `.env` directly instead of `.env.example` + copy step. Two-step copy is friction; users hit "env var missing" errors on first boot.
- [ ] **[CLI]** `auggy create` from wrong directory (e.g. a sibling project's checkout) scaffolds `<wrong-dir>/<name>/` without warning. Should detect or ask "create here?".
- [ ] **[CLI]** Missing `auggy remove <name>` command. Today you have to `rm -rf` the directory manually after a failed `auggy create`.
- [ ] **[CLI]** Env var error messages list missing vars but don't say "add these to your .env" or show the file path.
- [ ] **[CLI]** `auggy create` — replace the free-text model input with a `select()` dropdown of known models per provider (Claude Sonnet/Opus/Haiku, GPT-5/o3, OpenRouter top models), with "custom" option for typing a model slug. Currently operators have to know the exact model string.

## Polish

- [ ] **[org-context]** Retry-at-boot message says "running without org context" — should also say "lazy retry on first org_fetch" so operator doesn't restart unnecessarily.
- [ ] **[scaffold]** `agent.yaml` comments could include engine provider options (currently only shows anthropic as the default).

## v1.0 concierge-readiness

Captured 2026-05-14 during a strategic pass on the v1.0 adoption case (single-owner concierge / front-door agent thesis). Items tiered by whether the thesis is structurally broken without them. Tier 1 is the v1.0 ship gate; Tier 2 is launch polish; Tier 3 is post-v1.0.

### Tier 1 — blocks v1.0

- [ ] **[chat]** Fix `auggy chat` ↔ scaffold bearer-name mismatch (`AUGGY_WEB_TOKEN` vs `WEB_BEARER_TOKEN`). Scaffold writes one, `chat/src/lib/bearer.ts` reads the other; both sides have passing tests but neither cross-checks. Freshly scaffolded agent fails its first GUI connect. (G12, ~30 min)
- [ ] **[posture]** Flip anonymous-public from silent default to explicit opt-in via `webTransport.allowAnonymous` (default false in production scaffold profile, true in dev). Today Path 4 silently accepts unauthenticated turns on any public Railway URL. Update security eval suite to cover the gated posture. (G3, ~1 day)
- [ ] **[visitor-auth]** Ship a console-log adapter so OSS adopters can test the magic-link flow without paying for AgentMail. Today `AGENTMAIL_API_KEY` is required; OSS adopters cannot run the visitor-recognition flow end-to-end without a third-party signup. (G34, ~half-day)
- [ ] **[docs]** Write `docs/20-embedding.md` — copy-paste recipe for integrating a Next.js chat surface (the LORF platform pattern, OSS-friendly). Includes server-proxy bearer pattern, env-var setup, security notes. (G1, ~1 hour)
- [ ] **[process]** Run end-to-end DX walkthrough (`auggy create → dev → chat → visitor-auth → memory → notify`). Includes error-path coverage (G29), security-eval update for gated posture (G30), bash-can't-read-`.env` verification (G31), `auggy dev` observability check (G37). (G8, ~3-4 hours)
- [ ] **[chat]** Bake a minimal `/chat` HTML page into `webTransport`, served at `GET /` when no `publicFrontendUrl` is set. Localhost-default-on; public deploys gate behind visitorAuth's verify-email flow (depends on G3). Self-contained HTML+JS speaking AG-UI to `/agent/run`. (G2, ~half-day)
- [ ] **[engines]** Verify the OpenAI adapter works pointed at an Ollama HTTP endpoint (`OPENAI_BASE_URL`); document or ship an `ollama` engine if needed. The "free local model" adoption-case promise is currently undelivered. (G35, ~30 min verify; +1 day if engine build)
- [ ] **[examples]** Add `examples/concierge/` — vertical web-channel example (boutique store website chat + stubbed inventory module + visitor-auth + notify-to-operator). Demonstrates the augment composition pattern with a concrete domain. Instagram/SMS variants reframed as community wishlist (see `lo/docs/ROADMAP.md`). (G7, ~3-5 days)

### Tier 2 — launch polish

- [ ] **[budgets]** `auggy spend` command — operator surface for current spend by trust tier. Today operator queries SQLite directly. (G9)
- [ ] **[budgets]** Budget-threshold notify integration — fire `notify` when 80% / 100% of `dailyBudgetUsd` hits. Closes the cost-awareness loop. (G10)
- [ ] **[memory]** `auggy memory <agent> [--peer X]` — inspect/audit memory entries. Required for right-to-erasure verification and trust calibration; visually distinguishes agent-derived from creator-confirmed facts (G32). (G14)
- [ ] **[create]** Notify destination prompt inline during `auggy create`. Mirror the existing `orgContext` conditional-prompts pattern: when notify is selected, ask "webhook / Telegram / log-to-file" + capture config. (G17 revised)
- [ ] **[notify]** Ship a `log-to-file` destination adapter (`file:./notifications.jsonl`) as the zero-config default. Pairs with G17. (G18)
- [ ] **[notify]** `auggy notify test <destination>` validator — operator verifies a destination works without triggering the agent. (G19)
- [ ] **[org-context]** `auggy fact <agent> "..."` for adding org-context entries without editing files. Concrete use case: "we just got the green linen shirt in stock." (G23)
- [ ] **[deploy]** `auggy deploy logs <agent>` + post-deploy success verification (`wait-for /health = 200` after `railway up --detach`). (G25 + G26)
- [ ] **[transport]** Bearer-vs-visitor-token precedence design discussion. Today's runtime: `webTransport.identify()` Path 1 (creator) requires `__bearerValidated && !visitorPayload && !x-visitor-token` — a bearer-credentialed request that ALSO sends `x-visitor-token` (valid or stale) silently routes to Path 3/4 (visitor or anonymous). Multiple internal tests rely on this as the "admit via bearer, identify as visitor" pattern (`tests/integration/visitor-auth-flow.test.ts`, `tests/transports/web-transport.test.ts` — 5+ call sites). Codex round-6 review flagged this as a footgun for any future widget that accidentally forwards both headers (creator silently demoted to anonymous, hits anonymous budgets, writes anon-* memory). Decide between: (a) keep current ("explicit visitor-token signal wins"), (b) flip to bearer-wins (closes the footgun, requires updating 5+ tests + visitorAuth's documented test pattern), (c) reject mixed headers with 400 (most explicit, breaks adopters mid-migration). Pinned by `tests/integration/embedding-primitives.test.ts` ("valid bearer + stale x-visitor-token → public/anonymous"). Touches identity semantics; threat model belongs with the change. (G38, ~half-day to a day depending on choice + test refactor scope)

### Tier 3 — defer past v1.0

- [ ] **[chat-widget]** Publish `@auggy/chat-widget-react` (+ optional `@auggy/next` route helper) and/or a Web Component embed. v1.0 ships primitives reference only (`docs/20-embedding.md`) — packaged widget shape benefits from real adopter feedback (looselyorganized.xyz first). Generative-UI vision: components Auggy emits via tool calls (DossierCard, ChoicePrompt, FormBubble, etc.) using the existing AG-UI `TOOL_CALL_*` payload as the render contract — no runtime protocol changes. (G1 packaged + G37 ui-kit)
- [ ] **[link]** Mesh-vs-tunnel design resolution (npm-bundled mesh vs explicit per-peer config). (G4)
- [ ] **[creator-identity]** Multi-operator distinguishing — today single shared bearer = single "creator." Confirmed OK for v1.0 single-owner concierge thesis. (G11)
- [ ] **[trust]** `staff` (intermediate) trust tier between creator and public. Needed for HVAC-dispatcher-style scenarios; v1.1+. (G13)
- [ ] **[memory]** Row-count cap on layeredMemory entries (today `retentionDays: 90` is time-only). Slow growth at typical traffic; verify with monitoring before adding. (G15)
- [ ] **[org-context]** Naming + mode-signal clarity (`baseUrl: file://` default vs catalog description saying "API"). Don't rename in v1.0. (G21 + G22)
- [ ] **[deploy]** Other cloud targets (Fly, Render, custom Docker). Railway is v1.0 scope. (G24)

## OSS launch — open questions

- [ ] **[docs] How do we document the user-facing API surface?** We don't have an "SDK" per se — `defineAgent`, `defineAugment`, `defineTool` plus the engines is a small surface. The `docs/01-12-*.md` reference set is contributor-facing, not user-facing. Decide between: (a) one `docs/00-api-reference.md` page that lists each public function with signature + one example (cheap, ~1 hour), (b) auto-generated TypeDoc reference (medium, half-day), (c) a real docs site (Mintlify / Nextra / Starlight, hosted on a subdomain TBD, ~half-day). v0.3.1 shipped without this; revisit pre-OSS-launch. Surfaced 2026-04-28 during OSS readiness audit.
- [ ] **[examples] Do we ship `examples/` clone-and-run agent templates?** `scripts/hello.ts` is a one-shot demo, not a starter template. Candidates if we do: `examples/slack-bot/`, `examples/cli-chat/`, `examples/research-agent/`, `examples/coding-agent/`. Cost: each example is a maintained reference that breaks when the API moves. Benefit: answers "how do I X?" before the issue is filed. Decide between: defer until the first issue asks for it, or seed with 2-3 at launch. Surfaced 2026-04-28 during OSS readiness audit.
- [ ] **[architecture] Investigate cross-augment dependencies — what works with what, and how do we express it?** PR γ.2 (visitorAuth) surfaced this as a real question: visitorAuth's revocation-check needs webTransport's visitor-token verify path, requiring a deferred-closure wiring through `auggy resolver` because both augments are constructed independently. visitorAuth + layered-memory also have a coordination gap (Codex review H4 — promotion-flush after verify undoes peer-id migration). visitorAuth + webTransport's `agentBinding` mismatch silently strands visitors — we shipped a boot-time check, but that pattern doesn't generalize. Other likely-coupled pairs: notify ↔ telegramTransport (both use telegram-client.ts), turnControl ↔ webTransport (request_input semantics on streaming transport), bash ↔ filesystem (workspace mount visibility). Investigate: do we need a declared `requires` / `optionalCoordinatesWith` field on `Augment`? A topological resolver pass? A documented "augment compatibility matrix"? A general "cross-augment config consistency" validator? Spec needs to consider: silent failures (a depends on b but b is absent → degraded behavior), version skew (a expects b@v1, gets b@v2), and circular coupling. Surfaced 2026-05-08 during PR γ.2 implementation.
- [ ] **[setup-experience] Augment setup wizards — automate the cross-system bootstrap.** Each "real" augment requires the operator to wire up external dependencies before it works. visitorAuth needs 5 env vars (`AGENTMAIL_API_KEY`, `AGENTMAIL_INBOX_ID`, `AUGGY_PUBLIC_URL`, `VISITOR_SIGNING_KEY`, `AUGGY_AGENT_ID`); `notify` needs per-adapter creds (webhook URL, Telegram bot token, AgentMail key); `telegramTransport` needs a bot token + (in webhook mode) a public URL + secret; `orgContext` needs an API URL + token. The current scaffold drops template `${VAR}` placeholders into `.env.example` and tells the operator to fill them in — high friction at first-run. Automation tiers: (1) **Trivially automatable now** — `auggy add visitor-auth` runs `openssl rand -hex 32` for `VISITOR_SIGNING_KEY`; defaults `AUGGY_AGENT_ID` to the agent's name. (2) **API-integrated** — call AgentMail's create-inbox API for `AGENTMAIL_INBOX_ID`; ping `inboxes.list` to validate `AGENTMAIL_API_KEY` at setup-time instead of boot-time. Same shape for Telegram's `getMe`. (3) **Deployment-platform-aware** — auto-derive `AUGGY_PUBLIC_URL` from `RAILWAY_PUBLIC_DOMAIN` / `FLY_APP_NAME.fly.dev`; for local dev, integrate with `ngrok start` / `cloudflared tunnel`. (4) **Stays manual** — third-party signups (AgentMail account creation) can't be automated, but a documented walkthrough helps. Natural unit of work: an `auggy add <augment> --auto` mode + per-augment `setup()` hook in the catalog that knows how to bootstrap its dependencies. Plus per-platform `auggy deploy --auto-public-url`. Land this AFTER PRs 1-6 of the visitorAuth follow-ups; targets pre-OSS-launch when first-run friction becomes the dominant signal. Surfaced 2026-05-08 during visitorAuth ops walkthrough.

## Post-ship augments (separate roadmap entries, captured here for cross-reference)

- [x] ~~bashAugment~~ — shipped: `bash` augment with risk presets (scripts-only / restricted / standard / unrestricted), Layer 1 trust gating, named scripts, env sanitization. See `src/augments/bash.ts`.
- [ ] hooksAugment — PreToolUse/PostToolUse with Claw's exit-code contract
- [ ] **Memory Layer Architecture** — L0-L3 hierarchy with promotion rules, per-layer trust gating, consolidation pipeline, peer-scoped retrieval. Supersedes compactHistory (compaction is a bridge, not the architecture). **Planning brief:** [`docs/memory-layer-architecture-brief.md`](./memory-layer-architecture-brief.md). Large multi-session project — design session first.
- [ ] projectInstructions — AUGGY.md ancestor walk pattern
- [ ] Permission-mode ladder in agent.yaml
- [ ] researchAugment — web search + arxiv + document analysis for agents that need to look things up. Could wrap Brave/Tavily/Firecrawl; tools: `research_search`, `research_fetch_paper`, `research_summarize`. Progressive disclosure pattern.

## Aspirational (Plan 8+ / v2.0 Progressive Autonomy)

- [ ] **Self-extending agents** — agents can create their own augments and skills. Tools: `augment_create` (writes `.ts` file to `augments/` directory), `skill_create` (writes `SKILL.md`), `augment_install` (adds to agent.yaml, triggers restart). Blocks on: (1) hot-reload (Plan 8+ — today restart is required), (2) sandboxing to prevent escape (V8 isolates or similar), (3) operator approval flow for self-generated code (Layer 3 trust), (4) evals to measure whether self-generated augments actually improve agent quality (Plan 7). Significant feature — don't underestimate. Connects directly to v2.0 "Progressive Autonomy" in the LORF roadmap. Should be gated behind operator trust and a clear approval UX. Research: see `augment-1/docs/research/skill-folder-pattern-2026-04-09.md` for the self-authoring skill pattern.

---

When you fix something, remove the line. When you discover something, add it. If an item grows into a real project, move it to the roadmap.
