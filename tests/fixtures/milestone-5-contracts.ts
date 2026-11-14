/** Compile-only compatibility checks for the actual M5 producer contracts. */
import type {
  VerifiedSessionAdapter,
  AuggyAuthorizationPolicy,
} from "../../examples/company-app/src/server/contracts";
import type { IntegrationScenarioEvidence } from "../../scripts/release-smoke/integration-contracts";
import type {
  ManagedExternalAuthReplay,
  ManagedExternalAuthReplayOptions,
} from "../../src/auth/external-auth-replay-contracts";
import type { ExternalAuthReplayStore } from "../../src/auth/external-auth";
import type {
  DeploymentProfile,
  CloudRecordV2,
  StageBundleOptions,
  HealthCheckOptions,
} from "../../src/cli/deploy/contracts";
import type {
  RuntimeDataAdmission,
  RuntimeDataOwnership,
  WithRuntimeDataAdmission,
} from "../../src/runtime-data-contracts";
import { stageBundle } from "../../src/cli/deploy/bundle";
import { waitForHealth } from "../../src/cli/deploy/health";

function compileMilestone5Contracts(
  admission: RuntimeDataAdmission,
  managed: ManagedExternalAuthReplay,
  owned: RuntimeDataOwnership,
  callerOwned: ExternalAuthReplayStore,
  verifier: VerifiedSessionAdapter,
  policy: AuggyAuthorizationPolicy,
  evidence: IntegrationScenarioEvidence,
  borrow: WithRuntimeDataAdmission,
): void {
  // The existing compatibility helpers remain callable through the frozen inputs.
  const stageCompatibility: (options: StageBundleOptions) => string = stageBundle;
  const healthCompatibility: (
    url: string,
    options?: HealthCheckOptions,
  ) => ReturnType<typeof waitForHealth> = waitForHealth;

  const managedOptions: ManagedExternalAuthReplayOptions = {
    admission,
    dbPath: "/owned/data/external-auth-replay.db",
    managedDbPaths: ["/owned/data/external-auth-replay.db"],
    maxTtlSeconds: 60,
  };

  // A string root is not a runtime-issued admission capability.
  // @ts-expect-error A private brand and live runtime registry establish admission.
  const forgedAdmission: RuntimeDataAdmission = { runtimeDataRoot: "/owned", agentId: "agent" };

  const descriptorResult: number = borrow(admission, (rootFd) => rootFd);
  // @ts-expect-error Borrowed descriptors cannot outlive a synchronous callback.
  borrow(admission, async (rootFd) => rootFd);
  void descriptorResult;

  const worker: DeploymentProfile = { kind: "none" };
  // @ts-expect-error A worker profile cannot advertise a port.
  const workerWithPort: DeploymentProfile = { kind: "none", port: 8080 };

  // @ts-expect-error Version-2 worker deployments have no public URL.
  const workerWithUrl: CloudRecordV2 = {
    version: 2,
    agentId: "agent",
    provider: "railway",
    projectId: "p",
    serviceId: "s",
    volumeId: "v",
    deployedAt: "2026-11-14T00:00:00Z",
    profile: worker,
    url: "https://example.com",
  };

  async function verifyCallSites(request: Request): Promise<void> {
    const session = await verifier.verify(request);
    if (session) {
      const authorization = await policy.derive(session);
      const scopes: readonly string[] = authorization.scopes;
      void scopes;
    }
    // Caller-owned store signature and lifecycle remain unchanged.
    await callerOwned.consume("single-use-jti", 60_000, 0);
    await managed.checkAvailability(managedOptions.maxTtlSeconds);
    await managed.consumeVerified({
      audience: "agent",
      jti: "jti",
      issuedAt: 0,
      expiresAt: 60_000,
      maxTtlSeconds: 60,
    });
    const dataRoot: string | undefined = owned.runtimeDataRoot;
    const outcome: "passed" | "failed" | "unavailable" | "not-run" = evidence.outcome.status;
    void [dataRoot, outcome];
  }

  // This fixture is included by strict typecheck; it is not a runtime test or proof.
  void [
    stageCompatibility,
    healthCompatibility,
    managedOptions,
    forgedAdmission,
    workerWithPort,
    workerWithUrl,
    verifyCallSites,
  ];
}

void compileMilestone5Contracts;
