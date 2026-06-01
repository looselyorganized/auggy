import { resolve } from "node:path";
import type { Augment } from "../types";

export interface AugmentValidationResult {
  name: string;
  toolCount: number;
}

export async function validateCustomAugment(sourcePath: string): Promise<AugmentValidationResult> {
  const modulePath = resolve(sourcePath);
  const mod = await import(`${modulePath}?t=${Date.now()}`);
  const factory = mod.default;
  if (typeof factory !== "function") {
    throw new Error(`${modulePath} must export a default augment factory function.`);
  }

  const augment = factory({}) as Augment;
  validateAugmentShape(augment, modulePath);
  return { name: augment.name, toolCount: augment.tools?.length ?? 0 };
}

export function validateAugmentShape(
  augment: unknown,
  label = "custom augment",
): asserts augment is Augment {
  if (!augment || typeof augment !== "object" || Array.isArray(augment)) {
    throw new Error(`${label}: factory must return an augment object.`);
  }
  const candidate = augment as Augment;
  if (typeof candidate.name !== "string" || candidate.name.length === 0) {
    throw new Error(`${label}: augment.name must be a non-empty string.`);
  }

  const seenTools = new Set<string>();
  for (const tool of candidate.tools ?? []) {
    if (typeof tool.name !== "string" || tool.name.length === 0) {
      throw new Error(`${label}: every tool must have a non-empty name.`);
    }
    if (seenTools.has(tool.name)) {
      throw new Error(`${label}: duplicate tool name "${tool.name}".`);
    }
    seenTools.add(tool.name);

    if (typeof tool.description !== "string" || tool.description.length === 0) {
      throw new Error(`${label}: tool "${tool.name}" must have a description.`);
    }
    if (!tool.inputJsonSchema || typeof tool.inputJsonSchema !== "object") {
      throw new Error(`${label}: tool "${tool.name}" must expose an inputJsonSchema.`);
    }
    if (typeof tool.execute !== "function") {
      throw new Error(`${label}: tool "${tool.name}" must expose an execute function.`);
    }
  }
}
