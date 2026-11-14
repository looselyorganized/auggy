/** Pure approval and readback checks for one isolated rehearsal; never a cloud executor. */
import { applicationHash } from "./application-consumer";
import type { IntegrationBuildKind } from "./integration-contracts";

export type HostedServiceRole = "http" | "worker" | "recovery";
export type HostedVolumeAlias =
  | "http-original"
  | "worker-original"
  | "http-restore"
  | "worker-restore";

export interface HostedSourceArtifact {
  id: string;
  profile: "http" | "none";
  purpose: "baseline" | "edited" | "maintenance";
  buildKind: IntegrationBuildKind;
  /** Source-build inputs. A final OCI image digest is an observed output. */
  contextSHA256: string;
  exportManifestSHA256: string;
  sourceInventorySHA256: string;
  packageInventorySHA256: string;
  lockSHA256: string;
  dockerfileSHA256: string;
  entrypointSHA256: string;
  fixtureOverlaySHA256: string;
  baseImageDigest: string;
}

export interface HostedAcceptedEvidence {
  localSHA256: string;
  containerSHA256: string;
  hostedFixtureSHA256: string;
}

export interface HostedIntegrationPlan {
  version: 2;
  runId: string;
  railway: {
    workspaceId: string;
    region: string;
    newProject: { name: string; environmentName: string };
    services: readonly { role: HostedServiceRole; name: string }[];
    /** Aliases are approval identities; volumeCreate does not accept a name. */
    volumes: readonly {
      alias: HostedVolumeAlias;
      serviceRole: HostedServiceRole;
      mountPath: "/app/data";
      sizeMB: number;
    }[];
  };
  ssh: {
    scope: "workspace";
    keyName: string;
    /** SHA256 of the decoded OpenSSH public-key blob, matching fingerprint. */
    publicKeySHA256: string;
    fingerprint: string;
    relay: {
      hostname: "ssh.railway.com";
      port: 22;
      trust: "explicit-first-use-pin";
      /** An observed first-use pin is not authenticated provider publication. */
      providerAuthenticated: false;
      publicKeySHA256: string;
      fingerprint: string;
      knownHostsSHA256: string;
    };
  };
  artifacts: readonly HostedSourceArtifact[];
  /** Runner hash covers a self-contained artifact or its complete transitive source inventory. */
  actionManifest: { sha256: string; executorSHA256: string; actionCount: number };
  acceptedEvidence: HostedAcceptedEvidence;
  limits: {
    maxServices: number;
    maxVolumes: number;
    maxVolumeSizeMB: number;
    maxCpuPerService: number;
    maxMemoryBytesPerService: number;
    monitoredSpendUSD: number;
    providerHardSpendCap: false;
    maxRunSeconds: number;
    cleanupReserveSeconds: number;
    remoteCommandSeconds: number;
    fixtureActivitySeconds: number;
  };
  fixtures: {
    owner: string;
    connectivity: "service-loopback-via-ssh";
    services: readonly {
      role: "http" | "worker";
      origins: readonly string[];
      controlOrigin: string;
      controlSourceSHA256: string;
      sealedEvidenceContractSHA256: string;
    }[];
    syntheticIdentitySetSHA256: string;
    allowedEffectContractSHA256: string;
  };
  retention: {
    cleanupOwner: string;
    retainedUntil: string;
    privateArtifactLocation: string;
    retainResources: false;
  };
  source: { revision: string; tree: string; sourceChangesSHA256: string };
}

export interface HostedIntegrationApproval {
  /** Recorded only from the operator's explicit approval, never from credentials. */
  approvedPlanSHA256: string;
  recordedApprovalId: string;
  approvedAt: string;
  expiresAt: string;
}

export interface HostedObservedInputs {
  actionManifestSHA256: string;
  actionCount: number;
  executorSHA256: string;
  artifactInputsSHA256: string;
  acceptedEvidence: HostedAcceptedEvidence;
  ssh: {
    publicKeySHA256: string;
    relayPublicKeySHA256: string;
    knownHostsSHA256: string;
  };
}

export interface HostedProjectInventory {
  workspaceId: string;
  /** The caller must finish pagination; partial discovery cannot establish absence. */
  complete: boolean;
  projects: readonly { id: string; name: string; workspaceId: string }[];
}

export interface HostedProjectBinding {
  workspaceId: string;
  projectId: string;
  environmentId: string;
  projectName: string;
  environmentName: string;
}

export interface HostedSshKeyBinding {
  workspaceId: string;
  keyId: string;
  keyName: string;
  fingerprint: string;
}

export interface HostedServiceBinding extends HostedProjectBinding {
  role: HostedServiceRole;
  serviceId: string;
  serviceName: string;
}

