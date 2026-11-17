import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import type { startApplicationChild } from "../../scripts/release-smoke/application-child";
import {
  prepareHostedIntegration,
  type HostedIntegrationPlan,
} from "../../scripts/release-smoke/integration-hosted";
import { hostedSshPublicIdentity } from "../../scripts/release-smoke/integration-hosted-transport";
import {
  createHostedRailwayAdapter,
  createHostedRailwayAdapterForTest,
  prepareHostedRailwayAction,
  type HostedRailwayAction,
  type HostedRailwayAdapterOptions,
  type HostedRailwayResult,
} from "../../scripts/release-smoke/integration-hosted-railway";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (n: number) => n.toString(16).padStart(64, "0");
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const publicKey = `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString("base64")}`;
function plan(): HostedIntegrationPlan {
  return {
    version: 2,
    runId: "api-test",
    railway: {
      workspaceId: id(1),
      region: "us-west2",
      newProject: { name: "owned-rehearsal", environmentName: "rehearsal" },
      services: [
        { role: "http", name: "owned-http" },
        { role: "worker", name: "owned-worker" },
        { role: "http-recovery", name: "owned-http-recovery" },
        { role: "worker-recovery", name: "owned-worker-recovery" },
      ],
      volumes: [
        { alias: "http-original", serviceRole: "http", mountPath: "/app/data", sizeMB: 50000 },
        { alias: "worker-original", serviceRole: "worker", mountPath: "/app/data", sizeMB: 50000 },
        {
          alias: "http-restore",
          serviceRole: "http-recovery",
          mountPath: "/app/data",
          sizeMB: 50000,
        },
        {
          alias: "worker-restore",
          serviceRole: "worker-recovery",
          mountPath: "/app/data",
          sizeMB: 50000,
        },
      ],
    },
    ssh: {
      scope: "workspace",
      keyName: "owned-key",
      ...hostedSshPublicIdentity(publicKey),
      relay: {
        hostname: "ssh.railway.com",
        port: 22,
        trust: "explicit-first-use-pin",
        providerAuthenticated: false,
        ...hostedSshPublicIdentity(publicKey),
        knownHostsSHA256: sha(1),
      },
    },
    artifacts: (
      [
        ["http", "baseline"],
        ["none", "baseline"],
        ["http", "edited"],
        ["none", "edited"],
        ["none", "maintenance"],
      ] as const
    ).map(([profile, purpose]) => ({
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
    })),
    actionManifest: { sha256: sha(10), executorSHA256: sha(11), actionCount: 40 },
    acceptedEvidence: {
      localSHA256: sha(12),
      containerSHA256: sha(13),
      hostedFixtureSHA256: sha(14),
    },
    limits: {
      maxServices: 4,
      maxVolumes: 4,
      maxVolumeSizeMB: 50000,
      maxCpuPerService: 4,
      maxMemoryBytesPerService: 4_000_000_000,
      monitoredSpendUSD: 5,
      providerHardSpendCap: false,
      maxRunSeconds: 7200,
      cleanupReserveSeconds: 600,
      remoteCommandSeconds: 60,
      fixtureActivitySeconds: 120,
    },
    fixtures: {
      owner: "harness",
      connectivity: "service-loopback-via-ssh",
      services: (["http", "worker"] as const).map((role) => ({
        role,
        origins: ["http://127.0.0.1:43142"],
        controlOrigin: "http://127.0.0.1:43142",
        controlSourceSHA256: sha(15),
        sealedEvidenceContractSHA256: sha(16),
      })),
      syntheticIdentitySetSHA256: sha(17),
      allowedEffectContractSHA256: sha(18),
    },
    retention: {
      cleanupOwner: "harness",
      retainedUntil: new Date(Date.now() + 5 * 86400000).toISOString(),
      privateArtifactLocation: "private/api-test",
      retainResources: false,
    },
    source: { revision: "a".repeat(40), tree: "b".repeat(40), sourceChangesSHA256: sha(19) },
  };
}
const project = {
  workspaceId: id(1),
  projectId: id(2),
  environmentId: id(3),
  projectName: "owned-rehearsal",
  environmentName: "rehearsal",
};
const service = { ...project, role: "http" as const, serviceId: id(4), serviceName: "owned-http" };
const deployment = {
  ...service,
  artifactId: "http-baseline",
  deploymentId: id(5),
  imageDigest: `sha256:${sha(20)}`,
  instanceId: id(6),
};
const volume = {
  ...service,
  alias: "http-original" as const,
  volumeId: id(7),
  volumeInstanceId: id(8),
  sizeMB: 50000,
};
const before = { workspaceId: id(1), complete: true, projects: [] };
const createdProject = {
  data: { projectCreate: { id: id(2), name: "owned-rehearsal", workspaceId: id(1) } },
};
const createdService = {
  project,
  role: "http" as const,
  creation: { data: { serviceCreate: { id: id(4), name: "owned-http", projectId: id(2) } } },
};
const page = (nodes: unknown[] = []) => ({
  edges: nodes.map((node) => ({ node })),
  pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null },
});
type Child = Awaited<ReturnType<ReturnType<typeof startApplicationChild>["finish"]>>;
function child(data: Record<string, unknown>, overrides: Partial<Child> = {}): Child {
  const stdout = JSON.stringify({ data });
  return {
    exitCode: 0,
    signal: null,
    pid: 123,
    spawnFailed: false,
    timedOut: false,
    exceededOutput: false,
    orphanedGroup: false,
    cleanupConfirmed: true,
    inputComplete: true,
    inputFailed: false,
    durationMs: 1,
    stdout,
    stderr: "",
    stdoutSHA256: hash(stdout),
    stderrSHA256: hash(""),
    ...overrides,
  };
}
let cwd: string;
beforeEach(() => {
  cwd = mkdtempSync(join(tmpdir(), "hosted-api-test-"));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});
