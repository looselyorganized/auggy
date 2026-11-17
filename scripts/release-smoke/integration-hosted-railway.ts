/** Finite Railway API vocabulary. No upload, retry, credential handling, or provisioning loop. */
import { createHash } from "node:crypto";
import { closeSync, fstatSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { z } from "zod";
import { pinDirectory } from "../../src/lib/anchored-files";
import { APPLICATION_BOUNDS, startApplicationChild } from "./application-child";
import { readBoundedRegularFile } from "./bounded-file";
import {
  assertHostedIntegrationApproval,
  assertHostedProjectAvailable,
  assertHostedVolumeOwnership,
  prepareHostedIntegration,
  projectHostedServicePlacement,
  type HostedDeploymentBinding,
  type HostedProjectBinding,
  type HostedProjectInventory,
  type HostedServiceBinding,
  type HostedServiceRole,
  type HostedSshKeyBinding,
  type HostedVolumeAlias,
  type HostedVolumeOwnership,
} from "./integration-hosted";
import { hostedSshPublicIdentity } from "./integration-hosted-transport";

const CLI = "/opt/homebrew/bin/railway";
const API_MS = 15_000;
const BYTES = 2 * 1024 * 1024;
type Prepared = ReturnType<typeof prepareHostedIntegration>;
type Gate = Parameters<typeof assertHostedIntegrationApproval>[0];
type Child = Awaited<ReturnType<ReturnType<typeof startApplicationChild>["finish"]>>;
type RunnerInput = Parameters<typeof startApplicationChild>[0];
type Runner = (input: RunnerInput) => Promise<Child>;
const uuid = z.string().regex(/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const label = z.string().max(255);
const cursor = z.string().max(512).nullable();
const stamp = z.string().max(64).nullable();
const status = z.string().regex(/^[A-Z_]{1,32}$/);
const connection = <T extends z.ZodTypeAny>(node: T) =>
  z.object({
    edges: z.array(z.object({ node })).max(100),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      hasPreviousPage: z.boolean(),
      endCursor: cursor,
    }),
  });
const projectIdentity = z.object({ id: uuid, name: label, workspaceId: uuid });
const serviceIdentity = z.object({ id: uuid, name: label, projectId: uuid });
const volumeIdentity = z.object({ id: uuid, name: label, projectId: uuid });
const keyIdentity = z.object({
  id: uuid,
  name: label,
  fingerprint: z.string().regex(/^SHA256:[A-Za-z0-9+/]{43}$/),
  workspaceId: uuid.nullable(),
  userId: uuid.nullable(),
  createdAt: z.string().max(64),
});
const limitsSchema = z.object({
  containers: z.object({
    cpu: z.number().finite().nonnegative(),
    memoryBytes: z.number().int().safe().nonnegative(),
  }),
});
const volumeInstance = z.object({
  id: uuid,
  volumeId: uuid,
  environmentId: uuid,
  serviceId: uuid.nullable(),
  mountPath: z.string().max(255),
  region: label.nullable(),
  sizeMB: z.number().int().positive(),
  currentSizeMB: z.number().finite().nonnegative(),
  state: status.nullable(),
  deletedAt: stamp,
  isPendingDeletion: z.boolean(),
});
const projectSchema = projectIdentity.extend({
  isPublic: z.boolean(),
  prDeploys: z.boolean(),
  deletedAt: stamp,
  environments: connection(z.object({ id: uuid, name: label, projectId: uuid })),
  services: connection(serviceIdentity),
  volumes: connection(volumeIdentity.extend({ volumeInstances: connection(volumeInstance) })),
});
const deploymentSchema = z.object({
  id: uuid,
  projectId: uuid,
  environmentId: uuid,
  serviceId: uuid.nullable(),
  status,
  deploymentStopped: z.boolean(),
  meta: z
    .object({
      imageDigest: z
        .string()
        .regex(/^sha256:[a-f0-9]{64}$/)
        .optional(),
    })
    .nullable(),
  instances: z.array(z.object({ id: uuid, status })).max(100),
});
const PAGE = "pageInfo { hasNextPage hasPreviousPage endCursor }";
const PROJECT = `id name workspaceId isPublic prDeploys deletedAt
  environments(first:100) { edges { node { id name projectId } } ${PAGE} }
  services(first:100) { edges { node { id name projectId } } ${PAGE} }
  volumes(first:100) { edges { node { id name projectId
    volumeInstances(first:100) { edges { node { id volumeId environmentId serviceId mountPath region sizeMB currentSizeMB state deletedAt isPendingDeletion } } ${PAGE} }
  } } ${PAGE} }`;
