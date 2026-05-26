/**
 * Boot a small live agent with the /admin route enabled so we can poke at
 * the SPA in a browser. Picks up the freshly-built admin/dist/.
 *
 *   bun --hot scripts/dev-admin.ts
 *
 * Then open http://localhost:8081/admin — bearer is "dev-admin" (use the
 * browser's native Sign-In prompt: leave username blank, paste the bearer
 * into the password field).
 *
 * --hot is important: it patches server module changes in place without
 * killing the process. Without it, every code restart drops the browser's
 * cached HTTP Basic credentials and re-prompts the operator.
 *
 * When YOU NEED to restart vs. don't:
 *   - SPA-only changes (anything under `admin/src/`): just rebuild
 *     (`cd admin && bun run build`) and refresh the browser. The agent
 *     serves `admin/dist/` from disk on every request, no restart needed.
 *   - Server-side changes (`src/transports/admin/`, `src/types.ts`, augment
 *     factory edits): --hot reloads them in place. Process keeps running,
 *     browser auth stays cached.
 *   - agent.yaml / .env edits: need a full restart (agent loads them at boot).
 *
 * The agent mounts the same augment family as test_agent's agent.yaml so the
 * Augments tab reflects a realistic operator surface, minus the augments
 * that need external creds (visitor-auth, telegram-transport, link).
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { mkdtempSync } from "node:fs";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { bash } from "@/augments/bash";
import { budgets } from "@/augments/budgets";
import { fileMemory } from "@/augments/file-memory";
import { filesystem } from "@/augments/filesystem";
import { layeredMemory } from "@/augments/layered-memory";
import { notify } from "@/augments/notify";
import { orgContext } from "@/augments/org-context";
import { skills } from "@/augments/skills";
import { turnControl } from "@/augments/turn-control";
import { webFetch } from "@/augments/web-fetch";
import { webTransport } from "@/transports/web-transport";
import { copyBundledSkill } from "@/cli/scaffold-skills";
import { createMockModel } from "@tests/fixtures/mock-model";

const BEARER = "dev-admin";
const PORT = 8081;

const agentDir = mkdtempSync(join(tmpdir(), "auggy-admin-demo-"));
console.log(`[dev-admin] tempDir = ${agentDir}`);

// Stage workspace + skills dir + a stub org-context manifest + a `learned`
// file so every mounted augment has real backing state to show in the SPA.
const workspaceDir = join(agentDir, "workspace");
const skillsDir = join(agentDir, "skills");
const orgDir = join(agentDir, "org-context");
mkdirSync(workspaceDir, { recursive: true });
mkdirSync(skillsDir, { recursive: true });
mkdirSync(orgDir, { recursive: true });
writeFileSync(join(agentDir, "learned.md"), "# Learned notes\n\n(empty)\n", "utf-8");
// Seed a small .env so the Credentials tab has something to render.
writeFileSync(
  join(agentDir, ".env"),
  [
    "# Demo credentials — these are not real keys.",
    "AUGGY_WEB_TOKEN=dev-admin",
    'AUGGY_AGENT_ID="aug1_demo-0000-0000-0000-000000000000"',
    "ANTHROPIC_API_KEY=sk-ant-demo-0000000000000000000000000000",
    "AGENTMAIL_API_KEY=am-demo-fake-1234567890",
    "AGENTMAIL_INBOX_ID=inbox_demo",
    "",
    "# Toggle to enable richer demo behavior.",
    "DEMO_FLAG_VERBOSE=true",
    "",
  ].join("\n"),
  "utf-8",
);
writeFileSync(
  join(agentDir, "identity.md"),
  [
    "# demo agent",
    "",
    "You are demo, a dev-mode auggy agent used to exercise the /admin SPA.",
    "Be friendly, terse, and never pretend to be more than you are.",
    "",
    "## Operating principles",
    "",
    "- Answer directly. Avoid hedging.",
    "- When unsure, call request_input rather than guess.",
    "- All tool use stays within the mounted augments.",
    "",
    "## Operator",
    "",
    "Your operator is Mike. Defer to operator preferences when they conflict",
    "with general best practice.",
    "",
  ].join("\n"),
  "utf-8",
);

// Mirror what `auggy create` / `auggy add` do: copy each bundled skill into
// the agent's skills/ dir so the operator's "Missing skills" view in /admin
// is empty by default (the normal state).
for (const type of [
  "bash",
  "filesystem",
  "layeredMemory",
  "notify",
  "orgContext",
  "turnControl",
  "webFetch",
]) {
  copyBundledSkill(type, agentDir);
}
// Stub agent.yaml so the admin sidebar can surface real identity from disk.
writeFileSync(
  join(agentDir, "agent.yaml"),
  [
    "id: aug1_demo-0000-0000-0000-000000000000",
    "name: demo",
    "purpose: dev-mode demo agent for the admin SPA",
    "operators:",
    "  - Mike",
    "identity: ./identity.md",
    "",
  ].join("\n"),
  "utf-8",
);
writeFileSync(
  join(orgDir, "manifest"),
  JSON.stringify(
    {
      org: "demo-lab",
      purpose: "A dev-mode org-context stub for the admin SPA.",
      operator: "Mike",
      phase: "v0.3",
      endpoints: [
        { path: "/about", method: "GET", description: "About this lab." },
        { path: "/projects", method: "GET", description: "Current projects." },
      ],
    },
    null,
    2,
  ),
  "utf-8",
);

const model = createMockModel();
const mem = await layeredMemory({
  backend: "sqlite",
  namespace: "demo",
  dbPath: join(agentDir, "memory.db"),
  autoSave: { enabled: false },
});

// Seed one memory row so the table + row-action UI has something to render.
await mem.memory!.write!("demo:vis_alice:greeting", "hello world", {
  peerId: "vis_alice",
  trustLevel: "public",
});

const agent = defineAgent(
  {
    name: "demo",
    model: "mock",
    augments: [
      webTransport({
        port: PORT,
        auth: { type: "bearer", token: BEARER },
        allowAnonymous: false,
        adminRoute: true,
        agentDir,
      }),
      fileMemory({
        label: "learned",
        source: join(agentDir, "learned.md"),
        mutable: true,
        origin: "system",
        priority: "evictable",
        placement: "preamble",
        eviction: "drop",
      }),
      filesystem({
        mounts: [
          { name: "workspace", path: workspaceDir, writable: true, deletable: true },
          { name: "skills", path: skillsDir, writable: false },
        ],
      }),
      mem,
      webFetch({ timeoutMs: 15000 }),
      orgContext({ baseUrl: `file://${orgDir}` }),
      bash({ risk: "restricted", allowedCommands: ["ls", "pwd", "echo", "cat", "date"] }),
      budgets({
        dbPath: join(agentDir, "budgets.db"),
        agentDir,
        dailyBudgetUsd: 5,
        caps: { agent: { maxUsdPerDay: 2 } },
      }),
      notify({
        destinations: [
          { name: "creator", transport: "log-to-file", path: join(agentDir, "notifications.jsonl") },
        ],
        rateLimit: {
          cooldownMs: 120000,
          globalMaxPerHour: 5,
          dedupWindowMs: 300000,
          dedupThreshold: 0.6,
          perPeerCooldownMs: 30000,
        },
        agentDir,
      }),
      turnControl(),
      skills({ dir: skillsDir }),
    ],
  },
  model,
);

await agent.start();
console.log(`[dev-admin] running at http://localhost:${PORT}/admin`);
console.log(`[dev-admin] bearer: ${BEARER}`);
console.log(`[dev-admin] press Ctrl-C to stop.`);

for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, async () => {
    console.log(`\n[dev-admin] ${sig} — stopping...`);
    await agent.stop();
    process.exit(0);
  });
}
