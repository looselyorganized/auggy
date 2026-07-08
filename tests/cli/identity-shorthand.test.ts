import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { stringify } from "yaml";
import { parseConfig } from "../../src/cli/config-parser";

const TMP = join(import.meta.dir, ".tmp-identity-shorthand-test");

function writeYaml(name: string, content: string): string {
  const path = join(TMP, name);
  writeFileSync(path, content);
  return path;
}

/**
 * Build a config with overrides applied. Unlike the broader
 * `config-parser.test.ts` fixture, this one omits the identity augment
 * by default so individual tests can opt in to either the shorthand or
 * the explicit form.
 */
function configWithoutIdentity(overrides: Record<string, unknown> = {}): string {
  const base = {
    id: "aug1_a3f7c2e1-8b4d-4f9e-a6c1-2d8e9f0b3a5c",
    name: "test-agent",
    engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
    augments: [
      {
        name: "fs",
        type: "filesystem",
        options: { mounts: [{ name: "skills", path: "./skills", mode: "ro" }] },
      },
    ],
    ...overrides,
  };
  return stringify(base);
}

beforeEach(() => {
  mkdirSync(TMP, { recursive: true });
  // Write a dummy identity file so any downstream consumer using the path
  // (the parser does not, by design) doesn't trip a missing-file check.
  writeFileSync(join(TMP, "identity.md"), "# Test Identity");
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// identity: shorthand — happy path
// ---------------------------------------------------------------------------

describe("identity: shorthand parsing", () => {
  test("prepends the fileMemory-backed identity config as the FIRST entry", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "./identity.md" }));
    const config = parseConfig(path);

    expect(config.identity).toBe("./identity.md");
    // Identity must be prepended so it lands in system context before other memory.
    expect(config.augments).toHaveLength(2);
    expect(config.augments[0]!.name).toBe("identity");
    expect(config.augments[0]!.type).toBe("fileMemory");
    // Original augment(s) follow.
    expect(config.augments[1]!.name).toBe("fs");
  });

  test("backing identity config has the spec-defined option fields", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "./preamble.md" }));
    const config = parseConfig(path);
    const identityConfig = config.augments[0]!;

    expect(identityConfig.options).toEqual({
      label: "self",
      source: "./preamble.md",
      mutable: false,
      origin: "operator",
      priority: "required",
      placement: "system",
      eviction: "never",
    });
  });

  test("does NOT resolve or validate the file path at parse time", () => {
    // Use a path that definitely doesn't exist on disk; parser must not
    // touch the filesystem to confirm the identity file is present.
    const path = writeYaml(
      "agent.yaml",
      configWithoutIdentity({ identity: "/this/path/does/not/exist.md" }),
    );
    expect(() => parseConfig(path)).not.toThrow();
  });

  test("accepts non-.md extensions (parser does not validate extension)", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "./preamble.txt" }));
    const config = parseConfig(path);
    expect((config.augments[0]!.options as Record<string, unknown>).source).toBe("./preamble.txt");
  });
});

// ---------------------------------------------------------------------------
// Explicit form (existing behavior unchanged)
// ---------------------------------------------------------------------------

