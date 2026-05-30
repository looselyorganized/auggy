/**
 * Tests for `auggy add-skill <augment>`. Companion to the boot-time skill
 * validator (PR α task 7) — installs `src/augments/<augment>/skill/*` into
 * `<agent-dir>/skills/<augment>/`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { seedAgentForTest } from "../../../src/cli/agent-index";
import {
  addSkillCommand,
  resolveAgentDir,
  skillCommand,
} from "../../../src/cli/commands/add-skill";

const BUNDLED_WEB_FETCH_SKILL = resolve(
  import.meta.dir,
  "../../../src/augments/web-fetch/skill/SKILL.md",
);

let auggyDir: string;
let agentParent: string;

beforeEach(() => {
  auggyDir = mkdtempSync(join(tmpdir(), "auggy-add-skill-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "auggy-add-skill-test-agents-"));
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

/** Helper: scaffold a minimal agent dir under auggyDir/agents/<name>/. */
function makeAgentDir(name: string): string {
  const dir = seedAgentForTest(name, { auggyDir });
  mkdirSync(join(dir, "skills"), { recursive: true });
  return dir;
}

/** Helper: minimal CWD-only agent dir for tests that exercise CWD detection. */
function makeCwdAgentDir(name: string): string {
  const dir = join(agentParent, name);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "skills"), { recursive: true });
  writeFileSync(join(dir, "agent.yaml"), `id: aug1_${name}\nname: ${name}\n`);
  return dir;
}

describe("auggy add-skill — command shape", () => {
  test("registers as 'add-skill' subcommand with description", () => {
    const cmd = addSkillCommand();
    expect(cmd.name()).toBe("add-skill");
    expect(cmd.description()).toContain("Repair");
    expect(cmd.description()).toContain("bundled");
  });

  test("declares <augment> required argument", () => {
    const cmd = addSkillCommand();
    expect(cmd.helpInformation()).toContain("<augment>");
  });

  test("declares --agent option", () => {
    const cmd = addSkillCommand();
    const longs = cmd.options.map((o) => o.long);
    expect(longs).toContain("--agent");
  });

  test("frames add-skill as repair/update in help text", () => {
    const help = addSkillCommand().helpInformation();
    expect(help).toMatch(/repair/i);
    expect(help).toMatch(/reinstall/i);
  });
});

describe("auggy skill — command shape", () => {
  test("registers skill namespace with add/create/list/remove", () => {
    const cmd = skillCommand();
    expect(cmd.name()).toBe("skill");
    expect(cmd.commands.map((sub) => sub.name())).toEqual(["add", "create", "list", "remove"]);
  });
});