function setup(
  runner: Parameters<typeof createHostedRailwayAdapterForTest>[1],
  overrides: Partial<HostedRailwayAdapterOptions> = {},
) {
  const prepared = prepareHostedIntegration(plan());
  const events: unknown[] = [];
  const options: HostedRailwayAdapterOptions = {
    prepared,
    railwaySHA256: sha(22),
    workingDirectory: cwd,
    beforeAttempt: async (value) => {
      events.push({ before: value });
    },
    afterAttempt: async (value) => {
      events.push({ after: value });
    },
    ...overrides,
  };
  const gate = {
    prepared,
    approval: {
      approvedPlanSHA256: prepared.sha256,
      recordedApprovalId: "explicit-user-approval",
      approvedAt: new Date(Date.now() - 60000).toISOString(),
      expiresAt: new Date(Date.now() + 4 * 3600000).toISOString(),
    },
    observedInputs: {
      actionManifestSHA256: prepared.plan.actionManifest.sha256,
      actionCount: prepared.plan.actionManifest.actionCount,
      executorSHA256: prepared.plan.actionManifest.executorSHA256,
      artifactInputsSHA256: prepared.artifactInputsSHA256,
      acceptedEvidence: prepared.plan.acceptedEvidence,
      ssh: {
        publicKeySHA256: prepared.plan.ssh.publicKeySHA256,
        relayPublicKeySHA256: prepared.plan.ssh.relay.publicKeySHA256,
        knownHostsSHA256: prepared.plan.ssh.relay.knownHostsSHA256,
      },
    },
    startedAt: Date.now(),
    now: 0,
  };
  return {
    options,
    prepared,
    events,
    gate,
    api: createHostedRailwayAdapterForTest(options, runner),
  };
}
const createAction: HostedRailwayAction = {
  actionId: "create-project",
  operation: "project-create",
  before,
};

test("fixed builders derive exact allocation, policy, capacity, usage and cleanup variables", () => {
  const p = prepareHostedIntegration(plan());
  const build = (action: HostedRailwayAction) =>
    prepareHostedRailwayAction(p, action, { startedAt: 1000, now: 2000 });
  const vars = (action: HostedRailwayAction) => JSON.parse(build(action).input.toString());
  expect(vars(createAction)).toEqual({
    input: {
      workspaceId: id(1),
      name: "owned-rehearsal",
      defaultEnvironmentName: "rehearsal",
      isPublic: false,
      prDeploys: false,
    },
  });
  expect(vars({ actionId: "service", operation: "service-create", project, role: "http" })).toEqual(
    { input: { projectId: id(2), environmentId: id(3), name: "owned-http" } },
  );
  expect(vars({ actionId: "caps", operation: "service-caps", service: createdService })).toEqual({
    input: { serviceId: id(4), environmentId: id(3), vCPUs: 4, memoryGB: 4 },
  });
  expect(
    vars({ actionId: "policy", operation: "service-policy", service: createdService }).input,
  ).toEqual({
    numReplicas: 1,
    multiRegionConfig: { "us-west2": { numReplicas: 1 } },
    restartPolicyType: "NEVER",
    restartPolicyMaxRetries: 0,
    sleepApplication: false,
  });
  expect(
    vars({ actionId: "volume", operation: "volume-create", service, alias: "http-original" }),
  ).toEqual({
    input: {
      projectId: id(2),
      environmentId: id(3),
      serviceId: id(4),
      region: "us-west2",
      mountPath: "/app/data",
    },
  });
  expect(
    vars({
      actionId: "key",
      operation: "key-create",
      publicKey: `${publicKey} discarded-comment\n`,
    }).input.publicKey,
  ).toBe(publicKey);
  expect(
    vars({ actionId: "read-created", operation: "project-read", before, creation: createdProject }),
  ).toEqual({ id: id(2) });
  expect(build({ actionId: "capacity", operation: "workspace-capacity" }).query).toContain(
    "subscriptionPlanLimit",
  );
  expect(build({ actionId: "read", operation: "project-read", project }).query).toContain(
    "isPendingDeletion",
  );
  const usage = build({ actionId: "cost", operation: "usage", project });
  expect(usage.query).toContain("groupBy:[PROJECT_ID,SERVICE_ID]");
  expect(JSON.parse(usage.input.toString())).toEqual({
    projectId: id(2),
    workspaceId: id(1),
    start: "1970-01-01T00:00:01.000Z",
    end: "1970-01-01T00:00:02.000Z",
  });
  const deletes: HostedRailwayAction[] = [
    { actionId: "stop", operation: "deployment-stop", deployment },
    { actionId: "remove", operation: "deployment-delete", deployment },
    { actionId: "volume", operation: "volume-delete", volume },
    { actionId: "service", operation: "service-delete", service },
    { actionId: "project", operation: "project-delete", project },
    {
      actionId: "key",
      operation: "key-delete",
      key: {
        workspaceId: id(1),
        keyId: id(9),
        keyName: p.plan.ssh.keyName,
        fingerprint: p.plan.ssh.fingerprint,
      },
    },
  ];
  for (const action of deletes) expect(build(action).kind).toBe("mutation");
  expect(build(deletes[4]!).query).toContain("projectDelete(");
  expect(build(deletes[4]!).query).not.toContain("projectScheduleDelete");
});

