/** A reviewable hosted gate, not a deployment command and never implicit authorization. */
import { applicationHash } from "./application-consumer";
import { isIP } from "node:net";
import type { IntegrationBuildKind } from "./integration-contracts";

export interface HostedIntegrationPlan {
  version: 1;
  runId: string;
  railway: {
    projectId: string;
    environmentId: string;
    /** Explicit new-service names or exact authorized existing IDs; no ambient linked target. */
    services: readonly {
      profile: "http" | "none";
      name: string;
      existingServiceId: string | null;
      imageDigest: string;
      exportSHA256: string;
      buildKind: IntegrationBuildKind;
    }[];
  };
  limits: {
    maxServices: number;
    maxVolumes: number;
    maxVolumeGiB: number;
    maxMemoryMiBPerService: number;
    maxCpuPerService: number;
    maxSpendUSD: number;
    maxRunSeconds: number;
  };
  fixtures: {
    owner: string;
    /** Only approved private fixture origins, with no bearer/token path or query. */
    origins: readonly string[];
    connectivity: "railway-private-network" | "approved-private-tunnel";
    syntheticIdentitySetSHA256: string;
    allowedEffectContractSHA256: string;
  };
  retention: {
    cleanupOwner: string;
    retainedUntil: string;
    privateArtifactLocation: string;
    retainResources: boolean;
  };
  source: { revision: string; tree: string; sourceChangesSHA256: string };
}

export interface HostedIntegrationApproval {
  /** Root records the actual explicit user approval; availability of credentials is insufficient. */
  approvedPlanSHA256: string;
  recordedApprovalId: string;
  approvedAt: string;
  expiresAt: string;
}

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function id(value: string): void {
  check(
    typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/.test(value),
    "Invalid hosted resource identifier",
  );
}

function hash(value: string): void {
  check(
    typeof value === "string" && /^[a-f0-9]{64}$/.test(value),
    "Hosted plan requires exact SHA256 identity",
  );
}

