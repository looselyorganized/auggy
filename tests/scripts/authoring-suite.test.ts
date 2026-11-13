import { expect, test } from "bun:test";
import {
  parseAuthoringSuiteArguments,
  assertAuthoringSuiteStages,
  runAuthoringSuite,
} from "../../scripts/release-smoke/authoring-suite";

test("suite requires explicit unique artifact selection and a bounded evidence destination", () => {
  const args = [
    "--repo-root",
    "/repo",
    "--evidence-dir",
    "/evidence",
    "--core",
    "/core.tgz",
    "--anthropic",
    "/anthropic.tgz",
    "--openai",
    "/openai.tgz",
    "--openrouter",
    "/openrouter.tgz",
    "--ollama",
    "/ollama.tgz",
  ];
  expect(parseAuthoringSuiteArguments(args).globalCore).toBeUndefined();
  expect(parseAuthoringSuiteArguments([...args, "--global-core", "/baseline.tgz"]).globalCore).toBe(
    "/baseline.tgz",
  );
  expect(() => parseAuthoringSuiteArguments(args.slice(2))).toThrow("Missing");
  expect(() => parseAuthoringSuiteArguments([...args, "--core", "/other.tgz"])).toThrow(
    "duplicate",
  );
  expect(() => parseAuthoringSuiteArguments([...args, "--skip-audit", "true"])).toThrow("Invalid");
  expect(typeof runAuthoringSuite).toBe("function");
});

test("aggregate acceptance cannot hide missing stages or cleanup behind platform unavailability", () => {
  const stages = {
    "anthropic-adoption": "passed",
    "openai-adoption": "passed",
    "openrouter-adoption": "passed",
    "ollama-adoption": "passed",
    application: "passed",
    inspection: "passed",
    migration: { status: "passed", cleanupConfirmed: true },
    ownership: { state: "passed", cleanupConfirmed: true },
    deployment: { state: "passed", cleanupConfirmed: true },
    service: { state: "unavailable", cleanupConfirmed: true },
  };
  assertAuthoringSuiteStages(stages);
  expect(() => assertAuthoringSuiteStages({ ...stages, migration: undefined })).toThrow(
    "migration",
  );
  expect(() => assertAuthoringSuiteStages({ ...stages, inspection: "not-run" })).toThrow(
    "inspection",
  );
  expect(() =>
    assertAuthoringSuiteStages({
      ...stages,
      service: { state: "unavailable", cleanupConfirmed: false },
    }),
  ).toThrow("cleanup");
  expect(() =>
    assertAuthoringSuiteStages({
      ...stages,
      deployment: { state: "unavailable", cleanupConfirmed: true },
    }),
  ).toThrow("deployment");
});
