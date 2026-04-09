/**
 * Hello world — the first concrete Auggy composition.
 *
 * What this proves:
 *  - The Anthropic engine translates AssembledPrompt ↔ Messages API correctly
 *  - fileMemory loads an identity file and surfaces it to the model via system prompt
 *  - The four generic memory tools are callable by a real model
 *  - webTransport streams AG-UI events over SSE end-to-end
 *  - defineAgent / start / stop lifecycle works against a real LLM
 *
 * Run:
 *   export ANTHROPIC_API_KEY=sk-ant-...
 *   bun run scripts/hello.ts
 *
 * Then, from another terminal:
 *
 *   curl -N -X POST http://localhost:8080/agent/run \
 *     -H "authorization: Bearer dev-token" \
 *     -H "x-peer-id: curl-test" \
 *     -H "content-type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"hello, who are you?"}]}'
 *
 * Also try:
 *
 *   curl http://localhost:8080/health
 *   curl http://localhost:8080/.well-known/agent-card.json
 *
 * Stop with Ctrl-C.
 */
import { join } from "node:path";
import {
  defineAgent,
  fileMemory,
  webTransport,
  createAnthropicEngine,
} from "../src/index";

const apiKey = process.env.ANTHROPIC_API_KEY;
if (!apiKey) {
  console.error("ERROR: ANTHROPIC_API_KEY not set.");
  console.error("Run: export ANTHROPIC_API_KEY=sk-ant-...");
  process.exit(1);
}

const model = createAnthropicEngine({
  apiKey,
  model: "claude-sonnet-4-5",
});

const identity = fileMemory({
  label: "self",
  source: join(import.meta.dir, "hello-identity.md"),
  mutable: false,
  origin: "operator",
  priority: "required",
  placement: "system",
  eviction: "never",
});

const transport = webTransport({
  port: 8080,
  auth: { type: "bearer", token: "dev-token" },
});

const agent = defineAgent(
  {
    name: "hello",
    purpose: "throwaway test agent for proving Auggy end-to-end",
    model: "claude-sonnet-4-5",
    augments: [identity, transport],
  },
  model,
);

await agent.start();

console.log("─".repeat(60));
console.log("Auggy hello-world agent running on http://localhost:8080");
console.log("─".repeat(60));
console.log("Endpoints:");
console.log("  POST /agent/run                   (AG-UI SSE)");
console.log("  GET  /health");
console.log("  GET  /.well-known/agent-card.json");
console.log("");
console.log("Bearer token: dev-token");
console.log("Press Ctrl-C to stop.");

const shutdown = async (signal: string) => {
  console.log(`\n${signal} received — shutting down...`);
  await agent.stop();
  console.log("Agent stopped cleanly.");
  process.exit(0);
};

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
