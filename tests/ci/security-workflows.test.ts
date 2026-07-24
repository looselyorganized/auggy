import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { validateSecurityEvalRequest } from "../../scripts/validate-security-eval-request";

const ROOT = join(import.meta.dir, "..", "..");

describe("security evaluation workflow trust boundary", () => {
  test("the branch-selectable request workflow has no secret and executes no repository code", () => {
    const source = readFileSync(join(ROOT, ".github/workflows/security-eval.yml"), "utf8");
    const workflow = parseYaml(source) as Record<string, unknown>;

    expect(workflow).toBeDefined();
    expect(source).toContain("Security eval request");
    expect(source).toContain("security-eval-request");
    expect(source).toContain("permissions: {}");
    expect(source).not.toContain("secrets.");
    expect(source).not.toContain("actions/checkout");
    expect(source).not.toContain("bun install");
    expect(source).not.toContain("packages/evals/src/security/run.ts");
  });

  test("the secret-bearing workflow is default-branch trusted and treats branch artifacts as data", () => {
    const source = readFileSync(join(ROOT, ".github/workflows/security-eval-trusted.yml"), "utf8");
    const workflow = parseYaml(source) as Record<string, unknown>;

    expect(workflow).toBeDefined();
    expect(source).toContain("workflow_run:");
    expect(source).toContain('workflows: ["Security eval request"]');
    expect(source).not.toContain("workflow_dispatch:");
    expect(source).toContain("github.event.repository.default_branch");
    expect(source).toContain("persist-credentials: false");
    expect(source).toContain("validate-security-eval-request.ts");
    expect(source).toContain("github.event.workflow_run.head_sha");
    expect(source).toContain("ARTIFACT_MAX_BYTES: 4096");
    expect(source).toContain("ARTIFACT_MAX_ARCHIVE_BYTES: 8192");
    expect(source).toContain('head -c "$((ARTIFACT_MAX_ARCHIVE_BYTES + 1))"');
    expect(source).toContain('unzip -Z1 "$REQUEST_ARCHIVE"');
    expect(source).not.toContain("actions/download-artifact");
    expect(source).toContain("environment: security-eval");
    expect(source).toContain("secrets.ANTHROPIC_API_KEY_SECURITY_EVAL");
    expect(source).not.toContain("github.event.workflow_run.head_branch");
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
});

describe("release publishing identity", () => {
  test("uses an OIDC-capable Node/npm while retaining the token only as a documented migration fallback", () => {
    const source = readFileSync(join(ROOT, ".github/workflows/publish.yml"), "utf8");
    expect(source).toContain('node-version: "24"');
    expect(source).toContain("id-token: write");
    expect(source).toContain("11.5.1");
    expect(source).toContain("NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}");
    expect(source).toContain("OIDC_MIGRATION_BLOCKER");
  });
});
