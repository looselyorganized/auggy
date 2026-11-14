import { describe, expect, test } from "bun:test";
import {
  assertHostedInstanceBinding,
  assertHostedIntegrationApproval,
  assertHostedProjectAvailable,
  bindHostedDeployment,
  bindHostedProjectAllocation,
  bindHostedServiceAdmission,
  bindHostedSshKey,
  bindHostedVolumeAllocation,
  prepareHostedIntegration,
  type HostedIntegrationPlan,
  type HostedProjectInventory,
  type HostedSourceArtifact,
} from "../../scripts/release-smoke/integration-hosted";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: number) => n.toString(16).padStart(64, "0");
const fingerprint = (n: number) =>
  `SHA256:${Buffer.from(sha(n), "hex").toString("base64").replace(/=+$/, "")}`;
const data = <T>(value: T) => ({ data: value });
const connection = <T>(nodes: T[]) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage: false },
});

function artifact(
  profile: "http" | "none",
  purpose: HostedSourceArtifact["purpose"],
): HostedSourceArtifact {
  return {
    id: `${profile}-${purpose}`,
    profile,
    purpose,
    buildKind: "standalone-fixture",
    contextSHA256: sha(1),
    exportManifestSHA256: sha(2),
    sourceInventorySHA256: sha(3),
    packageInventorySHA256: sha(4),
    lockSHA256: sha(5),
    dockerfileSHA256: sha(6),
    entrypointSHA256: sha(7),
    fixtureOverlaySHA256: sha(8),
    baseImageDigest: `sha256:${sha(9)}`,
  };
}

function plan(): HostedIntegrationPlan {
  return {
    version: 2,
    runId: "rehearsal-run",
    railway: {
      workspaceId: uuid(1),
      region: "us-west2",
      newProject: { name: "auggy-owned-rehearsal", environmentName: "rehearsal" },
      services: [
        { role: "http", name: "proof-http" },
        { role: "worker", name: "proof-worker" },
        { role: "recovery", name: "proof-recovery" },
      ],
      volumes: [
        { alias: "http-original", serviceRole: "http", mountPath: "/app/data", sizeMB: 50000 },
        { alias: "worker-original", serviceRole: "worker", mountPath: "/app/data", sizeMB: 50000 },
        { alias: "http-restore", serviceRole: "recovery", mountPath: "/app/data", sizeMB: 50000 },
        { alias: "worker-restore", serviceRole: "recovery", mountPath: "/app/data", sizeMB: 50000 },
      ],
    },
    ssh: {
      scope: "workspace",
      keyName: "owned-rehearsal-key",
      publicKeySHA256: sha(10),
      fingerprint: fingerprint(10),
      relay: {
        hostname: "ssh.railway.com",
        port: 22,
        trust: "explicit-first-use-pin",
        providerAuthenticated: false,
        publicKeySHA256: sha(11),
        fingerprint: fingerprint(11),
        knownHostsSHA256: sha(12),
      },
    },
    artifacts: [
      artifact("http", "baseline"),
      artifact("none", "baseline"),
      artifact("http", "edited"),
      artifact("none", "edited"),
      artifact("none", "maintenance"),
    ],
    actionManifest: { sha256: sha(13), executorSHA256: sha(14), actionCount: 30 },
    acceptedEvidence: {
      localSHA256: sha(15),
      containerSHA256: sha(16),
      hostedFixtureSHA256: sha(17),
    },
    limits: {
      maxServices: 3,
      maxVolumes: 4,
      maxVolumeSizeMB: 50000,
      maxCpuPerService: 4,
      maxMemoryBytesPerService: 4_000_000_000,
      monitoredSpendUSD: 5,
      providerHardSpendCap: false,
      maxRunSeconds: 7200,
      cleanupReserveSeconds: 600,
      remoteCommandSeconds: 15,
      fixtureActivitySeconds: 120,
    },
    fixtures: {
      owner: "harness",
      connectivity: "service-loopback-via-ssh",
      services: [
        {
          role: "http",
          origins: ["http://127.0.0.1:43151", "http://127.0.0.1:43152", "http://127.0.0.1:43153"],
          controlOrigin: "http://127.0.0.1:43153",
          controlSourceSHA256: sha(18),
          sealedEvidenceContractSHA256: sha(19),
        },
        {
          role: "worker",
          origins: ["http://127.0.0.1:43141", "http://127.0.0.1:43142"],
          controlOrigin: "http://127.0.0.1:43142",
          controlSourceSHA256: sha(20),
          sealedEvidenceContractSHA256: sha(21),
        },
      ],
      syntheticIdentitySetSHA256: sha(22),
      allowedEffectContractSHA256: sha(23),
    },
    retention: {
      cleanupOwner: "harness",
      retainedUntil: "2030-01-07T00:00:00Z",
      privateArtifactLocation: "private-ci/rehearsal-run",
      retainResources: false,
    },
    source: { revision: "a".repeat(40), tree: "b".repeat(40), sourceChangesSHA256: sha(24) },
  };
}

