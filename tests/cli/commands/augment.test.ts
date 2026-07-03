import { describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { seedAgentForTest } from "../../../src/cli/agent-index";
import {
  augmentCommand,
  formatAugmentCatalog,
  formatAugmentList,
  installCustomAugment,
  listAugmentCatalog,
  listAugments,
  removeAugment,
} from "../../../src/cli/commands/augment";

describe("auggy augment command", () => {
  test("registers the augment command with create subcommand", () => {
    const cmd = augmentCommand();
    expect(cmd.name()).toBe("augment");
    expect(cmd.commands.map((c) => c.name())).toContain("create");
    expect(cmd.commands.map((c) => c.name())).toContain("add");
    expect(cmd.commands.map((c) => c.name())).toContain("setup");
    expect(cmd.commands.map((c) => c.name())).toContain("list");
    expect(cmd.commands.map((c) => c.name())).toContain("remove");
    expect(cmd.commands.map((c) => c.name())).toContain("install");
    expect(cmd.commands.map((c) => c.name())).toContain("test");
  });

  test("setup dispatches to setup helper", async () => {
    const setupAugment = mock(async () => "configured");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ setupAugment, auggyDir: "/tmp/auggy" });
      await cmd.parseAsync(
        [
          "setup",
          "agentMail",
          "--agent",
          "zip",
          "--mode",
          "manual",
          "--api-key",
          "am_x",
          "--inbox-id",
          "inb_x",
        ],
        { from: "user" },
      );
    } finally {
      console.log = origLog;
    }

    expect(setupAugment).toHaveBeenCalledWith(
      "agentMail",
      {
        agent: "zip",
        config: undefined,
        mode: "manual",
        humanEmail: undefined,
        username: undefined,
        displayName: undefined,
        apiKey: "am_x",
        inboxId: "inb_x",
        otp: undefined,
        baseUrl: undefined,
      },
      { auggyDir: "/tmp/auggy" },
    );
    expect(logs.join("\n")).toContain("configured");
  });

  test("add dispatches to runAdd for project-local augment add", async () => {
    const runAdd = mock(async () => {});

    const cmd = augmentCommand({ runAdd });
    await cmd.parseAsync(["add", "visitorAuth", "--skip-install"], { from: "user" });

    expect(runAdd).toHaveBeenCalledWith(undefined, {
      augment: ["visitorAuth"],
      config: undefined,
      skipInstall: true,
      yes: undefined,
      auggyDir: undefined,
    });
  });

  test("add with no augment dispatches to runAdd selector path", async () => {
    const runAdd = mock(async () => {});

    const cmd = augmentCommand({ runAdd });
    await cmd.parseAsync(["add", "--skip-install"], { from: "user" });

    expect(runAdd).toHaveBeenCalledWith(undefined, {
      augment: undefined,
      config: undefined,
      skipInstall: true,
      yes: undefined,
      auggyDir: undefined,
    });
  });

  test("add dispatches to runAdd for named agent add", async () => {
    const runAdd = mock(async () => {});

    const cmd = augmentCommand({ runAdd, auggyDir: "/tmp/auggy" });
    await cmd.parseAsync(["add", "visitorAuth", "--agent", "zip"], { from: "user" });

    expect(runAdd).toHaveBeenCalledWith("zip", {
      augment: ["visitorAuth"],
      config: undefined,
      skipInstall: undefined,
      yes: undefined,
      auggyDir: "/tmp/auggy",
    });
  });

  test("add dispatches multiple augment args to runAdd", async () => {
    const runAdd = mock(async () => {});

    const cmd = augmentCommand({ runAdd, auggyDir: "/tmp/auggy" });
    await cmd.parseAsync(["add", "knowledge", "visitorAuth", "--agent", "zip"], {
      from: "user",
    });

    expect(runAdd).toHaveBeenCalledWith("zip", {
      augment: ["knowledge", "visitorAuth"],
      config: undefined,
      skipInstall: undefined,
      yes: undefined,
      auggyDir: "/tmp/auggy",
    });
  });

  test("create dispatches to scaffold helper", async () => {
    const scaffold = mock(() => "/tmp/weather");
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ scaffoldCustomAugment: scaffold });
      await cmd.parseAsync(["create", "weather", "--dir", "/tmp/weather", "--force"], {
        from: "user",
      });
    } finally {
      console.log = origLog;
    }

    expect(scaffold).toHaveBeenCalledWith({
      slug: "weather",
      targetDir: "/tmp/weather",
      force: true,
    });
    expect(logs.join("\n")).toContain('Created custom augment "weather"');
  });

  test("create exits 1 on scaffold errors", async () => {
    const scaffold = mock(() => {
      throw new Error("bad slug");
    });
    const exit = mock((_code: number) => {});
    const errors: string[] = [];
    const origErr = console.error;
    console.error = (msg: unknown) => {
      errors.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ scaffoldCustomAugment: scaffold, exit });
      await cmd.parseAsync(["create", "Bad"], { from: "user" });
    } finally {
      console.error = origErr;
    }

    expect(exit).toHaveBeenCalledWith(1);
    expect(errors.join("\n")).toContain("bad slug");
  });

  test("install dispatches to install helper", async () => {
    const install = mock(() => ({
      configPath: "/tmp/agent.yaml",
      agentDir: "/tmp/agent",
      source: "./augments/weather/index.ts",
      name: "weather",
      skillCopied: true,
    }));
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ installCustomAugment: install, auggyDir: "/tmp/auggy" });
      await cmd.parseAsync(["install", "zip", "./augments/weather", "--config", "/tmp/a.yaml"], {
        from: "user",
      });
    } finally {
      console.log = origLog;
    }

    expect(install).toHaveBeenCalledWith({
      agentName: "zip",
      sourcePath: "./augments/weather",
      config: "/tmp/a.yaml",
      auggyDir: "/tmp/auggy",
    });
    expect(logs.join("\n")).toContain('Installed custom augment "weather"');
  });

  test("test dispatches to validator", async () => {
    const validate = mock(async () => ({ name: "weather", toolCount: 1 }));
    const logs: string[] = [];
    const root = mkdtempSync(join(tmpdir(), "augment-test-command-"));
    const augmentDir = join(root, "weather");
    mkdirSync(augmentDir, { recursive: true });
    writeFileSync(
      join(augmentDir, "index.ts"),
      "export default function weather() { return { name: 'weather' }; }\n",
    );
    const origLog = console.log;
    console.log = (msg: unknown) => {
      logs.push(String(msg));
    };

    try {
      const cmd = augmentCommand({ validateCustomAugment: validate });
      await cmd.parseAsync(["test", augmentDir], { from: "user" });
    } finally {
      console.log = origLog;
      rmSync(root, { recursive: true, force: true });
    }

    expect(validate).toHaveBeenCalledWith(join(augmentDir, "index.ts"));
    expect(logs.join("\n")).toContain('Valid custom augment "weather" (1 tool).');
  });
});