export interface HostedVolumeBinding extends HostedServiceBinding {
  alias: HostedVolumeAlias;
  volumeId: string;
  volumeInstanceId: string;
  sizeMB: number;
}

export interface HostedDeploymentBinding extends HostedServiceBinding {
  artifactId: string;
  deploymentId: string;
  imageDigest: string;
  instanceId: string;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function object(value: unknown): Record<string, unknown> {
  check(value && typeof value === "object" && !Array.isArray(value), "Invalid hosted record");
  return value as Record<string, unknown>;
}

function items(value: unknown, maximum: number): unknown[] {
  check(Array.isArray(value) && value.length <= maximum, "Hosted list is missing or unbounded");
  return value;
}

function name(value: unknown): asserts value is string {
  check(
    typeof value === "string" && /^[a-z0-9][a-z0-9-]{0,79}$/.test(value),
    "Invalid hosted logical name",
  );
}

function id(value: unknown): asserts value is string {
  check(
    typeof value === "string" &&
      /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(value),
    "Hosted resource requires an exact UUID",
  );
}

function hash(value: unknown): asserts value is string {
  check(typeof value === "string" && /^[a-f0-9]{64}$/.test(value), "Hosted input requires SHA256");
}

function digest(value: unknown): asserts value is string {
  check(
    typeof value === "string" && /^sha256:[a-f0-9]{64}$/.test(value),
    "Hosted image requires an exact OCI digest",
  );
}

function fingerprint(value: unknown, publicKeySHA256: string): asserts value is string {
  check(
    typeof value === "string" && /^SHA256:[A-Za-z0-9+/]{43}$/.test(value),
    "Invalid SSH public-key fingerprint",
  );
  const encoded = value.slice("SHA256:".length);
  const decoded = Buffer.from(encoded, "base64");
  check(
    decoded.length === 32 &&
      decoded.toString("base64").replace(/=+$/, "") === encoded &&
      decoded.toString("hex") === publicKeySHA256,
    "SSH fingerprint does not match its decoded public-key SHA256",
  );
}

function positive(value: number, maximum: number, integer = true): void {
  check(
    Number.isFinite(value) &&
      value > 0 &&
      value <= maximum &&
      (!integer || Number.isSafeInteger(value)),
    "Hosted limit is invalid or unbounded",
  );
}

function instant(value: string): number {
  check(
    typeof value === "string" && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value),
    "Hosted time must be an explicit UTC instant",
  );
  const time = Date.parse(value);
  check(
    Number.isFinite(time) &&
      new Date(time).toISOString() === (value.includes(".") ? value : value.replace("Z", ".000Z")),
    "Hosted time is invalid",
  );
  return time;
}

function evidence(input: HostedAcceptedEvidence): HostedAcceptedEvidence {
  hash(input.localSHA256);
  hash(input.containerSHA256);
  hash(input.hostedFixtureSHA256);
  return {
    localSHA256: input.localSHA256,
    containerSHA256: input.containerSHA256,
    hostedFixtureSHA256: input.hostedFixtureSHA256,
  };
}

function loopbackOrigin(value: string): string {
  const url = new URL(value);
  check(
    url.protocol === "http:" &&
      url.hostname === "127.0.0.1" &&
      url.port !== "" &&
      url.origin === value &&
      !url.username &&
      !url.password &&
      url.pathname === "/" &&
      !url.search &&
      !url.hash,
    "Hosted fixture origin must be an exact credential-free loopback origin",
  );
  return value;
}

