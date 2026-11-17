import { createHash } from "node:crypto";
import { closeSync, fstatSync } from "node:fs";
import { z } from "zod";
import { createPinnedFile, pinDirectory } from "../../src/lib/anchored-files";
import { INTEGRATION_LIMITS, type IntegrationScenarioEvidence } from "./integration-contracts";

const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const gitId = z.string().regex(/^[0-9a-f]{40}$/);
const label = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9 .:_/-]*$/);
const text = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => !/\p{Cc}/u.test(value));
const path = z
  .string()
  .min(1)
  .max(1024)
  .refine((value) => {
    const parts = value.split("/");
    return (
      !value.includes("\\") &&
      !/\p{Cc}/u.test(value) &&
      !value.includes(":") &&
      parts.length <= 64 &&
      parts.every((part) => part !== "" && part !== "." && part !== "..") &&
      !parts.some(
        (part) => part === ".env" || (part.startsWith(".env.") && part !== ".env.example"),
      )
    );
  });
const file = z.strictObject({ path, sha256 });
const files = z
  .array(file)
  .max(10_000)
  .refine((values) => new Set(values.map((value) => value.path)).size === values.length);
const nullableId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]*$/)
  .nullable();
const timestamp = z.string().datetime({ offset: true });
const profile = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("none") }),
  z.strictObject({
    kind: z.literal("http"),
    port: z.number().int().min(1).max(65_535),
    healthPath: z
      .string()
      .max(2048)
      .refine((value) => /^\/(?!\/)/.test(value) && !/[?#\\]/.test(value) && !/\p{Cc}/u.test(value))
      .nullable(),
    consolePath: z.literal("/console").nullable(),
  }),
]);
const outcome = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("passed"), checks: z.array(label).min(1).max(1000) }),
  z.strictObject({ status: z.enum(["failed", "unavailable", "not-run"]), reason: text }),
]);

const schema = z
  .strictObject({
    version: z.literal(1),
    scenarioId: label,
    runId: label,
    stage: z.enum(["local", "container", "hosted"]),
    buildKind: z.enum(["production-reference", "fixture-auth", "standalone-fixture"]),
    source: z.strictObject({
      revision: gitId,
      tree: gitId,
      sourceChangesSHA256: sha256,
      bunVersion: z
        .string()
        .max(64)
        .regex(/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/),
      lockfiles: files,
      packedPackages: files,
      installedFiles: files,
    }),
    profile,
    baselineFiles: files,
    changes: z
      .array(
        z.strictObject({
          path,
          kind: z.enum(["fixture-overlay", "source-edit", "dependency-materialization"]),
          beforeSHA256: sha256.nullable(),
          afterSHA256: sha256,
        }),
      )
      .max(10_000),
    execution: z.strictObject({
      commandLabels: z.array(label).max(1000),
      deadlinesMs: z
        .record(label, z.number().int().min(1).max(INTEGRATION_LIMITS.phaseBuildMs))
        .refine((values) => Object.keys(values).length <= 64),
      firstChunkBeforeTerminal: z.boolean().nullable(),
      effectCount: z.number().int().min(0).max(1_000_000),
      duplicateEffectCount: z.number().int().min(0).max(1_000_000),
      unauthorizedEffectCount: z.number().int().min(0).max(1_000_000),
      startup: z.enum(["ready", "failed", "not-run"]),
      channel: z.enum(["verified", "failed", "unverified"]),
      observations: z.array(text).max(1000),
    }),
    platform: z.strictObject({
      exportSHA256: sha256.nullable(),
      imageDigest: z
        .string()
        .regex(/^sha256:[0-9a-f]{64}$/)
        .nullable(),
      deploymentId: nullableId,
      resources: z.array(z.strictObject({ kind: label, id: nullableId.unwrap() })).max(1000),
    }),
    outcome,
    cleanup: z.strictObject({
      status: z.enum(["complete", "failed", "not-needed"]),
      remainingOwnedIds: z.array(nullableId.unwrap()).max(1000),
    }),
    artifacts: files,
    retainedUntil: timestamp.nullable(),
    independentReviewer: label.nullable(),
  })
  .superRefine((value, context) => {
    const issue = (message: string) => context.addIssue({ code: "custom", message });
    if (value.cleanup.status !== "failed" && value.cleanup.remainingOwnedIds.length)
      issue("Cleanup has remaining resources");
    if (value.cleanup.status === "not-needed" && value.platform.resources.length)
      issue("Owned platform resources require cleanup");
    if (value.stage !== "hosted" && value.platform.deploymentId !== null)
      issue("Only hosted evidence has a deployment ID");
    if (value.outcome.status === "passed") {
      if (value.cleanup.status === "failed") issue("Failed cleanup cannot pass");
      if (value.execution.duplicateEffectCount || value.execution.unauthorizedEffectCount)
        issue("Unexpected effects cannot pass");
      if (
        !value.source.lockfiles.length ||
        !value.source.packedPackages.length ||
        !value.source.installedFiles.length ||
        !value.artifacts.length
      )
        issue("Passed evidence requires installed artifact provenance");
      if (value.stage !== "local" && (!value.platform.exportSHA256 || !value.platform.imageDigest))
        issue("Platform acceptance requires exact export and image identities");
      if (value.stage === "hosted" && !value.platform.deploymentId)
        issue("Hosted acceptance requires a deployment identity");
    }
  });

