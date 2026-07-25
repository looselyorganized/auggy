import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateSecurityEvalRequest } from "../../scripts/validate-security-eval-request";
import { verifySecurityEvalCandidate } from "../../scripts/verify-security-eval-candidate";

const ROOT = join(import.meta.dir, "..", "..");

interface WorkflowStep {
  id?: string;
  name?: string;
  run?: string;
  env?: Record<string, string>;
}

interface WorkflowJob {
  needs?: string | string[];
  outputs?: Record<string, string>;
  strategy?: {
    matrix?: Record<string, unknown>;
  };
  steps?: WorkflowStep[];
}

function readWorkflow(filename: string): {
  source: string;
  jobs: Record<string, WorkflowJob>;
} {
  const source = readFileSync(join(ROOT, ".github/workflows", filename), "utf8");
  const workflow = parseYaml(source) as { jobs?: Record<string, WorkflowJob> };
  if (!workflow.jobs) throw new Error(`${filename} has no jobs`);
  return { source, jobs: workflow.jobs };
}

function requireJob(jobs: Record<string, WorkflowJob>, id: string): WorkflowJob {
  const job = jobs[id];
  if (!job) throw new Error(`workflow is missing job ${id}`);
  return job;
}

function requireStep(job: WorkflowJob, name: string): WorkflowStep {
  const step = job.steps?.find((candidate) => candidate.name === name);
  if (!step) throw new Error(`workflow is missing step ${name}`);
  return step;
}

function normalizedNeeds(job: WorkflowJob): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}

describe("security evaluation workflow trust boundary", () => {
  test("the paid workflow is default-branch-only and treats candidate metadata as data", () => {
    const source = readFileSync(join(ROOT, ".github/workflows/security-eval.yml"), "utf8");
    const workflow = parseYaml(source) as Record<string, unknown>;

    expect(workflow).toBeDefined();
    expect(source).toContain("repository_dispatch:");
    expect(source).toContain("types: [security-eval-request]");
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).not.toContain("workflow_run:");
    expect(source).toContain("github.event.repository.default_branch");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("validate-security-eval-request.ts");
    expect(source).toContain("toJson(github.event.client_payload)");
    expect(source).toContain("head -c 4097");
    expect(source).toContain("commits/${SOURCE_SHA}");
    expect(source).toContain("contents/${CONFIG_PATH}?ref=${SOURCE_SHA}");
    expect(source).toContain("verify-security-eval-candidate.ts");
    expect(source).toContain("SECURITY_EVAL_SOURCE_SHA");
    expect(source).toContain("environment: security-eval");
    expect(source).toContain("secrets.ANTHROPIC_API_KEY_SECURITY_EVAL_ENV_ONLY");
    expect(source).not.toContain("secrets.ANTHROPIC_API_KEY_SECURITY_EVAL }}");
    expect(source).toContain("group: trusted-security-eval");
  });

  test("trusted request validation maps a bounded enum to fixed fixtures", () => {
    const expectedSha = "a".repeat(40);
    expect(
      validateSecurityEvalRequest(
        JSON.stringify({ schema: 1, model: "haiku", sourceSha: expectedSha }),
        expectedSha,
      ),
    ).toEqual({
      model: "haiku",
      sourceSha: expectedSha,
      configPath: "packages/evals/src/security/fixtures/test-agent.yaml",
    });
    expect(
      validateSecurityEvalRequest(
        JSON.stringify({ schema: 1, model: "sonnet", sourceSha: expectedSha }),
        expectedSha,
      ).configPath,
    ).toBe("packages/evals/src/security/fixtures/test-agent-sonnet.yaml");
  });

  test("trusted request validation rejects alternate paths, refs, keys, and oversized data", () => {
    const expectedSha = "b".repeat(40);
    for (const request of [
      { schema: 1, model: "../../attacker", sourceSha: expectedSha },
      { schema: 1, model: "haiku", sourceSha: "c".repeat(40) },
      { schema: 1, model: "haiku", sourceSha: expectedSha, config: "/tmp/evil.yaml" },
      { schema: 2, model: "haiku", sourceSha: expectedSha },
      ["haiku", expectedSha],
    ]) {
      expect(() => validateSecurityEvalRequest(JSON.stringify(request), expectedSha)).toThrow();
    }
    expect(() => validateSecurityEvalRequest("x".repeat(4097), expectedSha)).toThrow(/4096/);
  });

  test("trusted candidate ingestion accepts only the exact bounded passive fixture", () => {
    const sourceSha = "d".repeat(40);
    const trusted = Buffer.from("name: trusted\n", "utf8");
    expect(
      verifySecurityEvalCandidate({
        candidate: Buffer.from(trusted),
        trusted,
        sourceSha,
      }),
    ).toEqual({
      sourceSha,
      configSha256: expect.stringMatching(/^[0-9a-f]{64}$/),
      scope: "trusted-harness-candidate-config",
    });
    expect(() =>
      verifySecurityEvalCandidate({
        candidate: Buffer.from("name: attacker\n"),
        trusted,
        sourceSha,
      }),
    ).toThrow(/never executes candidate-controlled configuration/);
  });
});

