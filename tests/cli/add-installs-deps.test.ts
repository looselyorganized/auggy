import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parse as parseYaml } from "yaml";
import { mockInquirerPrompts, type Answers } from "../fixtures/inquirer-mock";
import { createStubBunInstallSpawn, type SpawnCapture } from "../fixtures/bun-install-stub";

/**
 * Verifies `runAdd` (Phase 4 contract):
 *  - mutates the agent's `package.json` to include `packageDeps` from the
 *    catalog entry of every newly-selected augment
 *  - invokes `bun install` in the agent dir (mocked)
 *  - is a no-op on install when nothing new came in
 *  - bails clearly when the agent project has no package.json
 */

let answers: Answers = { augmentTypes: [] };
mockInquirerPrompts(() => answers);

const { runAdd } = await import("../../src/cli/commands/add");

let auggyDir: string;
let agentParent: string;
let bunInstallCalls: SpawnCapture[];

function setupAgent(name: string, augments: Array<{ type: string; name: string }> = []): string {
  const dir = join(agentParent, name);
  mkdirSync(dir, { recursive: true });

  const yaml =
    `# Agent configuration\n` +
    `id: aug1_test\nname: ${name}\n` +
    `engine:\n  provider: anthropic\n  model: claude-sonnet-4-6\n` +
    `augments:\n` +
    augments.map((a) => `  - name: ${a.name}\n    type: ${a.type}\n`).join("");
  writeFileSync(join(dir, "agent.yaml"), yaml);
  writeFileSync(
    join(dir, ".env"),
    "AUGGY_WEB_TOKEN=tok-test\nAUGGY_AGENT_ID=existing-agent\nAUGGY_PUBLIC_URL=http://localhost:18080\n",
  );

  const pkg = {
    name: `auggy-agent-${name}`,
    private: true,
    type: "module",
    dependencies: { auggy: "^0.3.1", "@auggy/anthropic": "^0.3.1" },
  };
  writeFileSync(join(dir, "package.json"), JSON.stringify(pkg, null, 2));

  return dir;
}

function readAgentAugments(dir: string): string[] {
  const parsed = parseYaml(readFileSync(join(dir, "agent.yaml"), "utf-8")) as {
    augments: string[];
  };
  return parsed.augments;
}

function readAugmentMetadata(dir: string, id: string): Record<string, unknown> {
  return parseYaml(readFileSync(join(dir, "augments", id, "augment.yaml"), "utf-8")) as Record<
    string,
    unknown
  >;
}

beforeEach(async () => {
  auggyDir = mkdtempSync(join(tmpdir(), "add-test-auggy-"));
  agentParent = mkdtempSync(join(tmpdir(), "add-test-agents-"));
  bunInstallCalls = [];
  answers = { augmentTypes: [] };
});

afterEach(() => {
  rmSync(auggyDir, { recursive: true, force: true });
  rmSync(agentParent, { recursive: true, force: true });
});

describe("runAdd mutates per-agent package.json", () => {
  test("adding `link` merges @auggy/link into dependencies", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    // Pre-existing deps untouched.
    expect(pkg.dependencies.auggy).toBe("^0.3.1");
    expect(pkg.dependencies["@auggy/anthropic"]).toBe("^0.3.1");
    const metadata = readAugmentMetadata(dir, "link");
    expect(metadata.type).toBe("link");
    expect(JSON.stringify(metadata.config)).toContain("./data/link.db");
    expect(metadata.kind).toBeUndefined();
  });

  test("invokes bun install in agent dir when packageDeps are added", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);
  });

  test("--skip-install mutates package.json but does NOT invoke install", async () => {
    const dir = setupAgent("with-link");
    answers = { augmentTypes: ["link"] };

    await runAdd("with-link", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      skipInstall: true,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    expect(pkg.dependencies["@auggy/link"]).toBe("^0.1.2");
    expect(bunInstallCalls).toHaveLength(0);
  });
});

