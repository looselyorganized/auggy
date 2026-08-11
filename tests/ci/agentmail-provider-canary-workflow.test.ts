import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  runAgentMailProviderCanary,
  type AgentMailCanaryDependencies,
} from "../../scripts/agentmail-provider-canary";

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

  test("checks out the approved immutable commit with pinned actions and no credential", () => {
    const { workflow } = readCanaryWorkflow();
    const steps = workflow.jobs?.canary?.steps ?? [];
    const checkout = steps.find((step) => step.name === "Checkout approved dispatch commit");
    const setupBun = steps.find((step) => step.name === "Setup Bun");

    expect(checkout?.uses).toMatch(/^actions\/checkout@[0-9a-f]{40}$/);
    expect(checkout?.with).toEqual({
      ref: "${{ github.sha }}",
      "persist-credentials": false,
    });
    expect(setupBun?.uses).toMatch(/^oven-sh\/setup-bun@[0-9a-f]{40}$/);
  });

  test("exposes the environment-only account key only to the final canary step", () => {
    const { source, workflow } = readCanaryWorkflow();
    const steps = workflow.jobs?.canary?.steps ?? [];
    const finalStep = steps.at(-1);
    const secretReference = "${{ secrets.AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY }}";

    expect(finalStep?.run).toBe("bun scripts/agentmail-provider-canary.ts");
    expect(finalStep?.env).toEqual({
      AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY: secretReference,
    });
    expect(steps.slice(0, -1).every((step) => step.env === undefined)).toBe(true);
    expect(source.match(/secrets\.AGENTMAIL_CANARY_ACCOUNT_API_KEY_ENV_ONLY/g)).toHaveLength(1);
    expect(source).not.toMatch(/secrets\.AGENTMAIL_CANARY_ACCOUNT_API_KEY(?:\s|})/);
    expect(source).not.toContain("secrets: inherit");
  });

  test("keeps the maintainer canary out of the published package surface", () => {
    const packageJson = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      files?: string[];
      scripts?: Record<string, string>;
    };

    expect(packageJson.scripts?.["canary:agentmail"]).toBeUndefined();
    expect(packageJson.files).not.toContain("scripts");
  });

  test("uses one stable client_id and never mutates AgentMail API keys", () => {
    const source = readFileSync(CANARY_PATH, "utf8");

    expect(source).toContain(
      'const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";',
    );
    expect(source).toContain('const CANARY_EMAIL = "auggy-release-canary-7d2c91f4@agentmail.to";');
    expect(source.match(/provisioner\.createInbox\(request\)/g)).toHaveLength(2);
    expect(source).toContain("first.email !== CANARY_EMAIL");
    expect(source).toContain("provisioner.listInboxes(accountApiKey)");
    expect(source).toContain("inbox.clientId === CANARY_CLIENT_ID");
    expect(source).not.toContain("createInboxApiKey");
    expect(source).not.toContain("inboxes.apiKeys");
    expect(source).not.toContain("client.inboxes.delete");
    expect(source).not.toMatch(/\.(?:sendMessage|sendMail|createRuntimeKey)\s*\(/);
    expect(source).not.toContain("error.providerCode");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*CANARY_EMAIL/);
  });

  test("uses the exact supplied key for inbox creation and ownership reads", async () => {
    const fixture = fakeCanary();

    await runAgentMailProviderCanary(fixture.dependencies);

    expect(fixture.inboxRequests).toHaveLength(2);
    expect(fixture.inboxRequests[0]).toEqual(fixture.inboxRequests[1]);
    expect(fixture.inboxRequests).toEqual([
      expect.objectContaining({ apiKey: "am_account_canary_not_real" }),
      expect.objectContaining({ apiKey: "am_account_canary_not_real" }),
    ]);
    expect(fixture.inboxListRequests).toEqual(["am_account_canary_not_real"]);
  });

  test("fails closed when read-only account inventory cannot prove the fixed inbox identity", async () => {
    const fixture = fakeCanary();
    const provisioner = fixture.dependencies.provisioner!;
    fixture.dependencies.provisioner = {
      ...provisioner,
      async listInboxes() {
        return [
          {
            inboxId: "inb_canary",
            email: "auggy-release-canary-7d2c91f4@agentmail.to",
            clientId: "some.other.integration",
          },
        ];
      },
    };

    await expect(runAgentMailProviderCanary(fixture.dependencies)).rejects.toThrow(
      /did not contain exactly one matching fixed canary inbox\/client_id/,
    );
  });
});

function fakeCanary(): {
  dependencies: AgentMailCanaryDependencies;
  inboxRequests: unknown[];
  inboxListRequests: string[];
} {
  const inboxRequests: unknown[] = [];
  const inboxListRequests: string[] = [];
  const provisioner: NonNullable<AgentMailCanaryDependencies["provisioner"]> = {
    async createInbox(input) {
      inboxRequests.push(input);
      return {
        inboxId: "inb_canary",
        email: "auggy-release-canary-7d2c91f4@agentmail.to",
        displayName: "Auggy release provider canary",
      };
    },
    async listInboxes(apiKey) {
      inboxListRequests.push(apiKey);
      return [
        {
          inboxId: "inb_unrelated",
          email: "unrelated@agentmail.to",
          clientId: "some.other.integration",
        },
        {
          inboxId: "inb_canary",
          email: "auggy-release-canary-7d2c91f4@agentmail.to",
          clientId: "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail",
        },
      ];
    },
  };

  return {
    dependencies: {
      accountApiKey: "am_account_canary_not_real",
      provisioner,
    },
    inboxRequests,
    inboxListRequests,
  };
}