/** Reconstruct only reviewed fields; unknown credential fields cannot enter the review record. */
export function prepareHostedIntegration(input: HostedIntegrationPlan) {
  check(
    input.version === 2,
    "Unsupported hosted plan version; v2 new-project approval is required",
  );
  name(input.runId);
  id(input.railway.workspaceId);
  name(input.railway.region);
  name(input.railway.newProject.name);
  name(input.railway.newProject.environmentName);
  const services = items(input.railway.services, 3).map((value) => {
    const service = object(value);
    check(
      typeof service.role === "string" && ["http", "worker", "recovery"].includes(service.role),
      "Invalid hosted service role",
    );
    name(service.name);
    return { role: service.role as HostedServiceRole, name: service.name };
  });
  check(
    services.length >= 2 &&
      services.some((service) => service.role === "http") &&
      services.some((service) => service.role === "worker") &&
      new Set(services.map((service) => service.role)).size === services.length &&
      new Set(services.map((service) => service.name)).size === services.length,
    "Hosted proof requires distinct HTTP/worker services and at most one recovery service",
  );
  const volumeAliases: HostedVolumeAlias[] = [
    "http-original",
    "worker-original",
    "http-restore",
    "worker-restore",
  ];
  const volumes = items(input.railway.volumes, 4).map((value) => {
    const volume = object(value);
    check(volumeAliases.includes(volume.alias as HostedVolumeAlias), "Invalid hosted volume alias");
    const originalRole = volume.alias === "http-original" ? "http" : "worker";
    const expectedRole =
      String(volume.alias).endsWith("-restore") &&
      services.some((service) => service.role === "recovery")
        ? "recovery"
        : String(volume.alias).startsWith("http-")
          ? "http"
          : originalRole;
    check(volume.serviceRole === expectedRole, "Volume belongs to the wrong approved service role");
    check(volume.mountPath === "/app/data", "Hosted volume must use the admitted runtime mount");
    positive(volume.sizeMB as number, 1_000_000);
    return {
      alias: volume.alias as HostedVolumeAlias,
      serviceRole: expectedRole as HostedServiceRole,
      mountPath: "/app/data" as const,
      sizeMB: volume.sizeMB as number,
    };
  });
  check(
    volumes.length === 4 && new Set(volumes.map((volume) => volume.alias)).size === 4,
    "Hosted proof requires all four distinct volume targets",
  );

  check(input.ssh.scope === "workspace", "Hosted key must have explicit workspace scope");
  name(input.ssh.keyName);
  hash(input.ssh.publicKeySHA256);
  fingerprint(input.ssh.fingerprint, input.ssh.publicKeySHA256);
  const relay = input.ssh.relay;
  check(
    relay.hostname === "ssh.railway.com" &&
      relay.port === 22 &&
      relay.trust === "explicit-first-use-pin" &&
      relay.providerAuthenticated === false,
    "Hosted SSH requires explicit first-use trust, not an authenticated-provider claim",
  );
  hash(relay.publicKeySHA256);
  fingerprint(relay.fingerprint, relay.publicKeySHA256);
  hash(relay.knownHostsSHA256);

  const artifacts = items(input.artifacts, 12).map((value): HostedSourceArtifact => {
    const artifact = object(value);
    name(artifact.id);
    check(
      artifact.profile === "http" || artifact.profile === "none",
      "Invalid hosted artifact profile",
    );
    check(
      typeof artifact.purpose === "string" &&
        ["baseline", "edited", "maintenance"].includes(artifact.purpose),
      "Invalid hosted artifact purpose",
    );
    check(
      typeof artifact.buildKind === "string" &&
        ["production-reference", "fixture-auth", "standalone-fixture"].includes(artifact.buildKind),
      "Invalid hosted build kind",
    );
    for (const field of [
      "contextSHA256",
      "exportManifestSHA256",
      "sourceInventorySHA256",
      "packageInventorySHA256",
      "lockSHA256",
      "dockerfileSHA256",
      "entrypointSHA256",
      "fixtureOverlaySHA256",
    ] as const)
      hash(artifact[field]);
    digest(artifact.baseImageDigest);
    return {
      id: artifact.id,
      profile: artifact.profile,
      purpose: artifact.purpose as HostedSourceArtifact["purpose"],
      buildKind: artifact.buildKind as IntegrationBuildKind,
      contextSHA256: artifact.contextSHA256 as string,
      exportManifestSHA256: artifact.exportManifestSHA256 as string,
      sourceInventorySHA256: artifact.sourceInventorySHA256 as string,
      packageInventorySHA256: artifact.packageInventorySHA256 as string,
      lockSHA256: artifact.lockSHA256 as string,
      dockerfileSHA256: artifact.dockerfileSHA256 as string,
      entrypointSHA256: artifact.entrypointSHA256 as string,
      fixtureOverlaySHA256: artifact.fixtureOverlaySHA256 as string,
      baseImageDigest: artifact.baseImageDigest,
    };
  });
  check(
    new Set(artifacts.map((artifact) => artifact.id)).size === artifacts.length,
    "Hosted artifact IDs must be distinct",
  );
  for (const profile of ["http", "none"] as const)
    for (const purpose of ["baseline", "edited"] as const)
      check(
        artifacts.some((artifact) => artifact.profile === profile && artifact.purpose === purpose),
        "Hosted proof needs baseline and edited source for both profiles",
      );
  check(
    artifacts.some((artifact) => artifact.purpose === "maintenance" && artifact.profile === "none"),
    "Hosted proof needs an approved no-ingress maintenance artifact",
  );
  hash(input.actionManifest.sha256);
  hash(input.actionManifest.executorSHA256);
  positive(input.actionManifest.actionCount, 128);

  const limits = input.limits;
  positive(limits.maxServices, 3);
  positive(limits.maxVolumes, 4);
  positive(limits.maxVolumeSizeMB, 1_000_000);
  positive(limits.maxCpuPerService, 16, false);
  positive(limits.maxMemoryBytesPerService, 16_384_000_000);
  positive(limits.monitoredSpendUSD, 10_000, false);
  positive(limits.maxRunSeconds, 7200);
  positive(limits.cleanupReserveSeconds, 600);
  positive(limits.remoteCommandSeconds, 60);
  positive(limits.fixtureActivitySeconds, 120);
  check(limits.providerHardSpendCap === false, "Monitored spending is not a provider hard cap");
  check(
    limits.maxServices >= services.length &&
      limits.maxVolumes === volumes.length &&
      volumes.every((volume) => volume.sizeMB <= limits.maxVolumeSizeMB),
    "Approved resource limits do not fit the declared resources",
  );

  name(input.fixtures.owner);
  check(
    input.fixtures.connectivity === "service-loopback-via-ssh",
    "Hosted fixture control must use explicit service loopback via SSH",
  );
  const fixtureServices = items(input.fixtures.services, 2).map(
    (value): HostedIntegrationPlan["fixtures"]["services"][number] => {
      const fixture = object(value);
      check(fixture.role === "http" || fixture.role === "worker", "Invalid hosted fixture role");
      const origins = items(fixture.origins, 3).map((origin) => loopbackOrigin(origin as string));
      check(
        origins.length > 0 && new Set(origins).size === origins.length,
        "Hosted fixture origins must be distinct",
      );
      const controlOrigin = loopbackOrigin(fixture.controlOrigin as string);
      check(origins.includes(controlOrigin), "Hosted control origin must belong to its service");
      hash(fixture.controlSourceSHA256);
      hash(fixture.sealedEvidenceContractSHA256);
      return {
        role: fixture.role,
        origins,
        controlOrigin,
        controlSourceSHA256: fixture.controlSourceSHA256,
        sealedEvidenceContractSHA256: fixture.sealedEvidenceContractSHA256,
      };
    },
  );
  check(
    fixtureServices.length === 2 &&
      new Set(fixtureServices.map((fixture) => fixture.role)).size === 2,
    "Hosted proof needs HTTP and polling fixture ownership",
  );
  hash(input.fixtures.syntheticIdentitySetSHA256);
  hash(input.fixtures.allowedEffectContractSHA256);
  name(input.retention.cleanupOwner);
  instant(input.retention.retainedUntil);
  check(
    input.retention.retainResources === false,
    "This rehearsal does not authorize retained resources",
  );
  check(
    typeof input.retention.privateArtifactLocation === "string" &&
      /^[a-z0-9][a-z0-9/_.-]{0,255}$/.test(input.retention.privateArtifactLocation) &&
      !input.retention.privateArtifactLocation.includes(".."),
    "Invalid private evidence location identifier",
  );
  check(
    typeof input.source.revision === "string" &&
      typeof input.source.tree === "string" &&
      /^[a-f0-9]{40}$/.test(input.source.revision) &&
      /^[a-f0-9]{40}$/.test(input.source.tree),
    "Hosted source revision/tree must be exact",
  );
  hash(input.source.sourceChangesSHA256);

  const plan: HostedIntegrationPlan = {
    version: 2,
    runId: input.runId,
    railway: {
      workspaceId: input.railway.workspaceId,
      region: input.railway.region,
      newProject: {
        name: input.railway.newProject.name,
        environmentName: input.railway.newProject.environmentName,
      },
      services,
      volumes,
    },
    ssh: {
      scope: "workspace",
      keyName: input.ssh.keyName,
      publicKeySHA256: input.ssh.publicKeySHA256,
      fingerprint: input.ssh.fingerprint,
      relay: {
        hostname: "ssh.railway.com",
        port: 22,
        trust: "explicit-first-use-pin",
        providerAuthenticated: false,
        publicKeySHA256: relay.publicKeySHA256,
        fingerprint: relay.fingerprint,
        knownHostsSHA256: relay.knownHostsSHA256,
      },
    },
    artifacts,
    actionManifest: {
      sha256: input.actionManifest.sha256,
      executorSHA256: input.actionManifest.executorSHA256,
      actionCount: input.actionManifest.actionCount,
    },
    acceptedEvidence: evidence(input.acceptedEvidence),
    limits: {
      maxServices: limits.maxServices,
      maxVolumes: limits.maxVolumes,
      maxVolumeSizeMB: limits.maxVolumeSizeMB,
      maxCpuPerService: limits.maxCpuPerService,
      maxMemoryBytesPerService: limits.maxMemoryBytesPerService,
      monitoredSpendUSD: limits.monitoredSpendUSD,
      providerHardSpendCap: false,
      maxRunSeconds: limits.maxRunSeconds,
      cleanupReserveSeconds: limits.cleanupReserveSeconds,
      remoteCommandSeconds: limits.remoteCommandSeconds,
      fixtureActivitySeconds: limits.fixtureActivitySeconds,
    },
    fixtures: {
      owner: input.fixtures.owner,
      connectivity: "service-loopback-via-ssh",
      services: fixtureServices,
      syntheticIdentitySetSHA256: input.fixtures.syntheticIdentitySetSHA256,
      allowedEffectContractSHA256: input.fixtures.allowedEffectContractSHA256,
    },
    retention: {
      cleanupOwner: input.retention.cleanupOwner,
      retainedUntil: input.retention.retainedUntil,
      privateArtifactLocation: input.retention.privateArtifactLocation,
      retainResources: false,
    },
    source: {
      revision: input.source.revision,
      tree: input.source.tree,
      sourceChangesSHA256: input.source.sourceChangesSHA256,
    },
  };
  const serialized = JSON.stringify(plan);
  check(Buffer.byteLength(serialized) <= 64 * 1024, "Hosted review plan exceeded bound");
  return {
    plan,
    sha256: applicationHash(serialized),
    artifactInputsSHA256: applicationHash(JSON.stringify(artifacts)),
    status: "not-run" as const,
    reason:
      "Explicit concrete approval and independently accepted evidence are required before hosted actions",
  };
}