const KEY = "id name fingerprint workspaceId userId createdAt";
const OPERATIONS = {
  "workspace-capacity": {
    kind: "query",
    query:
      "query HostedCapacity($workspaceId:String!) { workspace(workspaceId:$workspaceId) { id plan projectCount preferredRegion subscriptionPlanLimit customer { state isTrialing isUsageSubscriber planLimitOverride { __typename } } } }",
    schema: z.object({
      workspace: z.object({
        id: uuid,
        plan: status,
        projectCount: z.number().int().nonnegative(),
        preferredRegion: label.nullable(),
        subscriptionPlanLimit: z.object({
          projects: z.number().int().positive(),
          project: z.object({ services: z.number().int().positive() }),
          volumes: z.object({
            defaultSizeMB: z.number().int().positive(),
            maxSizeMB: z.number().int().positive(),
            maxPerProject: z.number().int().positive(),
          }),
          containers: z.object({
            cpu: z.number().positive(),
            memoryBytes: z.number().int().safe().positive(),
            minReplicaCpu: z.number().positive(),
            minReplicaMemoryBytes: z.number().int().safe().positive(),
          }),
          rateLimits: z.object({
            projectCreate: z.object({
              max: z.number().int().positive(),
              windowSeconds: z.number().positive(),
            }),
            volumeCreate: z.object({
              max: z.number().int().positive(),
              windowSeconds: z.number().positive(),
            }),
          }),
        }),
        customer: z.object({
          state: status,
          isTrialing: z.boolean(),
          isUsageSubscriber: z.boolean(),
          planLimitOverride: z.object({ __typename: z.string().max(64) }).nullable(),
        }),
      }),
    }),
  },
  "workspace-projects": {
    kind: "query",
    query: `query HostedProjects($workspaceId:String!,$after:String) { projects(workspaceId:$workspaceId,first:100,after:$after,includeDeleted:true) { edges { node { id name workspaceId } } ${PAGE} } }`,
    schema: z.object({ projects: connection(projectIdentity) }),
  },
  "workspace-active-projects": {
    kind: "query",
    query: `query HostedActiveProjects($workspaceId:String!,$after:String) { projects(workspaceId:$workspaceId,first:100,after:$after,includeDeleted:false) { edges { node { id name workspaceId deletedAt } } ${PAGE} } }`,
    schema: z.object({ projects: connection(projectIdentity.extend({ deletedAt: z.null() })) }),
  },
  "workspace-keys": {
    kind: "query",
    query: `query HostedKeys($workspaceId:String!,$after:String) { sshPublicKeys(workspaceId:$workspaceId,first:100,after:$after) { edges { node { ${KEY} } } ${PAGE} } }`,
    schema: z.object({ sshPublicKeys: connection(keyIdentity) }),
  },
  "project-create": {
    kind: "mutation",
    query:
      "mutation HostedProjectCreate($input:ProjectCreateInput!) { projectCreate(input:$input) { id name workspaceId } }",
    schema: z.object({ projectCreate: projectIdentity }),
  },
  "project-read": {
    kind: "query",
    query: `query HostedProject($id:String!) { project(id:$id) { ${PROJECT} } }`,
    schema: z.object({ project: projectSchema }),
  },
  "service-create": {
    kind: "mutation",
    query:
      "mutation HostedServiceCreate($input:ServiceCreateInput!) { serviceCreate(input:$input) { id name projectId } }",
    schema: z.object({ serviceCreate: serviceIdentity }),
  },
  "service-caps": {
    kind: "mutation",
    query:
      "mutation HostedServiceCaps($input:ServiceInstanceLimitsUpdateInput!) { serviceInstanceLimitsUpdate(input:$input) }",
    schema: z.object({ serviceInstanceLimitsUpdate: z.boolean() }),
  },
  "service-policy": {
    kind: "mutation",
    query:
      "mutation HostedServicePolicy($serviceId:String!,$environmentId:String!,$input:ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId:$serviceId,environmentId:$environmentId,input:$input) }",
    schema: z.object({ serviceInstanceUpdate: z.boolean() }),
  },
  "service-read": {
    kind: "query",
    query:
      "query HostedService($serviceId:String!,$environmentId:String!) { environment(id:$environmentId) { id projectId config(decryptVariables:false) } serviceInstance(serviceId:$serviceId,environmentId:$environmentId) { id serviceId environmentId numReplicas region restartPolicyType restartPolicyMaxRetries sleepApplication latestDeployment { id status } } serviceInstanceLimits(serviceId:$serviceId,environmentId:$environmentId) serviceInstanceLimitOverride(serviceId:$serviceId,environmentId:$environmentId) }",
    schema: z.object({
      serviceInstance: z.object({
        id: uuid,
        serviceId: uuid,
        environmentId: uuid,
        numReplicas: z.number().int().nullable(),
        region: label.nullable(),
        restartPolicyType: status,
        restartPolicyMaxRetries: z.number().int(),
        sleepApplication: z.boolean().nullable(),
        latestDeployment: z.object({ id: uuid, status }).nullable(),
      }),
      serviceInstanceLimits: limitsSchema,
      serviceInstanceLimitOverride: limitsSchema.nullable(),
    }),
  },
  "volume-create": {
    kind: "mutation",
    query:
      "mutation HostedVolumeCreate($input:VolumeCreateInput!) { volumeCreate(input:$input) { id name projectId } }",
    schema: z.object({ volumeCreate: volumeIdentity }),
  },
  "key-create": {
    kind: "mutation",
    query: `mutation HostedKeyCreate($input:SshPublicKeyCreateInput!) { sshPublicKeyCreate(input:$input) { ${KEY} } }`,
    schema: z.object({ sshPublicKeyCreate: keyIdentity }),
  },
  "deployment-read": {
    kind: "query",
    query:
      "query HostedDeployment($id:String!) { deployment(id:$id) { id projectId environmentId serviceId status deploymentStopped meta instances { id status } } }",
    schema: z.object({ deployment: deploymentSchema }),
  },
  usage: {
    kind: "query",
    query:
      "query HostedUsage($projectId:String!,$workspaceId:String!,$start:DateTime!,$end:DateTime!) { usage(projectId:$projectId,workspaceId:$workspaceId,startDate:$start,endDate:$end,includeDeleted:true,groupBy:[PROJECT_ID,SERVICE_ID],measurements:[MEMORY_USAGE_GB,CPU_USAGE,NETWORK_TX_GB,DISK_USAGE_GB,BACKUP_USAGE_GB]) { measurement value tags { projectId serviceId } } }",
    schema: z.object({
      usage: z
        .array(
          z.object({
            measurement: z.enum([
              "MEMORY_USAGE_GB",
              "CPU_USAGE",
              "NETWORK_TX_GB",
              "DISK_USAGE_GB",
              "BACKUP_USAGE_GB",
            ]),
            value: z.number().finite().nonnegative(),
            tags: z.object({ projectId: uuid, serviceId: uuid.nullable() }),
          }),
        )
        .max(1000),
    }),
  },
  "deployment-stop": {
    kind: "mutation",
    query: "mutation HostedStop($id:String!) { deploymentStop(id:$id) }",
    schema: z.object({ deploymentStop: z.boolean() }),
  },
  "deployment-delete": {
    kind: "mutation",
    query: "mutation HostedRemove($id:String!) { deploymentRemove(id:$id) }",
    schema: z.object({ deploymentRemove: z.boolean() }),
  },
  "volume-delete": {
    kind: "mutation",
    query: "mutation HostedVolumeDelete($id:String!) { volumeDelete(volumeId:$id) }",
    schema: z.object({ volumeDelete: z.boolean() }),
  },
  "service-delete": {
    kind: "mutation",
    query:
      "mutation HostedServiceDelete($id:String!,$environmentId:String!) { serviceDelete(id:$id,environmentId:$environmentId) }",
    schema: z.object({ serviceDelete: z.boolean() }),
  },
  "project-delete": {
    kind: "mutation",
    query: "mutation HostedProjectDelete($id:String!) { projectDelete(id:$id) }",
    schema: z.object({ projectDelete: z.boolean() }),
  },
  "key-delete": {
    kind: "mutation",
    query: "mutation HostedKeyDelete($id:String!) { sshPublicKeyDelete(id:$id) }",
    schema: z.object({ sshPublicKeyDelete: z.boolean() }),
  },
} as const;
export type HostedRailwayOperation = keyof typeof OPERATIONS;

