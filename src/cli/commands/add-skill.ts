/**
 * `auggy skill` — manage bundled and user-authored agent skills.
 *
 * `auggy skill add <skill>` repairs/restores a bundled augment skill or a
 * canonical starter skill such as `auggy` in `<agent-dir>/skills/<skill>/`.
 */

import { existsSync, lstatSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import {
  buildFolderToTypeMap,
  bundledSkillFiles,
  starterSkillFiles,
  listStarterSkillNames,
} from "../scaffold-skills";
import { displayPath } from "../display-path";
import type { GeneratedApplicationFile, PlannedFile } from "../authoring/contracts";
import { containedSnapshot } from "../authoring/publication-common";
import { createMutationPlan } from "../authoring/mutation";
import { acquireProjectMutationLease, publishMutationPlan } from "../authoring/publication";

function bundledSkillExists(type: string): boolean {
  const dir = resolve(import.meta.dir, "../../augments", type, "skill", "SKILL.md");
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

function installBundledSkill(skill: string, agentDir: string): void {
  if (listStarterSkillNames().includes(skill)) {
    const files = starterSkillFiles().filter((file) =>
      file.relativePath.startsWith(`skills/${skill}/`),
    );
    if (files.length === 0) {
      throw new Error(
        `failed to copy Auggy-provided starter skill for "${skill}" (source not found).`,
      );
    }
    publishSkillFiles(agentDir, files, true);
    return;
  }

  const folderToType = buildFolderToTypeMap();
  const type = folderToType.get(skill);
  if (!type) {
    const valid = [...new Set([...listStarterSkillNames(), ...folderToType.keys()])]
      .sort()
      .join(", ");
    throw new Error(`Unknown skill "${skill}".\n\n  Valid built-in skills: ${valid}`);
  }

  if (!bundledSkillExists(type)) {
    throw new Error(`"${skill}" augment ships no Auggy-provided skill. Nothing to add.`);
  }

  const files = bundledSkillFiles(type);
  if (files.length === 0) {
    throw new Error(`failed to copy Auggy-provided skill for "${skill}" (source not found).`);
  }
  publishSkillFiles(agentDir, files, true);
}

/** Explicit repair may replace bundled assets; ordinary augment authoring preserves them. */
function publishSkillFiles(
  agentDir: string,
  assets: readonly GeneratedApplicationFile[],
  replace: boolean,
): void {
  const projectDir = realpathSync(agentDir);
  const config = containedSnapshot(projectDir, "agent.yaml");
  if (!config.exists) throw new Error("Agent configuration is missing.");
  const files: PlannedFile[] = assets.map((asset) => {
    const before = containedSnapshot(projectDir, asset.relativePath);
    if (before.exists && !replace)
      throw new Error(`Skill already exists: ${displayPath(before.path)}`);
    return {
      ...asset,
      before,
      mode: before.exists ? before.identity.mode & 0o777 : asset.mode,
      role: "support",
    };
  });
  files.push({
    relativePath: "agent.yaml",
    before: config,
    bytes: config.bytes,
    mode: config.identity.mode & 0o777,
    role: "activation",
  });
  const plan = createMutationPlan({
    kind: "augment-install",
    projectDir,
    configRelativePath: "agent.yaml",
    inputs: files.map((file) => file.before),
    files,
    summary: files.map((file) => ({
      path: file.relativePath,
      operation: file.before.exists ? "replace" : "create",
      reason:
        file.role === "activation"
          ? "Keep the selected configuration unchanged."
          : "Install explicitly requested skill content.",
    })),
  });
  const result = publishMutationPlan(plan);
  if (result.status !== "complete")
    throw new Error(
      `Skill publication ${result.status}; run guarded recovery from the agent directory: auggy migrate --rollback ${result.operationId} --apply.`,
    );
}

export function skillCommand(deps: AddSkillCommandDeps = {}): Command {
  const exit = deps.exit ?? ((code: number) => process.exit(code));
  const command = new Command("skill").description("Manage agent skills");

  command
    .command("add <skill>")
    .description("Install or refresh an Auggy-provided starter or augment skill")
    .option("--agent <name>", "agent project directory name (defaults to current directory)")
    .action(async (skill: string, opts: { agent?: string }) => {
      try {
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        installBundledSkill(skill, agentDir);
        console.log(
          `Installed Auggy-provided skill for "${skill}" -> ${displayPath(
            join(agentDir, "skills", skill),
            deps.cwd,
          )}/`,
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
        const path = join(agentDir, "skills", name, "SKILL.md");
        publishSkillFiles(
          agentDir,
          [
            {
              relativePath: `skills/${name}/SKILL.md`,
              mode: 0o644,
              bytes: Buffer.from(
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
              ),
            },
          ],
          false,
        );
        console.log(`Created skill "${name}" -> ${displayPath(path, deps.cwd)}`);
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
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(name))
          throw new Error("Skill name must be a single safe folder name.");
        const agentDir = resolveAgentDir(opts.agent, { auggyDir: deps.auggyDir, cwd: deps.cwd });
        const dir = join(agentDir, "skills", name);
        const lease = acquireProjectMutationLease(agentDir);
        try {
          if (!existsSync(dir)) throw new Error(`Skill not found: ${name}`);
          for (const path of [join(agentDir, "skills"), dir]) {
            const stat = lstatSync(path);
            if (!stat.isDirectory() || stat.isSymbolicLink())
              throw new Error("Skill removal requires ordinary project directories.");
          }
          rmSync(dir, { recursive: true, force: true });
        } finally {
          lease.release();
        }
        console.log(`Removed skill "${name}".`);
        exit(0);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}