describe("runAdd no-op cases", () => {
  test("non-interactive augment argument mutates yaml without invoking picker", async () => {
    const dir = setupAgent("with-fetch");

    await runAdd("with-fetch", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "webFetch",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("webFetch");
    expect(readAugmentMetadata(dir, "webFetch").type).toBe("webFetch");
    expect(existsSync(join(dir, "skills", "webFetch", "SKILL.md"))).toBe(true);
  });

  test("project-local single arg is treated as augment when cwd has agent.yaml", async () => {
    const dir = setupAgent("local-add");

    await runAdd("webFetch", {
      cwd: dir,
      auggyDir,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("webFetch");
    expect(readAugmentMetadata(dir, "webFetch").type).toBe("webFetch");
    expect(existsSync(join(dir, "skills", "webFetch", "SKILL.md"))).toBe(true);
  });

  test("adding knowledge scaffolds knowledge sources and skill", async () => {
    const dir = setupAgent("with-knowledge");
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runAdd("with-knowledge", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "knowledge",
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(readAgentAugments(dir)).toContain("knowledge");
    expect(readAugmentMetadata(dir, "knowledge")).toMatchObject({
      type: "knowledge",
      config: { root: "./knowledge" },
    });
    expect(existsSync(join(dir, "knowledge", "sources.json"))).toBe(true);
    expect(existsSync(join(dir, "knowledge", "local", "manifest"))).toBe(true);
    expect(existsSync(join(dir, "knowledge", "local", "mission.md"))).toBe(true);
    expect(existsSync(join(dir, "knowledge", "local", "context.md"))).toBe(true);
    expect(existsSync(join(dir, "skills", "knowledge", "SKILL.md"))).toBe(true);
    const mission = readFileSync(join(dir, "knowledge", "local", "mission.md"), "utf-8");
    const context = readFileSync(join(dir, "knowledge", "local", "context.md"), "utf-8");
    expect(mission).toContain("_Add information about this agent's mission here._");
    expect(mission).toContain("_Add project or organization information");
    expect(mission).not.toContain("This agent helps with a helpful assistant");
    expect(context).toContain("## Team Members");
    expect(context).toContain("_Add relevant team members");
    expect(context).not.toContain("the operator: primary operator");
    const output = logs.join("\n");
    expect(output).toContain("skill: ");
    expect(output).toContain("skills/knowledge/SKILL.md");
    expect(output).toContain("Add knowledge:");
    expect(output).toContain("Edit, rename, or delete the starter markdown files");
    expect(output).toContain("Add more markdown files under knowledge/local/");
    expect(output).toContain("Add API-backed sources in knowledge/sources.json");
  });

  test("adding knowledge uses configured metadata in the source manifest", async () => {
    const dir = setupAgent("with-operator");
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    writeFileSync(
      join(dir, "agent.yaml"),
      yaml.replace("engine:\n", "purpose: Help visitors.\noperators:\n  - Mike\nengine:\n"),
    );

    await runAdd("with-operator", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "knowledge",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const manifest = JSON.parse(
      readFileSync(join(dir, "knowledge", "local", "manifest"), "utf-8"),
    ) as Record<string, unknown>;
    expect(manifest.org).toBe("with-operator");
    expect(manifest.operator).toBe("Mike");
    expect(manifest.purpose).toBe("Help visitors.");
  });

  test("adding mcp mounts the augment and creates .mcp.json", async () => {
    const dir = setupAgent("with-mcp");

    await runAdd("with-mcp", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "mcp",
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("mcp");
    expect(readAugmentMetadata(dir, "mcp").type).toBe("mcp");
    expect(existsSync(join(dir, ".mcp.json"))).toBe(true);
    expect(JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf-8"))).toEqual({
      mcpServers: {},
    });
    expect(existsSync(join(dir, "skills", "mcp", "SKILL.md"))).toBe(true);
  });

  test("project-local no args opens the picker for the cwd agent", async () => {
    const dir = setupAgent("local-picker");
    answers = { augmentTypes: ["bash"] };

    await runAdd(undefined, {
      cwd: dir,
      auggyDir,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("bash");
  });

  test("non-interactive canonical augment argument works for layeredMemory", async () => {
    const dir = setupAgent("with-memory");

    await runAdd("with-memory", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "layeredMemory",
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("layeredMemory");
    expect(readAugmentMetadata(dir, "layeredMemory")).toMatchObject({
      type: "layeredMemory",
      config: expect.objectContaining({ namespace: "with-memory" }),
    });
  });

  test("preview augment add declines without --yes when operator does not confirm", async () => {
    const dir = setupAgent("preview-decline");
    const before = readFileSync(join(dir, "agent.yaml"), "utf-8");

    await runAdd("preview-decline", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "layeredMemory",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readFileSync(join(dir, "agent.yaml"), "utf-8")).toBe(before);
    expect(existsSync(join(dir, "skills", "layeredMemory", "SKILL.md"))).toBe(false);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("stable augment add does not require preview confirmation", async () => {
    const dir = setupAgent("stable-add");
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runAdd("stable-add", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "notify",
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(readAgentAugments(dir)).toContain("notify");
    expect(readAugmentMetadata(dir, "notify").type).toBe("notify");
    expect(existsSync(join(dir, "skills", "notify", "SKILL.md"))).toBe(true);
    const output = logs.join("\n");
    expect(output).toContain("Use notify:");
    expect(output).toContain("skill: ");
    expect(output).toContain("skills/notify/SKILL.md");
    expect(output).toContain("Default destination: creator -> ./notifications.jsonl");
    expect(output).toContain("For real delivery, edit augments/notify/augment.yaml");
    expect(output).toContain("Telegram alerts need a notify destination with botToken + chatId");
  });

  test("adding telegramTransport explains required Telegram setup", async () => {
    const dir = setupAgent("with-telegram");
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runAdd("with-telegram", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "telegramTransport",
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(readAgentAugments(dir)).toContain("telegramTransport");
    const telegramMeta = JSON.stringify(readAugmentMetadata(dir, "telegramTransport"));
    expect(telegramMeta).toContain("${TELEGRAM_BOT_TOKEN}");
    expect(telegramMeta).toContain("polling");
    expect(telegramMeta).toContain("creatorUserIds");
    expect(telegramMeta).toContain("TELEGRAM_CREATOR_USER_IDS");

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toContain("TELEGRAM_BOT_TOKEN=");
    expect(env).toContain("TELEGRAM_CREATOR_USER_IDS=");
    expect(existsSync(join(dir, "skills", "telegramTransport", "SKILL.md"))).toBe(false);

    const output = logs.join("\n");
    expect(output).toContain("Use Telegram:");
    expect(output).toContain("Set TELEGRAM_BOT_TOKEN in .env");
    expect(output).toContain("Set TELEGRAM_CREATOR_USER_IDS in .env");
    expect(output).toContain("Default inbound mode: polling");
    expect(output).toContain("@userinfobot");
    expect(output).toContain("This enables Telegram chat with the agent");
    expect(output).toContain(
      "Proactive Telegram alerts are configured in augments/notify/augment.yaml",
    );
    expect(output).toContain("augments/telegramTransport/augment.yaml");
    expect(output).toContain("Add these to your .env:");
    expect(output).toContain("TELEGRAM_BOT_TOKEN=");
    expect(output).toContain("TELEGRAM_CREATOR_USER_IDS=");
  });

  test("adding agentMail explains email setup", async () => {
    const dir = setupAgent("with-agent-mail");
    const originalLog = console.log;
    const logs: string[] = [];
    console.log = (...args: unknown[]) => {
      logs.push(args.map(String).join(" "));
    };

    try {
      await runAdd("with-agent-mail", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "agentMail",
        yes: true,
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });
    } finally {
      console.log = originalLog;
    }

    expect(readAgentAugments(dir)).toContain("agentMail");
    expect(existsSync(join(dir, "skills", "agentMail", "SKILL.md"))).toBe(true);

    const output = logs.join("\n");
    expect(output).toContain("Use AgentMail:");
    expect(output).toContain("Set AGENTMAIL_API_KEY and AGENTMAIL_INBOX_ID in .env");
    expect(output).toContain("Configure mail policy in augments/agentMail/augment.yaml");
    expect(output).toContain("Default mode: outbound email only, creator trust required");
    expect(output).toContain("notify + Agent Mail is usually simpler");
    expect(output).toContain("AGENTMAIL_API_KEY=");
    expect(output).toContain("AGENTMAIL_INBOX_ID=");
  });

  test("adding visitorAuth generates VISITOR_SIGNING_KEY in .env", async () => {
    const dir = setupAgent("with-auth");

    await runAdd("with-auth", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "visitorAuth",
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readAgentAugments(dir)).toContain("visitorAuth");
    expect(JSON.stringify(readAugmentMetadata(dir, "visitorAuth"))).toContain(
      "${VISITOR_SIGNING_KEY}",
    );

    const env = readFileSync(join(dir, ".env"), "utf-8");
    const signingKey = env.match(/^VISITOR_SIGNING_KEY=([a-f0-9]{64})$/m)?.[1];
    expect(signingKey).toBeTruthy();
    expect(env).toContain("AUGGY_AGENT_ID=existing-agent");
    expect(env).toContain("AUGGY_PUBLIC_URL=http://localhost:18080");
    expect(existsSync(join(dir, "skills", "visitorAuth", "SKILL.md"))).toBe(true);
  });

  test("adding visitorAuth fills blank generated env vars", async () => {
    const dir = setupAgent("with-auth-blank");
    writeFileSync(join(dir, ".env"), "AUGGY_AGENT_ID=\nAUGGY_PUBLIC_URL=\nVISITOR_SIGNING_KEY=\n");

    await runAdd("with-auth-blank", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "visitorAuth",
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    const env = readFileSync(join(dir, ".env"), "utf-8");
    expect(env).toContain("AUGGY_AGENT_ID=with-auth-blank");
    expect(env).toContain("AUGGY_PUBLIC_URL=http://localhost:8080");
    expect(env).toMatch(/^VISITOR_SIGNING_KEY=[a-f0-9]{64}$/m);
  });

  test("non-interactive unknown augment throws with valid choices", async () => {
    const dir = setupAgent("bad-augment");

    await expect(
      runAdd("bad-augment", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        augment: "not-real",
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      }),
    ).rejects.toThrow(/Unknown augment "not-real".*webFetch/s);
  });

  test("non-interactive already-installed augment makes no changes", async () => {
    const dir = setupAgent("already-fetch", [{ name: "fetch", type: "webFetch" }]);
    const before = readFileSync(join(dir, "agent.yaml"), "utf-8");

    await runAdd("already-fetch", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      augment: "webFetch",
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(readFileSync(join(dir, "agent.yaml"), "utf-8")).toBe(before);
    expect(bunInstallCalls).toHaveLength(0);
  });

  test("adding augments with no packageDeps does NOT run bun install", async () => {
    const dir = setupAgent("with-bash");
    answers = { augmentTypes: ["bash"] }; // bash has no packageDeps

    await runAdd("with-bash", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    expect(bunInstallCalls).toHaveLength(0);

    // agent.yaml still mutated.
    expect(readAgentAugments(dir)).toContain("bash");
  });
});

describe("runAdd package manifest preflight", () => {
  test("missing package.json: bail BEFORE any disk write; yaml untouched, no skills, no install", async () => {
    const dir = setupAgent("missing-package");
    // Simulate an incomplete v1 agent project by removing the package.json
    // setupAgent wrote.
    rmSync(join(dir, "package.json"));
    const yamlBefore = readFileSync(join(dir, "agent.yaml"), "utf-8");
    answers = { augmentTypes: ["link"] };

    const originalExitCode = process.exitCode;
    try {
      await runAdd("missing-package", {
        config: join(dir, "agent.yaml"),
        auggyDir,
        yes: true,
        bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
      });

      // Exit signals failure to the operator.
      expect(process.exitCode).toBe(1);

      // Atomicity: yaml is BYTE-IDENTICAL to before the call. No partial
      // state for the operator to clean up before retrying after migration.
      const yamlAfter = readFileSync(join(dir, "agent.yaml"), "utf-8");
      expect(yamlAfter).toBe(yamlBefore);
      expect(yamlAfter).not.toContain("type: link");

      // package.json still absent (we never created it).
      expect(existsSync(join(dir, "package.json"))).toBe(false);

      // No `bun install` attempted.
      expect(bunInstallCalls).toHaveLength(0);
    } finally {
      // Normalize undefined → 0. Bun's test runner exits with whatever
      // process.exitCode is at suite end; some versions don't treat
      // `undefined` as "clean exit" the way Node does, so set explicitly.
      process.exitCode = originalExitCode ?? 0;
    }
  });

  test("commit-then-install order: all three artifacts present + consistent on happy path", async () => {
    // Pins the §13.3 contract that yaml + package.json + skills all persist
    // as a sequence after preflight passes, and that install runs strictly
    // last. Regression-guard: if a future refactor splits the writes or
    // re-introduces partial-state, the assertions here fail.
    const dir = setupAgent("happy-path");
    answers = { augmentTypes: ["link"] };

    await runAdd("happy-path", {
      config: join(dir, "agent.yaml"),
      auggyDir,
      yes: true,
      bunInstallSpawn: createStubBunInstallSpawn({ capture: bunInstallCalls }),
    });

    // 1. agent.yaml mutation present.
    expect(readAgentAugments(dir)).toContain("link");

    // 2. package.json updated with the new dep.
    const pkgAfter = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8")) as {
      dependencies: Record<string, string>;
    };
    expect(pkgAfter.dependencies["@auggy/link"]).toBe("^0.1.2");

    // 3. bun install invoked exactly once after the writes.
    expect(bunInstallCalls).toHaveLength(1);
    expect(bunInstallCalls[0]?.cwd).toBe(dir);
  });
});