test("wrong bindings, unsupported variables and partial creation replies cannot construct authority", () => {
  const p = prepareHostedIntegration(plan());
  const bad: unknown[] = [
    { actionId: "bad", operation: "raw-query", query: "mutation { projectDelete }" },
    { actionId: "bad", operation: "project-delete", project: { ...project, workspaceId: id(99) } },
    { actionId: "bad", operation: "project-delete", project: { ...project, projectId: "-p;evil" } },
    {
      actionId: "bad",
      operation: "service-caps",
      service: { ...service, serviceName: "unapproved" },
    },
    { actionId: "bad", operation: "volume-create", service, alias: "worker-original" },
    { actionId: "bad", operation: "volume-delete", volume: { ...volume, sizeMB: 49999 } },
    {
      actionId: "bad",
      operation: "project-read",
      before: { ...before, projects: [{ id: id(2), name: "old", workspaceId: id(1) }] },
      creation: createdProject,
    },
    {
      actionId: "bad",
      operation: "project-read",
      before,
      creation: { ...createdProject, errors: [{ message: "private-error" }] },
    },
    { actionId: "bad", operation: "workspace-projects", after: "x".repeat(513) },
    { actionId: "bad", operation: "key-create", publicKey: "private-secret" },
  ];
  for (const action of bad)
    expect(() => prepareHostedRailwayAction(p, action as HostedRailwayAction)).toThrow();
  const changed = structuredClone(p);
  changed.plan.railway.newProject.name = "other";
  expect(() => prepareHostedRailwayAction(changed, createAction)).toThrow("plan changed");
  const fakeOverride = {
    actionId: "caps",
    operation: "service-caps",
    service,
    input: { vCPUs: 24 },
    token: "secret-canary",
  } as HostedRailwayAction;
  const result = prepareHostedRailwayAction(p, fakeOverride);
  expect(JSON.parse(result.input.toString()).input.vCPUs).toBe(4);
  expect(JSON.stringify(result)).not.toContain("secret-canary");
  const small = plan();
  small.railway.volumes[0]!.sizeMB = 5000;
  expect(() =>
    prepareHostedRailwayAction(prepareHostedIntegration(small), {
      actionId: "volume",
      operation: "volume-create",
      service,
      alias: "http-original",
    }),
  ).toThrow("50000MB");
});

test("production executable hash mismatch refuses without invoking Railway or network", async () => {
  const s = setup(async () => {
    throw new Error("test runner must not run");
  });
  const api = createHostedRailwayAdapter({ ...s.options, railwaySHA256: "0".repeat(64) });
  await expect(api.run({ actionId: "inventory", operation: "workspace-projects" })).rejects.toThrow(
    "Pinned Railway CLI",
  );
});

test("dedicated restore roles target distinct services and reject cross-profile volume aliases", () => {
  const prepared = prepareHostedIntegration(plan());
  const httpRecovery = {
    ...project,
    role: "http-recovery" as const,
    serviceId: id(30),
    serviceName: "owned-http-recovery",
  };
  const workerRecovery = {
    ...project,
    role: "worker-recovery" as const,
    serviceId: id(31),
    serviceName: "owned-worker-recovery",
  };
  for (const [target, alias] of [
    [httpRecovery, "http-restore"],
    [workerRecovery, "worker-restore"],
  ] as const) {
    const action = prepareHostedRailwayAction(prepared, {
      actionId: "restore",
      operation: "volume-create",
      service: target,
      alias,
    });
    expect(JSON.parse(action.input.toString()).input.serviceId).toBe(target.serviceId);
  }
  expect(() =>
    prepareHostedRailwayAction(prepared, {
      actionId: "swapped",
      operation: "volume-create",
      service: httpRecovery,
      alias: "worker-restore",
    }),
  ).toThrow("role");
  expect(() =>
    prepareHostedRailwayAction(prepared, {
      actionId: "shared",
      operation: "service-create",
      project,
      role: "recovery" as typeof httpRecovery.role,
    }),
  ).toThrow("role");
});