export function assertHostedIntegrationApproval(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  approval: HostedIntegrationApproval;
  observedInputs: HostedObservedInputs;
  /** Immutable first-action time; subsequent checks cannot restart the run budget. */
  startedAt: number;
  phase?: "execution" | "cleanup";
  now?: number;
}): void {
  const prepared = prepareHostedIntegration(options.prepared.plan);
  hash(options.approval.approvedPlanSHA256);
  check(
    prepared.sha256 === options.prepared.sha256 &&
      prepared.sha256 === options.approval.approvedPlanSHA256 &&
      prepared.artifactInputsSHA256 === options.prepared.artifactInputsSHA256,
    "Hosted approval does not match the concrete deployment plan",
  );
  name(options.approval.recordedApprovalId);
  const observed = options.observedInputs;
  hash(observed.actionManifestSHA256);
  positive(observed.actionCount, 128);
  hash(observed.executorSHA256);
  hash(observed.artifactInputsSHA256);
  hash(observed.ssh.publicKeySHA256);
  hash(observed.ssh.relayPublicKeySHA256);
  hash(observed.ssh.knownHostsSHA256);
  check(
    observed.actionManifestSHA256 === prepared.plan.actionManifest.sha256 &&
      observed.actionCount === prepared.plan.actionManifest.actionCount &&
      observed.executorSHA256 === prepared.plan.actionManifest.executorSHA256 &&
      observed.artifactInputsSHA256 === prepared.artifactInputsSHA256 &&
      observed.ssh.publicKeySHA256 === prepared.plan.ssh.publicKeySHA256 &&
      observed.ssh.relayPublicKeySHA256 === prepared.plan.ssh.relay.publicKeySHA256 &&
      observed.ssh.knownHostsSHA256 === prepared.plan.ssh.relay.knownHostsSHA256 &&
      JSON.stringify(evidence(observed.acceptedEvidence)) ===
        JSON.stringify(prepared.plan.acceptedEvidence),
    "Hosted execution inputs differ from the approved evidence/actions/artifacts",
  );
  const now = options.now ?? Date.now();
  const startedAt = options.startedAt;
  const approvedAt = instant(options.approval.approvedAt);
  const expiresAt = instant(options.approval.expiresAt);
  const retainedUntil = instant(prepared.plan.retention.retainedUntil);
  const phase = options.phase ?? "execution";
  check(phase === "execution" || phase === "cleanup", "Invalid hosted approval phase");
  const totalSeconds =
    prepared.plan.limits.maxRunSeconds + prepared.plan.limits.cleanupReserveSeconds;
  check(
    Number.isFinite(now) &&
      Number.isFinite(startedAt) &&
      approvedAt <= startedAt &&
      startedAt <= now &&
      now < expiresAt &&
      expiresAt - approvedAt <= 86_400_000,
    "Hosted approval is expired, future-dated or unbounded",
  );
  check(
    startedAt + totalSeconds * 1000 <= expiresAt &&
      now <
        startedAt +
          (phase === "cleanup" ? totalSeconds : prepared.plan.limits.maxRunSeconds) * 1000 &&
      retainedUntil >= expiresAt &&
      retainedUntil - approvedAt <= 7 * 86_400_000,
    "Hosted run/cleanup/retention exceeds its approved time envelope",
  );
}

