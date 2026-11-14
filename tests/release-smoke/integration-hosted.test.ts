import { describe, expect, test } from "bun:test";
import {
  assertHostedIntegrationApproval,
  prepareHostedIntegration,
  type HostedIntegrationPlan,
} from "../../scripts/release-smoke/integration-hosted";

function plan(): HostedIntegrationPlan {
  return {
    version: 1,
    runId: "test-run",
    railway: {
      projectId: "isolated-project",
      environmentId: "isolated-environment",
      services: [
        {
          profile: "http",
          name: "fixture-http",
          existingServiceId: null,
          imageDigest: `sha256:${"1".repeat(64)}`,
          exportSHA256: "2".repeat(64),
          buildKind: "fixture-auth",
        },
        {
          profile: "none",
          name: "fixture-worker",
          existingServiceId: null,
          imageDigest: `sha256:${"3".repeat(64)}`,
          exportSHA256: "4".repeat(64),
          buildKind: "standalone-fixture",
        },
      ],
    },
    limits: {
      maxServices: 2,
      maxVolumes: 2,
      maxVolumeGiB: 1,
      maxMemoryMiBPerService: 512,
      maxCpuPerService: 1,
      maxSpendUSD: 5,
      maxRunSeconds: 3600,
    },
    fixtures: {
      owner: "harness",
      origins: ["http://fixture.railway.internal:8080"],
      connectivity: "railway-private-network",
      syntheticIdentitySetSHA256: "5".repeat(64),
      allowedEffectContractSHA256: "6".repeat(64),
    },
    retention: {
      cleanupOwner: "harness",
      retainedUntil: "2030-01-02T00:00:00Z",
      privateArtifactLocation: "private-ci/run-123",
      retainResources: false,
    },
    source: { revision: "a".repeat(40), tree: "b".repeat(40), sourceChangesSHA256: "c".repeat(64) },
  };
}

describe("hosted plan gate only; no hosted actions", () => {
  test("preparation remains not-run and binds approval to exact services/images/limits", () => {
    const prepared = prepareHostedIntegration(plan());
    expect(prepared.status).toBe("not-run");
    const approval = {
      approvedPlanSHA256: prepared.sha256,
      recordedApprovalId: "explicit-user-approval-record",
      approvedAt: "2030-01-01T00:00:00Z",
      expiresAt: "2030-01-01T02:00:00Z",
    };
    const options = {
      prepared,
      approval,
      acceptedLocalEvidenceSHA256: "d".repeat(64),
      acceptedContainerEvidenceSHA256: "e".repeat(64),
      now: Date.parse("2030-01-01T00:30:00Z"),
    };
    expect(() => assertHostedIntegrationApproval(options)).not.toThrow();
    prepared.plan.limits.maxSpendUSD = 6;
    expect(() => assertHostedIntegrationApproval(options)).toThrow("does not match");
  });

  test("expired approval, missing evidence and changed target cannot pass the gate", () => {
    const prepared = prepareHostedIntegration(plan());
    const options = {
      prepared,
      approval: {
        approvedPlanSHA256: prepared.sha256,
        recordedApprovalId: "approval",
        approvedAt: "2030-01-01T00:00:00Z",
        expiresAt: "2030-01-01T02:00:00Z",
      },
      acceptedLocalEvidenceSHA256: "d".repeat(64),
      acceptedContainerEvidenceSHA256: "e".repeat(64),
      now: Date.parse("2030-01-01T03:00:00Z"),
    };
    expect(() => assertHostedIntegrationApproval(options)).toThrow("expired");
    expect(() =>
      assertHostedIntegrationApproval({ ...options, acceptedContainerEvidenceSHA256: "" }),
    ).toThrow("SHA256");
    expect(() =>
      assertHostedIntegrationApproval({
        ...options,
        prepared: prepareHostedIntegration({
          ...plan(),
          railway: { ...plan().railway, projectId: "different-project" },
        }),
      }),
    ).toThrow("does not match");
  });

  test("public and credential-bearing fixture destinations, ambiguous services and unbounded spend fail", () => {
    for (const origin of [
      "https://10.evil.example",
      "https://example.com",
      "http://u:p@fixture.railway.internal",
      "http://fixture.railway.internal/token",
    ]) {
      const input = plan();
      input.fixtures.origins = [origin];
      expect(() => prepareHostedIntegration(input)).toThrow();
    }
    const input = plan();
    input.limits.maxSpendUSD = Number.POSITIVE_INFINITY;
    expect(() => prepareHostedIntegration(input)).toThrow("unbounded");
    input.limits.maxSpendUSD = 5;
    input.railway.services = [input.railway.services[0]!, input.railway.services[0]!];
    expect(() => prepareHostedIntegration(input)).toThrow("HTTP and worker");
  });

  test("review serialization cannot carry unknown credentials", () => {
    const input = { ...plan(), token: "private-canary" };
    const prepared = prepareHostedIntegration(input);
    expect(JSON.stringify(prepared)).not.toContain("private-canary");
  });
});