test("adapter construction rejects changed artifact evidence before any child admission", () => {
  const s = setup(async () => child(createdProject.data));
  const prepared = structuredClone(s.prepared);
  prepared.artifactInputsSHA256 = sha(99);
  expect(() =>
    createHostedRailwayAdapterForTest({ ...s.options, prepared }, async () => child({})),
  ).toThrow("plan changed");
});

test("capacity and volume readbacks keep allocation facts separate from used storage and omit unrelated fields", async () => {
  const capacity = {
    id: id(1),
    plan: "PRO",
    projectCount: 8,
    preferredRegion: "us-west2",
    subscriptionPlanLimit: {
      projects: 100,
      project: { services: 100, members: null },
      volumes: { defaultSizeMB: 50000, maxSizeMB: 1000000, maxPerProject: 20 },
      containers: {
        cpu: 24,
        memoryBytes: 24000000000,
        minReplicaCpu: 4,
        minReplicaMemoryBytes: 4000000000,
      },
      rateLimits: {
        projectCreate: { max: 1, windowSeconds: 30 },
        volumeCreate: { max: 1, windowSeconds: 30 },
      },
      privateBilling: "secret-canary",
    },
    customer: {
      state: "ACTIVE",
      isTrialing: false,
      isUsageSubscriber: true,
      planLimitOverride: null,
      usageLimit: "secret-canary",
    },
    name: "private-account-canary",
  };
  const s = setup(async () => child({ workspace: capacity }));
  const result = await s.api.run({ actionId: "capacity", operation: "workspace-capacity" });
  expect(result.outcome).toBe("response");
  expect(JSON.stringify(result)).not.toContain("secret-canary");
  expect(JSON.stringify(result)).not.toContain("private-account-canary");
  const unsafe = setup(async () =>
    child({ workspace: { ...capacity, subscriptionPlanLimit: null } }),
  );
  expect(
    (await unsafe.api.run({ actionId: "capacity", operation: "workspace-capacity" })).outcome,
  ).toBe("query-failed");
  const volumeReadback = {
    id: id(8),
    volumeId: id(7),
    environmentId: id(3),
    serviceId: id(4),
    mountPath: "/app/data",
    region: "us-west2",
    sizeMB: 50000,
    currentSizeMB: 0.25,
    state: "READY",
    deletedAt: null,
    isPendingDeletion: false,
  };
  const v = setup(async () =>
    child({
      project: {
        ...createdProject.data.projectCreate,
        isPublic: false,
        prDeploys: false,
        deletedAt: null,
        environments: page([{ id: id(3), name: "rehearsal", projectId: id(2) }]),
        services: page([{ id: id(4), name: "owned-http", projectId: id(2) }]),
        volumes: page([
          { id: id(7), name: "data", projectId: id(2), volumeInstances: page([volumeReadback]) },
        ]),
      },
    }),
  );
  const actual = await v.api.run({
    actionId: "volume-readback",
    operation: "project-read",
    project,
  });
  expect(actual.outcome).toBe("response");
  expect(JSON.stringify(actual.response)).toContain('"sizeMB":50000');
  expect(JSON.stringify(actual.response)).toContain('"currentSizeMB":0.25');
  expect(JSON.stringify(actual.response)).toContain('"isPendingDeletion":false');
});

test("mutation requires current matching approval, exclusive before receipt, and owned input delivery", async () => {
  const order: string[] = [];
  let call: Parameters<typeof startApplicationChild>[0] | undefined;
  const s = setup(
    async (input) => {
      order.push("run");
      call = input;
      return child(createdProject.data);
    },
    {
      beforeAttempt: async () => {
        order.push("before");
      },
      afterAttempt: async () => {
        order.push("after");
      },
    },
  );
  await expect(s.api.run(createAction)).rejects.toThrow("approval");
  expect(order).toEqual([]);
  const wrong = structuredClone(s.gate);
  wrong.approval.approvedPlanSHA256 = sha(99);
  await expect(s.api.run(createAction, wrong)).rejects.toThrow();
  const result = await s.api.run(createAction, s.gate);
  expect(order).toEqual(["before", "run", "after"]);
  expect(call!.command.slice(0, 2)).toEqual(["/opt/homebrew/bin/railway", "api"]);
  expect(call!.command.slice(-3)).toEqual(["--variables", "@-", "--compact"]);
  expect(call!.command).not.toContain("secret-canary");
  expect(call!.env).toEqual({
    HOME: realpathSync(homedir()),
    PATH: "/usr/bin:/bin",
    LANG: "C.UTF-8",
    NO_COLOR: "1",
    CI: "true",
  });
  expect(call!.env.RAILWAY_TOKEN).toBeUndefined();
  expect(call!.env.RAILWAY_API_TOKEN).toBeUndefined();
  expect(call!.timeoutMs).toBe(15000);
  expect(call!.maxOutputBytes).toBe(2 * 1024 * 1024);
  expect(hash(call!.input!)).toBe(result.inputSHA256);
  expect(result.outcome).toBe("response");
  expect(result.child?.inputComplete).toBe(true);
  expect(result.response).toEqual(createdProject);
  expect(JSON.stringify(result)).not.toContain('"stdout":');
});