describe("listAugments and removeAugment", () => {
  test("lists installed augments from an agent project", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-list-"));
    try {
      const auggyDir = join(root, "auggy");
      seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - name: fetch",
          "    type: webFetch",
          "  - name: weather",
          "    type: custom",
          "    source: ./augments/weather/index.ts",
          "",
        ].join("\n"),
      });

      expect(listAugments({ agentName: "zip", auggyDir })).toEqual([
        {
          label: "Web Fetch",
          name: "fetch",
          type: "webFetch",
          category: "built-in",
          source: undefined,
        },
        {
          label: "Weather",
          name: "weather",
          type: "custom",
          category: "custom",
          source: "./augments/weather/index.ts",
        },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("formats augment list as human label plus code type", () => {
    const text = formatAugmentList([
      { label: "File Memory", name: "learned", type: "fileMemory", category: "built-in" },
      { label: "Web Fetch", name: "fetch", type: "webFetch", category: "built-in" },
      {
        label: "Weather",
        name: "weather",
        type: "custom",
        category: "custom",
        source: "./augments/weather/index.ts",
      },
    ]);

    expect(text).toContain("AUGMENT");
    expect(text).toContain("TYPE");
    expect(text).toContain("CATEGORY");
    expect(text).toContain("SOURCE");
    expect(text).toContain("File Memory");
    expect(text).toContain("fileMemory");
    expect(text).not.toContain("learned");
    expect(text).toContain("Weather");
    expect(text).toContain("built-in");
    expect(text).toContain("custom");
    expect(text).toContain("./augments/weather/index.ts");
  });

  test("formats catalog list with installed, available, and preview sections", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-catalog-list-"));
    try {
      const auggyDir = join(root, "auggy");
      seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - name: webFetch",
          "    type: webFetch",
          "",
        ].join("\n"),
      });

      const list = listAugmentCatalog({ agentName: "zip", auggyDir });
      const text = formatAugmentCatalog(list);

      expect(text).toContain("Installed:");
      expect(text).toContain("webFetch");
      expect(text).toContain("Available:");
      expect(text).toContain("knowledge");
      expect(text).toContain("visitorAuth");
      expect(text).toContain("mcp");
      expect(text).toContain("# Local docs and API-backed knowledge sources");
      expect(text).not.toContain("Knowledge - local docs");
      expect(text).toContain("Preview:");
      expect(text).toContain("bash");
      expect(text).toContain("auggy augment add");
      expect(text).toContain("auggy augment add <name...>");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("catalog list works outside an agent project", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-catalog-standalone-"));
    try {
      const list = listAugmentCatalog({ cwd: root });
      const text = formatAugmentCatalog(list);

      expect(text).toContain("Installed:");
      expect(text).toContain("none");
      expect(text).toContain("Available:");
      expect(text).toContain("knowledge");
      expect(text).toContain("visitorAuth");
      expect(text).toContain("mcp");
      expect(text).toContain("Preview:");
      expect(text).toContain("bash");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("removes a built-in augment and its bundled skill folder", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-remove-"));
    try {
      const auggyDir = join(root, "auggy");
      const agentDir = seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - webTransport",
          "  - visitorAuth",
          "",
        ].join("\n"),
      });
      mkdirSync(join(agentDir, "augments", "webTransport"), { recursive: true });
      writeFileSync(
        join(agentDir, "augments", "webTransport", "augment.yaml"),
        "type: webTransport\n",
      );
      mkdirSync(join(agentDir, "augments", "visitorAuth"), { recursive: true });
      writeFileSync(
        join(agentDir, "augments", "visitorAuth", "augment.yaml"),
        "type: visitorAuth\n",
      );
      mkdirSync(join(agentDir, "skills", "visitorAuth"), { recursive: true });
      writeFileSync(
        join(agentDir, "skills", "visitorAuth", "SKILL.md"),
        "---\nname: visitorAuth\n",
      );

      const result = removeAugment({ agentName: "zip", augment: "visitorAuth", auggyDir });

      expect(result).toMatchObject({
        name: "visitorAuth",
        type: "visitorAuth",
        skillRemoved: join("skills", "visitorAuth"),
      });
      expect(existsSync(join(agentDir, "skills", "visitorAuth"))).toBe(false);
      expect(existsSync(join(agentDir, "augments", "visitorAuth"))).toBe(false);
      const parsed = parseYaml(readFileSync(join(agentDir, "agent.yaml"), "utf-8")) as {
        augments: string[];
      };
      expect(parsed.augments).toEqual(["webTransport"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses to remove required augments", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-remove-required-"));
    try {
      const auggyDir = join(root, "auggy");
      seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - name: fetch",
          "    type: webFetch",
          "",
        ].join("\n"),
      });

      expect(() => removeAugment({ agentName: "zip", augment: "fetch", auggyDir })).toThrow(
        /required/,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("installCustomAugment", () => {
  test("adds a type: custom augment with source relative to the agent dir and copies SKILL.md", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-install-"));
    try {
      const auggyDir = join(root, "auggy");
      const agentDir = seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments: []",
          "",
        ].join("\n"),
      });
      const customDir = join(agentDir, "augments", "weather");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(
        join(customDir, "index.ts"),
        "export default function weather() { return { name: 'weather' }; }\n",
      );
      writeFileSync(join(customDir, "SKILL.md"), "---\nname: weather\n---\n");

      const result = installCustomAugment({
        agentName: "zip",
        sourcePath: customDir,
        auggyDir,
      });

      expect(result.source).toBe("./augments/weather/index.ts");
      expect(result.skillCopied).toBe(true);
      expect(existsSync(join(agentDir, "skills", "weather", "SKILL.md"))).toBe(true);

      const parsed = parseYaml(readFileSync(join(agentDir, "agent.yaml"), "utf-8")) as {
        augments: string[];
      };
      expect(parsed.augments).toEqual(["weather"]);

      const metadata = parseYaml(
        readFileSync(join(agentDir, "augments", "weather", "augment.yaml"), "utf-8"),
      ) as Record<string, unknown>;
      expect(metadata).toEqual({
        type: "custom",
        source: "./index.ts",
        config: {},
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses duplicate custom augment names", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-install-"));
    try {
      const auggyDir = join(root, "auggy");
      const agentDir = seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments:",
          "  - name: weather",
          "    type: custom",
          "    source: ./augments/weather/index.ts",
          "",
        ].join("\n"),
      });
      const customDir = join(agentDir, "augments", "weather");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(
        join(customDir, "index.ts"),
        "export default function weather() { return { name: 'weather' }; }\n",
      );

      expect(() =>
        installCustomAugment({ agentName: "zip", sourcePath: customDir, auggyDir }),
      ).toThrow(/already declared/i);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects custom augment names that are not safe identifiers", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-install-"));
    try {
      const auggyDir = join(root, "auggy");
      const agentDir = seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments: []",
          "",
        ].join("\n"),
      });
      const customDir = join(agentDir, "augments", "bad.name");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(
        join(customDir, "index.ts"),
        "export default function bad() { return { name: 'bad' }; }\n",
      );

      expect(() =>
        installCustomAugment({ agentName: "zip", sourcePath: customDir, auggyDir }),
      ).toThrow(/Invalid augment name/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("preserves an existing custom augment.yaml when installing", () => {
    const root = mkdtempSync(join(tmpdir(), "augment-install-"));
    try {
      const auggyDir = join(root, "auggy");
      const agentDir = seedAgentForTest("zip", {
        auggyDir,
        yaml: [
          "id: aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
          "name: zip",
          "engine:",
          "  provider: anthropic",
          "  model: claude-sonnet-4-6",
          "augments: []",
          "",
        ].join("\n"),
      });
      const customDir = join(agentDir, "augments", "weather");
      mkdirSync(customDir, { recursive: true });
      writeFileSync(
        join(customDir, "index.ts"),
        "export default function weather() { return { name: 'weather' }; }\n",
      );
      writeFileSync(
        join(customDir, "augment.yaml"),
        "type: custom\nsource: ./index.ts\nconfig:\n  prefix: saved\n",
      );

      installCustomAugment({ agentName: "zip", sourcePath: customDir, auggyDir });

      const metadata = parseYaml(readFileSync(join(customDir, "augment.yaml"), "utf-8")) as Record<
        string,
        unknown
      >;
      expect(metadata).toEqual({
        type: "custom",
        source: "./index.ts",
        config: { prefix: "saved" },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