function approvalOptions() {
  const prepared = prepareHostedIntegration(plan());
  return {
    prepared,
    approval: {
      approvedPlanSHA256: prepared.sha256,
      recordedApprovalId: "explicit-user-approval",
      approvedAt: "2030-01-01T00:00:00Z",
      expiresAt: "2030-01-01T04:00:00Z",
    },
    observedInputs: {
      actionManifestSHA256: prepared.plan.actionManifest.sha256,
      actionCount: prepared.plan.actionManifest.actionCount,
      executorSHA256: prepared.plan.actionManifest.executorSHA256,
      artifactInputsSHA256: prepared.artifactInputsSHA256,
      acceptedEvidence: { ...prepared.plan.acceptedEvidence },
      ssh: {
        publicKeySHA256: prepared.plan.ssh.publicKeySHA256,
        relayPublicKeySHA256: prepared.plan.ssh.relay.publicKeySHA256,
        knownHostsSHA256: prepared.plan.ssh.relay.knownHostsSHA256,
      },
    },
    startedAt: Date.parse("2030-01-01T00:30:00Z"),
    now: Date.parse("2030-01-01T00:30:00Z"),
  };
}

function projectFixture() {
  const prepared = prepareHostedIntegration(plan());
  const before: HostedProjectInventory = { workspaceId: uuid(1), complete: true, projects: [] };
  const created = {
    id: uuid(2),
    name: prepared.plan.railway.newProject.name,
    workspaceId: uuid(1),
  };
  const project = {
    ...created,
    isPublic: false,
    prDeploys: false,
    deletedAt: null,
    environments: connection([{ id: uuid(3), name: "rehearsal", projectId: uuid(2) }]),
    services: connection([]),
    volumes: connection([]),
  };
  return {
    prepared,
    before,
    creation: data({ projectCreate: created }),
    readback: data({ project }),
  };
}

function serviceFixture() {
  const fixture = projectFixture();
  const project = bindHostedProjectAllocation(fixture);
  return {
    prepared: fixture.prepared,
    project,
    role: "http" as const,
    creation: data({ serviceCreate: { id: uuid(4), name: "proof-http", projectId: uuid(2) } }),
    capMutation: data({ serviceInstanceLimitsUpdate: true }),
    policyMutation: data({ serviceInstanceUpdate: true }),
    readback: data({
      serviceInstance: {
        id: uuid(5),
        serviceId: uuid(4),
        environmentId: uuid(3),
        latestDeployment: null,
        numReplicas: 1,
        region: "us-west2",
        restartPolicyType: "NEVER",
        restartPolicyMaxRetries: 0,
        sleepApplication: false,
      },
      serviceInstanceLimits: { containers: { cpu: 4, memoryBytes: 4_000_000_000 } },
    }),
  };
}