test("failure to durably admit refuses before API; changed admission after recording reports not-started", async () => {
  let runs = 0;
  const s = setup(
    async () => {
      runs++;
      return child(createdProject.data);
    },
    {
      beforeAttempt: async () => {
        throw new Error("private-callback-canary");
      },
    },
  );
  await expect(s.api.run(createAction, s.gate)).rejects.toThrow("not recorded");
  expect(runs).toBe(0);
  const outcomes: HostedRailwayResult[] = [];
  const changed = setup(
    async () => {
      runs++;
      return child(createdProject.data);
    },
    {
      beforeAttempt: async () => {
        changed.gate.approval.expiresAt = new Date(Date.now() - 1).toISOString();
      },
      afterAttempt: async (result) => {
        outcomes.push(result);
      },
    },
  );
  expect((await changed.api.run(createAction, changed.gate)).outcome).toBe("not-started");
  expect(outcomes[0]!.outcome).toBe("not-started");
  expect(runs).toBe(0);
});

test("each failed child/input/cleanup observation is unknown for mutations and never retried", async () => {
  const changes: Partial<Child>[] = [
    { timedOut: true },
    { cleanupConfirmed: false },
    { orphanedGroup: true },
    { inputComplete: false },
    { inputFailed: true },
    { exceededOutput: true },
    { exitCode: 1 },
    { signal: "SIGKILL" },
    { spawnFailed: true },
  ];
  for (const change of changes) {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      return child(createdProject.data, change);
    });
    const result = await s.api.run(createAction, s.gate);
    expect(result.outcome).toBe("unknown");
    expect(result.response).toBeNull();
    expect(calls).toBe(1);
    expect(s.events).toHaveLength(2);
  }
  const thrown = setup(async () => {
    throw new Error("private-runner-canary");
  });
  const result = await thrown.api.run(createAction, thrown.gate);
  expect(result.outcome).toBe("unknown");
  expect(JSON.stringify(result)).not.toContain("private-runner-canary");
});

test("partial GraphQL data, malformed bodies and oversized output cannot become mutation success", async () => {
  for (const stdout of [
    JSON.stringify({ ...createdProject, errors: [{ message: "credential-canary" }] }),
    JSON.stringify({ ...createdProject, errors: null }),
    "not-json",
    "x".repeat(2 * 1024 * 1024 + 1),
    JSON.stringify({
      data: { projectCreate: { ...createdProject.data.projectCreate, id: "wrong" } },
    }),
  ]) {
    const s = setup(async () => child(createdProject.data, { stdout }));
    const result = await s.api.run(createAction, s.gate);
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("invalid-response");
    expect(result.response).toBeNull();
    expect(JSON.stringify(result)).not.toContain("credential-canary");
  }
});

test("known identity response reconstruction strips credentials, opaque deployment metadata and diagnostics", async () => {
  const s = setup(async () =>
    child(
      {
        deployment: {
          id: id(5),
          projectId: id(2),
          environmentId: id(3),
          serviceId: id(4),
          status: "SUCCESS",
          deploymentStopped: false,
          meta: { imageDigest: `sha256:${sha(20)}`, variables: { token: "secret-canary" } },
          instances: [{ id: id(6), status: "RUNNING", privateKey: "secret-canary" }],
        },
        token: "secret-canary",
      },
      { stderr: "private-diagnostic-canary" },
    ),
  );
  const result = await s.api.run({
    actionId: "read",
    operation: "deployment-read",
    service,
    returnedDeploymentId: id(5),
  });
  expect(result.outcome).toBe("response");
  expect(JSON.stringify(result)).not.toContain("secret-canary");
  expect(JSON.stringify(result)).not.toContain("private-diagnostic-canary");
  expect(s.events).toHaveLength(0);
});

test("Boolean false stays a response rather than a no-effect claim; failed journaling blocks progression", async () => {
  const s = setup(async () => child({ projectDelete: false }));
  const result = await s.api.run(
    { actionId: "delete", operation: "project-delete", project },
    s.gate,
  );
  expect(result.outcome).toBe("response");
  expect(result.response).toEqual({ data: { projectDelete: false } });
  const failed = setup(async () => child(createdProject.data), {
    afterAttempt: async () => {
      throw new Error("private-journal-canary");
    },
  });
  await expect(failed.api.run(createAction, failed.gate)).rejects.toThrow("do not replay");
});

test("pagination is explicit and bounded; inventory reads cannot carry variables or target overrides", async () => {
  let variables: unknown;
  const s = setup(async (input) => {
    variables = JSON.parse(Buffer.from(input.input!).toString());
    return child({ projects: page() });
  });
  const action = {
    actionId: "inventory",
    operation: "workspace-projects",
    after: "cursor-one",
    variables: { workspaceId: id(99) },
    endpoint: "https://evil.invalid",
  } as HostedRailwayAction;
  expect((await s.api.run(action)).outcome).toBe("response");
  expect(variables).toEqual({ workspaceId: id(1), after: "cursor-one" });
  const missing = setup(async () => child({ projects: { edges: [] } }));
  expect(
    (await missing.api.run({ actionId: "inventory", operation: "workspace-projects" })).outcome,
  ).toBe("query-failed");
});