/** Shared wire contract. Scenario runners supply their own bounded ownership/lifetime policy. */
export function hostedRailwayProtocol<K extends HostedRailwayOperation>(
  operation: K,
): (typeof OPERATIONS)[K] {
  check(Object.hasOwn(OPERATIONS, operation), "Unknown hosted Railway operation");
  return OPERATIONS[operation];
}
/** Unbound creation replies are checked against the approved parent/name before cap/readback calls. */
export type HostedCreatedService = {
  project: HostedProjectBinding;
  role: HostedServiceRole;
  creation: unknown;
};
type ServiceTarget = HostedServiceBinding | HostedCreatedService;
export type HostedRailwayAction = { actionId: string } & (
  | { operation: "workspace-capacity" }
  | {
      operation: "workspace-projects" | "workspace-active-projects" | "workspace-keys";
      after?: string;
    }
  | { operation: "project-create"; before: HostedProjectInventory }
  | { operation: "project-read"; project: HostedProjectBinding }
  | { operation: "project-read"; before: HostedProjectInventory; creation: unknown }
  | { operation: "service-create"; project: HostedProjectBinding; role: HostedServiceRole }
  | { operation: "service-caps" | "service-policy" | "service-read"; service: ServiceTarget }
  | { operation: "volume-create"; service: HostedServiceBinding; alias: HostedVolumeAlias }
  | { operation: "key-create"; publicKey: string }
  | { operation: "deployment-read"; service: HostedServiceBinding; returnedDeploymentId: string }
  | { operation: "usage"; project: HostedProjectBinding }
  | { operation: "deployment-stop" | "deployment-delete"; deployment: HostedDeploymentBinding }
  | { operation: "volume-delete"; volume: HostedVolumeOwnership }
  | { operation: "service-delete"; service: HostedServiceBinding }
  | { operation: "project-delete"; project: HostedProjectBinding }
  | { operation: "key-delete"; key: HostedSshKeyBinding }
);
export interface HostedRailwayAttempt {
  actionId: string;
  operation: HostedRailwayOperation;
  inputSHA256: string;
}
export type HostedRailwayChildOutcome = Omit<Child, "stdout" | "stderr">;
export interface HostedRailwayResponseDiagnostic {
  stage: "response-size" | "json" | "envelope" | "schema" | "placement";
  issues: { path: string; code: string }[];
  issuesTruncated: boolean;
  structure: { path: string; type: string }[];
  graphqlErrorPaths?: string[];
}
export interface HostedRailwayResult extends HostedRailwayAttempt {
  kind: "query" | "mutation";
  /** A valid Boolean false is a response, never proof that no effects occurred. */
  outcome: "response" | "query-failed" | "unknown" | "not-started";
  reason: "none" | "child-failure" | "invalid-response" | "admission-changed";
  child: HostedRailwayChildOutcome | null;
  response: { data: Record<string, unknown> } | null;
  /** Fixed paths and type labels only; never provider values, keys, messages or Zod input. */
  diagnostic?: HostedRailwayResponseDiagnostic;
}
const SERVICE_DIAGNOSTIC_PATHS = [
  "environment",
  "environment.id",
  "environment.projectId",
  "environment.config",
  "environment.config.services",
  "serviceInstance",
  ...[
    "id",
    "serviceId",
    "environmentId",
    "numReplicas",
    "region",
    "restartPolicyType",
    "restartPolicyMaxRetries",
    "sleepApplication",
    "latestDeployment",
    "latestDeployment.id",
    "latestDeployment.status",
  ].map((path) => `serviceInstance.${path}`),
  ...["serviceInstanceLimits", "serviceInstanceLimitOverride"].flatMap((path) => [
    path,
    `${path}.containers`,
    `${path}.containers.cpu`,
    `${path}.containers.memoryBytes`,
  ]),
];
function responseDiagnostic(
  stage: HostedRailwayResponseDiagnostic["stage"],
  operation: HostedRailwayOperation,
  data: unknown,
  error: unknown,
  placementServiceId?: string,
): HostedRailwayResponseDiagnostic {
  const paths =
    stage === "placement"
      ? [
          "environment",
          "environment.id",
          "environment.projectId",
          "environment.config",
          "environment.config.services",
          "environment.config.services.[selected]",
          "environment.config.services.[selected].deploy",
          "environment.config.services.[selected].deploy.multiRegionConfig",
        ]
      : stage === "envelope"
        ? ["data", "errors"]
        : stage === "schema" && operation === "service-read"
          ? SERVICE_DIAGNOSTIC_PATHS
          : [];
  const issues = error instanceof z.ZodError ? error.issues : [];
  return {
    stage,
    issues:
      stage === "placement"
        ? [{ path: "servicePlacement", code: "projection-refused" }]
        : issues.slice(0, 24).map((issue) => {
            const path = issue.path.join(".");
            return {
              path: path === "" ? "$" : paths.includes(path) ? path : "[unlisted]",
              code: issue.code,
            };
          }),
    issuesTruncated: issues.length > 24,
    structure: paths.map((path) => {
      let value = data;
      for (const key of path.split(".")) {
        value =
          value && typeof value === "object" && !Array.isArray(value)
            ? (value as Record<string, unknown>)[key === "[selected]" ? placementServiceId! : key]
            : undefined;
      }
      return {
        path,
        type:
          value === undefined
            ? "missing"
            : value === null
              ? "null"
              : Array.isArray(value)
                ? "array"
                : typeof value,
      };
    }),
    ...(stage === "envelope" && operation === "service-read"
      ? {
          graphqlErrorPaths:
            z
              .object({ errors: z.array(z.unknown()) })
              .safeParse(data)
              .data?.errors.slice(0, 24)
              .map((error) => {
                const parsed = z.object({ path: z.array(z.string()).max(4) }).safeParse(error);
                const path = parsed.success ? parsed.data.path.join(".") : "";
                return SERVICE_DIAGNOSTIC_PATHS.includes(path) ? path : "[unlisted]";
              }) ?? [],
        }
      : {}),
  };
}
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const hash = (bytes: string | Uint8Array) => createHash("sha256").update(bytes).digest("hex");
function body(value: unknown): Record<string, unknown> {
  const record = z
    .object({
      data: z.record(z.string(), z.unknown()),
      errors: z.array(z.unknown()).max(0).optional(),
    })
    .parse(value);
  return record.data;
}
function projectTarget(prepared: Prepared, project: HostedProjectBinding) {
  uuid.parse(project.projectId);
  uuid.parse(project.environmentId);
  check(
    project.workspaceId === prepared.plan.railway.workspaceId &&
      project.projectName === prepared.plan.railway.newProject.name &&
      project.environmentName === prepared.plan.railway.newProject.environmentName,
    "Hosted API project is not the approved owned allocation",
  );
  return { projectId: project.projectId, environmentId: project.environmentId };
}
function serviceTarget(prepared: Prepared, target: ServiceTarget) {
  const project = "creation" in target ? target.project : target;
  const parent = projectTarget(prepared, project);
  const approved = prepared.plan.railway.services.find((entry) => entry.role === target.role);
  check(approved, "Hosted API service role is not approved");
  const service =
    "creation" in target
      ? serviceIdentity.parse(body(target.creation).serviceCreate)
      : { id: target.serviceId, name: target.serviceName, projectId: target.projectId };
  uuid.parse(service.id);
  check(
    service.projectId === parent.projectId && service.name === approved.name,
    "Hosted API service has wrong parent/name",
  );
  return { ...parent, serviceId: service.id };
}
/** Builds only known operations. The executor binds every action and returned ID in its immutable ledger. */
export function prepareHostedRailwayAction(
  preparedInput: Prepared,
  action: HostedRailwayAction,
  clock?: { startedAt: number; now: number },
) {
  const prepared = prepareHostedIntegration(preparedInput.plan);
  check(
    prepared.sha256 === preparedInput.sha256 &&
      prepared.artifactInputsSHA256 === preparedInput.artifactInputsSHA256,
    "Hosted API plan changed",
  );
  check(/^[a-z][a-z0-9-]{0,79}$/.test(action.actionId), "Invalid hosted API action identity");
  check(Object.hasOwn(OPERATIONS, action.operation), "Unapproved hosted API operation");
  let variables: Record<string, unknown>;
  const plan = prepared.plan;
  switch (action.operation) {
    case "workspace-capacity":
      variables = { workspaceId: plan.railway.workspaceId };
      break;
    case "workspace-projects":
    case "workspace-active-projects":
    case "workspace-keys":
      variables = {
        workspaceId: plan.railway.workspaceId,
        after: cursor.parse(action.after ?? null),
      };
      break;
    case "project-create":
      assertHostedProjectAvailable(prepared, action.before);
      variables = {
        input: {
          workspaceId: plan.railway.workspaceId,
          name: plan.railway.newProject.name,
          defaultEnvironmentName: plan.railway.newProject.environmentName,
          isPublic: false,
          prDeploys: false,
        },
      };
      break;
    case "project-read": {
      if ("project" in action)
        variables = { id: projectTarget(prepared, action.project).projectId };
      else {
        assertHostedProjectAvailable(prepared, action.before);
        const created = projectIdentity.parse(body(action.creation).projectCreate);
        check(
          created.workspaceId === plan.railway.workspaceId &&
            created.name === plan.railway.newProject.name &&
            !action.before.projects.some((existing) => existing.id === created.id),
          "Hosted API returned project is not a new approved allocation",
        );
        variables = { id: created.id };
      }
      break;
    }
    case "service-create": {
      const parent = projectTarget(prepared, action.project);
      const service = plan.railway.services.find((entry) => entry.role === action.role);
      check(service, "Hosted API service role is not approved");
      variables = { input: { ...parent, name: service.name } };
      break;
    }
    case "service-caps": {
      const target = serviceTarget(prepared, action.service);
      variables = {
        input: {
          serviceId: target.serviceId,
          environmentId: target.environmentId,
          vCPUs: plan.limits.maxCpuPerService,
          memoryGB: plan.limits.maxMemoryBytesPerService / 1_000_000_000,
        },
      };
      break;
    }
    case "service-policy": {
      const target = serviceTarget(prepared, action.service);
      variables = {
        serviceId: target.serviceId,
        environmentId: target.environmentId,
        input: {
          numReplicas: 1,
          multiRegionConfig: { [plan.railway.region]: { numReplicas: 1 } },
          restartPolicyType: "NEVER",
          restartPolicyMaxRetries: 0,
          sleepApplication: false,
        },
      };
      break;
    }
    case "service-read": {
      const target = serviceTarget(prepared, action.service);
      variables = { serviceId: target.serviceId, environmentId: target.environmentId };
      break;
    }
    case "volume-create": {
      const target = serviceTarget(prepared, action.service);
      const volume = plan.railway.volumes.find((entry) => entry.alias === action.alias);
      check(
        volume && volume.serviceRole === action.service.role,
        "Hosted API volume role is not approved",
      );
      check(
        volume.sizeMB === 50_000,
        "Ordinary Railway volume allocation requires the approved observed 50000MB default; recheck fresh capacity before creation",
      );
      variables = {
        input: { ...target, region: plan.railway.region, mountPath: volume.mountPath },
      };
      break;
    }
    case "key-create": {
      const key = hostedSshPublicIdentity(action.publicKey);
      check(
        key.publicKeySHA256 === plan.ssh.publicKeySHA256 &&
          key.fingerprint === plan.ssh.fingerprint,
        "Hosted API public key differs from approval",
      );
      variables = {
        input: {
          workspaceId: plan.railway.workspaceId,
          name: plan.ssh.keyName,
          publicKey: action.publicKey.trim().split(" ").slice(0, 2).join(" "),
        },
      };
      break;
    }
    case "deployment-read":
      serviceTarget(prepared, action.service);
      uuid.parse(action.returnedDeploymentId);
      variables = { id: action.returnedDeploymentId };
      break;
    case "usage": {
      const target = projectTarget(prepared, action.project);
      check(
        clock &&
          Number.isFinite(clock.startedAt) &&
          Number.isFinite(clock.now) &&
          clock.startedAt <= clock.now &&
          clock.now - clock.startedAt <=
            (plan.limits.maxRunSeconds + plan.limits.cleanupReserveSeconds) * 1000,
        "Hosted API usage window exceeds the finite run",
      );
      variables = {
        projectId: target.projectId,
        workspaceId: plan.railway.workspaceId,
        start: new Date(clock.startedAt).toISOString(),
        end: new Date(clock.now).toISOString(),
      };
      break;
    }
    case "deployment-stop":
    case "deployment-delete": {
      serviceTarget(prepared, action.deployment);
      uuid.parse(action.deployment.deploymentId);
      uuid.parse(action.deployment.instanceId);
      check(
        /^sha256:[a-f0-9]{64}$/.test(action.deployment.imageDigest) &&
          plan.artifacts.some((entry) => entry.id === action.deployment.artifactId),
        "Hosted API deployment artifact is not bound",
      );
      variables = { id: action.deployment.deploymentId };
      break;
    }
    case "volume-delete": {
      assertHostedVolumeOwnership(prepared, action.volume);
      variables = { id: action.volume.volumeId };
      break;
    }
    case "service-delete": {
      const target = serviceTarget(prepared, action.service);
      variables = { id: target.serviceId, environmentId: target.environmentId };
      break;
    }
    case "project-delete":
      variables = { id: projectTarget(prepared, action.project).projectId };
      break;
    case "key-delete":
      uuid.parse(action.key.keyId);
      check(
        action.key.workspaceId === plan.railway.workspaceId &&
          action.key.keyName === plan.ssh.keyName &&
          action.key.fingerprint === plan.ssh.fingerprint,
        "Hosted API key is not the approved owned key",
      );
      variables = { id: action.key.keyId };
      break;
  }
  const operation = OPERATIONS[action.operation];
  const input = Buffer.from(JSON.stringify(variables));
  check(input.byteLength <= BYTES, "Hosted API variables exceeded bounds");
  return {
    actionId: action.actionId,
    operation: action.operation,
    kind: operation.kind,
    query: operation.query,
    input,
    inputSHA256: hash(input),
  };
}