describe("resolveAgentDir", () => {
  test("returns CWD when no --agent flag is supplied and CWD has agent.yaml", () => {
    const dir = makeAgentDir("local");
    expect(resolveAgentDir(undefined, { auggyDir, cwd: dir })).toBe(dir);
  });

  test("throws when CWD has no agent.yaml and no --agent is supplied", () => {
    const empty = mkdtempSync(join(tmpdir(), "auggy-add-skill-empty-"));
    try {
      expect(() => resolveAgentDir(undefined, { auggyDir, cwd: empty })).toThrow(
        /not an agent directory/i,
      );
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  test("looks up project directory via --agent flag", () => {
    const dir = makeAgentDir("zip");
    expect(resolveAgentDir("zip", { auggyDir })).toBe(dir);
  });

  test("throws clear error for unknown --agent name", () => {
    expect(() => resolveAgentDir("ghost", { auggyDir })).toThrow(/not found/i);
  });

  test("treats agent dir without agent.yaml as not found", () => {
    mkdirSync(join(auggyDir, "agents", "ghost"), { recursive: true });
    expect(() => resolveAgentDir("ghost", { auggyDir })).toThrow(/not found/i);
  });
});

describe("auggy add-skill — happy path (CWD-based)", () => {
  test("copies bundled skill into agent dir for an augment that ships one", async () => {
    const dir = makeAgentDir("zip");

    const exit = mock((_code: number) => {});
    const cmd = addSkillCommand({ exit, auggyDir, cwd: dir });
    await cmd.parseAsync(["web-fetch"], { from: "user" });

    expect(exit).toHaveBeenCalledWith(0);
    const installed = join(dir, "skills", "web-fetch", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf-8")).toBe(readFileSync(BUNDLED_WEB_FETCH_SKILL, "utf-8"));
  });
});

describe("auggy skill — user-authored skills", () => {
  test("skill create writes skills/<name>/SKILL.md", async () => {
    const dir = makeAgentDir("zip");
    const exit = mock((_code: number) => {});

    await skillCommand({ exit, auggyDir, cwd: dir }).parseAsync(["create", "sales-playbook"], {
      from: "user",
    });

    expect(exit).toHaveBeenCalledWith(0);
    const skill = join(dir, "skills", "sales-playbook", "SKILL.md");
    expect(readFileSync(skill, "utf-8")).toContain("name: sales-playbook");
  });

  test("skill add installs a bundled augment skill", async () => {
    const dir = makeAgentDir("zip");
    const exit = mock((_code: number) => {});

    await skillCommand({ exit, auggyDir, cwd: dir }).parseAsync(["add", "web-fetch"], {
      from: "user",
    });

    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(join(dir, "skills", "web-fetch", "SKILL.md"))).toBe(true);
  });

  test("skill list prints installed skill folders", async () => {
    const dir = makeAgentDir("zip");
    mkdirSync(join(dir, "skills", "sales-playbook"), { recursive: true });
    writeFileSync(join(dir, "skills", "sales-playbook", "SKILL.md"), "# Sales\n");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      await skillCommand({ exit: mock(() => {}), auggyDir, cwd: dir }).parseAsync(["list"], {
        from: "user",
      });
    } finally {
      console.log = origLog;
    }

    expect(logs).toContain("sales-playbook");
  });

  test("skill remove deletes a skill folder", async () => {
    const dir = makeAgentDir("zip");
    mkdirSync(join(dir, "skills", "sales-playbook"), { recursive: true });
    writeFileSync(join(dir, "skills", "sales-playbook", "SKILL.md"), "# Sales\n");
    const exit = mock((_code: number) => {});

    await skillCommand({ exit, auggyDir, cwd: dir }).parseAsync(["remove", "sales-playbook"], {
      from: "user",
    });

    expect(exit).toHaveBeenCalledWith(0);
    expect(existsSync(join(dir, "skills", "sales-playbook"))).toBe(false);
  });
});

describe("auggy add-skill — idempotent re-run", () => {
  test("re-running succeeds and the file still matches the bundled source", async () => {
    const dir = makeAgentDir("zip");

    const exit1 = mock((_code: number) => {});
    await addSkillCommand({ exit: exit1, auggyDir, cwd: dir }).parseAsync(["web-fetch"], {
      from: "user",
    });
    expect(exit1).toHaveBeenCalledWith(0);

    const exit2 = mock((_code: number) => {});
    await addSkillCommand({ exit: exit2, auggyDir, cwd: dir }).parseAsync(["web-fetch"], {
      from: "user",
    });
    expect(exit2).toHaveBeenCalledWith(0);

    const installed = join(dir, "skills", "web-fetch", "SKILL.md");
    expect(readFileSync(installed, "utf-8")).toBe(readFileSync(BUNDLED_WEB_FETCH_SKILL, "utf-8"));
  });
});

describe("auggy add-skill — invalid input", () => {
  test("unknown augment name exits 1 with a helpful list of valid options", async () => {
    const dir = makeAgentDir("zip");

    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = addSkillCommand({ exit, auggyDir, cwd: dir });
      await cmd.parseAsync(["nonexistent-augment"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(exit).toHaveBeenCalledWith(1);
    const errOut = errors.join("\n");
    expect(errOut).toMatch(/unknown augment "nonexistent-augment"/i);
    // Helpful list must include at least the obvious tool-providing augments.
    expect(errOut).toContain("web-fetch");
    expect(errOut).toContain("layered-memory");
    expect(errOut).toContain("filesystem");

    // Nothing got written to disk.
    expect(existsSync(join(dir, "skills", "nonexistent-augment"))).toBe(false);
  });

  test("not-an-agent-dir exits 1 with a clear message", async () => {
    const empty = mkdtempSync(join(tmpdir(), "auggy-add-skill-not-agent-"));
    try {
      const exit = mock((_code: number) => {});
      const errors: string[] = [];
      const origErr = console.error;
      console.error = (msg: unknown) => {
        errors.push(String(msg));
      };

      try {
        const cmd = addSkillCommand({ exit, auggyDir, cwd: empty });
        await cmd.parseAsync(["web-fetch"], { from: "user" });
      } finally {
        console.error = origErr;
      }

      expect(exit).toHaveBeenCalledWith(1);
      expect(errors.join("\n")).toMatch(/not an agent directory|agent\.yaml/i);
      expect(existsSync(join(empty, "skills"))).toBe(false);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe("auggy add-skill — --agent flag", () => {
  test("targets a project directory regardless of CWD", async () => {
    const dir = makeAgentDir("target");

    // Run from a sibling cwd that has no agent.yaml — --agent must take over.
    const sibling = mkdtempSync(join(tmpdir(), "auggy-add-skill-sibling-"));
    try {
      const exit = mock((_code: number) => {});
      const cmd = addSkillCommand({ exit, auggyDir, cwd: sibling });
      await cmd.parseAsync(["web-fetch", "--agent", "target"], { from: "user" });

      expect(exit).toHaveBeenCalledWith(0);
      expect(existsSync(join(dir, "skills", "web-fetch", "SKILL.md"))).toBe(true);
    } finally {
      rmSync(sibling, { recursive: true, force: true });
    }
  });
});

describe("auggy add-skill — augment without a bundled skill", () => {
  test("file-memory has no skill folder; command exits 1 with a clear message", async () => {
    const dir = makeAgentDir("zip");

    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = addSkillCommand({ exit, auggyDir, cwd: dir });
      await cmd.parseAsync(["file-memory"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toMatch(/file-memory.*ships no bundled skill/i);
    expect(existsSync(join(dir, "skills", "file-memory"))).toBe(false);
  });
});

describe("auggy add-skill — content overwrite on re-run", () => {
  test("operator-modified skill is replaced with the bundled source", async () => {
    const dir = makeAgentDir("zip");

    // First copy.
    const exit1 = mock((_code: number) => {});
    await addSkillCommand({ exit: exit1, auggyDir, cwd: dir }).parseAsync(["web-fetch"], {
      from: "user",
    });
    expect(exit1).toHaveBeenCalledWith(0);

    // Operator edits the installed copy.
    const installed = join(dir, "skills", "web-fetch", "SKILL.md");
    const stale = "STALE-MARKER-LINE\n# old content\n";
    writeFileSync(installed, stale);
    expect(readFileSync(installed, "utf-8")).toBe(stale);

    // Re-run must overwrite.
    const exit2 = mock((_code: number) => {});
    await addSkillCommand({ exit: exit2, auggyDir, cwd: dir }).parseAsync(["web-fetch"], {
      from: "user",
    });
    expect(exit2).toHaveBeenCalledWith(0);

    const fresh = readFileSync(installed, "utf-8");
    expect(fresh).not.toContain("STALE-MARKER-LINE");
    expect(fresh).toBe(readFileSync(BUNDLED_WEB_FETCH_SKILL, "utf-8"));
  });
});