test("cleanup uses an explicitly active inventory; allocation still includes deleted history", async () => {
  const prepared = prepareHostedIntegration(plan());
  const history = prepareHostedRailwayAction(prepared, {
    actionId: "before",
    operation: "workspace-projects",
  });
  const active = prepareHostedRailwayAction(prepared, {
    actionId: "absent",
    operation: "workspace-active-projects",
    after: "next",
  });
  expect(history.query).toContain("includeDeleted:true");
  expect(active.query).toContain("includeDeleted:false");
  expect(active.query).toContain("deletedAt");
  expect(JSON.parse(active.input.toString())).toEqual({ workspaceId: id(1), after: "next" });
  for (const deletedAt of [undefined, "2026-11-15T00:00:00Z", null]) {
    const s = setup(async () =>
      child({ projects: page([{ ...createdProject.data.projectCreate, deletedAt }]) }),
    );
    const result = await s.api.run({ actionId: "absent", operation: "workspace-active-projects" });
    expect(result.outcome).toBe(deletedAt === null ? "response" : "query-failed");
  }
});

test("service schema failures retain only bounded structural paths, codes and types", async () => {
  const s = setup(async () =>
    child(
      {
        serviceInstance: {
          id: "credential-canary",
          serviceId: id(4),
          environmentId: id(3),
          numReplicas: "credential-canary",
          region: "private-region-canary",
          restartPolicyType: "NEVER",
          restartPolicyMaxRetries: 0,
          sleepApplication: false,
          latestDeployment: null,
          "private-key-canary": "credential-canary",
        },
        serviceInstanceLimits: { containers: { cpu: "credential-canary", memoryBytes: null } },
        serviceInstanceLimitOverride: null,
        "private-key-canary": "credential-canary",
      },
      { stderr: "credential-canary" },
    ),
  );
  const result = await s.api.run({ actionId: "read", operation: "service-read", service });
  expect(result.outcome).toBe("query-failed");
  expect(result.reason).toBe("invalid-response");
  expect(result.response).toBeNull();
  expect(result.diagnostic?.stage).toBe("schema");
  expect(result.diagnostic?.issues).toContainEqual({
    path: "serviceInstanceLimits.containers.cpu",
    code: "invalid_type",
  });
  expect(result.diagnostic?.structure).toContainEqual({
    path: "serviceInstanceLimits.containers.memoryBytes",
    type: "null",
  });
  expect(result.diagnostic?.issues.length).toBeLessThanOrEqual(24);
  expect(result.diagnostic?.structure.length).toBeLessThanOrEqual(32);
  expect(JSON.stringify(result)).not.toContain("canary");
  expect(JSON.stringify(result).length).toBeLessThan(5000);
});

test("service read projects only owned placement from nondecrypted environment config", async () => {
  const raw = {
    environment: {
      id: id(3),
      projectId: id(2),
      config: {
        sharedVariables: { token: { value: "secret-canary" } },
        services: {
          [id(4)]: {
            variables: { token: { value: "secret-canary" } },
            deploy: {
              multiRegionConfig: { "us-west2": { numReplicas: 1 } },
              registryCredentials: { password: "secret-canary" },
            },
          },
          [id(99)]: { variables: { token: { value: "secret-canary" } } },
        },
      },
    },
    serviceInstance: {
      id: id(5),
      serviceId: id(4),
      environmentId: id(3),
      numReplicas: 1,
      region: null,
      restartPolicyType: "NEVER",
      restartPolicyMaxRetries: 0,
      sleepApplication: false,
      latestDeployment: null,
    },
    serviceInstanceLimits: { containers: { cpu: 4, memoryBytes: 4000000000 } },
    serviceInstanceLimitOverride: null,
    servicePlacement: { secret: "secret-canary" },
  };
  const s = setup(async (input) => {
    expect(input.command[2]).toContain("config(decryptVariables:false)");
    return child(raw);
  });
  const result = await s.api.run({ actionId: "read", operation: "service-read", service });
  expect(result.outcome).toBe("response");
  expect(result.response?.data.servicePlacement).toEqual({
    environmentId: id(3),
    projectId: id(2),
    serviceId: id(4),
    multiRegionConfig: { "us-west2": { numReplicas: 1 } },
  });
  expect(result.response?.data.environment).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("secret-canary");
  for (const config of [
    undefined,
    null,
    { services: {} },
    {
      services: {
        [id(4)]: { deploy: { multiRegionConfig: { "secret-canary": "secret-canary" } } },
      },
    },
  ]) {
    const failed = setup(async () =>
      child({ ...raw, environment: { ...raw.environment, config } }),
    );
    const observation = await failed.api.run({
      actionId: "read",
      operation: "service-read",
      service,
    });
    expect(observation.outcome).toBe("query-failed");
    expect(observation.response).toBeNull();
    expect(observation.diagnostic?.stage).toBe("placement");
    expect(observation.diagnostic?.issues).toEqual([
      { path: "servicePlacement", code: "projection-refused" },
    ]);
    expect(observation.diagnostic?.structure).toContainEqual({
      path: "environment.config.services.[selected].deploy.multiRegionConfig",
      type: config?.services?.[id(4)] ? "object" : "missing",
    });
    expect(JSON.stringify(observation)).not.toContain("secret-canary");
  }
});

