import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  createHostedContext,
  hostedInputSchema,
  type HostedContext,
} from "../../scripts/release-smoke/hosted-context";
import {
  createScenarioRailway,
  hostedResourceName,
  bindScenarioRestart,
  type ScenarioDeployment,
} from "../../scripts/release-smoke/hosted-railway";
import { hostedSshPublicIdentity } from "../../scripts/release-smoke/integration-hosted-transport";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const publicKey = `ssh-ed25519 ${Buffer.concat([Buffer.from([0, 0, 0, 11]), Buffer.from("ssh-ed25519"), Buffer.from([0, 0, 0, 32]), Buffer.alloc(32, 1)]).toString("base64")}`;
const page = <T>(values: T[]) => ({
  edges: values.map((node) => ({ node })),
  pageInfo: { hasNextPage: false, hasPreviousPage: false, endCursor: null },
});
test("generated resource names fit Railway's project-name limit before allocation", () => {
  expect(hostedResourceName("9f46c7df-c529-4dcb-91ad-91d512697fa8")).toBe(
    "auggy-m5-9f46c7dfc5294dcb91ad",
  );
  expect(hostedResourceName(id(1)).length).toBeLessThanOrEqual(32);
  expect(() => hostedResourceName("unvalidated-project-name")).toThrow();
});
function fixture(fail?: "unknown-service" | "foreign-volume") {
  const base = mkdtempSync(join(realpathSync(tmpdir()), "m5-provider-test-"));
  roots.push(base);
  const env = join(base, "fixture.env");
  writeFileSync(env, "FIXTURE_SECRET=private-fixture-token\n");
  const input = hostedInputSchema.parse({
    version: 1,
    workspaceId: id(1),
    revision: "a".repeat(40),
    baselineConsumer: base,
    editedConsumer: base,
    environmentFile: env,
    knownHostsFile: env,
    packages: [
      { name: "auggy", path: "core.tgz", sha256: "a".repeat(64) },
      { name: "@auggy/anthropic", path: "provider.tgz", sha256: "b".repeat(64) },
    ],
  });
  const real = createHostedContext(input, join(base, "run"));
  const calls: string[] = [];
  const services = new Map<string, { id: string; name: string; projectId: string }>();
  const volumes = new Map<
    string,
    { id: string; name: string; projectId: string; serviceId: string }
  >();
  let projectName = "",
    keyName = "",
    keyExists = false,
    projectExists = false;
  let currentDeployment: Parameters<typeof bindScenarioRestart>[1] | null = null;
  const restartCommands: string[][] = [];
  const command: HostedContext["command"] = async (label, args, options) => {
    if (label === "ssh-keygen") {
      writeFileSync(join(real.root, "auth/identity.pub"), `${publicKey}\n`, { mode: 0o600 });
      return { exitCode: 0 } as Awaited<ReturnType<HostedContext["command"]>>;
    }
    if (label === "deployment-restart") {
      restartCommands.push([...args]);
      if (!currentDeployment) throw Error("No restart source");
      currentDeployment = {
        ...currentDeployment,
        instances: [
          { id: id(41), status: "STOPPED" },
          { id: id(42), status: "RUNNING" },
        ],
      };
      return { exitCode: 0, stdout: JSON.stringify({ id: currentDeployment.id }) } as Awaited<
        ReturnType<HostedContext["command"]>
      >;
    }
    const vars = JSON.parse(Buffer.from(options!.input!).toString());
    const query = args[2]!,
      op = /\b(?:query|mutation) (\w+)/.exec(query)![1]!;
    calls.push(op);
    let data: unknown;
    const project = () => ({
      id: id(2),
      name: projectName,
      workspaceId: id(1),
      isPublic: false,
      prDeploys: false,
      deletedAt: null,
      environments: page([{ id: id(3), name: "rehearsal", projectId: id(2) }]),
      services: page([...services.values()]),
      volumes: page(
        [...volumes.values()].map((v) => ({
          id: v.id,
          name: v.name,
          projectId: v.projectId,
          volumeInstances: page([
            {
              id: id(90),
              volumeId: v.id,
              environmentId: id(3),
              serviceId: fail === "foreign-volume" ? id(999) : v.serviceId,
              mountPath: "/app/data",
              region: "us-west2",
              sizeMB: 50000,
              currentSizeMB: 0,
              state: "READY",
              deletedAt: null,
              isPendingDeletion: false,
            },
          ]),
        })),
      ),
    });
    const key = () => ({
      id: id(4),
      name: keyName,
      fingerprint: hostedSshPublicIdentity(publicKey).fingerprint,
      workspaceId: id(1),
      userId: null,
      createdAt: new Date().toISOString(),
    });
    switch (op) {
      case "HostedCapacity":
        data = {
          workspace: {
            id: id(1),
            plan: "PRO",
            projectCount: 1,
            preferredRegion: null,
            subscriptionPlanLimit: {
              projects: 100,
              project: { services: 4 },
              volumes: { defaultSizeMB: 50000, maxSizeMB: 50000, maxPerProject: 4 },
              containers: {
                cpu: 4,
                memoryBytes: 4000000000,
                minReplicaCpu: 1,
                minReplicaMemoryBytes: 1000,
              },
              rateLimits: {
                projectCreate: { max: 10, windowSeconds: 30 },
                volumeCreate: { max: 10, windowSeconds: 30 },
              },
            },
            customer: {
              state: "ACTIVE",
              isTrialing: false,
              isUsageSubscriber: true,
              planLimitOverride: null,
            },
          },
        };
        break;
      case "HostedProjectCreate":
        projectName = vars.input.name;
        projectExists = true;
        data = { projectCreate: { id: id(2), name: projectName, workspaceId: id(1) } };
        break;
      case "HostedProject":
        data = { project: project() };
        break;
      case "HostedServiceCreate":
        if (fail === "unknown-service") throw Error("Service response lost");
        {
          const s = { id: id(10 + services.size), name: vars.input.name, projectId: id(2) };
          services.set(s.id, s);
          data = { serviceCreate: s };
        }
        break;
      case "HostedServiceCaps":
        data = { serviceInstanceLimitsUpdate: true };
        break;
      case "HostedServicePolicy":
        data = { serviceInstanceUpdate: true };
        break;
      case "HostedService":
        data = {
          environment: {
            id: id(3),
            projectId: id(2),
            config: {
              services: Object.fromEntries(
                [...services.keys()].map((k) => [
                  k,
                  { deploy: { multiRegionConfig: { "us-west2": { numReplicas: 1 } } } },
                ]),
              ),
            },
          },
          serviceInstance: {
            id: id(50),
            serviceId: vars.serviceId,
            environmentId: id(3),
            numReplicas: 1,
            region: null,
            restartPolicyType: "NEVER",
            restartPolicyMaxRetries: 10,
            sleepApplication: false,
            latestDeployment: currentDeployment
              ? { id: currentDeployment.id, status: currentDeployment.status }
              : null,
          },
          serviceInstanceLimits: { containers: { cpu: 4, memoryBytes: 4000000000 } },
          serviceInstanceLimitOverride: null,
        };
        break;
      case "HostedDeployment":
        data = { deployment: currentDeployment };
        break;
      case "HostedVolumeCreate":
        {
          const v = {
            id: id(20 + volumes.size),
            name: "volume",
            projectId: id(2),
            serviceId: vars.input.serviceId,
          };
          volumes.set(v.id, v);
          data = { volumeCreate: v };
        }
        break;
      case "HostedKeys":
        data = { sshPublicKeys: page(keyExists ? [key()] : []) };
        break;
      case "HostedKeyCreate":
        keyName = vars.input.name;
        keyExists = true;
        data = { sshPublicKeyCreate: key() };
        break;
      case "HostedUsage":
        if (!projectExists) throw Error("Project not found");
        data = { usage: [] };
        break;
      case "HostedVolumeDelete":
        volumes.delete(vars.id);
        data = { volumeDelete: true };
        break;
      case "HostedServiceDelete":
        services.delete(vars.id);
        data = { serviceDelete: true };
        break;
      case "HostedProjectDelete":
        projectExists = false;
        data = { projectDelete: true };
        break;
      case "HostedActiveProjects":
        data = {
          projects: page(
            projectExists
              ? [{ id: id(2), name: projectName, workspaceId: id(1), deletedAt: null }]
              : [],
          ),
        };
        break;
      case "HostedKeyDelete":
        keyExists = false;
        data = { sshPublicKeyDelete: true };
        break;
      default:
        throw Error(`Unexpected query ${op}`);
    }
    return { exitCode: 0, stdout: JSON.stringify({ data }) } as Awaited<
      ReturnType<HostedContext["command"]>
    >;
  };
  const ctx = { ...real, command, nativeIdentity() {} };
  return {
    provider: createScenarioRailway(ctx, "/mock/railway"),
    calls,
    root: real.root,
    restartCommands,
    running(): ScenarioDeployment {
      currentDeployment = {
        id: id(40),
        projectId: id(2),
        environmentId: id(3),
        serviceId: id(10),
        status: "SUCCESS",
        deploymentStopped: false,
        meta: { imageDigest: `sha256:${"a".repeat(64)}` },
        instances: [{ id: id(41), status: "RUNNING" }],
      };
      return {
        id: id(40),
        projectId: id(2),
        environmentId: id(3),
        serviceId: id(10),
        imageDigest: currentDeployment.meta!.imageDigest!,
        instanceId: id(41),
        startedAt: Date.now(),
      };
    },
  };
}

