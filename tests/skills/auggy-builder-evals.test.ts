import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";

const ROOT = join(import.meta.dir, "..", "..");
const EVAL_PATH = join(
  ROOT,
  "packages",
  "auggy-builder-skill",
  "evals",
  "fresh-agent-prompts.yaml",
);
const SKILL_ROOT = join(ROOT, "packages", "auggy-builder-skill", "auggy");

interface FreshAgentEvalSuite {
  suite: string;
  version: number;
  skillPath: string;
  cases: FreshAgentEvalCase[];
}

interface FreshAgentEvalCase {
  id: string;
  category: string;
  activation: "explicit" | "implicit";
  prompt: string;
  requiredReferences?: string[];
  requiredAssets?: string[];
  requiredScripts?: string[];
  successCriteria: string[];
}

describe("auggy builder skill fresh-agent eval prompts", () => {
  const suite = parseYaml(readFileSync(EVAL_PATH, "utf-8")) as FreshAgentEvalSuite;

  test("suite metadata is stable", () => {
    expect(suite.suite).toBe("auggy-builder-skill-fresh-agent");
    expect(suite.version).toBe(2);
    expect(suite.skillPath).toBe("../auggy");
    expect(suite.cases.length).toBeGreaterThanOrEqual(8);
  });

  test("case ids are unique and prompts have valid activation semantics", () => {
    const ids = new Set<string>();

    for (const testCase of suite.cases) {
      expect(ids.has(testCase.id), testCase.id).toBe(false);
      ids.add(testCase.id);
      expect(["explicit", "implicit"], testCase.id).toContain(testCase.activation);
      if (testCase.activation === "explicit") {
        expect(testCase.prompt, testCase.id).toContain("Use $auggy");
      } else {
        expect(testCase.prompt, testCase.id).not.toContain("Use $auggy");
      }
      expect(testCase.successCriteria.length, testCase.id).toBeGreaterThanOrEqual(3);
    }
  });

  test("suite covers both explicit invocation and implicit skill discovery", () => {
    const explicit = suite.cases.filter((testCase) => testCase.activation === "explicit");
    const implicit = suite.cases.filter((testCase) => testCase.activation === "implicit");

    expect(explicit.length).toBeGreaterThan(0);
    expect(implicit.length).toBeGreaterThan(0);
    expect(
      implicit.some((testCase) =>
        testCase.successCriteria.some((criterion) =>
          criterion.includes("without explicit invocation"),
        ),
      ),
    ).toBe(true);
  });

  test("referenced skill files exist", () => {
    for (const testCase of suite.cases) {
      for (const path of [
        ...(testCase.requiredReferences ?? []),
        ...(testCase.requiredAssets ?? []),
        ...(testCase.requiredScripts ?? []),
      ]) {
        expect(existsSync(join(SKILL_ROOT, path)), `${testCase.id}:${path}`).toBe(true);
      }
    }
  });

  test("suite covers core builder workflows", () => {
    const categories = new Set(suite.cases.map((testCase) => testCase.category));

    expect(categories).toContain("mental-model");
    expect(categories).toContain("cli");
    expect(categories).toContain("augment-development");
    expect(categories).toContain("generated-clients");
    expect(categories).toContain("authz");
    expect(categories).toContain("memory-trust");
    expect(categories).toContain("troubleshooting");
  });

  test("authz eval points at provider-specific app auth recipes", () => {
    const appAuth = suite.cases.find((testCase) => testCase.id === "app-auth-bridge-supabase");
    expect(appAuth).toBeDefined();
    expect(appAuth!.requiredAssets).toContain(
      "assets/templates/app-auth-bridge/supabase-next-route.ts.txt",
    );
  });
});
