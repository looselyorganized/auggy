import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseIntegrationEvidence,
  writeIntegrationEvidence,
} from "../../scripts/release-smoke/integration-evidence";
import type { IntegrationScenarioEvidence } from "../../scripts/release-smoke/integration-contracts";
import { createExternalAuthAssertion } from "../../src/auth/external-auth";

function evidence(): IntegrationScenarioEvidence {
  const hash = "a".repeat(64);
  return {
    version: 1,
    scenarioId: "standalone-http",
    runId: "fixture-run",
    stage: "local",
    buildKind: "standalone-fixture",
    source: {
      revision: "b".repeat(40),
      tree: "c".repeat(40),
      sourceChangesSHA256: hash,
      bunVersion: "1.3.14",
      lockfiles: [{ path: "bun.lock", sha256: hash }],
      packedPackages: [{ path: "packs/auggy.tgz", sha256: hash }],
      installedFiles: [{ path: "node_modules/auggy/src/agent.ts", sha256: hash }],
    },
    profile: { kind: "none" },
    baselineFiles: [],
    changes: [],
    execution: {
      commandLabels: ["cli-create"],
      deadlinesMs: { readiness: 60000 },
      firstChunkBeforeTerminal: null,
      effectCount: 1,
      duplicateEffectCount: 0,
      unauthorizedEffectCount: 0,
      startup: "ready",
      channel: "verified",
      observations: ["fixture-channel-verified"],
    },
    platform: { exportSHA256: null, imageDigest: null, deploymentId: null, resources: [] },
    outcome: { status: "passed", checks: ["one-effect"] },
    cleanup: { status: "complete", remainingOwnedIds: [] },
    artifacts: [{ path: "observations.json", sha256: hash }],
    retainedUntil: null,
    independentReviewer: null,
  };
}

test("evidence refuses passing claims without provenance, safe effects or cleanup", () => {
  expect(parseIntegrationEvidence(JSON.stringify(evidence())).outcome.status).toBe("passed");
  for (const change of [
    (value: IntegrationScenarioEvidence) => {
      value.source.installedFiles = [];
    },
    (value: IntegrationScenarioEvidence) => {
      value.execution.unauthorizedEffectCount = 1;
    },
    (value: IntegrationScenarioEvidence) => {
      value.execution.duplicateEffectCount = 1;
    },
    (value: IntegrationScenarioEvidence) => {
      value.cleanup.status = "failed";
    },
    (value: IntegrationScenarioEvidence) => {
      value.cleanup.remainingOwnedIds = ["unremoved-container"];
    },
    (value: IntegrationScenarioEvidence) => {
      value.stage = "container";
    },
    (value: IntegrationScenarioEvidence) => {
      value.baselineFiles = [{ path: "../outside", sha256: "a".repeat(64) }];
    },
    (value: IntegrationScenarioEvidence) => {
      value.execution.deadlinesMs = { unbounded: Infinity };
    },
  ]) {
    const value = evidence();
    change(value);
    expect(() => parseIntegrationEvidence(JSON.stringify(value))).toThrow(
      "Invalid integration evidence contract",
    );
  }
});

test("unavailable is explicit and evidence never emits credential values in validation errors", () => {
  const value = evidence();
  value.outcome = { status: "unavailable", reason: "docker-daemon-unavailable" };
  value.source.installedFiles = [];
  value.execution.startup = "not-run";
  value.execution.channel = "unverified";
  expect(parseIntegrationEvidence(JSON.stringify(value)).outcome.status).toBe("unavailable");
  for (const secret of [
    "Bearer private-value",
    "https://user:password@example.test/",
    'known-quote-"-secret',
  ]) {
    value.execution.observations = [secret];
    try {
      parseIntegrationEvidence(JSON.stringify(value), [secret]);
      throw new Error("missing rejection");
    } catch (error) {
      expect(String(error)).toContain("configured secret");
      expect(String(error)).not.toContain(secret);
    }
  }
  value.execution.observations = ["cookie: confidential-session"];
  expect(() => parseIntegrationEvidence(JSON.stringify(value))).toThrow("credential-shaped");
  expect(() =>
    parseIntegrationEvidence(JSON.stringify({ ...evidence(), rawHeaders: { cookie: "private" } })),
  ).toThrow("Invalid integration evidence contract");
});

test("evidence publication is private, exclusive and rejects unsafe directory modes", () => {
  const root = mkdtempSync(join(tmpdir(), "auggy-integration-evidence-"));
  try {
    const json = JSON.stringify(evidence());
    const written = writeIntegrationEvidence(root, "scenario.json", json);
    expect(written.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(join(root, "scenario.json")).mode & 0o777).toBe(0o600);
    expect(parseIntegrationEvidence(readFileSync(join(root, "scenario.json"), "utf8"))).toEqual(
      evidence(),
    );
    expect(() => writeIntegrationEvidence(root, "scenario.json", json)).toThrow(/already exists/);
    expect(() => writeIntegrationEvidence(root, "../escape.json", json)).toThrow(/filename/);
    chmodSync(root, 0o755);
    expect(() => writeIntegrationEvidence(root, "second.json", json)).toThrow(/0700/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("dynamic assertions, Telegram tokens and private-key markers are rejected without a supplied secret inventory", () => {
  const token = createExternalAuthAssertion({
    secret: "synthetic-signing-secret",
    audience: "fixture",
    provider: "app",
    subject: "fixture-person",
    jti: "fixture-nonce",
  });
  const value = evidence();
  for (const diagnostic of [
    token,
    `x-auggy-auth-assertion: ${token}`,
    "https://api.telegram.org/bot123456:synthetic-token/getUpdates",
    "-----BEGIN PRIVATE KEY----- synthetic",
    "-----BEGIN RSA PRIVATE KEY----- synthetic",
  ]) {
    value.execution.observations = [diagnostic];
    expect(() => parseIntegrationEvidence(JSON.stringify(value))).toThrow("credential-shaped");
  }
});