test.each([false, true])(
  "owned allocation and cleanup use only %s recovery resources",
  async (recovery) => {
    const { provider, calls } = fixture();
    await provider.allocate(recovery);
    await provider.cleanup();
    expect(calls.filter((c) => c === "HostedServiceCreate")).toHaveLength(recovery ? 2 : 1);
    expect(calls.filter((c) => c === "HostedVolumeDelete")).toHaveLength(recovery ? 2 : 1);
    expect(calls).toContain("HostedProjectDelete");
    expect(calls).toContain("HostedKeyDelete");
    expect(calls.lastIndexOf("HostedUsage")).toBeLessThan(calls.indexOf("HostedProjectDelete"));
  },
);

test("unknown creation is never retried or silently reported as a successful cleanup", async () => {
  const { provider, calls, root } = fixture("unknown-service");
  await expect(provider.allocate(false)).rejects.toThrow("response lost");
  await expect(provider.cleanup()).rejects.toThrow("unknown mutations");
  expect(calls.filter((c) => c === "HostedServiceCreate")).toHaveLength(1);
  const evidence = JSON.parse(readFileSync(join(root, "evidence/cleanup.json"), "utf8"));
  expect(evidence.unknownMutations).toHaveLength(1);
});

test("foreign attachment blocks destructive cleanup and does not bypass through project deletion", async () => {
  const { provider, calls } = fixture("foreign-volume");
  await expect(provider.allocate(false)).rejects.toThrow("Wrong volume attachment");
  await expect(provider.cleanup()).rejects.toThrow("foreign attachment");
  expect(calls).not.toContain("HostedVolumeDelete");
  expect(calls).not.toContain("HostedProjectDelete");
});