function volumeFixture() {
  const fixture = serviceFixture();
  const service = bindHostedServiceAdmission(fixture);
  const volume = {
    id: uuid(6),
    name: "provider-generated-name",
    projectId: uuid(2),
    volumeInstances: connection([
      {
        id: uuid(7),
        volumeId: uuid(6),
        environmentId: uuid(3),
        serviceId: uuid(4),
        mountPath: "/app/data",
        region: "us-west2",
        sizeMB: 50000,
        currentSizeMB: 12.5,
        state: "READY",
        deletedAt: null,
        isPendingDeletion: false,
      },
    ]),
  };
  return {
    prepared: fixture.prepared,
    service,
    alias: "http-original" as const,
    creation: data({
      volumeCreate: { id: volume.id, name: volume.name, projectId: volume.projectId },
    }),
    readback: data({
      project: { id: uuid(2), workspaceId: uuid(1), volumes: connection([volume]) },
    }),
    previousVolumeIds: [] as string[],
  };
}

function deploymentFixture() {
  const fixture = serviceFixture();
  const service = bindHostedServiceAdmission(fixture);
  return {
    prepared: fixture.prepared,
    service,
    artifactId: "http-baseline",
    returnedDeploymentId: uuid(8),
    readback: data({
      deployment: {
        id: uuid(8),
        projectId: uuid(2),
        environmentId: uuid(3),
        serviceId: uuid(4),
        status: "SUCCESS",
        deploymentStopped: false,
        meta: { imageDigest: `sha256:${sha(25)}` },
        instances: [{ id: uuid(9), status: "RUNNING" }],
      },
    }),
  };
}