/** Accept bounded JSON, never live objects with getters or custom serialization. */
export function parseIntegrationEvidence(
  json: string,
  secrets: readonly string[] = [],
): IntegrationScenarioEvidence {
  if (Buffer.byteLength(json) > INTEGRATION_LIMITS.evidenceBytes)
    throw new Error("Integration evidence exceeds its size limit");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new Error("Invalid integration evidence JSON");
  }
  const parsed = schema.safeParse(value);
  // Never expose parser issues: their values could contain confidential input.
  if (!parsed.success) throw new Error("Invalid integration evidence contract");
  const credentialPatterns = [
    /Bearer\s+\S+/i,
    /(?:authorization|set-cookie|cookie)\s*:/i,
    /https?:\/\/[^/\s"@]+@/i,
    /[?&](?:token|secret|password|key|assertion)=/i,
    /x-auggy-auth-assertion\s*[:=]/i,
    /https?:\/\/api\.telegram\.org\/bot[^\s"'<>]+/i,
    /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/,
    /-----BEGIN [^-\r\n]*PRIVATE KEY-----/,
    /\b(?:sk-ant-|sk-proj-|am_)[A-Za-z0-9_-]{8,}/,
  ];
  const remaining: unknown[] = [parsed.data];
  while (remaining.length) {
    const value = remaining.pop();
    if (typeof value === "string") {
      if (secrets.some((secret) => secret && value.includes(secret)))
        throw new Error("Integration evidence contains a configured secret");
      if (credentialPatterns.some((pattern) => pattern.test(value)))
        throw new Error("Integration evidence contains credential-shaped diagnostics");
    } else if (Array.isArray(value)) remaining.push(...value);
    else if (value && typeof value === "object") {
      for (const [key, entry] of Object.entries(value)) remaining.push(key, entry);
    }
  }
  return parsed.data;
}

/** Exclusive private publication; a previous run's record is never overwritten. */
export function writeIntegrationEvidence(
  directory: string,
  filename: string,
  json: string,
  secrets: readonly string[] = [],
): { sha256: string; evidence: IntegrationScenarioEvidence } {
  if (!/^[a-z0-9][a-z0-9-]{0,127}\.json$/.test(filename))
    throw new Error("Invalid integration evidence filename");
  const evidence = parseIntegrationEvidence(json, secrets);
  const bytes = `${JSON.stringify(evidence, null, 2)}\n`;
  if (Buffer.byteLength(bytes) > INTEGRATION_LIMITS.evidenceBytes)
    throw new Error("Formatted evidence exceeds its size limit");
  const pinned = pinDirectory(directory, "Integration evidence directory");
  try {
    if ((fstatSync(pinned.fd).mode & 0o7777) !== 0o700)
      throw new Error("Integration evidence directory must have mode 0700");
    if (!createPinnedFile(pinned.fd, filename, bytes, "Integration evidence"))
      throw new Error("Integration evidence already exists");
  } finally {
    closeSync(pinned.fd);
  }
  return { sha256: createHash("sha256").update(bytes).digest("hex"), evidence };
}
