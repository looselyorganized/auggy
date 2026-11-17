import { closeSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { openPinnedChildDirectory, pinDirectory, readPinnedFile } from "../../lib/anchored-files";
import {
  DEPLOYMENT_FILES,
  DEPLOYMENT_LIMITS,
  DEPLOYMENT_TOOLCHAIN,
  type DeploymentManifestExpectation,
  type DeploymentManifestV1,
  type DeploymentProfile,
} from "./contracts";
import { validateDeploymentProfile } from "./profile";

function safePath(value: string): boolean {
  const parts = value.split("/");
  return (
    Buffer.byteLength(value) <= DEPLOYMENT_LIMITS.pathBytes &&
    parts.length <= DEPLOYMENT_LIMITS.directoryDepth &&
    !isAbsolute(value) &&
    !value.includes("\\") &&
    !/\p{Cc}/u.test(value) &&
    parts.every((part) => part !== "" && part !== "." && part !== "..")
  );
}

const sha256 = z.string().regex(/^[a-f0-9]{64}$/);
const file = z.strictObject({
  path: z.string().refine(safePath),
  sha256,
  bytes: z.number().int().min(0).max(DEPLOYMENT_LIMITS.regularFileBytes),
  mode: z.number().int().min(0).max(0o777),
});
const files = z
  .array(file)
  .max(DEPLOYMENT_LIMITS.visitedEntries)
  .refine((entries) =>
    entries.every((entry, index) => index === 0 || entries[index - 1]!.path < entry.path),
  );
const manifestSchema = z
  .strictObject({
    version: z.literal(1),
    agentId: z
      .string()
      .regex(/^aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/),
    agentName: z
      .string()
      .regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]*$/)
      .max(256),
    configPath: z.string().refine(safePath),
    profile: z.custom<DeploymentProfile>((value) => {
      try {
        validateDeploymentProfile(value);
        return true;
      } catch {
        return false;
      }
    }),
    selection: z.enum(["auto", "none", "http"]),
    evidence: z.enum(["known-config", "operator-declared"]),
    toolchain: z.strictObject({
      bunVersion: z.literal(DEPLOYMENT_TOOLCHAIN.bunVersion),
      image: z.literal(DEPLOYMENT_TOOLCHAIN.image),
      imageDigest: z.literal(DEPLOYMENT_TOOLCHAIN.imageDigest),
    }),
    packageJsonSHA256: sha256,
    lockfileSHA256: sha256,
    sourceFiles: files,
    dependencyTarballs: files,
    generatedFiles: files,
  })
  .superRefine((value, context) => {
    const invalid = () =>
      context.addIssue({ code: "custom", message: "Invalid deployment artifact relationship" });
    const all = [...value.sourceFiles, ...value.dependencyTarballs, ...value.generatedFiles];
    if (
      all.length > DEPLOYMENT_LIMITS.visitedEntries ||
      new Set(all.map((entry) => entry.path)).size !== all.length
    )
      invalid();
    if (all.some((entry) => entry.path === DEPLOYMENT_FILES.manifest)) invalid();
    const sources = new Map(value.sourceFiles.map((entry) => [entry.path, entry]));
    if (
      sources.get(DEPLOYMENT_FILES.packageManifest)?.sha256 !== value.packageJsonSHA256 ||
      sources.get(DEPLOYMENT_FILES.lockfile)?.sha256 !== value.lockfileSHA256 ||
      !sources.has(value.configPath)
    )
      invalid();
    if (value.dependencyTarballs.some((entry) => !entry.path.endsWith(".tgz"))) invalid();
    if (
      value.generatedFiles.length !== 2 ||
      value.generatedFiles[0]?.path !== DEPLOYMENT_FILES.dockerfile ||
      value.generatedFiles[1]?.path !== DEPLOYMENT_FILES.entrypoint
    )
      invalid();
    if (
      (value.selection === "none" && value.profile.kind !== "none") ||
      (value.selection === "http" && value.profile.kind !== "http") ||
      (value.selection === "auto" && value.evidence !== "known-config")
    )
      invalid();
  });

/** Validate metadata; source hashes are evidence fields, not execution authority. */
export function validateDeploymentManifest(
  value: unknown,
  expected: DeploymentManifestExpectation,
): DeploymentManifestV1 {
  const parsed = manifestSchema.safeParse(value);
  if (!parsed.success) throw new Error("[deployment] invalid or unsupported deployment manifest");
  if (
    parsed.data.agentId !== expected.agentId ||
    parsed.data.agentName !== expected.agentName ||
    parsed.data.configPath !== expected.configPath
  ) {
    throw new Error(
      "[deployment] manifest identity or selected config does not match this application",
    );
  }
  return parsed.data;
}

/** Read one bounded ordinary metadata file without following any project-relative symlink. */
export function readDeploymentManifest(
  path: string,
  projectDir: string,
  expected: DeploymentManifestExpectation,
): DeploymentManifestV1 {
  if (
    !path ||
    path.includes("\0") ||
    path.split(/[\\/]/).some((part) => part === "." || part === "..")
  )
    throw new Error("[deployment] manifest path must name a contained ordinary file");
  const root = resolve(projectDir);
  const selected = resolve(root, path);
  const fromRoot = relative(root, selected).split(sep).join("/");
  if (!safePath(fromRoot))
    throw new Error("[deployment] manifest must stay inside the agent project");
  const segments = fromRoot.split("/");
  const leaf = segments.pop()!;
  let current = pinDirectory(root, "[deployment] project").fd;
  try {
    for (const segment of segments) {
      const next = openPinnedChildDirectory(
        current,
        segment,
        "[deployment] manifest parent",
        false,
        false,
      );
      closeSync(current);
      current = next;
    }
    const bytes = readPinnedFile(
      current,
      leaf,
      "[deployment] manifest",
      DEPLOYMENT_LIMITS.deploymentManifestBytes,
    );
    let value: unknown;
    try {
      value = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw new Error("[deployment] manifest is not valid JSON");
    }
    return validateDeploymentManifest(value, expected);
  } finally {
    closeSync(current);
  }
}