test("failed service queries distinguish child failure and GraphQL envelope failure without leaking messages", async () => {
  for (const failedChild of [true, false]) {
    const s = setup(async () =>
      child(
        {},
        {
          timedOut: failedChild,
          stdout: JSON.stringify({
            data: { serviceInstance: null },
            errors: [{ message: "credential-canary", path: ["private-key-canary"] }],
          }),
          stderr: "credential-canary",
        },
      ),
    );
    const result = await s.api.run({ actionId: "read", operation: "service-read", service });
    expect(result.outcome).toBe("query-failed");
    expect(result.reason).toBe(failedChild ? "child-failure" : "invalid-response");
    expect(result.diagnostic?.stage).toBe(failedChild ? undefined : "envelope");
    if (!failedChild)
      expect(result.diagnostic?.issues).toEqual([{ path: "errors", code: "too_big" }]);
    expect(JSON.stringify(result)).not.toContain("canary");
  }
});

test("native exit-one GraphQL service failures expose only allowlisted paths and never become responses", async () => {
  const stdout = JSON.stringify({
    data: null,
    errors: [
      { message: "credential-canary", path: ["serviceInstance"] },
      { message: "credential-canary", path: ["serviceInstanceLimitOverride"] },
      { path: ["private-key-canary"] },
    ],
  });
  for (const change of [
    {},
    { timedOut: true },
    { exceededOutput: true },
    { inputComplete: false },
    { cleanupConfirmed: false },
  ]) {
    const s = setup(async () => child({}, { exitCode: 1, stdout, ...change }));
    const result = await s.api.run({ actionId: "read", operation: "service-read", service });
    expect(result.outcome).toBe("query-failed");
    expect(result.reason).toBe("child-failure");
    expect(result.response).toBeNull();
    if (Object.keys(change).length === 0) {
      expect(result.diagnostic?.stage).toBe("envelope");
      expect(result.diagnostic?.graphqlErrorPaths).toEqual([
        "serviceInstance",
        "serviceInstanceLimitOverride",
        "[unlisted]",
      ]);
    } else expect(result.diagnostic).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("canary");
  }
});

test("mutation variables are owned before an asynchronous admission callback", async () => {
  const target = { ...project };
  let actual: unknown;
  const s = setup(
    async (input) => {
      actual = JSON.parse(Buffer.from(input.input!).toString());
      return child({ projectDelete: true });
    },
    {
      beforeAttempt: async () => {
        await Bun.sleep(1);
        target.projectId = id(99);
      },
    },
  );
  await s.api.run({ actionId: "delete", operation: "project-delete", project: target }, s.gate);
  expect(actual).toEqual({ id: id(2) });
});

test("insufficient phase budget refuses before a mutation is journaled", async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return child(createdProject.data);
  });
  s.gate.startedAt = Date.now() - 7200 * 1000 + 1000;
  s.gate.approval.approvedAt = new Date(s.gate.startedAt - 60000).toISOString();
  await expect(s.api.run(createAction, s.gate)).rejects.toThrow("Insufficient");
  expect(calls).toBe(0);
  expect(s.events).toHaveLength(0);
});

test("cleanup reserve refuses allocation and policy before admission, including a phase change during admission", async () => {
  let calls = 0;
  const s = setup(async () => {
    calls++;
    return child({ projectDelete: true });
  });
  const cleanup = { ...s.gate, phase: "cleanup" as const };
  const forbidden: HostedRailwayAction[] = [
    createAction,
    { actionId: "service-create", operation: "service-create", project, role: "http" },
    { actionId: "service-caps", operation: "service-caps", service },
    { actionId: "service-policy", operation: "service-policy", service },
    { actionId: "volume-create", operation: "volume-create", service, alias: "http-original" },
    { actionId: "key-create", operation: "key-create", publicKey },
  ];
  for (const action of forbidden)
    await expect(s.api.run(action, cleanup)).rejects.toThrow("cleanup reserve");
  expect(s.events).toHaveLength(0);
  expect(calls).toBe(0);
  expect(
    (await s.api.run({ actionId: "delete", operation: "project-delete", project }, cleanup))
      .outcome,
  ).toBe("response");
  expect(calls).toBe(1);

  const gate = { ...s.gate, phase: "execution" as "execution" | "cleanup" };
  const switching = setup(
    async () => {
      calls++;
      return child(createdProject.data);
    },
    {
      beforeAttempt: async () => {
        gate.phase = "cleanup";
      },
    },
  );
  gate.prepared = switching.prepared;
  gate.approval.approvedPlanSHA256 = switching.prepared.sha256;
  gate.observedInputs = switching.gate.observedInputs;
  const changed = await switching.api.run(createAction, gate);
  expect(changed.outcome).toBe("not-started");
  expect(calls).toBe(1);
  expect(switching.events).toHaveLength(1);
});