function responseData(value: unknown): Record<string, unknown> {
  const response = object(value);
  check(
    response.errors === undefined ||
      (Array.isArray(response.errors) && response.errors.length === 0),
    "Hosted readback returned GraphQL errors",
  );
  return object(response.data);
}

function connection(value: unknown): Record<string, unknown>[] {
  const record = object(value);
  check(
    object(record.pageInfo).hasNextPage === false,
    "Hosted readback is not completely paginated",
  );
  return items(record.edges, 100).map((edge) => object(object(edge).node));
}

/** Workspace scope is explicit; an existing key is never adopted or re-registered. */
export function bindHostedSshKey(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  before: unknown;
  creation: unknown;
  readback: unknown;
}): HostedSshKeyBinding {
  const plan = options.prepared.plan;
  const before = connection(responseData(options.before).sshPublicKeys);
  const ids = new Set<string>();
  for (const key of before) {
    id(key.id);
    check(
      key.workspaceId === plan.railway.workspaceId && !ids.has(key.id),
      "Hosted SSH discovery has ambiguous workspace ownership",
    );
    check(
      key.name !== plan.ssh.keyName && key.fingerprint !== plan.ssh.fingerprint,
      "Hosted SSH key already exists; adoption is forbidden",
    );
    ids.add(key.id);
  }
  const created = object(responseData(options.creation).sshPublicKeyCreate);
  id(created.id);
  check(
    !ids.has(created.id) &&
      created.name === plan.ssh.keyName &&
      created.workspaceId === plan.railway.workspaceId &&
      created.fingerprint === plan.ssh.fingerprint,
    "Hosted SSH registration has the wrong identity/scope",
  );
  const keys = connection(responseData(options.readback).sshPublicKeys);
  const matches = keys.filter((key) => key.id === created.id);
  check(
    matches.length === 1 &&
      matches[0]!.name === created.name &&
      matches[0]!.workspaceId === created.workspaceId &&
      matches[0]!.fingerprint === created.fingerprint &&
      keys.filter((key) => key.name === created.name || key.fingerprint === created.fingerprint)
        .length === 1,
    "Hosted SSH key readback is absent or ambiguous",
  );
  return {
    workspaceId: plan.railway.workspaceId,
    keyId: created.id,
    keyName: plan.ssh.keyName,
    fingerprint: plan.ssh.fingerprint,
  };
}

