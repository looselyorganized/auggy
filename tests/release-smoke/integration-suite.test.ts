import { expect, test } from "bun:test";
import type { IntegrationScenarioEvidence } from "../../scripts/release-smoke/integration-contracts";
import {
  assertIntegrationStages,
  parseIntegrationSuiteArguments,
} from "../../scripts/release-smoke/integration-suite";

const required = [
  "--repo-root",
  "/checkout",
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

test("suite parser cannot silently omit browser prerequisites or enter a hosted stage", () => {
  expect(() => parseIntegrationSuiteArguments(required)).toThrow("Chromium");
  expect(parseIntegrationSuiteArguments([...required, "--stage", "container"]).stage).toBe(
    "container",
  );
  expect(() => parseIntegrationSuiteArguments([...required, "--stage", "hosted"])).toThrow("stage");
  expect(() => parseIntegrationSuiteArguments([...required, "--core", "/other.tgz"])).toThrow(
    "duplicate",
  );
  expect(() =>
    parseIntegrationSuiteArguments([...required, "--chromium-path", "/browser"]),
  ).toThrow("both");
  const local = parseIntegrationSuiteArguments([
    ...required,
    "--stage",
    "local",
    "--chromium-path",
    "/browser",
    "--chromium-sha256",
    "a".repeat(64),
  ]);
  expect(local.stage).toBe("local");
});

// Minimal row fixtures test the aggregate gate only, not installed product behavior.
const row = (scenarioId: string, status = "passed", cleanup = "complete") => {
  const container = scenarioId === "container-storage-recovery";
  const worker = scenarioId === "telegram-installed-worker";
  const production = scenarioId === "application-production-reference";
  const browser = scenarioId === "application-browser-integration";
  return {
    scenarioId,
    stage: container ? "container" : "local",
    buildKind: production
      ? "production-reference"
      : browser
        ? "fixture-auth"
        : "standalone-fixture",
    profile: { kind: worker ? "none" : "http" },
    execution: {
      startup: "ready",
      channel: container || production ? "unverified" : "verified",
      effectCount: container ? 4 : worker ? 2 : production ? 0 : 1,
      duplicateEffectCount: 0,
      unauthorizedEffectCount: 0,
    },
    platform: {
      imageDigest: container ? `sha256:${"a".repeat(64)}` : null,
      exportSHA256: container || worker ? "b".repeat(64) : null,
      deploymentId: null,
      resources: container ? [{ kind: "image", id: `sha256:${"a".repeat(64)}` }] : [],
    },
    outcome: { status },
    cleanup: { status: cleanup, remainingOwnedIds: [] },
  } as unknown as IntegrationScenarioEvidence;
};

test("aggregate refuses missing rows, duplicate identities, unavailability and unconfirmed cleanup", () => {
  const rows = [
    "telegram-installed-worker",
    "standalone-http-policy",
    "application-production-reference",
    "application-browser-integration",
  ].map((id) => row(id));
  expect(() => assertIntegrationStages("local", rows)).not.toThrow();
  expect(() => assertIntegrationStages("all", rows)).toThrow("incomplete");
  expect(() => assertIntegrationStages("local", [...rows.slice(0, 3), rows[0]!])).toThrow(
    "duplicated",
  );
  expect(() =>
    assertIntegrationStages("container", [row("container-storage-recovery", "unavailable")]),
  ).toThrow("did not pass");
  expect(() =>
    assertIntegrationStages("container", [row("container-storage-recovery", "passed", "failed")]),
  ).toThrow("cleanup");
});

test("a renamed local row cannot impersonate container proof, and platform identities are required", () => {
  const local = row("standalone-http-policy");
  local.scenarioId = "container-storage-recovery";
  expect(() => assertIntegrationStages("container", [local])).toThrow("metadata");
  const container = row("container-storage-recovery");
  expect(() => assertIntegrationStages("container", [container])).not.toThrow();
  container.platform.imageDigest = null;
  expect(() => assertIntegrationStages("container", [container])).toThrow("tested image");
  const wrongEffects = row("container-storage-recovery");
  wrongEffects.execution.unauthorizedEffectCount = 1;
  expect(() => assertIntegrationStages("container", [wrongEffects])).toThrow("observations");
});
