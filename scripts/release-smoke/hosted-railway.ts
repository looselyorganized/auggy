/** Small provider adapter for owned scenario resources; uses the existing tested API contracts. */
import { chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { hostedRailwayProtocol, type HostedRailwayOperation } from "./integration-hosted-railway";
import { projectHostedServicePlacement } from "./integration-hosted";
import { hostedSshPublicIdentity } from "./integration-hosted-transport";
import { hostedCheck as check, type HostedContext } from "./hosted-context";

type Response<K extends HostedRailwayOperation> = z.output<
  ReturnType<typeof hostedRailwayProtocol<K>>["schema"]
>;
export function hostedResourceName(runId: string) {
  z.string().uuid().parse(runId);
  const name = `auggy-m5-${runId.replaceAll("-", "").slice(0, 20)}`;
  check(name.length <= 32, "Railway project names must fit the 32-character provider limit");
  return name;
}
export interface ScenarioService {
  id: string;
  volumeId: string;
  environmentId: string;
  projectId: string;
  recovery: boolean;
}
export interface ScenarioDeployment {
  id: string;
  projectId: string;
  environmentId: string;
  serviceId: string;
  imageDigest: string;
  instanceId: string;
  startedAt: number;
}
const RATES = {
  MEMORY_USAGE_GB: 10 / 43200,
  CPU_USAGE: 20 / 43200,
  NETWORK_TX_GB: 0.05,
  DISK_USAGE_GB: 0.15 / 43200,
  BACKUP_USAGE_GB: 0.15 / 43200,
};
const LOGS =
  "query HostedStoppedLogs($deploymentId:String!,$start:DateTime!,$end:DateTime!) { deploymentLogs(deploymentId:$deploymentId,startDate:$start,endDate:$end,limit:2000) { message timestamp tags { deploymentId deploymentInstanceId environmentId projectId serviceId } } }";
const DOMAINS =
  "query HostedGuardDomains($projectId:String!,$environmentId:String!,$serviceId:String!) { domains(projectId:$projectId,environmentId:$environmentId,serviceId:$serviceId) { serviceDomains { id domain serviceId environmentId projectId targetPort deletedAt } customDomains { id domain serviceId environmentId projectId targetPort deletedAt } } }";

export function createScenarioRailway(
  ctx: HostedContext,
  native: string | null = Bun.which("railway"),
) {
  check(native, "Install the Railway CLI before hosted execution");
  let sequence = 0;
  let project: { id: string; name: string; environmentId: string } | undefined;
  let key: { id: string; fingerprint: string } | undefined;
  const services: ScenarioService[] = [];
  const volumeIds = new Set<string>();
  const volumeOwners = new Map<string, string>();
  const serviceIds = new Set<string>();
  const unknown = new Set<string>();
  const name = hostedResourceName(ctx.runId);
  const api = async <K extends HostedRailwayOperation>(
    operation: K,
    variables: object,
    cleanup = false,
  ): Promise<Response<K>> => {
    const protocol = hostedRailwayProtocol(operation);
    const label = `api-${++sequence}-${operation}`;
    if (protocol.kind === "mutation") {
      unknown.add(label);
      ctx.save(`${label}-intent.json`, { operation, variables });
    }
    const r = await ctx.command(
      label,
      [native, "api", protocol.query, "--variables", "@-", "--compact"],
      { input: Buffer.from(JSON.stringify(variables)), cleanup },
    );
    const envelope = z
      .object({ data: z.unknown(), errors: z.array(z.unknown()).optional() })
      .parse(JSON.parse(r.stdout));
    check(
      !envelope.errors?.length,
      `${operation}: provider reported an error; inspect command evidence`,
    );
    if (operation === "service-read") {
      const target = z
        .object({ serviceId: z.string(), environmentId: z.string() })
        .parse(variables);
      const environment = z.object({ environment: z.unknown() }).parse(envelope.data).environment;
      const placement = projectHostedServicePlacement(environment, target.serviceId);
      check(
        placement.environmentId === target.environmentId &&
          placement.projectId === project?.id &&
          Object.entries(placement.multiRegionConfig).every(
            ([region, config]) => config.numReplicas === (region === ctx.input.region ? 1 : 0),
          ) &&
          placement.multiRegionConfig[ctx.input.region]?.numReplicas === 1,
        "Explicit service placement differs",
      );
    }
    const parsed = protocol.schema.parse(envelope.data) as Response<K>;
    ctx.save(`${label}-response.json`, parsed);
    unknown.delete(label);
    return parsed;
  };
  const projectRead = async (cleanup = false) => {
    check(project, "No owned project");
    const p = (await api("project-read", { id: project.id }, cleanup)).project;
    check(
      p.id === project.id &&
        p.workspaceId === ctx.input.workspaceId &&
        p.name === name &&
        p.isPublic === false,
      "Project identity/ownership changed",
    );
    check(
      !p.environments.pageInfo.hasNextPage &&
        !p.services.pageInfo.hasNextPage &&
        !p.volumes.pageInfo.hasNextPage,
      "Project inventory is incomplete",
    );
    check(
      p.services.edges.every((e) => serviceIds.has(e.node.id)),
      "Project contains an unowned service; retain for inspection",
    );
    check(
      p.volumes.edges.every((e) => volumeIds.has(e.node.id)),
      "Project contains an unowned volume; retain for inspection",
    );
    return p;
  };
  const poll = async <T>(
    label: string,
    read: () => Promise<T>,
    ready: (value: T) => boolean,
    maximum = 180000,
    cleanup = false,
  ) => {
    const end = performance.now() + Math.min(maximum, ctx.remaining(cleanup) - 5000);
    while (performance.now() < end) {
      const value = await read();
      if (ready(value)) return value;
      const pause = Math.min(5000, end - performance.now());
      if (pause > 0) await Bun.sleep(pause);
    }
    throw Error(`${label}: readiness deadline exceeded`);
  };
  const assertService = (s: ScenarioService) => {
    check(
      project &&
        s.projectId === project.id &&
        s.environmentId === project.environmentId &&
        serviceIds.has(s.id) &&
        volumeIds.has(s.volumeId),
      "Not an owned scenario service",
    );
  };
  const deployment = async (s: ScenarioService, cleanup = false) => {
    assertService(s);
    const read = await api(
      "service-read",
      { serviceId: s.id, environmentId: s.environmentId },
      cleanup,
    );
    const id = read.serviceInstance.latestDeployment?.id;
    if (!id) return null;
    const d = (await api("deployment-read", { id }, cleanup)).deployment;
    check(
      d.projectId === s.projectId && d.environmentId === s.environmentId && d.serviceId === s.id,
      "Deployment belongs to another target",
    );
    return d;
  };
  const usage = async (cleanup = false) => {
    if (!project) return;
    const data = await api(
      "usage",
      {
        projectId: project.id,
        workspaceId: ctx.input.workspaceId,
        start: new Date(ctx.startedAt).toISOString(),
        end: new Date().toISOString(),
      },
      cleanup,
    );
    let estimatedUSD = 0;
    for (const row of data.usage) {
      check(
        row.tags.projectId === project.id &&
          (row.tags.serviceId === null || serviceIds.has(row.tags.serviceId)),
        "Usage has foreign resources",
      );
      estimatedUSD += row.value * RATES[row.measurement];
    }
    ctx.save(`usage-${++sequence}.json`, {
      estimatedUSD,
      targetUSD: 5,
      providerHardCap: false,
      reportingMayLag: true,
    });
    check(cleanup || estimatedUSD < 5, "Monitored $5 spend target exceeded; cleanup required");
  };
  const keys = async (cleanup = false) => {
    const found: Response<"workspace-keys">["sshPublicKeys"]["edges"] = [];
    let after: string | null = null;
    for (let page = 0; page < 20; page++) {
      const r: Response<"workspace-keys"> = await api(
        "workspace-keys",
        { workspaceId: ctx.input.workspaceId, after },
        cleanup,
      );
      found.push(...r.sshPublicKeys.edges);
      if (!r.sshPublicKeys.pageInfo.hasNextPage) return found.map((e) => e.node);
      check(
        r.sshPublicKeys.pageInfo.endCursor && r.sshPublicKeys.pageInfo.endCursor !== after,
        "Key pagination stalled",
      );
      after = r.sshPublicKeys.pageInfo.endCursor;
    }
    throw Error("Key inventory exceeded bounded pagination");
  };
  const readLogs = async (d: Pick<ScenarioDeployment, "id" | "startedAt">, cleanup = false) => {
    const r = await ctx.command(
      "deployment-logs",
      [native, "api", LOGS, "--variables", "@-", "--compact"],
      {
        cleanup,
        input: Buffer.from(
          JSON.stringify({
            deploymentId: d.id,
            start: new Date(d.startedAt - 1000).toISOString(),
            end: new Date().toISOString(),
          }),
        ),
      },
    );
    const raw = z
      .object({
        data: z.object({
          deploymentLogs: z
            .array(
              z.object({
                message: z.string(),
                timestamp: z.string(),
                tags: z.record(z.string(), z.unknown()),
              }),
            )
            .max(1999),
        }),
      })
      .parse(JSON.parse(r.stdout));
    return raw.data.deploymentLogs;
  };
  return {
    api,
    poll,
    usage,
    deployment,
    async allocate(recovery: boolean) {
      ctx.nativeIdentity();
      const capacity = (await api("workspace-capacity", { workspaceId: ctx.input.workspaceId }))
        .workspace;
      const count = recovery ? 2 : 1,
        limit = capacity.subscriptionPlanLimit;
      check(
        capacity.id === ctx.input.workspaceId &&
          capacity.projectCount < limit.projects &&
          limit.project.services >= count &&
          limit.volumes.maxPerProject >= count &&
          limit.volumes.defaultSizeMB === 50000,
        "Insufficient approved capacity or changed volume default",
      );
      check(
        limit.containers.cpu >= 4 && limit.containers.memoryBytes >= 4000000000,
        "Requested resource caps unavailable",
      );
      const created = (
        await api("project-create", {
          input: {
            workspaceId: ctx.input.workspaceId,
            name,
            defaultEnvironmentName: "rehearsal",
            isPublic: false,
            prDeploys: false,
          },
        })
      ).projectCreate;
      project = { id: created.id, name: created.name, environmentId: "" };
      check(
        created.name === name && created.workspaceId === ctx.input.workspaceId,
        "Created project identity mismatch",
      );
      const p = await projectRead();
      check(
        p.environments.edges.length === 1 && p.environments.edges[0]!.node.name === "rehearsal",
        "Unexpected environment inventory",
      );
      project.environmentId = p.environments.edges[0]!.node.id;
      for (let index = 0; index < count; index++) {
        await projectRead();
        const made = (
          await api("service-create", {
            input: {
              projectId: project.id,
              environmentId: project.environmentId,
              name: `scenario-${index}`,
            },
          })
        ).serviceCreate;
        serviceIds.add(made.id);
        check(made.projectId === project.id, "Created service parent mismatch");
        const target = { serviceId: made.id, environmentId: project.environmentId };
        check(
          (await api("service-caps", { input: { ...target, vCPUs: 4, memoryGB: 4 } }))
            .serviceInstanceLimitsUpdate,
          "Service caps refused",
        );
        check(
          (
            await api("service-policy", {
              ...target,
              input: {
                numReplicas: 1,
                multiRegionConfig: { [ctx.input.region]: { numReplicas: 1 } },
                restartPolicyType: "NEVER",
                restartPolicyMaxRetries: 0,
                sleepApplication: false,
              },
            })
          ).serviceInstanceUpdate,
          "Service policy refused",
        );
        const observed = await api("service-read", target);
        const i = observed.serviceInstance,
          c = observed.serviceInstanceLimits.containers;
        check(
          i.serviceId === made.id &&
            i.environmentId === project.environmentId &&
            i.numReplicas === 1 &&
            i.restartPolicyType === "NEVER" &&
            i.sleepApplication === false &&
            c.cpu === 4 &&
            c.memoryBytes === 4000000000,
          "Effective service policy differs",
        );
        const volume = (
          await api("volume-create", {
            input: {
              projectId: project.id,
              ...target,
              region: ctx.input.region,
              mountPath: "/app/data",
            },
          })
        ).volumeCreate;
        volumeIds.add(volume.id);
        volumeOwners.set(volume.id, made.id);
        check(volume.projectId === project.id, "Created volume parent mismatch");
        const service = {
          id: made.id,
          projectId: project.id,
          environmentId: project.environmentId,
          volumeId: volume.id,
          recovery: index === 1,
        };
        services.push(service);
        await poll(
          "volume attachment",
          () => projectRead(),
          (value) => {
            const v = value.volumes.edges.find((e) => e.node.id === volume.id)?.node;
            check(
              v && !v.volumeInstances.pageInfo.hasNextPage,
              "Owned volume missing or truncated",
            );
            const active = v.volumeInstances.edges
              .map((e) => e.node)
              .filter((n) => n.deletedAt === null && !n.isPendingDeletion);
            check(active.length <= 1, "Ambiguous volume attachment");
            if (!active.length || active[0]!.serviceId === null) return false;
            const instance = active[0]!;
            check(
              instance.serviceId === service.id &&
                instance.environmentId === service.environmentId &&
                instance.mountPath === "/app/data" &&
                instance.region === ctx.input.region &&
                instance.sizeMB === 50000,
              "Wrong volume attachment",
            );
            return instance.state === "READY";
          },
        );
      }
      await ctx.command("ssh-keygen", [
        "/usr/bin/ssh-keygen",
        "-q",
        "-t",
        "ed25519",
        "-N",
        "",
        "-f",
        join(ctx.root, "auth/identity"),
      ]);
      chmodSync(join(ctx.root, "auth/identity.pub"), 0o600);
      const publicKey = readFileSync(join(ctx.root, "auth/identity.pub"), "utf8"),
        identity = hostedSshPublicIdentity(publicKey);
      check(
        (await keys()).every((k) => k.fingerprint !== identity.fingerprint),
        "SSH identity already registered",
      );
      const createdKey = (
        await api("key-create", {
          input: {
            workspaceId: ctx.input.workspaceId,
            name,
            publicKey: publicKey.trim().split(" ").slice(0, 2).join(" "),
          },
        })
      ).sshPublicKeyCreate;
      key = { id: createdKey.id, fingerprint: createdKey.fingerprint };
      check(
        createdKey.workspaceId === ctx.input.workspaceId &&
          createdKey.name === name &&
          key.fingerprint === identity.fingerprint,
        "SSH key binding mismatch",
      );
      await usage();
    },
    service(recovery = false) {
      const s = services.find((s) => s.recovery === recovery);
      check(s, "Service was not allocated");
      return s;
    },
    async running(s: ScenarioService): Promise<ScenarioDeployment> {
      const d = await deployment(s);
      check(
        d &&
          d.status === "SUCCESS" &&
          !d.deploymentStopped &&
          d.instances.length === 1 &&
          d.instances[0]!.status === "RUNNING" &&
          /^sha256:[a-f0-9]{64}$/.test(d.meta?.imageDigest ?? ""),
        "Deployment is not a ready singleton",
      );
      return {
        id: d.id,
        projectId: s.projectId,
        environmentId: s.environmentId,
        serviceId: s.id,
        imageDigest: d.meta!.imageDigest!,
        instanceId: d.instances[0]!.id,
        startedAt: Date.now(),
      };
    },
    async stop(s: ScenarioService) {
      const d = await deployment(s);
      if (!d || d.deploymentStopped) return;
      check((await api("deployment-stop", { id: d.id })).deploymentStop, "Deployment stop refused");
      await poll(
        "deployment stop",
        () => api("deployment-read", { id: d.id }),
        (r) => {
          const x = r.deployment;
          check(x.projectId === s.projectId && x.serviceId === s.id, "Stopped target changed");
          return (
            x.deploymentStopped &&
            x.instances.every((i) => ["STOPPED", "EXITED", "REMOVED"].includes(i.status))
          );
        },
        60000,
      );
    },
    logs: readLogs,
    async inspectDomains(s: ScenarioService) {
      assertService(s);
      const r = await ctx.command(
        "service-domains",
        [native, "api", DOMAINS, "--variables", "@-", "--compact"],
        {
          input: Buffer.from(
            JSON.stringify({
              projectId: s.projectId,
              environmentId: s.environmentId,
              serviceId: s.id,
            }),
          ),
        },
      );
      const domain = z.object({
        id: z.string().uuid(),
        domain: z.string(),
        serviceId: z.string().uuid(),
        environmentId: z.string().uuid(),
        projectId: z.string().uuid().nullable(),
        targetPort: z.number().int().nullable(),
        deletedAt: z.string().nullable(),
      });
      const d = z
        .object({
          data: z.object({
            domains: z.object({
              serviceDomains: z.array(domain).max(100),
              customDomains: z.array(domain).max(100),
            }),
          }),
        })
        .parse(JSON.parse(r.stdout)).data.domains;
      for (const row of [...d.serviceDomains, ...d.customDomains])
        check(
          row.serviceId === s.id &&
            row.environmentId === s.environmentId &&
            (row.projectId === null || row.projectId === s.projectId),
          "Domain belongs to another target",
        );
      return {
        serviceDomains: d.serviceDomains.filter((d) => d.deletedAt === null),
        customDomains: d.customDomains.filter((d) => d.deletedAt === null),
      };
    },
    async cleanup() {
      const failures: string[] = [];
      const warnings: string[] = [];
      const attempt = async (label: string, work: () => Promise<void>) => {
        try {
          await work();
        } catch (error) {
          failures.push(`${label}: ${error instanceof Error ? error.message : String(error)}`);
        }
      };
      if (project) {
        try {
          await usage(true);
        } catch (error) {
          warnings.push(`usage: ${error instanceof Error ? error.message : String(error)}`);
        }
        for (const s of services)
          await attempt(`stop-${s.id}`, async () => {
            const d = await deployment(s, true);
            if (d)
              try {
                await readLogs({ id: d.id, startedAt: ctx.startedAt }, true);
              } catch (error) {
                warnings.push(
                  `logs-${d.id}: ${error instanceof Error ? error.message : String(error)}`,
                );
              }
            if (d && !d.deploymentStopped) {
              check(
                (await api("deployment-stop", { id: d.id }, true)).deploymentStop,
                "Stop refused",
              );
              await poll(
                "cleanup stop",
                () => deployment(s, true),
                (x) => !x || x.deploymentStopped,
                60000,
                true,
              );
            }
          });
        await attempt("resources", async () => {
          const inventory = await projectRead(true);
          for (const edge of inventory.volumes.edges) {
            const v = edge.node;
            check(
              !v.volumeInstances.pageInfo.hasNextPage &&
                v.projectId === project!.id &&
                v.volumeInstances.edges.every(
                  (e) =>
                    e.node.volumeId === v.id &&
                    e.node.environmentId === project!.environmentId &&
                    (e.node.serviceId === null || e.node.serviceId === volumeOwners.get(v.id)),
                ),
              "Volume inventory has a foreign attachment or is incomplete",
            );
            check(
              (await api("volume-delete", { id: v.id }, true)).volumeDelete,
              "Volume delete refused",
            );
          }
          for (const edge of inventory.services.edges)
            check(
              (
                await api(
                  "service-delete",
                  { id: edge.node.id, environmentId: project!.environmentId },
                  true,
                )
              ).serviceDelete,
              "Service delete refused",
            );
          check(
            (await api("project-delete", { id: project!.id }, true)).projectDelete,
            "Project delete refused",
          );
          let after: string | null = null,
            absent = false;
          for (let page = 0; page < 20; page++) {
            const r: Response<"workspace-active-projects"> = await api(
              "workspace-active-projects",
              { workspaceId: ctx.input.workspaceId, after },
              true,
            );
            check(
              !r.projects.edges.some((e) => e.node.id === project!.id),
              "Owned project still active",
            );
            if (!r.projects.pageInfo.hasNextPage) {
              absent = true;
              break;
            }
            check(
              r.projects.pageInfo.endCursor && r.projects.pageInfo.endCursor !== after,
              "Project pagination stalled",
            );
            after = r.projects.pageInfo.endCursor;
          }
          check(absent, "Active-project inventory incomplete");
        });
      }
      if (key)
        await attempt("ssh-key", async () => {
          const owned = (await keys(true)).find((k) => k.id === key!.id);
          if (owned) {
            check(
              owned.workspaceId === ctx.input.workspaceId &&
                owned.name === name &&
                owned.fingerprint === key!.fingerprint,
              "Key ownership changed",
            );
            check(
              (await api("key-delete", { id: key!.id }, true)).sshPublicKeyDelete,
              "Key delete refused",
            );
          }
          check(!(await keys(true)).some((k) => k.id === key!.id), "SSH key still registered");
        });
      ctx.save("cleanup.json", {
        failures,
        warnings,
        unknownMutations: [...unknown],
        projectId: project?.id,
        keyId: key?.id,
      });
      check(
        failures.length === 0 && unknown.size === 0,
        `Cleanup incomplete: ${failures.join("; ")}; unknown mutations: ${[...unknown].join(",")}`,
      );
    },
  };
}
export type ScenarioRailway = ReturnType<typeof createScenarioRailway>;