test("volume deletion uses validated allocation ownership without fabricating an instance", () => {
  const { volumeInstanceId: _, ...ownership } = volume;
  const prepared = prepareHostedIntegration(plan());
  const built = prepareHostedRailwayAction(prepared, {
    actionId: "delete-unbound-volume",
    operation: "volume-delete",
    volume: ownership,
  });
  expect(JSON.parse(built.input.toString())).toEqual({ id: volume.volumeId });
  expect(built.query).toContain("volumeDelete");
  expect(() =>
    prepareHostedRailwayAction(prepared, {
      actionId: "delete-wrong-role",
      operation: "volume-delete",
      volume: { ...ownership, alias: "worker-original" },
    }),
  ).toThrow("ownership");
});

test("request deadlines reserve reap time and never extend request or phase limits", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    const observed: number[] = [];
    const s = setup(async (input) => {
      observed.push(input.timeoutMs!);
      return child({ projectDelete: true });
    });
    const action: HostedRailwayAction = {
      actionId: "delete",
      operation: "project-delete",
      project,
    };
    expect((await s.api.run(action, s.gate, { deadlineMs: now + 10000 })).outcome).toBe("response");
    expect((await s.api.run(action, s.gate, { deadlineMs: now + 60000 })).outcome).toBe("response");
    s.gate.startedAt = now - 7200 * 1000 + 12000;
    s.gate.approval.approvedAt = new Date(s.gate.startedAt - 60000).toISOString();
    expect((await s.api.run(action, s.gate, { deadlineMs: now + 60000 })).outcome).toBe("response");
    const cleanup = { ...s.gate, phase: "cleanup" as const, startedAt: now - 7800 * 1000 + 9000 };
    cleanup.approval = {
      ...cleanup.approval,
      approvedAt: new Date(cleanup.startedAt - 60000).toISOString(),
    };
    expect((await s.api.run(action, cleanup, { deadlineMs: now + 60000 })).outcome).toBe(
      "response",
    );
    expect(observed).toEqual([5000, 15000, 7000, 4000]);
  } finally {
    clock.mockRestore();
  }
});

test("invalid or exhausted request deadlines refuse before admission or child creation", async () => {
  const now = Date.now();
  const clock = spyOn(Date, "now").mockReturnValue(now);
  try {
    let calls = 0;
    const s = setup(async () => {
      calls++;
      return child(createdProject.data);
    });
    for (const deadlineMs of [
      Number.NaN,
      Infinity,
      -1,
      0,
      0.5,
      Number.MAX_SAFE_INTEGER + 1,
      undefined,
      null,
    ])
      await expect(
        s.api.run(createAction, s.gate, { deadlineMs: deadlineMs as number }),
      ).rejects.toThrow("Invalid hosted API request deadline");
    for (const deadlineMs of [now - 1, now, now + 5000])
      await expect(s.api.run(createAction, s.gate, { deadlineMs })).rejects.toThrow("Insufficient");
    expect(calls).toBe(0);
    expect(s.events).toHaveLength(0);
  } finally {
    clock.mockRestore();
  }
});

test("admission latency reduces the captured request deadline even if its caller mutates options", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const request = { deadlineMs: now + 15000 };
    let timeout: number | undefined;
    const s = setup(
      async (input) => {
        timeout = input.timeoutMs;
        return child(createdProject.data);
      },
      {
        beforeAttempt: async () => {
          await Promise.resolve();
          now += 2000;
          request.deadlineMs = now + 60000;
        },
      },
    );
    expect((await s.api.run(createAction, s.gate, request)).outcome).toBe("response");
    expect(timeout).toBe(8000);
  } finally {
    clock.mockRestore();
  }
});

test("deadline exhaustion during admission records not-started without calling the provider", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    let calls = 0;
    const request = { deadlineMs: now + 10000 };
    const s = setup(
      async () => {
        calls++;
        return child(createdProject.data);
      },
      {
        beforeAttempt: async () => {
          await Promise.resolve();
          now += 5000;
        },
      },
    );
    const result = await s.api.run(createAction, s.gate, request);
    expect(result.outcome).toBe("not-started");
    expect(result.reason).toBe("admission-changed");
    expect(result.child).toBeNull();
    expect(calls).toBe(0);
    expect(s.events).toEqual([{ after: result }]);
  } finally {
    clock.mockRestore();
  }
});

test("a child returning beyond the deadline retains evidence without establishing success", async () => {
  let now = Date.now();
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  try {
    const s = setup(async () => {
      now += 10001;
      return child(createdProject.data);
    });
    const result = await s.api.run(createAction, s.gate, { deadlineMs: now + 10000 });
    expect(result.outcome).toBe("unknown");
    expect(result.reason).toBe("child-failure");
    expect(result.response).toBeNull();
    expect(result.child?.exitCode).toBe(0);
    expect(s.events).toHaveLength(2);
    const query = setup(async () => {
      now += 10001;
      return child({ project: null });
    });
    expect(
      (
        await query.api.run({ actionId: "read", operation: "project-read", project }, query.gate, {
          deadlineMs: now + 10000,
        })
      ).outcome,
    ).toBe("query-failed");
  } finally {
    clock.mockRestore();
  }
});
