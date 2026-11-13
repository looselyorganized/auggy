import type { ApplicationRecipe } from "./application-consumer";

/** Explicit owner-reviewed reference schema, not a generated imitation of the app. */
export const INSPECTABLE_APPLICATION_RECIPE: ApplicationRecipe = {
  entrypoint: "src/index.ts",
  sourceFiles: [
    "package.json",
    "tsconfig.json",
    "agent.yaml",
    "identity.md",
    "README.md",
    ".env.example",
    ".gitignore",
    "src/index.ts",
    "src/agent.ts",
    "src/http.ts",
    "src/turn.ts",
    "src/observability.ts",
    "src/augments/example/index.ts",
    "src/augments/example/schemas.ts",
    "src/augments/example/service.ts",
    "src/augments/example/skill/SKILL.md",
    "tests/example.test.ts",
  ],
  edits: {
    startup: {
      path: "src/index.ts",
      before: 'const startupLabel = "inspectable-agent";',
      after: 'const startupLabel = "application-startup-edited";',
    },
    http: {
      path: "src/http.ts",
      before: 'const applicationHeader = "inspectable-agent";',
      after: 'const applicationHeader = "application-http-edited";',
    },
    turn: { path: "src/turn.ts", before: "maxInferences: 2,", after: "maxInferences: 1," },
  },
  tool: {
    name: "example_get_order",
    input: { orderId: "DEMO-1001" },
    invalidInput: { orderId: 17 },
  },
  userMessage: "Use example_get_order to read order DEMO-1001 and report its status.",
  evidenceFiles: {
    startup: "data/observability/startup.jsonl",
    trace: "data/observability/turns.jsonl",
    finalization: "data/observability/finalization.jsonl",
    toolJournal: "data/observability/tools.jsonl",
  },
};

export const INSPECTABLE_ORDER_OUTPUT = JSON.stringify({
  orderId: "DEMO-1001",
  status: "ready-for-pickup",
  itemCount: 2,
});
