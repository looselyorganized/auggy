import {
  LEGACY_HTTP_PROFILE,
  type NormalizedCloudDeployment,
  type PersistedCloudRecord,
} from "./contracts";
import { validateDeploymentProfile } from "./profile";

const idPattern = /^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function invalid(): never {
  throw new Error(
    "Cloud deployment metadata is legacy, malformed, or belongs to another immutable agent. Verify the Railway target before replacing it.",
  );
}

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !/\p{Cc}/u.test(value)
  );
}

function origin(value: unknown): string {
  if (
    typeof value !== "string" ||
    value !== value.trim() ||
    value.length > 2048 ||
    /[\p{Cc}\s\\]/u.test(value) ||
    !/^https?:\/\/[^/?#]+\/?$/i.test(value)
  )
    invalid();
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return invalid();
  }
  if (
    (parsed.protocol !== "https:" && parsed.protocol !== "http:") ||
    parsed.username ||
    parsed.password ||
    parsed.search ||
    parsed.hash ||
    parsed.pathname !== "/" ||
    value.includes("?") ||
    value.includes("#")
  )
    invalid();
  return parsed.origin;
}

/** Unknown disk data cannot authorize a cloud operation until identity and topology agree. */
export function validateCloudRecord(value: unknown, expectedAgentId: string): PersistedCloudRecord {
  if (
    !idPattern.test(expectedAgentId) ||
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  )
    invalid();
  const record = value as Record<string, unknown>;
  const common = [
    "version",
    "agentId",
    "provider",
    "projectId",
    "serviceId",
    "volumeId",
    "deployedAt",
    "url",
  ];
  const fields = record.version === 2 ? [...common, "profile"] : common;
  if (
    (record.version !== 1 && record.version !== 2) ||
    Object.keys(record).length !== fields.length ||
    Object.keys(record).some((key) => !fields.includes(key)) ||
    record.agentId !== expectedAgentId ||
    record.provider !== "railway" ||
    ![record.projectId, record.serviceId, record.volumeId].every(validIdentifier) ||
    typeof record.deployedAt !== "string" ||
    record.deployedAt.length > 128 ||
    !Number.isFinite(Date.parse(record.deployedAt))
  )
    invalid();
  if (record.version === 1) origin(record.url);
  else {
    try {
      validateDeploymentProfile(record.profile);
    } catch {
      invalid();
    }
    if (record.profile.kind === "none") {
      if (record.url !== null) invalid();
    } else origin(record.url);
  }
  return record as unknown as PersistedCloudRecord;
}

/** Produce a read view without migrating or rewriting a legacy record. */
export function normalizeCloudRecord(record: PersistedCloudRecord): NormalizedCloudDeployment {
  const validated = validateCloudRecord(record, record.agentId);
  const { version, ...target } = validated;
  if (validated.version === 1) {
    return {
      ...target,
      recordVersion: version,
      profile: LEGACY_HTTP_PROFILE,
      url: origin(validated.url),
    };
  }
  return validated.profile.kind === "none"
    ? { ...target, recordVersion: version, profile: validated.profile, url: null }
    : { ...target, recordVersion: version, profile: validated.profile, url: origin(validated.url) };
}
