/**
 * auggy add-skill <augment> — install a bundled augment skill into an agent.
 *
 * Companion command to the boot-time skill validator (PR α task 7) and the
 * scaffold-time auto-copy in `auggy create` / `auggy add`. When an operator
 * has an augment configured but no `skills/<augment>/SKILL.md` mounted (the
 * augment was added before bundled-skill copying existed, an upgrade brought
 * a new skill the operator wants, or the operator manually deleted the
 * folder), this command copies `src/augments/<augment>/skill/*` into the
 * agent directory at `<agent-dir>/skills/<augment>/`.
 *
 * The argument is the augment FOLDER NAME (kebab-case) — what the boot-time
 * validator emits in its remediation hint and what shows up under
 * `<agent-dir>/skills/`. Example: `auggy add-skill web-fetch`, NOT
 * `auggy add-skill webFetch` (the camelCase YAML `type:` field).
 *
 * Per ADR-025 Decision 5 + spec Decision 7. Idempotent — re-running
 * overwrites existing skill files (operator opt-in to updates).
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { copyBundledSkill, augmentFolderForType } from "../scaffold-skills";
import { getAgent } from "../agent-index";

/**
 * Inverse of `TYPE_TO_AUGMENT_FOLDER` exported via `augmentFolderForType`:
 * we need the camelCase `type:` for `copyBundledSkill`, but the operator
 * passes the folder name. The set of folder names is the canonical list of
 * valid `<augment>` arguments. Built lazily so the data lives in one place
 * (scaffold-skills.ts) and we don't drift.
 */
const KNOWN_TYPES = [
  "filesystem",
  "layeredMemory",
  "webFetch",
  "orgContext",
  "bash",
  "notify",
  "turnControl",
  "fileMemory",
  "supabaseMemory",
  "budgets",
  "webTransport",
  "telegramTransport",
] as const;

function buildFolderToTypeMap(): Map<string, string> {
  const map = new Map<string, string>();
  for (const type of KNOWN_TYPES) {
    const folder = augmentFolderForType(type);
    if (folder) map.set(folder, type);
  }
  return map;
}

/**
 * Resolve the on-disk path to the bundled skill SKILL.md for a folder, used
 * to verify the augment ships a skill at all before attempting to copy.
 */
function bundledSkillExists(folder: string): boolean {
  const dir = resolve(import.meta.dir, "../../augments", folder, "skill", "SKILL.md");
  return existsSync(dir);
}

interface ResolveAgentDirOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Override CWD for tests. Defaults to process.cwd(). */
  cwd?: string;
}

/**
 * Resolve the agent directory from the optional --agent flag or CWD.
 *
 * - With `--agent <name>`: look up the registered agent in the index.
 * - Without: use CWD; require an `agent.yaml` to be present so we don't
 *   silently create a `skills/` directory in the wrong place.
 */
export function resolveAgentDir(
  agentNameFlag: string | undefined,
  opts: ResolveAgentDirOptions = {},
): string {
  if (agentNameFlag) {
    const entry = getAgent(agentNameFlag, { auggyDir: opts.auggyDir });
    if (!entry) {
      throw new Error(
        `Agent "${agentNameFlag}" is not registered.\n\n` +
          `  Run \`auggy ls\` to see registered agents.`,
      );
    }
    const cfg = join(entry.localDir, "agent.yaml");
    if (!existsSync(cfg)) {
      throw new Error(
        `agent.yaml missing at indexed path: ${cfg}\n\n` +
          `  The agent directory may have been deleted or moved manually.\n` +
          `  Run \`auggy remove ${agentNameFlag}\` to clean up the index entry.`,
      );
    }
    return entry.localDir;
  }

  const cwd = opts.cwd ?? process.cwd();
  const agentYaml = join(cwd, "agent.yaml");
  if (!existsSync(agentYaml)) {
    throw new Error(
      `Not an agent directory: no agent.yaml in ${cwd}.\n\n` +
        `  Run from inside an agent dir, or pass \`--agent <name>\` to target a registered agent.`,
    );
  }
  return cwd;
}

interface AddSkillCommandDeps {
  /** Override exit so tests can assert the exit code without crashing the runner. */
  exit?: (code: number) => void;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Override CWD for tests. */
  cwd?: string;
}

export function addSkillCommand(deps: AddSkillCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("add-skill")
    .description("Install a bundled augment skill into an existing agent")
    .argument("<augment>", "augment folder name (kebab-case), e.g. web-fetch, layered-memory, bash")
    .option("--agent <name>", "registered agent name (defaults to current directory)")
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  cd my-agent && auggy add-skill web-fetch",
        "  auggy add-skill layered-memory --agent zip",
      ].join("\n"),
    )
    .action(async (augment: string, opts: { agent?: string }) => {
      // 1. Resolve agent dir.
      let agentDir: string;
      try {
        agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
        return;
      }

      // 2. Validate the augment folder name.
      const folderToType = buildFolderToTypeMap();
      const type = folderToType.get(augment);
      if (!type) {
        const valid = [...folderToType.keys()].sort().join(", ");
        console.error(
          `Error: Unknown augment "${augment}".\n\n` + `  Valid augment folder names: ${valid}`,
        );
        exit(1);
        return;
      }

      // 3. Verify the augment ships a bundled skill.
      if (!bundledSkillExists(augment)) {
        console.error(`Error: "${augment}" augment ships no bundled skill. Nothing to add-skill.`);
        exit(1);
        return;
      }

      // 4. Copy via the shared helper. Idempotent (overwrites existing files).
      let copied: boolean;
      try {
        copied = copyBundledSkill(type, agentDir);
      } catch (err) {
        console.error(`Error: failed to copy skill files: ${(err as Error).message}`);
        exit(2);
        return;
      }

      if (!copied) {
        // Defensive — the bundledSkillExists check above should make this
        // unreachable, but if copyBundledSkill returns false for any reason
        // (e.g. mid-call filesystem disappearance) surface it as an error.
        console.error(`Error: failed to copy bundled skill for "${augment}" (source not found).`);
        exit(2);
        return;
      }

      console.log(
        `Installed bundled skill for "${augment}" -> ${join(agentDir, "skills", augment)}/`,
      );
      exit(0);
    });
}
