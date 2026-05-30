/**
 * Boot-time skill validator.
 *
 * Per ADR-025 Decision 5 + PR α foundation spec §H. After augments are
 * resolved at agent boot, scan: for each augment that contributes tools
 * to the model but lacks a corresponding `<agent-dir>/skills/<augment-
 * folder>/SKILL.md`, emit a one-line warning. Operators see the gap at
 * startup, not in production-failure mode where the model guesses.
 *
 * Discriminator (model-perspective): an augment contributes tools if EITHER
 *  (a) `augment.tools.length > 0` — tools declared on the factory return,
 *  (b) `augment.memory?.owns?.kind === "namespace"` — namespace memory
 *      provider; the kernel-synthesized memory-bus exposes 5 generic
 *      tools (memory_read / memory_write / memory_search / memory_list /
 *      memory_forget — see src/memory/tools.ts) keyed off its prefix.
 *
 * The model can't tell where the tools came from; from its perspective
 * both routes produce model-callable tools that need teaching. The strict
 * spec wording ("non-empty tools[]") would have missed (b), and (b) is
 * the most common real case — layered-memory is the default-scaffold
 * memory augment.
 *
 * Tool-less augments (fileMemory + supabaseMemory static providers,
 * transports, budgets) intentionally do NOT trigger the warning — they
 * contribute only `context()` blocks or admission gates, no model-
 * callable tools.
 *
 * Warning, not error. The agent still boots successfully. An opt-out
 * flag is deferred per spec §Decision 7.
 */

/**
 * Number of tools the kernel memory-bus synthesizes for a namespace
 * memory provider. Source: src/memory/tools.ts (memory_read / memory_write
 * / memory_search / memory_list / memory_forget). If that surface changes,
 * update this constant — tests asserting the count will catch drift.
 */
const NAMESPACE_MEMORY_TOOL_COUNT = 5;

import { statSync } from "node:fs";
import { join } from "node:path";
import type { Augment } from "../types";
import type { AugmentConfig } from "./types";
import { augmentFolderForType } from "./scaffold-skills";

/**
 * Filesystem probe outcome for the skill SKILL.md file.
 *
 * - "present": file exists and is readable as a regular file.
 * - "missing": parent dir is reachable; SKILL.md is absent (ENOENT). The
 *   normal "operator hasn't installed this skill" case.
 * - "unreadable": stat surfaced a non-ENOENT error (e.g. EACCES). The
 *   skill MAY be present on disk but the runtime cannot confirm; surfaced
 *   as a different warning class so an operator with a misconfigured
 *   permissions setup doesn't get fooled into thinking the skill is there.
 */
type SkillProbe =
  | { kind: "present" }
  | { kind: "missing" }
  | { kind: "unreadable"; reason: string };

function probeSkillFile(skillPath: string): SkillProbe {
  try {
    const stats = statSync(skillPath);
    if (stats.isFile()) return { kind: "present" };
    // SKILL.md exists but is a directory or other non-file — surface as
    // unreadable rather than silently treating as present. Rare misconfig.
    return { kind: "unreadable", reason: `path is not a regular file` };
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { kind: "missing" };
    return {
      kind: "unreadable",
      reason: `${code ?? "unknown"}: ${(err as Error).message}`,
    };
  }
}

/**
 * Scan resolved augments paired with their source configs and warn for
 * any tool-providing augment whose skill is missing or unreadable. Walks
 * configs and augments in lockstep — `resolveAugments` preserves order
 * and never drops entries, so index alignment is exact.
 *
 * Hook point: called from `resolveAugments` after all augment factories
 * have run, so the agent's tool surface is finalized before the warning
 * decision is made.
 */
export function validateBundledSkills(
  configs: AugmentConfig[],
  augments: Augment[],
  agentDir: string,
): void {
  // Defensive: if the caller passed mismatched arrays, skip validation
  // entirely rather than emit confusing warnings against the wrong
  // augment. resolveAugments today always produces matched pairs.
  if (configs.length !== augments.length) return;

  for (let i = 0; i < augments.length; i++) {
    const aug = augments[i]!;
    const cfg = configs[i]!;

    const factoryToolCount = aug.tools?.length ?? 0;
    const isNamespaceMemory = aug.memory?.owns?.kind === "namespace";
    const toolCount = factoryToolCount + (isNamespaceMemory ? NAMESPACE_MEMORY_TOOL_COUNT : 0);
    if (toolCount === 0) continue;

    // Custom augments (operator-authored) do not have a bundled skill folder
    // by convention; the operator owns their own teaching. Don't warn —
    // the `auggy skill add` command is built-in-only too.
    if (cfg.type === "custom") continue;

    const folder = augmentFolderForType(cfg.type);
    if (!folder) {
      // Unknown built-in type. resolveAugments would have thrown earlier;
      // this branch only fires if the type-to-folder map drifts from
      // the resolver's switch. Emit a diagnostic so the drift is visible.
      console.warn(
        `[augment-resolver] augment "${aug.name}" (type "${cfg.type}") exposes ${toolCount} ` +
          `tool${toolCount === 1 ? "" : "s"} but has no folder mapping in scaffold-skills. ` +
          `Skill validation skipped — file an issue if this augment ships skill content.`,
      );
      continue;
    }

    const skillPath = join(agentDir, "skills", folder, "SKILL.md");
    const probe = probeSkillFile(skillPath);
    if (probe.kind === "present") continue;

    if (probe.kind === "missing") {
      console.warn(
        `[augment-resolver] augment "${folder}" exposes ${toolCount} tool${
          toolCount === 1 ? "" : "s"
        } with no skill mounted at\n` +
          `  ${skillPath}. Model will guess at tool usage.\n` +
          `  Run \`auggy skill add ${folder}\` to install the bundled teaching, OR copy\n` +
          `  src/augments/${folder}/skill/* into the agent's skills/${folder}/ directory.`,
      );
      continue;
    }

    // probe.kind === "unreadable"
    console.warn(
      `[augment-resolver] augment "${folder}" exposes ${toolCount} tool${
        toolCount === 1 ? "" : "s"
      } and a skill file at\n` +
        `  ${skillPath} is unreadable (${probe.reason}).\n` +
        `  Skill teaching cannot be confirmed; check filesystem permissions.`,
    );
  }
}
