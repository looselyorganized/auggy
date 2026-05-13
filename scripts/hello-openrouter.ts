/**
 * Hello world — OpenRouter engine variant.
 *
 * The primary motivating verification: drive Qwen3.5-397B-A17B (or any other
 * OpenRouter-hosted model) through Auggy. Proves the OpenRouter engine wires
 * through to the kernel, the apiKey guard fires correctly, and the typed-cast
 * pattern for OpenRouter extras (reasoning, provider routing) reaches the API.
 *
 * Run:
 *   export OPENROUTER_API_KEY=sk-or-...
 *   bun run scripts/hello-openrouter.ts
 *
 * Then, from another terminal:
 *
 *   curl -N -X POST http://localhost:8082/agent/run \
 *     -H "authorization: Bearer dev-token" \
 *     -H "x-peer-id: curl-test" \
 *     -H "content-type: application/json" \
 *     -d '{"messages":[{"role":"user","content":"hello, who are you?"}]}'
 *
 * Override the model:
 *   export OPENROUTER_MODEL=anthropic/claude-sonnet-4.5
 *   bun run scripts/hello-openrouter.ts
 *
 * Stop with Ctrl-C.
 */
import { join } from "node:path";
import { defineAgent, fileMemory, webTransport } from "../src/index";
import { createOpenRouterEngine } from "@auggy/openrouter";

const apiKey = process.env.OPENROUTER_API_KEY;
if (!apiKey) {
  console.error("ERROR: OPENROUTER_API_KEY not set.");
  console.error("Run: export OPENROUTER_API_KEY=sk-or-...");
  process.exit(1);
}

const modelId = process.env.OPENROUTER_MODEL ?? "qwen/qwen3.5-397b-a17b";

const model = createOpenRouterEngine({
  apiKey,
  model: modelId,
  // Qwen3.5-397B-A17B native context is 262K. Conservative default 128K
  // works fine for hello-world; bump if the prompt grows.
  // maxContextTokens: 262_000,
  // reasoningEffort: "medium",  // uncomment to engage thinking mode
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
  port: 8082,
  auth: { type: "bearer", token: "dev-token" },
});

const agent = defineAgent(
  {
    name: "hello-openrouter",
    purpose: "throwaway test agent proving OpenRouter (Qwen3.5) end-to-end",
    model: modelId,
    augments: [identity, transport],
  },
  model,
);

await agent.start();

console.log("─".repeat(60));
console.log(`Auggy hello-openrouter agent (${modelId}) on http://localhost:8082`);
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