function boundedPositive(value: number, maximum: number, integer = true): void {
  check(
    Number.isFinite(value) &&
      value > 0 &&
      value <= maximum &&
      (!integer || Number.isSafeInteger(value)),
    "Hosted resource limit is invalid or unbounded",
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

/** Complete allowlisted reconstruction prevents unknown credential fields entering a review record. */
export function prepareHostedIntegration(input: HostedIntegrationPlan) {
  check(input.version === 1, "Unsupported hosted plan version");
  id(input.runId);
  id(input.railway.projectId);
  id(input.railway.environmentId);
  check(
    input.railway.services.length === 2 &&
      new Set(input.railway.services.map((service) => service.profile)).size === 2 &&
      input.railway.services.every(
        (service) => service.profile === "http" || service.profile === "none",
      ),
    "Hosted proof requires explicit HTTP and worker services",
  );
  const services = input.railway.services.map((service) => {
    id(service.name);
    if (service.existingServiceId !== null) id(service.existingServiceId);
    check(
      /^sha256:[a-f0-9]{64}$/.test(service.imageDigest),
      "Hosted service lacks an exact image identity",
    );
    hash(service.exportSHA256);
    check(
      ["production-reference", "fixture-auth", "standalone-fixture"].includes(service.buildKind),
      "Invalid hosted build kind",
    );
    return {
      profile: service.profile,
      name: service.name,
      existingServiceId: service.existingServiceId,
      imageDigest: service.imageDigest,
      exportSHA256: service.exportSHA256,
      buildKind: service.buildKind,
    };
  });
  check(
    new Set(services.map((service) => service.name)).size === services.length,
    "Hosted service names must be distinct",
  );
  const existing = services.flatMap((service) =>
    service.existingServiceId === null ? [] : [service.existingServiceId],
  );
  check(new Set(existing).size === existing.length, "Hosted service IDs must be distinct");
  boundedPositive(input.limits.maxServices, 4);
  boundedPositive(input.limits.maxVolumes, 4);
  boundedPositive(input.limits.maxVolumeGiB, 100);
  boundedPositive(input.limits.maxMemoryMiBPerService, 16_384);
  boundedPositive(input.limits.maxCpuPerService, 16, false);
  boundedPositive(input.limits.maxSpendUSD, 10_000, false);
  boundedPositive(input.limits.maxRunSeconds, 86_400);
  check(
    input.limits.maxServices >= services.length && input.limits.maxVolumes >= services.length,
    "Hosted resource limits cannot fit the selected scenarios",
  );
  const limits = {
    maxServices: input.limits.maxServices,
    maxVolumes: input.limits.maxVolumes,
    maxVolumeGiB: input.limits.maxVolumeGiB,
    maxMemoryMiBPerService: input.limits.maxMemoryMiBPerService,
    maxCpuPerService: input.limits.maxCpuPerService,
    maxSpendUSD: input.limits.maxSpendUSD,
    maxRunSeconds: input.limits.maxRunSeconds,
  };
  id(input.fixtures.owner);
  check(
    ["railway-private-network", "approved-private-tunnel"].includes(input.fixtures.connectivity),
    "Hosted fixture connectivity is not approved private routing",
  );
  check(
    input.fixtures.origins.length > 0 &&
      input.fixtures.origins.length <= 8 &&
      new Set(input.fixtures.origins).size === input.fixtures.origins.length,
    "Hosted fixture origins must be explicit and bounded",
  );
  const origins = input.fixtures.origins.map((origin) => {
    const url = new URL(origin);
    check(
      ["http:", "https:"].includes(url.protocol) &&
        !url.username &&
        !url.password &&
        url.pathname === "/" &&
        !url.search &&
        !url.hash &&
        url.origin === origin,
      "Hosted fixture origin must not contain credentials or paths",
    );
    const octets = url.hostname.split(".").map(Number);
    const privateIPv4 =
      isIP(url.hostname) === 4 &&
      (octets[0] === 127 ||
        octets[0] === 10 ||
        (octets[0] === 192 && octets[1] === 168) ||
        (octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31));
    const privateHost =
      /(?:^|\.)railway\.internal$/.test(url.hostname) || privateIPv4 || url.hostname === "[::1]";
    check(privateHost, "Hosted fixture origin must be explicitly private");
    return origin;
  });
  hash(input.fixtures.syntheticIdentitySetSHA256);
  hash(input.fixtures.allowedEffectContractSHA256);
  const fixtures = {
    owner: input.fixtures.owner,
    origins,
    connectivity: input.fixtures.connectivity,
    syntheticIdentitySetSHA256: input.fixtures.syntheticIdentitySetSHA256,
    allowedEffectContractSHA256: input.fixtures.allowedEffectContractSHA256,
  };
  id(input.retention.cleanupOwner);
  instant(input.retention.retainedUntil);
  check(
    typeof input.retention.retainResources === "boolean",
    "Hosted resource retention must be explicit",
  );
  check(
    typeof input.retention.privateArtifactLocation === "string" &&
      /^[A-Za-z0-9][A-Za-z0-9/_.:-]{0,511}$/.test(input.retention.privateArtifactLocation) &&
      !input.retention.privateArtifactLocation.includes(".."),
    "Private artifact location must be a credential-free identifier",
  );
  const retention = {
    cleanupOwner: input.retention.cleanupOwner,
    retainedUntil: input.retention.retainedUntil,
    privateArtifactLocation: input.retention.privateArtifactLocation,
    retainResources: input.retention.retainResources,
  };
  check(
    /^[a-f0-9]{40}$/.test(input.source.revision) && /^[a-f0-9]{40}$/.test(input.source.tree),
    "Hosted source revision/tree must be exact",
  );
  hash(input.source.sourceChangesSHA256);
  const source = {
    revision: input.source.revision,
    tree: input.source.tree,
    sourceChangesSHA256: input.source.sourceChangesSHA256,
  };
  const plan: HostedIntegrationPlan = {
    version: 1,
    runId: input.runId,
    railway: {
      projectId: input.railway.projectId,
      environmentId: input.railway.environmentId,
      services,
    },
    limits,
    fixtures,
    retention,
    source,
  };
  const serialized = JSON.stringify(plan);
  check(Buffer.byteLength(serialized) <= 64 * 1024, "Hosted review plan exceeded bound");
  return {
    plan,
    sha256: applicationHash(serialized),
    status: "not-run" as const,
    reason:
      "Concrete approval and accepted local/container evidence are required before hosted actions",
  };
}

/** A binding check only; it cannot manufacture approval or certify local/container behavior. */
export function assertHostedIntegrationApproval(options: {
  prepared: ReturnType<typeof prepareHostedIntegration>;
  approval: HostedIntegrationApproval;
  acceptedLocalEvidenceSHA256: string;
  acceptedContainerEvidenceSHA256: string;
  now?: number;
}): void {
  const prepared = prepareHostedIntegration(options.prepared.plan);
  check(
    prepared.sha256 === options.prepared.sha256 &&
      prepared.sha256 === options.approval.approvedPlanSHA256,
    "Hosted approval does not match the concrete deployment plan",
  );
  id(options.approval.recordedApprovalId);
  hash(options.acceptedLocalEvidenceSHA256);
  hash(options.acceptedContainerEvidenceSHA256);
  const now = options.now ?? Date.now();
  const approvedAt = instant(options.approval.approvedAt);
  const expiresAt = instant(options.approval.expiresAt);
  const retainedUntil = instant(prepared.plan.retention.retainedUntil);
  check(
    Number.isFinite(now) &&
      approvedAt <= now &&
      now < expiresAt &&
      expiresAt - approvedAt <= 86_400_000,
    "Hosted approval is expired, future-dated or unbounded",
  );
  check(
    now + prepared.plan.limits.maxRunSeconds * 1000 <= expiresAt &&
      retainedUntil >= expiresAt &&
      retainedUntil - approvedAt <= 30 * 86_400_000,
    "Hosted run/retention exceeds its approved time envelope",
  );
}