describe("explicit fileMemory@placement:system (no shorthand)", () => {
  test("parses successfully with no shorthand and an explicit system fileMemory", () => {
    const path = writeYaml(
      "agent.yaml",
      configWithoutIdentity({
        augments: [
          {
            name: "identity",
            type: "fileMemory",
            options: {
              label: "self",
              source: "./identity.md",
              mutable: false,
              origin: "operator",
              priority: "required",
              placement: "system",
              eviction: "never",
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);

    expect(config.identity).toBeUndefined();
    expect(config.augments).toHaveLength(1);
    expect(config.augments[0]!.name).toBe("identity");
    expect(config.augments[0]!.type).toBe("fileMemory");
    expect((config.augments[0]!.options as Record<string, unknown>).placement).toBe("system");
  });
});

// ---------------------------------------------------------------------------
// Conflict detection
// ---------------------------------------------------------------------------

describe("conflict detection", () => {
  test("rejects shorthand AND explicit fileMemory@placement:system together", () => {
    const path = writeYaml(
      "agent.yaml",
      configWithoutIdentity({
        identity: "./identity.md",
        augments: [
          {
            name: "self-context",
            type: "fileMemory",
            options: {
              label: "self",
              source: "./identity.md",
              mutable: false,
              origin: "operator",
              priority: "required",
              placement: "system",
              eviction: "never",
            },
          },
        ],
      }),
    );
    expect(() => parseConfig(path)).toThrow(
      "agent.yaml has both 'identity' shorthand and an explicit fileMemory augment with placement:system — pick one.",
    );
  });

  test("allows shorthand AND explicit fileMemory with non-system placement", () => {
    const path = writeYaml(
      "agent.yaml",
      configWithoutIdentity({
        identity: "./identity.md",
        augments: [
          {
            name: "notes",
            type: "fileMemory",
            options: {
              label: "notes",
              source: "./notes.md",
              mutable: true,
              origin: "system",
              priority: "default",
              placement: "context",
              eviction: "lru",
            },
          },
        ],
      }),
    );
    const config = parseConfig(path);

    // Identity is first, the explicit non-system fileMemory follows.
    expect(config.augments).toHaveLength(2);
    expect(config.augments[0]!.name).toBe("identity");
    expect((config.augments[0]!.options as Record<string, unknown>).placement).toBe("system");
    expect(config.augments[1]!.name).toBe("notes");
    expect((config.augments[1]!.options as Record<string, unknown>).placement).toBe("context");
  });
});

// ---------------------------------------------------------------------------
// Missing identity (degraded but valid)
// ---------------------------------------------------------------------------

describe("no identity (neither shorthand nor explicit)", () => {
  test("parses successfully with no identity entry at all", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity());
    const config = parseConfig(path);

    expect(config.identity).toBeUndefined();
    expect(config.augments).toHaveLength(1);
    expect(config.augments[0]!.name).toBe("fs");
    // No backing identity entry.
    expect(config.augments.find((a) => a.name === "identity")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Validation — non-string and empty values
// ---------------------------------------------------------------------------

describe("identity field validation", () => {
  test("rejects identity: number", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: 42 }));
    expect(() => parseConfig(path)).toThrow(
      "identity: must be a non-empty string path to a markdown file (got number)",
    );
  });

  test("rejects identity: array", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: ["./identity.md"] }));
    expect(() => parseConfig(path)).toThrow(
      "identity: must be a non-empty string path to a markdown file (got array)",
    );
  });

  test("rejects identity: object", () => {
    const path = writeYaml(
      "agent.yaml",
      configWithoutIdentity({ identity: { path: "./identity.md" } }),
    );
    expect(() => parseConfig(path)).toThrow(
      "identity: must be a non-empty string path to a markdown file (got object)",
    );
  });

  test("rejects identity: empty string", () => {
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "" }));
    expect(() => parseConfig(path)).toThrow(
      "identity: must be a non-empty string path to a markdown file (got empty string)",
    );
  });

  test("rejects identity: whitespace-only string (Codex Imp-2)", () => {
    // A whitespace-only path slips past the length-zero gate but produces
    // a useless file path. Validator now trims and rejects.
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "   " }));
    expect(() => parseConfig(path)).toThrow(
      "identity: must be a non-empty string path to a markdown file (got whitespace-only string)",
    );
  });

  test("trims surrounding whitespace from a valid identity path", () => {
    // A valid path with leading/trailing whitespace should be accepted but
    // trimmed at parse — preserving the canonical form for downstream use.
    const path = writeYaml("agent.yaml", configWithoutIdentity({ identity: "  ./identity.md  " }));
    const parsed = parseConfig(path);
    const identityAug = parsed.augments.find((a) => a.name === "identity");
    expect(identityAug).toBeDefined();
    const identityOptions = identityAug!.options as { source?: string };
    expect(identityOptions.source).toBe("./identity.md");
  });
});