export interface HostedRailwayAdapterOptions {
  prepared: Prepared;
  railwaySHA256: string;
  workingDirectory: string;
  /** Must exclusively claim a reviewed action, fsync its exact operation/input hash, and reject reuse. */
  beforeAttempt(attempt: HostedRailwayAttempt): Promise<void>;
  /** Must fsync outcome, including unknown. A failed callback is never permission to replay. */
  afterAttempt(result: HostedRailwayResult): Promise<void>;
}
function childFacts(result: Child): HostedRailwayChildOutcome {
  return {
    exitCode: result.exitCode,
    signal: result.signal,
    pid: result.pid,
    spawnFailed: result.spawnFailed,
    timedOut: result.timedOut,
    exceededOutput: result.exceededOutput,
    orphanedGroup: result.orphanedGroup,
    cleanupConfirmed: result.cleanupConfirmed,
    inputComplete: result.inputComplete,
    inputFailed: result.inputFailed,
    durationMs: result.durationMs,
    stdoutSHA256: result.stdoutSHA256,
    stderrSHA256: result.stderrSHA256,
  };
}
function successful(result: HostedRailwayChildOutcome): boolean {
  return (
    result.exitCode === 0 &&
    result.signal === null &&
    !result.spawnFailed &&
    !result.timedOut &&
    !result.exceededOutput &&
    !result.orphanedGroup &&
    result.cleanupConfirmed &&
    result.inputComplete === true &&
    result.inputFailed === false
  );
}
function assertRemaining(gate: Gate, prepared: Prepared, operation: HostedRailwayOperation) {
  check(gate.prepared.sha256 === prepared.sha256, "Hosted API approval belongs to another plan");
  assertHostedIntegrationApproval({ ...gate, now: Date.now() });
  check(
    gate.phase !== "cleanup" ||
      OPERATIONS[operation].kind === "query" ||
      [
        "deployment-stop",
        "deployment-delete",
        "volume-delete",
        "service-delete",
        "project-delete",
        "key-delete",
      ].includes(operation),
    "Hosted API cleanup reserve permits only owned stop/delete mutations",
  );
  const limits = prepared.plan.limits;
  const end =
    gate.startedAt +
    (limits.maxRunSeconds + (gate.phase === "cleanup" ? limits.cleanupReserveSeconds : 0)) * 1000;
  return Math.min(end, Date.parse(gate.approval.expiresAt));
}

