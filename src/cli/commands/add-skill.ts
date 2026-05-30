/**
 * `auggy skill` — manage bundled and user-authored agent skills.
 *
 * `auggy skill add <augment>` repairs/restores a bundled skill by copying
 * `src/augments/<augment>/skill/*` into `<agent-dir>/skills/<augment>/`.
 * The argument is the augment folder name (kebab-case), e.g. `web-fetch`,
 * not the camelCase YAML `type:` field (`webFetch`).
 */

import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { buildFolderToTypeMap, copyBundledSkill } from "../scaffold-skills";

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
 * - With `--agent <name>`: target ./<name>/agent.yaml from CWD.
 * - Without: use CWD; require an `agent.yaml` to be present so we don't
 *   silently create a `skills/` directory in the wrong place.
 */
export function resolveAgentDir(
  agentNameFlag: string | undefined,
  opts: ResolveAgentDirOptions = {},
): string {
  const cwd = opts.cwd ?? process.cwd();
  if (agentNameFlag) {
    const baseDir = opts.auggyDir ? join(opts.auggyDir, "agents") : cwd;
    const agentDir = resolve(baseDir, agentNameFlag);
    if (!existsSync(join(agentDir, "agent.yaml"))) {
      throw new Error(
        `Agent "${agentNameFlag}" not found at ${agentDir}.\n\n` +
          `  Run from inside an agent dir, or pass a project directory name from its parent.`,
      );
    }
    return agentDir;
  }

  const agentYaml = join(cwd, "agent.yaml");
  if (!existsSync(agentYaml)) {
    throw new Error(
      `Not an agent directory: no agent.yaml in ${cwd}.\n\n` +
        `  Run from inside an agent dir, or pass \`--agent <name>\` from its parent.`,
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

function installBundledSkill(augment: string, agentDir: string): void {
  const folderToType = buildFolderToTypeMap();
  const type = folderToType.get(augment);
  if (!type) {
    const valid = [...folderToType.keys()].sort().join(", ");
    throw new Error(`Unknown augment "${augment}".\n\n  Valid augment folder names: ${valid}`);
  }

  if (!bundledSkillExists(augment)) {
    throw new Error(`"${augment}" augment ships no bundled skill. Nothing to add.`);
  }

  const copied = copyBundledSkill(type, agentDir);
  if (!copied) {
    throw new Error(`failed to copy bundled skill for "${augment}" (source not found).`);
  }
}

export function skillCommand(deps: AddSkillCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const command = new Command("skill").description("Manage agent skills");

  command
    .command("add <augment>")
    .description("Install or restore a bundled skill for an installed augment")
    .option("--agent <name>", "agent project directory name (defaults to current directory)")
    .action(async (augment: string, opts: { agent?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        installBundledSkill(augment, agentDir);
        console.log(
          `Installed bundled skill for "${augment}" -> ${join(agentDir, "skills", augment)}/`,
        );
        exit(0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("create <name>")
    .description("Create a user-authored skill in skills/<name>/SKILL.md")
    .option("--agent <name>", "agent project directory name (defaults to current directory)")
    .action(async (name: string, opts: { agent?: string }) => {
      try {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) {
          throw new Error("Skill name must be kebab-case (letters, numbers, hyphens).");
        }
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        const dir = join(agentDir, "skills", name);
        const path = join(dir, "SKILL.md");
        if (existsSync(path)) throw new Error(`Skill already exists: ${path}`);
        mkdirSync(dir, { recursive: true });
        writeFileSync(
          path,
          [
            "---",
            `name: ${name}`,
            "description: Describe when the agent should use this skill.",
            "---",
            "",
            `# ${name}`,
            "",
            "Write instructions, examples, and operating guidance for the agent here.",
            "",
          ].join("\n"),
        );
        console.log(`Created skill "${name}" -> ${path}`);
        exit(0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("list")
    .description("List skills installed in the current agent")
    .option("--agent <name>", "agent project directory name (defaults to current directory)")
    .action(async (opts: { agent?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        const skillsDir = join(agentDir, "skills");
        const names = existsSync(skillsDir)
          ? readdirSync(skillsDir, { withFileTypes: true })
              .filter((entry) => entry.isDirectory())
              .map((entry) => entry.name)
              .sort()
          : [];
        if (names.length === 0) {
          console.log("No skills installed.");
        } else {
          for (const name of names) console.log(name);
        }
        exit(0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  command
    .command("remove <name>")
    .description("Remove a skill folder from the current agent")
    .option("--agent <name>", "agent project directory name (defaults to current directory)")
    .action(async (name: string, opts: { agent?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        const dir = join(agentDir, "skills", name);
        if (!existsSync(dir)) throw new Error(`Skill not found: ${name}`);
        rmSync(dir, { recursive: true, force: true });
        console.log(`Removed skill "${name}".`);
        exit(0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}