describe("hosted v2 gate only; no resource creation or certification", () => {
  test("binds the finite new-project/source-build plan and observed inputs", () => {
    const options = approvalOptions();
    expect(options.prepared.status).toBe("not-run");
    expect(options.prepared.plan.version).toBe(2);
    expect(JSON.stringify(options.prepared.plan)).not.toContain('"imageDigest"');
    expect(() => assertHostedIntegrationApproval(options)).not.toThrow();
    expect(() =>
      prepareHostedIntegration({ version: 1 } as unknown as HostedIntegrationPlan),
    ).toThrow("v2");
  });

  test("every authority-bearing input invalidates the previously approved hash", () => {
    const mutations: ((input: HostedIntegrationPlan) => void)[] = [
      (input) => {
        input.railway.workspaceId = uuid(99);
      },
      (input) => {
        input.railway.newProject.name = "another-new-project";
      },
      (input) => {
        input.railway.newProject.environmentName = "another-environment";
      },
      (input) => {
        input.railway.services[0]!.name = "different-http-service";
      },
      (input) => {
        input.railway.volumes[0]!.sizeMB = 49999;
      },
      (input) => {
        input.artifacts[0]!.contextSHA256 = sha(99);
      },
      (input) => {
        input.artifacts[0]!.fixtureOverlaySHA256 = sha(99);
      },
      (input) => {
        input.artifacts[0]!.baseImageDigest = `sha256:${sha(99)}`;
      },
      (input) => {
        input.ssh.keyName = "another-workspace-key";
      },
      (input) => {
        input.ssh.publicKeySHA256 = sha(99);
        input.ssh.fingerprint = fingerprint(99);
      },
      (input) => {
        input.ssh.relay.publicKeySHA256 = sha(99);
        input.ssh.relay.fingerprint = fingerprint(99);
      },
      (input) => {
        input.ssh.relay.knownHostsSHA256 = sha(99);
      },
      (input) => {
        input.actionManifest.sha256 = sha(99);
      },
      (input) => {
        input.actionManifest.executorSHA256 = sha(99);
      },
      (input) => {
        input.actionManifest.actionCount++;
      },
      (input) => {
        input.acceptedEvidence.hostedFixtureSHA256 = sha(99);
      },
      (input) => {
        input.fixtures.services[0]!.controlSourceSHA256 = sha(99);
      },
      (input) => {
        input.limits.monitoredSpendUSD = 6;
      },
      (input) => {
        input.limits.maxCpuPerService = 3;
      },
      (input) => {
        input.limits.cleanupReserveSeconds = 599;
      },
      (input) => {
        input.retention.retainedUntil = "2030-01-06T00:00:00Z";
      },
      (input) => {
        input.source.tree = "c".repeat(40);
      },
    ];
    for (const mutate of mutations) {
      const options = approvalOptions();
      mutate(options.prepared.plan);
      expect(() => assertHostedIntegrationApproval(options)).toThrow("does not match");
    }
  });

  test("approval cannot substitute unreviewed executable, manifest, artifact or accepted evidence bytes", () => {
    for (const field of [
      "actionManifestSHA256",
      "executorSHA256",
      "artifactInputsSHA256",
    ] as const) {
      const options = approvalOptions();
      options.observedInputs[field] = sha(99);
      expect(() => assertHostedIntegrationApproval(options)).toThrow("execution inputs");
    }
    const options = approvalOptions();
    options.observedInputs.actionCount++;
    expect(() => assertHostedIntegrationApproval(options)).toThrow("execution inputs");
    for (const field of ["localSHA256", "containerSHA256", "hostedFixtureSHA256"] as const) {
      const changed = approvalOptions();
      changed.observedInputs.acceptedEvidence[field] = sha(99);
      expect(() => assertHostedIntegrationApproval(changed)).toThrow("execution inputs");
    }
  });

  test("changed SSH key or known_hosts bytes cannot borrow an unchanged plan's approval", () => {
    for (const field of ["publicKeySHA256", "relayPublicKeySHA256", "knownHostsSHA256"] as const) {
      const options = approvalOptions();
      options.observedInputs.ssh[field] = sha(99);
      expect(() => assertHostedIntegrationApproval(options)).toThrow("execution inputs");
    }
  });

  test("run budget cannot consume cleanup reserve or restart through a later approval check", () => {
    const options = approvalOptions();
    options.now = options.startedAt + options.prepared.plan.limits.maxRunSeconds * 1000;
    expect(() => assertHostedIntegrationApproval(options)).toThrow("time envelope");
    expect(() => assertHostedIntegrationApproval({ ...options, phase: "cleanup" })).not.toThrow();
    options.now += options.prepared.plan.limits.cleanupReserveSeconds * 1000;
    expect(() => assertHostedIntegrationApproval({ ...options, phase: "cleanup" })).toThrow(
      "time envelope",
    );
    const noReserve = approvalOptions();
    noReserve.approval.expiresAt = "2030-01-01T02:30:00Z";
    expect(() => assertHostedIntegrationApproval(noReserve)).toThrow("time envelope");
    const expired = approvalOptions();
    expired.now = Date.parse(expired.approval.expiresAt);
    expect(() => assertHostedIntegrationApproval(expired)).toThrow("expired");
    const rollback = approvalOptions();
    rollback.now = rollback.startedAt - 1;
    expect(() => assertHostedIntegrationApproval(rollback)).toThrow("future-dated");
    const retained = plan();
    retained.retention.retainedUntil = "2030-01-09T00:00:00Z";
    const longRetention = approvalOptions();
    longRetention.prepared = prepareHostedIntegration(retained);
    longRetention.approval.approvedPlanSHA256 = longRetention.prepared.sha256;
    expect(() => assertHostedIntegrationApproval(longRetention)).toThrow("time envelope");
  });

  test("public control, unsupported key trust, retention and excessive resources fail closed", () => {
    const mutations: ((input: HostedIntegrationPlan) => void)[] = [
      (input) => {
        input.fixtures.services[0]!.origins = ["http://fixture.railway.internal:80"];
      },
      (input) => {
        input.fixtures.services[0]!.controlOrigin = "http://user:secret@127.0.0.1:43153";
      },
      (input) => {
        input.ssh.relay.providerAuthenticated = true as false;
      },
      (input) => {
        input.ssh.scope = "personal" as "workspace";
      },
      (input) => {
        input.ssh.fingerprint = fingerprint(99);
      },
      (input) => {
        input.ssh.relay.hostname = "ssh.example.com" as "ssh.railway.com";
      },
      (input) => {
        input.retention.retainResources = true as false;
      },
      (input) => {
        input.limits.providerHardSpendCap = true as false;
      },
      (input) => {
        input.limits.maxRunSeconds = 7201;
      },
      (input) => {
        input.limits.cleanupReserveSeconds = 601;
      },
      (input) => {
        input.limits.monitoredSpendUSD = Number.POSITIVE_INFINITY;
      },
      (input) => {
        input.railway.services = [
          ...input.railway.services,
          { role: "recovery", name: "extra-service" },
        ];
      },
      (input) => {
        input.railway.volumes = input.railway.volumes.slice(0, 3);
      },
      (input) => {
        input.railway.volumes[2]!.alias = "http-original";
      },
      (input) => {
        input.railway.volumes[2]!.serviceRole = "http";
      },
      (input) => {
        input.artifacts = input.artifacts.filter((value) => value.purpose !== "maintenance");
      },
    ];
    for (const mutate of mutations) {
      const input = plan();
      mutate(input);
      expect(() => prepareHostedIntegration(input)).toThrow();
    }
  });

  test("sequential recovery may reuse primary service slots but still counts four distinct volumes", () => {
    const input = plan();
    input.railway.services = input.railway.services.slice(0, 2);
    input.limits.maxServices = 2;
    input.railway.volumes[2]!.serviceRole = "http";
    input.railway.volumes[3]!.serviceRole = "worker";
    expect(prepareHostedIntegration(input).plan.railway.volumes).toHaveLength(4);
    input.limits.maxVolumes = 3;
    expect(() => prepareHostedIntegration(input)).toThrow("resource limits");
  });

  test("unknown credential fields and private material never survive review reconstruction", () => {
    const input = plan();
    Object.assign(input, { token: "secret-canary" });
    Object.assign(input.ssh, { privateKey: "secret-canary" });
    Object.assign(input.ssh.relay, { credentials: "secret-canary" });
    Object.assign(input.railway.newProject, {
      existingProjectId: uuid(55),
      password: "secret-canary",
    });
    Object.assign(input.artifacts[0]!, { imageDigest: `sha256:${sha(99)}`, env: "secret-canary" });
    Object.assign(input.fixtures.services[0]!, { headers: { authorization: "secret-canary" } });
    const prepared = prepareHostedIntegration(input);
    expect(JSON.stringify(prepared)).not.toContain("secret-canary");
    expect(JSON.stringify(prepared.plan)).not.toContain("existingProjectId");
    expect(JSON.stringify(prepared.plan)).not.toContain("imageDigest");
    expect(prepared.sha256).toBe(prepareHostedIntegration(plan()).sha256);
  });
});

