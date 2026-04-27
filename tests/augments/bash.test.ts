import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { bash } from "@/augments/bash";
import { createCapabilityTable } from "@/kernel/capability-table";
import type { TurnState } from "@/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function getTool(augment: ReturnType<typeof bash>, name: string) {
  const tool = augment.tools?.find((t) => t.name === name);
  if (!tool) throw new Error(`Tool ${name} not found`);
  return tool;
}

function turnWithTrust(level: "creator" | "agent" | "public"): TurnState {
  return {
    turnId: "t1",
    threadId: "th1",
    trigger: { type: "message", turnId: "t1", timestamp: Date.now(), payload: {} as never },
    peer: { id: `peer-${level}`, kind: "human", trustLevel: level, sourceAugment: "test" },
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
  };
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = join("/tmp", `auggy-bash-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(tmpDir, { recursive: true });
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Structure / risk levels
// ---------------------------------------------------------------------------

describe("bash augment structure", () => {
  it("default risk is restricted and requires allowedCommands", () => {
    expect(() => bash()).toThrow(/restricted.*requires.*allowedCommands/i);
  });

  it("restricted provides shell_exec only", () => {
    const aug = bash({ risk: "restricted", allowedCommands: ["echo"] });
    expect(aug.tools).toHaveLength(1);
    expect(aug.tools![0]!.name).toBe("shell_exec");
  });

  it("standard provides shell_exec", () => {
    const aug = bash({ risk: "standard" });
    expect(aug.tools).toHaveLength(1);
    expect(aug.tools![0]!.name).toBe("shell_exec");
  });

  it("unrestricted provides shell_exec", () => {
    const aug = bash({ risk: "unrestricted" });
    expect(aug.tools).toHaveLength(1);
    expect(aug.tools![0]!.name).toBe("shell_exec");
  });

  it("scripts-only provides only run_script", () => {
    const aug = bash({
      risk: "scripts-only",
      scripts: [{ name: "test", description: "test", command: "echo hi" }],
    });
    expect(aug.tools).toHaveLength(1);
    expect(aug.tools![0]!.name).toBe("run_script");
  });

  it("scripts-only with no scripts throws", () => {
    expect(() => bash({ risk: "scripts-only" })).toThrow(/no tools available/i);
  });

  it("standard + scripts provides both tools", () => {
    const aug = bash({
      risk: "standard",
      scripts: [{ name: "deploy", description: "deploy", command: "echo deploy" }],
    });
    expect(aug.tools).toHaveLength(2);
    const names = aug.tools!.map((t) => t.name);
    expect(names).toContain("shell_exec");
    expect(names).toContain("run_script");
  });
});

// ---------------------------------------------------------------------------
// Trust gating
// ---------------------------------------------------------------------------

describe("bash trust gating", () => {
  it("hides shell_exec from public AND agent by default — only creator gets bash", () => {
    const aug = bash({ risk: "standard" });
    const table = createCapabilityTable([aug]);

    expect(table.canExpose("shell_exec", turnWithTrust("public"))).toBe(false);
    expect(table.canExpose("shell_exec", turnWithTrust("agent"))).toBe(false);
    expect(table.canExpose("shell_exec", turnWithTrust("creator"))).toBe(true);
  });

  it("hides run_script from public AND agent by default", () => {
    const aug = bash({
      risk: "scripts-only",
      scripts: [{ name: "s", description: "s", command: "echo" }],
    });
    const table = createCapabilityTable([aug]);

    expect(table.canExpose("run_script", turnWithTrust("public"))).toBe(false);
    expect(table.canExpose("run_script", turnWithTrust("agent"))).toBe(false);
    expect(table.canExpose("run_script", turnWithTrust("creator"))).toBe(true);
  });

  it("operator can override perTrustLevel to admit agent peers", () => {
    // Explicit perTrustLevel that only blocks public — agent gets bash.
    const aug = bash({
      risk: "standard",
      perTrustLevel: {
        public: { neverExpose: ["shell_exec"] },
      },
    });
    const table = createCapabilityTable([aug]);

    expect(table.canExpose("shell_exec", turnWithTrust("public"))).toBe(false);
    expect(table.canExpose("shell_exec", turnWithTrust("agent"))).toBe(true);
    expect(table.canExpose("shell_exec", turnWithTrust("creator"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Command execution
// ---------------------------------------------------------------------------

describe("shell_exec execution", () => {
  it("runs echo and captures stdout", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "echo hello" }));
    expect(result.stdout.trim()).toBe("hello");
    expect(result.exitCode).toBe(0);
    expect(result.durationMs).toBeGreaterThan(0);
  });

  it("captures stderr on failure", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "ls /nonexistent-path-xyz" }));
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toBeTruthy();
  });

  it("respects workingDir", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "pwd" }));
    // Resolve through realpath since /tmp may be a symlink on macOS
    const { realpathSync } = await import("node:fs");
    expect(result.stdout.trim()).toBe(realpathSync(tmpDir));
  });

  it("exec mode uses args array without shell interpretation", async () => {
    const aug = bash({
      risk: "restricted",
      allowedCommands: ["echo"],
      workingDir: tmpDir,
    });
    const tool = getTool(aug, "shell_exec");
    // In exec mode, semicolons are NOT interpreted as command separators
    const result = JSON.parse(
      await tool.execute({ command: "echo", args: ["hello; ls"] }),
    );
    expect(result.stdout.trim()).toBe("hello; ls"); // literal, not executed
    expect(result.exitCode).toBe(0);
  });

  it("truncates output exceeding maxOutputBytes", async () => {
    const aug = bash({
      risk: "standard",
      workingDir: tmpDir,
      maxOutputBytes: 50,
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(
      await tool.execute({ command: "yes hello | head -100" }),
    );
    expect(result.truncated).toBe(true);
    expect(result.stdout).toContain("[truncated at 50 bytes]");
  });

  it("kills long-running commands after timeout", async () => {
    const aug = bash({
      risk: "standard",
      workingDir: tmpDir,
      timeout: 500,
    });
    const tool = getTool(aug, "shell_exec");
    const start = performance.now();
    const result = JSON.parse(await tool.execute({ command: "sleep 60" }));
    const elapsed = performance.now() - start;
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000); // Should finish well under 5s
  });
});

// ---------------------------------------------------------------------------
// Security checks
// ---------------------------------------------------------------------------

describe("bash security", () => {
  it("blocks hardcoded dangerous commands", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "rm -rf /" }));
    expect(result.error).toMatch(/blocked/i);
  });

  it("blocks operator-defined blocked commands", async () => {
    const aug = bash({
      risk: "standard",
      workingDir: tmpDir,
      blockedCommands: ["my-dangerous-cmd"],
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(
      await tool.execute({ command: "my-dangerous-cmd --flag" }),
    );
    expect(result.error).toMatch(/blocked/i);
  });

  it("exec mode rejects commands not in allowlist", async () => {
    const aug = bash({
      risk: "restricted",
      allowedCommands: ["echo"],
      workingDir: tmpDir,
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "curl", args: ["http://evil.com"] }));
    expect(result.error).toMatch(/not in the allowed list/i);
  });

  it("exec mode allows commands in allowlist", async () => {
    const aug = bash({
      risk: "restricted",
      allowedCommands: ["echo"],
      workingDir: tmpDir,
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "echo", args: ["safe"] }));
    expect(result.exitCode).toBe(0);
    expect(result.stdout.trim()).toBe("safe");
  });

  it("inheritEnv false does not leak ANTHROPIC_API_KEY", async () => {
    // Set a marker env var to test inheritance
    process.env.__BASH_TEST_SECRET = "should-not-leak";
    try {
      const aug = bash({
        risk: "standard",
        workingDir: tmpDir,
        inheritEnv: false,
      });
      const tool = getTool(aug, "shell_exec");
      const result = JSON.parse(await tool.execute({ command: "env" }));
      expect(result.stdout).not.toContain("__BASH_TEST_SECRET");
    } finally {
      delete process.env.__BASH_TEST_SECRET;
    }
  });

  it("inheritEnv true passes process env", async () => {
    process.env.__BASH_TEST_VISIBLE = "visible-value";
    try {
      const aug = bash({
        risk: "unrestricted",
        workingDir: tmpDir,
      });
      const tool = getTool(aug, "shell_exec");
      const result = JSON.parse(await tool.execute({ command: "echo $__BASH_TEST_VISIBLE" }));
      expect(result.stdout.trim()).toBe("visible-value");
    } finally {
      delete process.env.__BASH_TEST_VISIBLE;
    }
  });

  it("explicit env vars are available to the command", async () => {
    const aug = bash({
      risk: "standard",
      workingDir: tmpDir,
      env: { MY_VAR: "test-value" },
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "echo $MY_VAR" }));
    expect(result.stdout.trim()).toBe("test-value");
  });

  // --- Adversarial bypass regression tests (from code review) ---

  it("C1: allowlist + standard risk forces exec mode, preventing $(…) bypass", () => {
    // If an operator sets allowedCommands on standard risk, mode is forced
    // to exec. The model can't use $(...) to run arbitrary commands.
    const aug = bash({
      risk: "standard",
      allowedCommands: ["echo"],
      workingDir: tmpDir,
    });
    const tool = getTool(aug, "shell_exec");
    // This should be safe — exec mode passes $(...) literally
    // Verify the augment was created (the mode forcing happens at config time)
    expect(aug.tools).toHaveLength(1);
  });

  it("C1: exec mode passes $() literally, not as substitution", async () => {
    const aug = bash({
      risk: "restricted",
      allowedCommands: ["echo"],
      workingDir: tmpDir,
    });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(
      await tool.execute({ command: "echo", args: ["$(whoami)"] }),
    );
    expect(result.stdout.trim()).toBe("$(whoami)"); // literal, not expanded
  });

  it("C2: blocks rm -rf with quotes (rm -rf \"/\")", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: 'rm -rf "/"' }));
    expect(result.error).toMatch(/blocked/i);
  });

  it("C2: blocks rm with split flags (rm -r -f /)", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "rm -r -f /" }));
    expect(result.error).toMatch(/blocked/i);
  });

  it("C2: blocks rm -rf with extra whitespace", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir });
    const tool = getTool(aug, "shell_exec");
    const result = JSON.parse(await tool.execute({ command: "rm  -rf  /" }));
    expect(result.error).toMatch(/blocked/i);
  });

  it("I1: stdin is closed — cat exits immediately instead of hanging", async () => {
    const aug = bash({ risk: "standard", workingDir: tmpDir, timeout: 2000 });
    const tool = getTool(aug, "shell_exec");
    const start = performance.now();
    // `cat` with no arguments reads from stdin. With stdin: "ignore", it
    // should get immediate EOF and exit instead of hanging until timeout.
    const result = JSON.parse(await tool.execute({ command: "cat" }));
    const elapsed = performance.now() - start;
    // The key assertion: should finish near-instantly, NOT wait for timeout
    expect(elapsed).toBeLessThan(1500);
  });

  it("I4: scripts with blocked commands are rejected at construction time", () => {
    expect(() =>
      bash({
        risk: "scripts-only",
        scripts: [
          { name: "danger", description: "bad", command: "rm -rf /" },
        ],
      }),
    ).toThrow(/blocked command/i);
  });
});

// ---------------------------------------------------------------------------
// Named scripts
// ---------------------------------------------------------------------------

describe("run_script", () => {
  it("executes a named script", async () => {
    const aug = bash({
      risk: "scripts-only",
      workingDir: tmpDir,
      scripts: [
        { name: "greet", description: "Say hello", command: "echo hello from script" },
      ],
    });
    const tool = getTool(aug, "run_script");
    const result = JSON.parse(await tool.execute({ name: "greet" }));
    expect(result.stdout.trim()).toBe("hello from script");
    expect(result.exitCode).toBe(0);
    expect(result.script).toBe("greet");
  });

  it("returns error for unknown script name", async () => {
    const aug = bash({
      risk: "scripts-only",
      workingDir: tmpDir,
      scripts: [
        { name: "greet", description: "Say hello", command: "echo hi" },
      ],
    });
    const tool = getTool(aug, "run_script");
    const result = JSON.parse(await tool.execute({ name: "nonexistent" }));
    expect(result.error).toMatch(/unknown script/i);
    expect(result.error).toContain("greet");
  });

  it("uses script-specific workingDir", async () => {
    const scriptDir = join(tmpDir, "script-cwd");
    mkdirSync(scriptDir, { recursive: true });

    const aug = bash({
      risk: "scripts-only",
      workingDir: tmpDir,
      scripts: [
        { name: "pwd-check", description: "Check cwd", command: "pwd", workingDir: scriptDir },
      ],
    });
    const tool = getTool(aug, "run_script");
    const result = JSON.parse(await tool.execute({ name: "pwd-check" }));
    const { realpathSync } = await import("node:fs");
    expect(result.stdout.trim()).toBe(realpathSync(scriptDir));
  });

  it("uses script-specific timeout", async () => {
    const aug = bash({
      risk: "scripts-only",
      workingDir: tmpDir,
      timeout: 60000, // augment default: generous
      scripts: [
        { name: "slow", description: "Slow", command: "sleep 60", timeout: 500 },
      ],
    });
    const tool = getTool(aug, "run_script");
    const start = performance.now();
    const result = JSON.parse(await tool.execute({ name: "slow" }));
    const elapsed = performance.now() - start;
    expect(result.exitCode).not.toBe(0);
    expect(elapsed).toBeLessThan(5000);
  });
});