/** A per-request deadline can only shorten the enclosing approved phase. */
export interface HostedRailwayRequestOptions {
  deadlineMs: number;
}
function requestBudget(
  gate: Gate | undefined,
  prepared: Prepared,
  operation: HostedRailwayOperation,
  deadlineMs?: number,
) {
  if (deadlineMs !== undefined)
    check(
      Number.isSafeInteger(deadlineMs) && deadlineMs > 0,
      "Invalid hosted API request deadline",
    );
  const phaseEnd = gate ? assertRemaining(gate, prepared, operation) : Infinity;
  const end = Math.min(phaseEnd, deadlineMs ?? Infinity);
  const available = Math.floor(end - Date.now() - APPLICATION_BOUNDS.reapMs);
  check(
    available > 0 && (deadlineMs !== undefined || available >= API_MS),
    "Insufficient approved API and reap time",
  );
  return { timeoutMs: Math.min(API_MS, available), end };
}

function adapter(
  options: HostedRailwayAdapterOptions,
  runner: Runner,
  verifyExecutable: () => void,
) {
  const prepared = prepareHostedIntegration(options.prepared.plan);
  check(
    prepared.sha256 === options.prepared.sha256 &&
      prepared.artifactInputsSHA256 === options.prepared.artifactInputsSHA256,
    "Hosted API plan changed",
  );
  sha.parse(options.railwaySHA256);
  const home = realpathSync(homedir());
  const directory = pinDirectory(options.workingDirectory, "Hosted API working directory");
  let cwd: string;
  try {
    check(
      (fstatSync(directory.fd).mode & 0o777) === 0o700,
      "Hosted API working directory must be private",
    );
    cwd = directory.canonical;
  } finally {
    closeSync(directory.fd);
  }
  return {
    async run(
      action: HostedRailwayAction,
      gate?: Gate,
      request?: HostedRailwayRequestOptions,
    ): Promise<HostedRailwayResult> {
      const deadlineMs = request?.deadlineMs;
      if (request !== undefined)
        check(
          Number.isSafeInteger(deadlineMs) && deadlineMs! > 0,
          "Invalid hosted API request deadline",
        );
      const built = prepareHostedRailwayAction(
        prepared,
        action,
        gate && { startedAt: gate.startedAt, now: Date.now() },
      );
      const mutation = built.kind === "mutation";
      const placementServiceId =
        action.operation === "service-read"
          ? serviceTarget(prepared, action.service).serviceId
          : undefined;
      if (mutation) check(gate, "Explicit hosted approval is required for every mutation");
      requestBudget(gate, prepared, built.operation, deadlineMs);
      verifyExecutable();
      const attempt = {
        actionId: built.actionId,
        operation: built.operation,
        inputSHA256: built.inputSHA256,
      };
      if (mutation) {
        try {
          await options.beforeAttempt(Object.freeze({ ...attempt }));
        } catch {
          throw new Error("Hosted mutation admission was not recorded; no API call started");
        }
      }
      let result: HostedRailwayResult = {
        ...attempt,
        kind: built.kind,
        outcome: "not-started",
        reason: "admission-changed",
        child: null,
        response: null,
      };
      let started = false;
      try {
        verifyExecutable();
        const budget = requestBudget(gate, prepared, built.operation, deadlineMs);
        started = true;
        const raw = await runner({
          command: [CLI, "api", built.query, "--variables", "@-", "--compact"],
          cwd,
          env: { HOME: home, PATH: "/usr/bin:/bin", LANG: "C.UTF-8", NO_COLOR: "1", CI: "true" },
          secrets: [],
          input: Buffer.from(built.input),
          timeoutMs: budget.timeoutMs,
          maxOutputBytes: BYTES,
        });
        result = {
          ...attempt,
          kind: built.kind,
          outcome: mutation ? "unknown" : "query-failed",
          reason: "child-failure",
          child: childFacts(raw),
          response: null,
        };
        const withinDeadline = Date.now() <= budget.end;
        const childSucceeded = withinDeadline && successful(result.child!);
        // Native GraphQL errors can exit 1. Diagnose only complete, bounded service reads;
        // a failed child never supplies a response or successful admission.
        const rejectedService =
          withinDeadline &&
          built.operation === "service-read" &&
          raw.exitCode === 1 &&
          successful({ ...result.child!, exitCode: 0 });
        if (childSucceeded || rejectedService) {
          let stage: HostedRailwayResponseDiagnostic["stage"] = "response-size";
          let decoded: unknown;
          try {
            check(Buffer.byteLength(raw.stdout) <= BYTES, "Hosted API response exceeded bounds");
            stage = "json";
            decoded = JSON.parse(raw.stdout);
            stage = "envelope";
            decoded = body(decoded);
            stage = "schema";
            const data: Record<string, unknown> = OPERATIONS[built.operation].schema.parse(decoded);
            if (placementServiceId) {
              stage = "placement";
              data.servicePlacement = projectHostedServicePlacement(
                (decoded as Record<string, unknown>).environment,
                placementServiceId,
              );
            }
            if (childSucceeded) {
              result.response = { data };
              result.outcome = "response";
              result.reason = "none";
            }
          } catch (error) {
            if (childSucceeded) result.reason = "invalid-response";
            result.diagnostic = responseDiagnostic(
              stage,
              built.operation,
              decoded,
              error,
              placementServiceId,
            );
          }
        }
      } catch {
        result = {
          ...attempt,
          kind: built.kind,
          outcome: started ? (mutation ? "unknown" : "query-failed") : "not-started",
          reason: started ? "child-failure" : "admission-changed",
          child: null,
          response: null,
        };
      }
      if (mutation) {
        try {
          await options.afterAttempt(structuredClone(result));
        } catch {
          throw new Error("Hosted API outcome could not be journaled; do not replay the mutation");
        }
      }
      return result;
    },
  };
}
/** The only production command is the locally pinned CLI using its existing HOME authentication. */
export function createHostedRailwayAdapter(options: HostedRailwayAdapterOptions) {
  const expectedSHA256 = sha.parse(options.railwaySHA256);
  const verify = () => {
    try {
      const binary = realpathSync(CLI);
      check(
        hash(readBoundedRegularFile(binary, 128 * 1024 * 1024).bytes) === expectedSHA256,
        "Pinned Railway CLI changed",
      );
    } catch {
      throw new Error("Pinned Railway CLI changed or is unavailable");
    }
  };
  return adapter(options, async (input) => startApplicationChild(input).finish(), verify);
}
/** Unit tests only; never use an injected runner in the reviewed hosted executor. */
export function createHostedRailwayAdapterForTest(
  options: HostedRailwayAdapterOptions,
  runner: Runner,
  verifyExecutable: () => void = () => {},
) {
  return adapter(options, runner, verifyExecutable);
}