describe("release publishing identity", () => {
  test("isolates repository execution from OIDC and environment-only publish credentials", () => {
    const source = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");
    const releaseDocs = readFileSync(join(ROOT, "docs/RELEASING.md"), "utf8");
    const publishJob = source.slice(source.indexOf("\n  publish:"));
    const verifyJob = source.slice(source.indexOf("\n  verify:"), source.indexOf("\n  publish:"));

    expect(source).toContain('node-version: "24"');
    expect(source).toContain("11.5.1");
    expect(source.match(/package-manager-cache: false/g)?.length).toBe(2);
    expect(verifyJob).toContain("Confirm tag commit belongs to main");
    expect(verifyJob.indexOf("Confirm tag commit belongs to main")).toBeLessThan(
      verifyJob.indexOf("bun install --frozen-lockfile"),
    );
    expect(verifyJob).not.toContain("id-token: write");
    expect(verifyJob).not.toContain("NODE_AUTH_TOKEN");
    expect(publishJob).toContain("needs: verify");
    expect(publishJob).toContain("environment: npm-publish");
    expect(publishJob).toContain("id-token: write");
    expect(publishJob).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN_PUBLISH_ENV_ONLY }}");
    expect(publishJob).not.toContain("actions/checkout");
    expect(publishJob).not.toContain("bun install");
    expect(publishJob).not.toContain("bun run test");
    expect(publishJob).toContain('tar -xOf "$tarball" package/package.json');
    expect(publishJob).toContain("manifest.name !== expectedName");
    expect(publishJob).toContain("manifest.version !== expectedVersion");
    expect(publishJob).toContain("manifest.publishConfig !== undefined");
    expect(publishJob).toContain("--registry=https://registry.npmjs.org");
    expect(publishJob).toContain("--tag=latest");
    expect(publishJob).toContain("--access=public");
    expect(publishJob).toContain("--ignore-scripts");
    expect(publishJob).not.toContain('npm publish "$tarball" --access public');
    expect(releaseDocs).toContain("workflow filename");
    expect(releaseDocs).toContain("`publish.yml`");
    expect(releaseDocs).toContain("Environment");
    expect(releaseDocs).toContain("`npm-publish`");
    expect(releaseDocs).toContain("allowed action `npm publish` only");
    expect(releaseDocs).toContain("Do not allow\n   `npm stage publish`");
  });
});

describe("tracked test-surface workflow enforcement", () => {
  test("primary CI derives its runtime matrix and aggregate gate from inventory", () => {
    const { jobs } = readWorkflow("ci.yml");
    const inventory = requireJob(jobs, "inventory");
    const surface = requireStep(inventory, "Validate tracked test surface");
    expect(inventory.outputs?.runtime).toBe("${{ steps.surface.outputs.runtime }}");
    expect(surface.id).toBe("surface");
    expect(surface.run).toContain("bun scripts/test-surface-inventory.ts check");
    expect(surface.run).toContain("bun scripts/test-surface-inventory.ts matrix runtime");

    const runtime = requireJob(jobs, "runtime_shards");
    expect(normalizedNeeds(runtime)).toEqual(["inventory"]);
    expect(runtime.strategy?.matrix?.shard).toBe(
      "${{ fromJSON(needs.inventory.outputs.runtime) }}",
    );
    const runtimeStep = requireStep(runtime, "Run sequential runtime shard");
    expect(runtimeStep.env?.TEST_SHARD).toBe("${{ matrix.shard }}");
    expect(runtimeStep.run).toBe('bun scripts/test-surface-inventory.ts run "$TEST_SHARD"');

    const consoleJob = requireJob(jobs, "console");
    expect(requireStep(consoleJob, "Run inventoried creator console tests").run).toBe(
      "bun scripts/test-surface-inventory.ts run console",
    );

    const aggregate = requireJob(jobs, "test");
    expect(normalizedNeeds(aggregate)).toContain("inventory");
    expect(requireStep(aggregate, "Verify constituent gates").env?.INVENTORY_RESULT).toBe(
      "${{ needs.inventory.result }}",
    );
  });

  test("release rehearsal executes the same canonical bounded inventory", () => {
    const { jobs } = readWorkflow("release-rehearsal.yml");
    const rehearse = requireJob(jobs, "rehearse");

    expect(requireStep(rehearse, "Validate tracked test surface").run).toBe(
      "bun scripts/test-surface-inventory.ts check",
    );
    expect(requireStep(rehearse, "Run runtime tests in bounded shards").run).toBe(
      "bun scripts/test-surface-inventory.ts run-runtime",
    );
    expect(requireStep(rehearse, "Run console tests").run).toBe(
      "bun scripts/test-surface-inventory.ts run console",
    );
    expect(requireStep(rehearse, "Smoke packed release").run).toBe("bun run smoke:release");
    expect(rehearse.steps?.some((step) => step.run?.includes("bun test "))).toBeFalse();
  });
});
