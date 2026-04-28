/**
 * Hello world — OpenAI engine variant.
 *
 * Mirrors scripts/hello.ts but drives an agent via OpenAI's Chat Completions
 * API instead of Anthropic. Proves the OpenAI engine wires through to the
 * kernel, transport, and tool layers identically.
 *
 * Run:
 *   export OPENAI_API_KEY=sk-...
 *   bun run scripts/hello-openai.ts
 *
 * Then, from another terminal:
 *
 *   curl -N -X POST http://localhost:8081/agent/run \
 *     -H "authorization: Bearer dev-token" \
 *     -H "x-peer-id: curl-test" \
 *     -H "content-type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"hello, who are you?"}]}'
 *
 * Also try (proves reasoning_effort gets forwarded):
 *   Set OPENAI_MODEL=o3 and uncomment the reasoningEffort line below.
 *
 * Stop with Ctrl-C.
 */
import { join } from "node:path";
import { defineAgent, fileMemory, webTransport, createOpenAIEngine } from "../src/index";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("ERROR: OPENAI_API_KEY not set.");
  console.error("Run: export OPENAI_API_KEY=sk-...");
  process.exit(1);
}

const modelId = process.env.OPENAI_MODEL ?? "gpt-5";

const model = createOpenAIEngine({
  apiKey,
  model: modelId,
  // reasoningEffort: "medium",  // uncomment for o-series / gpt-5 reasoning
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
  port: 8081,
  auth: { type: "bearer", token: "dev-token" },
});

const agent = defineAgent(
  {
    name: "hello-openai",
    purpose: "throwaway test agent proving the OpenAI engine end-to-end",
    model: modelId,
    augments: [identity, transport],
  },
  model,
);

await agent.start();

console.log("─".repeat(60));
console.log(`Auggy hello-openai agent (${modelId}) on http://localhost:8081`);
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