function assertProjectBinding(plan: HostedIntegrationPlan, binding: HostedProjectBinding): void {
  id(binding.workspaceId);
  id(binding.projectId);
  id(binding.environmentId);
  check(
    binding.workspaceId === plan.railway.workspaceId &&
      binding.projectName === plan.railway.newProject.name &&
      binding.environmentName === plan.railway.newProject.environmentName,
    "Hosted project binding differs from its approved allocation",
  );
}

function servicePlan(plan: HostedIntegrationPlan, role: HostedServiceRole) {
  const selected = plan.railway.services.find((service) => service.role === role);
  check(selected, "Hosted service role is not approved");
  return selected;
}

function assertServiceBinding(plan: HostedIntegrationPlan, binding: HostedServiceBinding): void {
  assertProjectBinding(plan, binding);
  id(binding.serviceId);
  check(
    binding.serviceName === servicePlan(plan, binding.role).name,
    "Hosted service differs from its approved allocation",
  );
}

function projectIdentity(binding: HostedProjectBinding): HostedProjectBinding {
  return {
    workspaceId: binding.workspaceId,
    projectId: binding.projectId,
    environmentId: binding.environmentId,
    projectName: binding.projectName,
    environmentName: binding.environmentName,
  };
}

function serviceIdentity(binding: HostedServiceBinding): HostedServiceBinding {
  return {
    ...projectIdentity(binding),
    role: binding.role,
    serviceId: binding.serviceId,
    serviceName: binding.serviceName,
  };
}

// Readback helpers bind metadata, not permission. The executor must check the
// approved plan and its current deadline before each mutation or remote command.

export function assertHostedProjectAvailable(
  prepared: ReturnType<typeof prepareHostedIntegration>,
  inventory: HostedProjectInventory,
): void {
  check(
    inventory.complete === true && inventory.workspaceId === prepared.plan.railway.workspaceId,
    "Hosted project discovery is incomplete or belongs to another workspace",
  );
  const projects = items(inventory.projects, 1000).map(object);
  const ids = new Set<string>();
  for (const project of projects) {
    id(project.id);
    check(
      typeof project.name === "string" &&
        project.name.length <= 255 &&
        project.workspaceId === inventory.workspaceId &&
        !ids.has(project.id),
      "Hosted project discovery has ambiguous ownership",
    );
    ids.add(project.id);
    check(
      project.name.trim().toLowerCase() !== prepared.plan.railway.newProject.name,
      "Hosted project name already exists; adoption is forbidden",
    );
  }
}

