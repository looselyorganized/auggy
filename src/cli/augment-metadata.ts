import { lstatSync } from "node:fs";
import { join, resolve, relative } from "node:path";
import {
  AUTHORING_LIMITS,
  type AuthoringDocument,
  type DocumentEdit,
  type FileSnapshot,
  type GeneratedApplicationFile,
  type MutationKind,
  type PlannedFile,
  type PublicationOptions,
  type PublicationResult,
} from "./authoring/contracts";
import { readFileSnapshot } from "./authoring/document-io";
import { editAuthoringDocument } from "./authoring/document";
import { createMutationPlan, validateRelativePath } from "./authoring/mutation";
import { publishMutationPlan } from "./authoring/publication";
/** CLI-private composition helpers shared by augment authoring commands. */
export { assertInlineAuthoring, readAuthoringDocument } from "./authoring/document";

export function rootSkillsEdit(document: AuthoringDocument): DocumentEdit[] {
  const mounts = document.declarations.filter((entry) => entry.type === "skills");
  if (mounts.length === 0)
    return [
      {
        kind: "append-augment",
        entry: { name: "skills", type: "skills", options: { dir: "./skills" } },
      },
    ];
  const options = mounts[0]!.options;
  const dir =
    options && typeof options === "object" && !Array.isArray(options)
      ? (options as Record<string, unknown>).dir
      : undefined;
  const effectiveDir = dir ?? "./skills";
  if (
    mounts.length !== 1 ||
    typeof effectiveDir !== "string" ||
    effectiveDir.includes("${") ||
    resolve(document.projectDir, effectiveDir) !== join(document.projectDir, "skills")
  ) {
    throw new Error(
      "This operation adds root skills. Review the existing skills declarations and configure exactly one mount with options.dir: ./skills before retrying; existing mounts were preserved.",
    );
  }
  return [];
}

export function planAugmentAssets(
  document: AuthoringDocument,
  assets: readonly GeneratedApplicationFile[],
  preserveExisting = false,
): { files: PlannedFile[]; inputs: FileSnapshot[]; retained: string[] } {
  const files: PlannedFile[] = [];
  const inputs: FileSnapshot[] = [];
  const retained: string[] = [];
  for (const asset of assets) {
    validateRelativePath(asset.relativePath);
    let parent = document.projectDir;
    for (const segment of asset.relativePath.split("/").slice(0, -1)) {
      parent = join(parent, segment);
      try {
        const stat = lstatSync(parent);
        if (!stat.isDirectory() || stat.isSymbolicLink())
          throw new Error(
            "Augment assets require real project directories; review symlinks and conflicting paths before retrying.",
          );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const before = readFileSnapshot(
      join(document.projectDir, asset.relativePath),
      AUTHORING_LIMITS.outputBytes,
      { allowMissing: true },
    );
    inputs.push(before);
    if (before.exists) {
      if (!preserveExisting)
        throw new Error(
          `Destination already exists: ${asset.relativePath}. Choose another name or review the existing files manually; --force does not overwrite them.`,
        );
      retained.push(asset.relativePath);
      continue;
    }
    files.push({ ...asset, before, role: "support" });
  }
  return { files, inputs, retained };
}

export function planAugmentMutation(
  document: AuthoringDocument,
  kind: MutationKind,
  edits: readonly DocumentEdit[],
  support: readonly PlannedFile[] = [],
  inputs: readonly FileSnapshot[] = [],
) {
  const activation = editAuthoringDocument(document, edits);
  const files = [...support, activation];
  return createMutationPlan({
    kind,
    projectDir: document.projectDir,
    configRelativePath: relative(document.projectDir, document.configPath),
    inputs: [...document.inputs, ...inputs, ...support.map((file) => file.before)],
    files,
    summary: files.map((file) => ({
      path: file.relativePath,
      operation: file.before.exists ? "replace" : "create",
      reason:
        file.role === "activation"
          ? "Update central augment declarations"
          : "Add requested augment assets",
    })),
  });
}

export function requireCompletePublication(result: PublicationResult): void {
  if (result.status !== "complete")
    throw new Error(
      `Augment publication ${result.status}; operation ${result.operationId}. Configuration is ${result.activation}. Review the private receipt and use guarded rollback before retrying.`,
    );
}

export function publishAugmentMutation(
  document: AuthoringDocument,
  kind: MutationKind,
  edits: readonly DocumentEdit[],
  support: readonly PlannedFile[] = [],
  inputs: readonly FileSnapshot[] = [],
  options?: PublicationOptions,
): void {
  requireCompletePublication(
    publishMutationPlan(planAugmentMutation(document, kind, edits, support, inputs), options),
  );
}
