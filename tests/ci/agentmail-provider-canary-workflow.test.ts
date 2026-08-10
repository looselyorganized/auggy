import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import {
  AgentMailProvisioningResponseError,
  AgentMailProvisioningTransportError,
} from "../../src/cli/agentmail-provisioning";
import {
  runAgentMailProviderCanary,
  type AgentMailCanaryDependencies,
  type AgentMailCanaryKeyAdmin,
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

  test("uses one stable client_id and a disposable least-privilege scoped key", () => {
    const source = readFileSync(CANARY_PATH, "utf8");

    expect(source).toContain(
      'const CANARY_CLIENT_ID = "auggy.v1.inbox.aug1_7d2c91f4-8a65-4f0b-9c3d-5e6f708192ab.agentMail";',
    );
    expect(source).toContain('const CANARY_EMAIL = "auggy-release-canary-7d2c91f4@agentmail.to";');
    expect(source.match(/provisioner\.createInbox\(request\)/g)).toHaveLength(2);
    expect(source).toContain("first.email !== CANARY_EMAIL");
    expect(source).toContain("provisioner.listInboxes(accountApiKey)");
    expect(source).toContain("inbox.clientId === CANARY_CLIENT_ID");
    expect(source.match(/provisioner\.createInboxApiKey\(/g)).toHaveLength(1);
    expect(source).toContain("permissions: CANARY_KEY_PERMISSIONS");
    expect(source).toContain("client.inboxes.apiKeys.list");
    expect(source).toContain("client.inboxes.apiKeys.delete");
    expect(source).not.toContain("client.inboxes.delete");
    expect(source).not.toMatch(/\.(?:sendMessage|sendMail|createRuntimeKey)\s*\(/);
    expect(source).not.toContain("error.providerCode");
    expect(source).not.toMatch(/console\.(?:log|error)\([^\n]*CANARY_EMAIL/);
  });

  test("removes stale and newly created reserved keys while preserving unrelated keys", async () => {
    const fixture = fakeCanary();
    fixture.keys.set("key_stale", "auggy-release-canary-scoped-key-stale");
    fixture.keys.set("key_unrelated", "operator-runtime-key");

    await runAgentMailProviderCanary(fixture.dependencies);

    expect(fixture.inboxRequests).toHaveLength(2);
    expect(fixture.inboxRequests[0]).toEqual(fixture.inboxRequests[1]);
    expect(fixture.inboxListRequests).toEqual(["am_account_canary_not_real"]);
    expect(fixture.keyRequest).toMatchObject({
      inboxId: "inb_canary",
      name: "auggy-release-canary-scoped-key-123456789",
      permissions: { inbox_read: true, message_send: true },
    });
    expect([...fixture.keys.entries()]).toEqual([["key_unrelated", "operator-runtime-key"]]);
    expect(fixture.deleted).toContain("key_stale");
    expect(fixture.deleted).toContain("key_created");
  });

  test("reconciles a reserved key after ambiguous create and response-validation failures", async () => {
    for (const createError of [
      new AgentMailProvisioningTransportError("/inboxes/inb_canary/api-keys", "network", true),
      new AgentMailProvisioningResponseError(
        "/inboxes/inb_canary/api-keys",
        "permissions did not match",
        true,
      ),
    ]) {
      const fixture = fakeCanary(createError);
      let caught: unknown;
      try {
        await runAgentMailProviderCanary(fixture.dependencies);
      } catch (error) {
        caught = error;
      }

      expect(caught).toBe(createError);
      expect(
        [...fixture.keys.values()].filter((name) =>
          name.startsWith("auggy-release-canary-scoped-key-"),
        ),
      ).toEqual([]);
      expect(fixture.deleted).toContain("key_created");
    }
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
    expect(fixture.keyRequest).toBeUndefined();
    expect(fixture.deleted).toEqual([]);
  });

  test("fails closed without provider details when post-create reconciliation is unprovable", async () => {
    const fixture = fakeCanary();
    const baseAdmin = fixture.dependencies.keyAdmin as AgentMailCanaryKeyAdmin;
    let listCalls = 0;
    fixture.dependencies.keyAdmin = {
      ...baseAdmin,
      async list(inboxId, pageToken) {
        listCalls += 1;
        if (listCalls > 1) throw new Error("provider response am_secret_must_not_escape");
        return baseAdmin.list(inboxId, pageToken);
      },
    };

    let caught: unknown;
    try {
      await runAgentMailProviderCanary(fixture.dependencies);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toContain("cleanup could not prove");
    expect((caught as Error).message).not.toContain("am_secret_must_not_escape");
  });
});

function fakeCanary(createError?: Error): {
  dependencies: AgentMailCanaryDependencies;
  keys: Map<string, string>;
  deleted: string[];
  inboxRequests: unknown[];
  inboxListRequests: string[];
  keyRequest: Record<string, unknown> | undefined;
} {
  const keys = new Map<string, string>();
  const deleted: string[] = [];
  const inboxRequests: unknown[] = [];
  const inboxListRequests: string[] = [];
  let keyRequest: Record<string, unknown> | undefined;
  const keyAdmin: AgentMailCanaryKeyAdmin = {
    async list() {
      return {
        apiKeys: [...keys].map(([apiKeyId, name]) => ({ apiKeyId, name })),
      };
    },
    async delete(_inboxId, apiKeyId) {
      deleted.push(apiKeyId);
      keys.delete(apiKeyId);
    },
  };
  const provisioner: NonNullable<AgentMailCanaryDependencies["provisioner"]> = {
    async createInbox(input) {
      inboxRequests.push(input);
      return {
        inboxId: "inb_canary",
        email: "auggy-release-canary-7d2c91f4@agentmail.to",
        displayName: "Auggy release provider canary",
      };
    },
    async createInboxApiKey(input) {
      keyRequest = { ...input, apiKey: "[redacted]" };
      keys.set("key_created", input.name);
      if (createError) throw createError;
      return {
        apiKeyId: "key_created",
        apiKey: "am_disposable_canary_not_real",
        name: input.name,
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
      runId: "123456789",
      provisioner,
      keyAdmin,
    },
    keys,
    deleted,
    inboxRequests,
    inboxListRequests,
    get keyRequest() {
      return keyRequest;
    },
  };
}