describe("hosted readback bindings; no network calls", () => {
  test("both-profile recovery requires no-ingress maintenance, not only HTTP maintenance", () => {
    const input = plan();
    input.artifacts = [
      ...input.artifacts.filter((value) => value.purpose !== "maintenance"),
      artifact("http", "maintenance"),
    ];
    expect(() => prepareHostedIntegration(input)).toThrow("no-ingress maintenance");
  });

  test("maintenance profile rules apply equally to deployment and SSH rebinding", () => {
    const input = plan();
    input.artifacts = [...input.artifacts, artifact("http", "maintenance")];
    const prepared = prepareHostedIntegration(input);
    const cases = [
      { role: "http", serviceName: "proof-http", artifactId: "http-maintenance", allowed: true },
      { role: "http", serviceName: "proof-http", artifactId: "none-maintenance", allowed: true },
      {
        role: "worker",
        serviceName: "proof-worker",
        artifactId: "none-maintenance",
        allowed: true,
      },
      {
        role: "worker",
        serviceName: "proof-worker",
        artifactId: "http-maintenance",
        allowed: false,
      },
      { role: "worker", serviceName: "proof-worker", artifactId: "http-baseline", allowed: false },
      {
        role: "recovery",
        serviceName: "proof-recovery",
        artifactId: "http-maintenance",
        allowed: true,
      },
      {
        role: "recovery",
        serviceName: "proof-recovery",
        artifactId: "http-baseline",
        allowed: true,
      },
      {
        role: "recovery",
        serviceName: "proof-recovery",
        artifactId: "none-maintenance",
        allowed: true,
      },
    ] as const;
    for (const row of cases) {
      const fixture = deploymentFixture();
      const service = { ...fixture.service, role: row.role, serviceName: row.serviceName };
      const bind = () =>
        bindHostedDeployment({ ...fixture, prepared, service, artifactId: row.artifactId });
      // Begin with a valid binding, then change only its approved artifact ID:
      // command-time validation must independently reapply the profile rule.
      const baseline = bindHostedDeployment({
        ...fixture,
        prepared,
        service,
        artifactId: row.role === "worker" ? "none-baseline" : "http-baseline",
      });
      const rebind = () =>
        assertHostedInstanceBinding({
          prepared,
          binding: { ...baseline, artifactId: row.artifactId },
          selectedInstanceId: uuid(9),
          readback: fixture.readback,
        });
      if (row.allowed) {
        expect(bind).not.toThrow();
        expect(rebind).not.toThrow();
      } else {
        expect(bind).toThrow("profile");
        expect(rebind).toThrow("profile");
      }
    }
  });

  test("returned evidence strips unrelated private fields from caller bindings", () => {
    const service = serviceFixture();
    Object.assign(service.project, { privateKey: "binding-secret-canary" });
    expect(JSON.stringify(bindHostedServiceAdmission(service))).not.toContain(
      "binding-secret-canary",
    );
    const volume = volumeFixture();
    Object.assign(volume.service, { controlToken: "binding-secret-canary" });
    expect(JSON.stringify(bindHostedVolumeAllocation(volume))).not.toContain(
      "binding-secret-canary",
    );
    const deployment = deploymentFixture();
    Object.assign(deployment.service, { apiCredential: "binding-secret-canary" });
    expect(JSON.stringify(bindHostedDeployment(deployment))).not.toContain("binding-secret-canary");
  });

  test("new project binds exact returned IDs and an empty sole environment", () => {
    const fixture = projectFixture();
    expect(() => assertHostedProjectAvailable(fixture.prepared, fixture.before)).not.toThrow();
    expect(bindHostedProjectAllocation(fixture)).toEqual({
      workspaceId: uuid(1),
      projectId: uuid(2),
      environmentId: uuid(3),
      projectName: "auggy-owned-rehearsal",
      environmentName: "rehearsal",
    });
  });

  test("existing name/ID, incomplete inventory, wrong parent and ambiguous environments refuse", () => {
    const collision = projectFixture();
    collision.before.projects = [
      { id: uuid(44), name: "auggy-owned-rehearsal", workspaceId: uuid(1) },
    ];
    expect(() => assertHostedProjectAvailable(collision.prepared, collision.before)).toThrow(
      "already exists",
    );
    const existing = projectFixture();
    existing.before.projects = [{ id: uuid(2), name: "old-project", workspaceId: uuid(1) }];
    expect(() => bindHostedProjectAllocation(existing)).toThrow("preexisting");
    const incomplete = projectFixture();
    incomplete.before.complete = false;
    expect(() => bindHostedProjectAllocation(incomplete)).toThrow("incomplete");
    const wrongParent = projectFixture();
    wrongParent.readback.data.project.workspaceId = uuid(99);
    expect(() => bindHostedProjectAllocation(wrongParent)).toThrow("parent");
    const wrongEnvironment = projectFixture();
    wrongEnvironment.readback.data.project.environments.edges[0]!.node.projectId = uuid(99);
    expect(() => bindHostedProjectAllocation(wrongEnvironment)).toThrow("sole approved");
    const ambiguous = projectFixture();
    ambiguous.readback.data.project.environments.edges.push({
      node: { id: uuid(44), name: "other", projectId: uuid(2) },
    });
    expect(() => bindHostedProjectAllocation(ambiguous)).toThrow("sole approved");
    const paginated = projectFixture();
    paginated.readback.data.project.environments.pageInfo.hasNextPage = true;
    expect(() => bindHostedProjectAllocation(paginated)).toThrow("paginated");
    const partial = projectFixture();
    Object.assign(partial.readback, { errors: [{ message: "denied" }] });
    expect(() => bindHostedProjectAllocation(partial)).toThrow("GraphQL errors");
  });

  test("workspace SSH registration binds new identity and refuses adoption or scope drift", () => {
    const prepared = prepareHostedIntegration(plan());
    const key = {
      id: uuid(11),
      name: prepared.plan.ssh.keyName,
      workspaceId: uuid(1),
      fingerprint: prepared.plan.ssh.fingerprint,
    };
    const options = {
      prepared,
      before: data({ sshPublicKeys: connection<typeof key>([]) }),
      creation: data({ sshPublicKeyCreate: key }),
      readback: data({ sshPublicKeys: connection([key]) }),
    };
    expect(bindHostedSshKey(options).keyId).toBe(key.id);
    expect(() =>
      bindHostedSshKey({ ...options, before: data({ sshPublicKeys: connection([key]) }) }),
    ).toThrow("already exists");
    expect(() =>
      bindHostedSshKey({
        ...options,
        creation: data({ sshPublicKeyCreate: { ...key, workspaceId: null } }),
      }),
    ).toThrow("scope");
    expect(() =>
      bindHostedSshKey({
        ...options,
        readback: data({ sshPublicKeys: connection([{ ...key, fingerprint: fingerprint(99) }]) }),
      }),
    ).toThrow("absent or ambiguous");
    expect(() =>
      bindHostedSshKey({
        ...options,
        readback: data({ sshPublicKeys: connection([key, { ...key, id: uuid(12) }]) }),
      }),
    ).toThrow("ambiguous");
  });

  test("refused setters, wrong identities, widened caps or restart policy cannot admit workload", () => {
    expect(bindHostedServiceAdmission(serviceFixture()).serviceId).toBe(uuid(4));
    const rejected = serviceFixture();
    rejected.capMutation.data.serviceInstanceLimitsUpdate = false;
    expect(() => bindHostedServiceAdmission(rejected)).toThrow("widening");
    const cap = serviceFixture();
    cap.readback.data.serviceInstanceLimits.containers.cpu = 24;
    expect(() => bindHostedServiceAdmission(cap)).toThrow("caps/policy");
    const memory = serviceFixture();
    memory.readback.data.serviceInstanceLimits.containers.memoryBytes = 4_294_967_296;
    expect(() => bindHostedServiceAdmission(memory)).toThrow("caps/policy");
    const restart = serviceFixture();
    restart.readback.data.serviceInstance.restartPolicyType = "ON_FAILURE";
    expect(() => bindHostedServiceAdmission(restart)).toThrow("caps/policy");
    const replicas = serviceFixture();
    replicas.readback.data.serviceInstance.numReplicas = 2;
    expect(() => bindHostedServiceAdmission(replicas)).toThrow("caps/policy");
    const wrongTarget = serviceFixture();
    wrongTarget.readback.data.serviceInstance.environmentId = uuid(99);
    expect(() => bindHostedServiceAdmission(wrongTarget)).toThrow("target");
    const wrongParent = serviceFixture();
    wrongParent.creation.data.serviceCreate.projectId = uuid(99);
    expect(() => bindHostedServiceAdmission(wrongParent)).toThrow("parent");
    const existing = serviceFixture();
    Object.assign(existing.readback.data.serviceInstance, { latestDeployment: { id: uuid(8) } });
    expect(() => bindHostedServiceAdmission(existing)).toThrow("existing workload");
  });

  test("volume admission counts historical IDs, exact provider capacity, attachment and readiness", () => {
    expect(bindHostedVolumeAllocation(volumeFixture()).volumeId).toBe(uuid(6));
    const reused = volumeFixture();
    reused.previousVolumeIds = [uuid(6)];
    expect(() => bindHostedVolumeAllocation(reused)).toThrow("reused");
    const exhausted = volumeFixture();
    exhausted.previousVolumeIds = [uuid(60), uuid(61), uuid(62), uuid(63)];
    expect(() => bindHostedVolumeAllocation(exhausted)).toThrow("allowance");
    for (const change of [
      { sizeMB: 50001 },
      { currentSizeMB: Number.NaN },
      { currentSizeMB: 50001 },
      { state: "MIGRATING" },
      { isPendingDeletion: true },
      { serviceId: uuid(99) },
      { environmentId: uuid(99) },
      { mountPath: "/elsewhere" },
    ]) {
      const fixture = volumeFixture();
      Object.assign(
        fixture.readback.data.project.volumes.edges[0]!.node.volumeInstances.edges[0]!.node,
        change,
      );
      expect(() => bindHostedVolumeAllocation(fixture)).toThrow("attachment/size/state");
    }
    const unexpected = volumeFixture();
    const extra = structuredClone(unexpected.readback.data.project.volumes.edges[0]!);
    extra.node.id = uuid(99);
    unexpected.readback.data.project.volumes.edges.push(extra);
    expect(() => bindHostedVolumeAllocation(unexpected)).toThrow("unexpected");
  });

  test("source build binds its returned deployment and observed image then rebinds every SSH instance", () => {
    const fixture = deploymentFixture();
    const binding = bindHostedDeployment(fixture);
    expect(binding.imageDigest).toBe(`sha256:${sha(25)}`);
    expect(binding.artifactId).toBe("http-baseline");
    expect(() =>
      assertHostedInstanceBinding({
        prepared: fixture.prepared,
        binding,
        selectedInstanceId: uuid(9),
        readback: fixture.readback,
      }),
    ).not.toThrow();
    expect(() =>
      assertHostedInstanceBinding({
        prepared: fixture.prepared,
        binding,
        selectedInstanceId: uuid(99),
        readback: fixture.readback,
      }),
    ).toThrow("forbidden");
    for (const change of [
      { id: uuid(99) },
      { projectId: uuid(99) },
      { environmentId: uuid(99) },
      { serviceId: uuid(99) },
      { meta: { imageDigest: `sha256:${sha(99)}` } },
      { instances: [{ id: uuid(99), status: "RUNNING" }] },
    ]) {
      const changed = structuredClone(fixture.readback);
      Object.assign(changed.data.deployment, change);
      expect(() =>
        assertHostedInstanceBinding({
          prepared: fixture.prepared,
          binding,
          selectedInstanceId: uuid(9),
          readback: changed,
        }),
      ).toThrow("forbidden");
    }
    const duplicate = deploymentFixture();
    duplicate.readback.data.deployment.instances.push({ id: uuid(99), status: "RUNNING" });
    expect(() => bindHostedDeployment(duplicate)).toThrow("singleton");
    const stopped = deploymentFixture();
    stopped.readback.data.deployment.deploymentStopped = true;
    expect(() => bindHostedDeployment(stopped)).toThrow("not running");
    expect(() => bindHostedDeployment({ ...fixture, artifactId: "none-baseline" })).toThrow(
      "profile",
    );
    expect(() => bindHostedDeployment({ ...fixture, artifactId: "unapproved" })).toThrow(
      "not approved",
    );
    expect(() => bindHostedDeployment({ ...fixture, returnedDeploymentId: uuid(99) })).toThrow(
      "returned ID",
    );
  });
});