test("restart uses exact service/environment and verifies a new instance of the same image", async () => {
  const f = fixture();
  await f.provider.allocate(false);
  const previous = f.running();
  const result = await f.provider.restart(f.provider.service(), previous);
  expect(result.instanceId).toBe(id(42));
  expect(result.imageDigest).toBe(previous.imageDigest);
  expect(f.restartCommands).toEqual([
    [
      "/mock/railway",
      "restart",
      "--project",
      id(2),
      "--environment",
      id(3),
      "--service",
      id(10),
      "--yes",
      "--json",
    ],
  ]);
});

test("restart readback cannot accept a rebuild, foreign target or the unchanged instance", () => {
  const previous: ScenarioDeployment = {
    id: id(40),
    projectId: id(2),
    environmentId: id(3),
    serviceId: id(10),
    instanceId: id(41),
    imageDigest: `sha256:${"a".repeat(64)}`,
    startedAt: 1,
  };
  const next: Parameters<typeof bindScenarioRestart>[1] = {
    id: id(40),
    projectId: id(2),
    environmentId: id(3),
    serviceId: id(10),
    status: "SUCCESS",
    deploymentStopped: false,
    meta: { imageDigest: previous.imageDigest },
    instances: [
      { id: id(41), status: "STOPPED" },
      { id: id(42), status: "RUNNING" },
    ],
  };
  expect(bindScenarioRestart(previous, next)?.instanceId).toBe(id(42));
  expect(
    bindScenarioRestart(previous, { ...next, instances: [{ id: id(41), status: "RUNNING" }] }),
  ).toBeNull();
  expect(() =>
    bindScenarioRestart(previous, { ...next, meta: { imageDigest: `sha256:${"b".repeat(64)}` } }),
  ).toThrow("image");
  expect(() => bindScenarioRestart(previous, { ...next, serviceId: id(99) })).toThrow("target");
  expect(() => bindScenarioRestart(previous, { ...next, id: id(99) })).toThrow("target");
  expect(() => bindScenarioRestart(previous, { ...next, meta: null })).toThrow("image");
  expect(
    bindScenarioRestart(previous, {
      ...next,
      instances: [
        { id: id(41), status: "RUNNING" },
        { id: id(42), status: "RUNNING" },
      ],
    }),
  ).toBeNull();
});
