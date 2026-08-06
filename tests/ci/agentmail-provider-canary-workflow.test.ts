import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const WORKFLOW_PATH = join(ROOT, ".github/workflows/agentmail-provider-canary.yml");
const CANARY_PATH = join(ROOT, "scripts/agentmail-provider-canary.ts");

interface WorkflowStep {
  name?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, unknown>;
}

interface CanaryWorkflow {
  on?: Record<string, unknown>;
  concurrency?: {
    group?: string;
    "cancel-in-progress"?: boolean;
  };
  permissions?: Record<string, string>;
  jobs?: Record<
    string,
    {
      if?: string;
      environment?: string;
      "timeout-minutes"?: number;
      steps?: WorkflowStep[];
    }
  >;
}

function readCanaryWorkflow(): { source: string; workflow: CanaryWorkflow } {
  const source = readFileSync(WORKFLOW_PATH, "utf8");
  return { source, workflow: parseYaml(source) as CanaryWorkflow };
}

describe("AgentMail provider canary trust boundary", () => {
  test("is manual-only, canonical-main-only, serialized, and least-privileged", () => {
    const { workflow } = readCanaryWorkflow();

    expect(Object.keys(workflow.on ?? {})).toEqual(["workflow_dispatch"]);
    for (const forbidden of ["push", "pull_request", "schedule", "repository_dispatch"]) {
      expect(workflow.on).not.toHaveProperty(forbidden);
    }
    expect(workflow.permissions).toEqual({ contents: "read" });
    expect(workflow.concurrency).toEqual({
      group: "agentmail-provider-canary",
      "cancel-in-progress": false,
    });

    const job = workflow.jobs?.canary;
    expect(job).toBeDefined();
    expect(job?.if).toBe(
      "github.repository == 'looselyorganized/auggy' && github.ref == 'refs/heads/main'",
    );
    expect(job?.environment).toBe("agentmail-provider-canary");
    expect(job?.["timeout-minutes"]).toBe(5);
  });

  test("checks out trusted code with pinned actions and no persisted credential", () => {
    const { workflow } = readCanaryWorkflow();
    const steps = workflow.jobs?.canary?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout trusted default branch");
    const setupBun = steps.find((step) => step.name === "Setup Bun");

    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout?.with).toEqual({
      ref: "${{ github.event.repository.default_branch }}",
      "persist-credentials": false,
    });
    expect(setupBun?.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
  });

  test("exposes the environment-only account key only to the final canary step", () => {
    const { source, workflow } = readCanaryWorkflow();
    const steps = workflow.jobs?.canary?.steps ?? [];
    const finalStep = steps.at(-1);
    const secretReference = "${{ secrets.AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY }}";

    expect(finalStep?.run).toBe("bun run canary:agentmail");
    expect(finalStep?.env).toEqual({
      AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY: secretReference,
    });
    expect(steps.slice(0, -1).every((step) => step.env === undefined)).toBe(true);
    expect(source.match(/secrets\.AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY/g)).toHaveLength(1);
    expect(source).not.toMatch(/secrets\.AGENTMAIL_CANARY_ACCOUNT_API_KEY(?:\s|})/);
    expect(source).not.toContain("secrets: inherit");
  });

  test("uses one stable client_id twice without mail or runtime-key operations", () => {
    const source = readFileSync(CANARY_PATH, "utf8");

    expect(source).toContain(
      'const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";',
    );
    expect(source.match(/provisioner\.createInbox\(request\)/g)).toHaveLength(2);
    expect(source).not.toMatch(/\.(?:sendMessage|sendMail|createApiKey|createRuntimeKey)\s*\(/);
    expect(source).not.toContain("error.providerCode");
  });
});