export function bindHostedProjectAllocation(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  before: HostedProjectInventory;
  creation: unknown;
  readback: unknown;
}): HostedProjectBinding {
  assertHostedProjectAvailable(options.prepared, options.before);
  const plan = options.prepared.plan;
  const created = object(responseData(options.creation).projectCreate);
  const project = object(responseData(options.readback).project);
  id(created.id);
  check(
    !options.before.projects.some((existing) => existing.id === created.id),
    "Hosted allocation returned a preexisting project",
  );
  check(
    created.name === plan.railway.newProject.name &&
      created.workspaceId === plan.railway.workspaceId &&
      project.id === created.id &&
      project.name === created.name &&
      project.workspaceId === created.workspaceId &&
      project.deletedAt === null &&
      project.isPublic === false &&
      project.prDeploys === false,
    "Hosted project allocation has the wrong parent/name/policy",
  );
  const environments = connection(project.environments);
  check(
    environments.length === 1 &&
      environments[0]!.name === plan.railway.newProject.environmentName &&
      environments[0]!.projectId === created.id,
    "Hosted project must have its exact sole approved environment",
  );
  const environment = environments[0]!;
  id(environment.id);
  check(
    connection(project.services).length === 0 && connection(project.volumes).length === 0,
    "New hosted project unexpectedly contains resources",
  );
  return {
    workspaceId: plan.railway.workspaceId,
    projectId: created.id,
    environmentId: environment.id,
    projectName: created.name as string,
    environmentName: environment.name as string,
  };
}

/** Initial admission requires an empty service, accepted setters and exact effective cap readback. */
export function bindHostedServiceAdmission(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  project: HostedProjectBinding;
  role: HostedServiceRole;
  creation: unknown;
  capMutation: unknown;
  policyMutation: unknown;
  readback: unknown;
}): HostedServiceBinding {
  const plan = options.prepared.plan;
  assertProjectBinding(plan, options.project);
  const approved = servicePlan(plan, options.role);
  const service = object(responseData(options.creation).serviceCreate);
  id(service.id);
  check(
    service.projectId === options.project.projectId && service.name === approved.name,
    "Hosted service allocation has the wrong parent/name",
  );
  check(
    responseData(options.capMutation).serviceInstanceLimitsUpdate === true &&
      responseData(options.policyMutation).serviceInstanceUpdate === true,
    "Hosted service limits/policy were refused; widening is forbidden",
  );
  const data = responseData(options.readback);
  const instance = object(data.serviceInstance);
  const limits = object(object(data.serviceInstanceLimits).containers);
  check(
    instance.serviceId === service.id &&
      instance.environmentId === options.project.environmentId &&
      instance.latestDeployment === null,
    "Hosted service admission has the wrong target or an existing workload",
  );
  check(
    limits.cpu === plan.limits.maxCpuPerService &&
      limits.memoryBytes === plan.limits.maxMemoryBytesPerService &&
      instance.numReplicas === 1 &&
      instance.region === plan.railway.region &&
      instance.restartPolicyType === "NEVER" &&
      instance.restartPolicyMaxRetries === 0 &&
      instance.sleepApplication === false,
    "Hosted effective caps/policy differ from approval; workload must not start",
  );
  return {
    ...projectIdentity(options.project),
    role: options.role,
    serviceId: service.id,
    serviceName: approved.name,
  };
}

export function bindHostedVolumeAllocation(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  service: HostedServiceBinding;
  alias: HostedVolumeAlias;
  creation: unknown;
  /** Complete ProjectBinding readback, including volumeInstances. */
  readback: unknown;
  previousVolumeIds: readonly string[];
}): HostedVolumeBinding {
  const plan = options.prepared.plan;
  assertServiceBinding(plan, options.service);
  const approved = plan.railway.volumes.find((volume) => volume.alias === options.alias);
  check(
    approved && approved.serviceRole === options.service.role,
    "Hosted volume role is not approved",
  );
  const created = object(responseData(options.creation).volumeCreate);
  id(created.id);
  check(
    !options.previousVolumeIds.includes(created.id) &&
      options.previousVolumeIds.length < plan.limits.maxVolumes &&
      new Set(options.previousVolumeIds).size === options.previousVolumeIds.length,
    "Hosted volume was reused or exceeds the distinct-resource allowance",
  );
  for (const previous of options.previousVolumeIds) id(previous);
  check(
    created.projectId === options.service.projectId,
    "Hosted volume allocation has the wrong parent",
  );
  const project = object(responseData(options.readback).project);
  check(
    project.id === options.service.projectId && project.workspaceId === options.service.workspaceId,
    "Hosted volume readback has the wrong project/workspace",
  );
  const volumes = connection(project.volumes);
  const permitted = new Set([...options.previousVolumeIds, created.id]);
  const observed = new Set<string>();
  for (const volume of volumes) {
    id(volume.id);
    check(
      permitted.has(volume.id) && !observed.has(volume.id) && volume.projectId === project.id,
      "Hosted volume inventory contains an unexpected or duplicate resource",
    );
    observed.add(volume.id);
  }
  const matches = volumes.filter((volume) => volume.id === created.id);
  check(
    matches.length === 1 && matches[0]!.projectId === project.id,
    "Hosted volume identity is missing or ambiguous",
  );
  const instances = connection(matches[0]!.volumeInstances);
  check(instances.length === 1, "Hosted volume has ambiguous attachments");
  const instance = instances[0]!;
  id(instance.id);
  check(
    instance.volumeId === created.id &&
      instance.environmentId === options.service.environmentId &&
      instance.serviceId === options.service.serviceId &&
      instance.mountPath === approved.mountPath &&
      instance.region === plan.railway.region &&
      instance.sizeMB === approved.sizeMB &&
      typeof instance.currentSizeMB === "number" &&
      Number.isFinite(instance.currentSizeMB) &&
      instance.currentSizeMB >= 0 &&
      instance.currentSizeMB <= approved.sizeMB &&
      instance.deletedAt === null &&
      instance.isPendingDeletion === false &&
      instance.state === "READY",
    "Hosted volume attachment/size/state differs from approval",
  );
  return {
    ...serviceIdentity(options.service),
    alias: options.alias,
    volumeId: created.id,
    volumeInstanceId: instance.id,
    sizeMB: approved.sizeMB,
  };
}

