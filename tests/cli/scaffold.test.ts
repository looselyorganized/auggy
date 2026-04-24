import { describe, test, expect, afterEach } from "bun:test";
import { existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { scaffoldAgent } from "../../src/cli/scaffold";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-scaffold-test");

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

describe("scaffoldAgent", () => {
  test("creates the expected directory structure", () => {
    const dir = scaffoldAgent({ name: "test-agent", targetDir: join(TMP, "test-agent") });

    expect(existsSync(join(dir, "agent.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".env"))).toBe(true);
    expect(existsSync(join(dir, "identity.md"))).toBe(true);
    expect(existsSync(join(dir, "learned.md"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "skills"))).toBe(true);
    expect(existsSync(join(dir, "skills", "memory", "SKILL.md"))).toBe(true);
    expect(existsSync(join(dir, "workspace"))).toBe(true);
    expect(existsSync(join(dir, "augments"))).toBe(true);
  });

  test("generates a valid aug1_ UUID in agent.yaml", () => {
    const dir = scaffoldAgent({ name: "test-agent", targetDir: join(TMP, "test-agent") });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toMatch(/^id: aug1_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/m);
  });

  test("agent.yaml contains the agent name", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("name: zip");
  });

  test("agent.yaml sets trustLevel: untrusted on webTransport", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("trustLevel: untrusted");
  });

  test("identity.md contains the agent name and skill manifest", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    const identity = readFileSync(join(dir, "identity.md"), "utf-8");
    expect(identity).toContain("# zip");
    expect(identity).toContain("Available skills");
    expect(identity).toContain("memory/SKILL.md");
  });

  test("generated agent.yaml parses through the config parser", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    // Set the required env var for the web transport token.
    process.env.AUGGY_WEB_TOKEN = "test-token";
    const config = parseConfig(join(dir, "agent.yaml"));
    expect(config.name).toBe("zip");
    expect(config.id).toMatch(/^aug1_/);
    expect(config.augments.length).toBeGreaterThanOrEqual(3);
    delete process.env.AUGGY_WEB_TOKEN;
  });

  test("throws if target directory already exists", () => {
    scaffoldAgent({ name: "exists", targetDir: join(TMP, "exists") });
    expect(() =>
      scaffoldAgent({ name: "exists", targetDir: join(TMP, "exists") }),
    ).toThrow("already exists");
  });

  test("uses custom purpose when provided", () => {
    const dir = scaffoldAgent({
      name: "zip",
      targetDir: join(TMP, "zip"),
      purpose: "LORF front-door agent",
    });
    const yaml = readFileSync(join(dir, "agent.yaml"), "utf-8");
    expect(yaml).toContain("LORF front-door agent");
  });

  test("memory SKILL.md has valid frontmatter", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    const skill = readFileSync(join(dir, "skills", "memory", "SKILL.md"), "utf-8");
    expect(skill).toContain("---");
    expect(skill).toContain("name: memory");
    expect(skill).toContain("description:");
  });

  test(".gitignore excludes .env and workspace", () => {
    const dir = scaffoldAgent({ name: "zip", targetDir: join(TMP, "zip") });
    const gitignore = readFileSync(join(dir, ".gitignore"), "utf-8");
    expect(gitignore).toContain(".env");
    expect(gitignore).toContain("workspace/");
  });
});