function runningDeployment(value: unknown): {
  deployment: Record<string, unknown>;
  instanceId: string;
  imageDigest: string;
} {
  const deployment = object(responseData(value).deployment);
  id(deployment.id);
  id(deployment.projectId);
  id(deployment.environmentId);
  id(deployment.serviceId);
  check(
    deployment.status === "SUCCESS" && deployment.deploymentStopped === false,
    "Hosted deployment is not running successfully",
  );
  const instances = items(deployment.instances, 2).map(object);
  check(
    instances.length === 1 && instances[0]!.status === "RUNNING",
    "Hosted deployment is not the exact running singleton",
  );
  id(instances[0]!.id);
  const imageDigest = object(deployment.meta).imageDigest;
  digest(imageDigest);
  return { deployment, instanceId: instances[0]!.id, imageDigest };
}

function assertArtifactProfile(role: HostedServiceRole, artifact: HostedSourceArtifact): void {
  // Recovery is the explicitly approved temporary slot for either profile.
  // Only no-ingress maintenance may temporarily replace a primary profile.
  check(
    role === "recovery" ||
      (artifact.purpose === "maintenance" && artifact.profile === "none") ||
      artifact.profile === (role === "http" ? "http" : "none"),
    "Hosted artifact belongs to the wrong service profile",
  );
}

export function bindHostedDeployment(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  service: HostedServiceBinding;
  artifactId: string;
  returnedDeploymentId: string;
  readback: unknown;
}): HostedDeploymentBinding {
  assertServiceBinding(options.prepared.plan, options.service);
  const artifact = options.prepared.plan.artifacts.find((value) => value.id === options.artifactId);
  check(artifact, "Hosted source artifact was not approved");
  assertArtifactProfile(options.service.role, artifact);
  id(options.returnedDeploymentId);
  const { deployment, instanceId, imageDigest } = runningDeployment(options.readback);
  check(
    deployment.id === options.returnedDeploymentId &&
      deployment.projectId === options.service.projectId &&
      deployment.environmentId === options.service.environmentId &&
      deployment.serviceId === options.service.serviceId,
    "Hosted deployment has the wrong returned ID or parent target",
  );
  return {
    ...serviceIdentity(options.service),
    artifactId: artifact.id,
    deploymentId: options.returnedDeploymentId,
    imageDigest,
    instanceId,
  };
}

/** Call immediately before every SSH command; an instance selector alone does not bind its parent. */
export function assertHostedInstanceBinding(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  binding: HostedDeploymentBinding;
  selectedInstanceId: string;
  readback: unknown;
}): void {
  const expected = options.binding;
  assertServiceBinding(options.prepared.plan, expected);
  const artifact = options.prepared.plan.artifacts.find(
    (value) => value.id === expected.artifactId,
  );
  check(artifact, "Hosted instance has an unapproved source artifact");
  assertArtifactProfile(expected.role, artifact);
  id(expected.deploymentId);
  id(expected.instanceId);
  digest(expected.imageDigest);
  const { deployment, instanceId, imageDigest } = runningDeployment(options.readback);
  check(
    deployment.id === expected.deploymentId &&
      deployment.projectId === expected.projectId &&
      deployment.environmentId === expected.environmentId &&
      deployment.serviceId === expected.serviceId &&
      imageDigest === expected.imageDigest &&
      instanceId === expected.instanceId &&
      options.selectedInstanceId === expected.instanceId,
    "Hosted SSH instance/image/parent changed; remote execution is forbidden",
  );
}
