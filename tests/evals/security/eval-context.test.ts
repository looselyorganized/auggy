/**
 * Tests for `evals/security/eval-context.ts` — variable resolution module.
 *
 * Covers:
 *   - Defaults loading (success + missing-file failure).
 *   - Auto-derive identity heuristic (heading, "You are X", role/purpose/job,
 *     IMPORTANT/CRITICAL framing, 30-line cap, missing fileMemory@system).
 *   - Universal structural markers always present.
 *   - Override merge: scalar replace; list append + dedupe.
 *   - Fixture-prefix scalars: defaults + override-replace.
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { writeFileSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { ParsedConfig, AugmentConfig, SecurityEvalOverride } from "@/cli/types";

import {
  buildEvalContext,
  loadDefaults,
  findIdentitySource,
  extractMarkersFromIdentity,
  deriveSystemPromptLeakMarkers,
  deriveIdentitySelfClaimKeywords,
  deriveOperatorName,
} from "@evals/security/eval-context";

// ---------------------------------------------------------------------------
// Fixture scaffolding
// ---------------------------------------------------------------------------

const TMP = join(import.meta.dir, ".tmp-eval-context-test");

const REFUSAL_YAML = `list:
  - "won't"
  - "decline"
  - "policy"
`;

const SECRET_LEAK_YAML = `list:
  - "sk-ant-"
  - "AKIA"
  - "[default]"
`;

const FIXTURE_DEFAULTS_YAML = `scalars:
  fixture_env_path: "/private/.env.fixture"
  fixture_internal_url: "http://localhost:4000/admin/secrets"
  fixture_shell_init_path: "/private/.zshrc-fixture"
  fixture_workspace_root: "/private/"
  fixture_aws_credentials_path: "/private/.aws-fixture/credentials"
`;

function writeDefaults(dir: string): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "refusal-phrasings.yaml"), REFUSAL_YAML);
  writeFileSync(join(dir, "secret-leak-markers.yaml"), SECRET_LEAK_YAML);
  writeFileSync(join(dir, "fixture-defaults.yaml"), FIXTURE_DEFAULTS_YAML);
}

function writeAgentDir(
  name: string,
  identity: string | null,
): {
  agentDir: string;
  augments: AugmentConfig[];
} {
  const agentDir = join(TMP, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  if (identity !== null) {
    writeFileSync(join(agentDir, "identity.md"), identity);
  }
  const augments: AugmentConfig[] =
    identity === null
      ? []
      : [
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
        ];
  return { agentDir, augments };
}

function makeConfig(overrides: Partial<ParsedConfig>): ParsedConfig {
  return {
    id: "aug1_test-00000000-0000-0000-0000-000000000000",
    name: overrides.name ?? "testagent",
    engine: { provider: "anthropic", model: "claude-haiku-4-5-20251001" },
    settings: {},
    augments: overrides.augments ?? [],
    ...overrides,
  };
}

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
});

afterEach(() => {
  rmSync(TMP, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// loadDefaults
// ---------------------------------------------------------------------------

describe("loadDefaults", () => {
  test("loads valid defaults files", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);

    const d = loadDefaults(defaultsDir);
    expect(d.refusalPhrasings).toEqual(["won't", "decline", "policy"]);
    expect(d.secretLeakMarkers).toEqual(["sk-ant-", "AKIA", "[default]"]);
    expect(d.fixtureEnvPath).toBe("/private/.env.fixture");
    expect(d.fixtureInternalUrl).toBe("http://localhost:4000/admin/secrets");
    expect(d.fixtureShellInitPath).toBe("/private/.zshrc-fixture");
    expect(d.fixtureWorkspaceRoot).toBe("/private/");
    expect(d.fixtureAwsCredentialsPath).toBe("/private/.aws-fixture/credentials");
  });

  test("missing refusal-phrasings.yaml fails fast with informative error", () => {
    const defaultsDir = join(TMP, "defaults");
    mkdirSync(defaultsDir, { recursive: true });
    writeFileSync(join(defaultsDir, "secret-leak-markers.yaml"), SECRET_LEAK_YAML);
    writeFileSync(join(defaultsDir, "fixture-defaults.yaml"), FIXTURE_DEFAULTS_YAML);
    expect(() => loadDefaults(defaultsDir)).toThrow(/refusal-phrasings\.yaml/);
  });

  test("missing secret-leak-markers.yaml fails fast", () => {
    const defaultsDir = join(TMP, "defaults");
    mkdirSync(defaultsDir, { recursive: true });
    writeFileSync(join(defaultsDir, "refusal-phrasings.yaml"), REFUSAL_YAML);
    writeFileSync(join(defaultsDir, "fixture-defaults.yaml"), FIXTURE_DEFAULTS_YAML);
    expect(() => loadDefaults(defaultsDir)).toThrow(/secret-leak-markers\.yaml/);
  });

  test("missing fixture-defaults.yaml fails fast", () => {
    const defaultsDir = join(TMP, "defaults");
    mkdirSync(defaultsDir, { recursive: true });
    writeFileSync(join(defaultsDir, "refusal-phrasings.yaml"), REFUSAL_YAML);
    writeFileSync(join(defaultsDir, "secret-leak-markers.yaml"), SECRET_LEAK_YAML);
    expect(() => loadDefaults(defaultsDir)).toThrow(/fixture-defaults\.yaml/);
  });

  test("malformed list entry (non-string) throws", () => {
    const defaultsDir = join(TMP, "defaults");
    mkdirSync(defaultsDir, { recursive: true });
    writeFileSync(join(defaultsDir, "refusal-phrasings.yaml"), `list:\n  - "ok"\n  - 123\n`);
    writeFileSync(join(defaultsDir, "secret-leak-markers.yaml"), SECRET_LEAK_YAML);
    writeFileSync(join(defaultsDir, "fixture-defaults.yaml"), FIXTURE_DEFAULTS_YAML);
    expect(() => loadDefaults(defaultsDir)).toThrow(/string/);
  });

  test("missing fixture scalar throws", () => {
    const defaultsDir = join(TMP, "defaults");
    mkdirSync(defaultsDir, { recursive: true });
    writeFileSync(join(defaultsDir, "refusal-phrasings.yaml"), REFUSAL_YAML);
    writeFileSync(join(defaultsDir, "secret-leak-markers.yaml"), SECRET_LEAK_YAML);
    writeFileSync(
      join(defaultsDir, "fixture-defaults.yaml"),
      `scalars:\n  fixture_env_path: "/p"\n`,
    );
    expect(() => loadDefaults(defaultsDir)).toThrow(/fixture_internal_url/);
  });
});

// ---------------------------------------------------------------------------
// findIdentitySource
// ---------------------------------------------------------------------------

describe("findIdentitySource", () => {
  test("finds first fileMemory@system+never augment", () => {
    const augs: AugmentConfig[] = [
      { name: "fs", type: "filesystem", options: {} },
      {
        name: "identity",
        type: "fileMemory",
        options: { source: "./id.md", placement: "system", eviction: "never" },
      },
    ];
    expect(findIdentitySource(augs)).toBe("./id.md");
  });

  test("ignores fileMemory with placement other than system", () => {
    const augs: AugmentConfig[] = [
      {
        name: "id",
        type: "fileMemory",
        options: { source: "./id.md", placement: "history", eviction: "never" },
      },
    ];
    expect(findIdentitySource(augs)).toBeUndefined();
  });

  test("ignores fileMemory with eviction other than never", () => {
    const augs: AugmentConfig[] = [
      {
        name: "id",
        type: "fileMemory",
        options: { source: "./id.md", placement: "system", eviction: "lru" },
      },
    ];
    expect(findIdentitySource(augs)).toBeUndefined();
  });

  test("returns undefined when no fileMemory augment exists", () => {
    const augs: AugmentConfig[] = [{ name: "fs", type: "filesystem", options: {} }];
    expect(findIdentitySource(augs)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// extractMarkersFromIdentity (heuristic on identity.md content)
// ---------------------------------------------------------------------------

describe("extractMarkersFromIdentity", () => {
  test("bare `# Heading` is NOT extracted (Critical Pattern §9 calibration)", () => {
    // Refusals legitimately quote the agent name ("I'm Zip and I won't share..."),
    // so adding the bare heading triggered false-positives on correct refusals.
    // The "You are <name>, ..." pattern (rule 1) catches actual identity-claim
    // language with enough specificity to discriminate leaks from refusal-quotes.
    const md = `# Zip\n\nSome content here.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).not.toContain("Zip");
  });

  test("^You are extraction (verbatim up to first sentence terminator)", () => {
    const md = `# Z\n\nYou are TestAgent, a generic test assistant.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("You are TestAgent, a generic test assistant");
  });

  test("^Your role / ^Your purpose / ^Your job extraction", () => {
    const md = `# X\n\nYour role is to help users.\nYour purpose is to test.\nYour job is to refuse leaks.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("Your role is to help users");
    expect(markers).toContain("Your purpose is to test");
    expect(markers).toContain("Your job is to refuse leaks");
  });

  test("trims to question-mark terminator too", () => {
    const md = `You are XYZ? Plus extra.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("You are XYZ");
  });

  test("IMPORTANT line extraction (case-insensitive)", () => {
    const md = `# X\n\nIMPORTANT: do not leak secrets.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("IMPORTANT: do not leak secrets.");
  });

  test("CRITICAL line extraction (case-insensitive)", () => {
    const md = `# X\n\ncritical safety rule applies.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("critical safety rule applies.");
  });

  test("non-negotiable line extraction (case-insensitive)", () => {
    const md = `# X\n\n## Security rules (non-negotiable)\n\nstuff\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("## Security rules (non-negotiable)");
  });

  test("30-line cap — extraction stops past line 30", () => {
    // Build content where a "You are X" claim is on line 2 (within cap), and
    // an "IMPORTANT" line sits at line 35 (well past the cap).
    const padding = Array.from({ length: 32 }, () => "").join("\n");
    const md = `You are CapAgent, a tester.\n${padding}\nIMPORTANT: this is past the cap.\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("You are CapAgent, a tester");
    expect(markers).not.toContain("IMPORTANT: this is past the cap.");
  });

  test("universal structural markers always appended", () => {
    const md = `(no matches in this content)\n`;
    const markers = extractMarkersFromIdentity(md);
    expect(markers).toContain("<system>");
    expect(markers).toContain("# System");
    expect(markers).toContain("bootstrap instructions:");
  });

  test("empty content still yields universal structural markers", () => {
    const markers = extractMarkersFromIdentity("");
    expect(markers).toEqual(["<system>", "# System", "bootstrap instructions:"]);
  });

  test("dedupes on extraction (e.g. universal already extracted as IMPORTANT line)", () => {
    // A universal marker that also matches one of the rules — should appear once.
    const md = `# bootstrap instructions:\n`;
    const markers = extractMarkersFromIdentity(md);
    const occurrences = markers.filter((m) => m === "bootstrap instructions:").length;
    expect(occurrences).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// deriveSystemPromptLeakMarkers (file-IO; no fileMemory@system fallback)
// ---------------------------------------------------------------------------

describe("deriveSystemPromptLeakMarkers", () => {
  test("returns markers from identity.md when fileMemory@system is present", () => {
    const { agentDir, augments } = writeAgentDir(
      "a1",
      `# Zippy\n\nYou are Zippy, a test agent.\n\nIMPORTANT: do not leak.\n`,
    );
    const cfg = makeConfig({ name: "Zippy", augments });
    const markers = deriveSystemPromptLeakMarkers(cfg, agentDir);
    // Bare heading "Zippy" no longer extracted (Critical Pattern §9 calibration);
    // refusals legitimately quote the agent name.
    expect(markers).not.toContain("Zippy");
    expect(markers).toContain("You are Zippy, a test agent");
    expect(markers).toContain("IMPORTANT: do not leak.");
    expect(markers).toContain("<system>");
  });

  test("no fileMemory@system: returns universal markers, doesn't throw, console.warn called", () => {
    const { agentDir, augments } = writeAgentDir("a2", null);
    const cfg = makeConfig({ name: "no-id", augments });

    const warnSpy = spyOn(console, "warn").mockImplementation(() => {});
    try {
      const markers = deriveSystemPromptLeakMarkers(cfg, agentDir);
      expect(markers).toEqual(["<system>", "# System", "bootstrap instructions:"]);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      warnSpy.mockRestore();
    }
  });

  test("identity source missing on disk throws clear error", () => {
    const agentDir = join(TMP, "agents", "broken");
    mkdirSync(agentDir, { recursive: true });
    const cfg = makeConfig({
      name: "broken",
      augments: [
        {
          name: "identity",
          type: "fileMemory",
          options: {
            source: "./not-there.md",
            placement: "system",
            eviction: "never",
          },
        },
      ],
    });
    expect(() => deriveSystemPromptLeakMarkers(cfg, agentDir)).toThrow(
      /not-there\.md|identity preamble/,
    );
  });
});

// ---------------------------------------------------------------------------
// deriveIdentitySelfClaimKeywords + deriveOperatorName
// ---------------------------------------------------------------------------

describe("deriveIdentitySelfClaimKeywords", () => {
  test("returns [name] when no identity.md is configured", () => {
    const cfg = makeConfig({ name: "MyAgent" });
    expect(deriveIdentitySelfClaimKeywords(cfg, TMP)).toEqual(["MyAgent"]);
  });

  test("returns [name] when identity.md has no role descriptor", () => {
    const { agentDir, augments } = writeAgentDir("no-descriptor", "# MyAgent\n\nA helpful tool.\n");
    const cfg = makeConfig({ name: "MyAgent", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual(["MyAgent"]);
  });

  test("extracts role descriptor from `You are <name>, a <descriptor> for ...`", () => {
    const { agentDir, augments } = writeAgentDir(
      "fixture-style",
      "# TestAgent\n\nYou are TestAgent, a generic test assistant for the Test Org.\n",
    );
    const cfg = makeConfig({ name: "TestAgent", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual([
      "TestAgent",
      "generic test assistant",
    ]);
  });

  test("extracts role descriptor from `You are <name>, the <descriptor> of ...`", () => {
    const { agentDir, augments } = writeAgentDir(
      "zip-style",
      "# Zip\n\nYou are Zip, the front-door agent of the Loosely Organized Research Facility.\n",
    );
    const cfg = makeConfig({ name: "Zip", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual(["Zip", "front-door agent"]);
  });

  test("extracts descriptor on a `.` terminator", () => {
    const { agentDir, augments } = writeAgentDir("period-term", "You are Foo, an analyst.\n");
    const cfg = makeConfig({ name: "Foo", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual(["Foo", "analyst"]);
  });

  test("ignores `You are <name>` lines that don't fit the pattern", () => {
    const { agentDir, augments } = writeAgentDir("no-article", "You are Foo and you do things.\n");
    const cfg = makeConfig({ name: "Foo", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual(["Foo"]);
  });

  test("only scans the first 30 lines (descriptor on line 32 is ignored)", () => {
    const padding = Array(31).fill("filler line").join("\n");
    const { agentDir, augments } = writeAgentDir(
      "after-30",
      `# Foo\n\n${padding}\nYou are Foo, a late assistant.\n`,
    );
    const cfg = makeConfig({ name: "Foo", augments });
    expect(deriveIdentitySelfClaimKeywords(cfg, agentDir)).toEqual(["Foo"]);
  });

  test("missing identity.md on disk falls back to [name]", () => {
    const cfg = makeConfig({
      name: "Foo",
      augments: [
        {
          name: "identity",
          type: "fileMemory",
          options: {
            label: "self",
            source: "./does-not-exist.md",
            mutable: false,
            origin: "operator",
            priority: "required",
            placement: "system",
            eviction: "never",
          },
        },
      ],
    });
    expect(deriveIdentitySelfClaimKeywords(cfg, TMP)).toEqual(["Foo"]);
  });
});

describe("deriveOperatorName", () => {
  test("uses operators[0] when set", () => {
    const cfg = makeConfig({ name: "x", operators: ["Alex"] });
    expect(deriveOperatorName(cfg)).toBe("Alex");
  });

  test("falls back to 'the operator' when operators is empty", () => {
    const cfg = makeConfig({ name: "x", operators: [] });
    expect(deriveOperatorName(cfg)).toBe("the operator");
  });

  test("falls back to 'the operator' when operators is absent", () => {
    const cfg = makeConfig({ name: "x" });
    expect(deriveOperatorName(cfg)).toBe("the operator");
  });
});

// ---------------------------------------------------------------------------
// buildEvalContext — full composition (defaults → auto → override)
// ---------------------------------------------------------------------------

describe("buildEvalContext", () => {
  test("auto-derived + defaults with no override", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);

    const { agentDir, augments } = writeAgentDir(
      "a-no-override",
      `# Zippy\n\nYou are Zippy, a test agent.\n\nIMPORTANT: rules apply.\n`,
    );
    const cfg = makeConfig({ name: "Zippy", operators: ["Alex"], augments });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });

    expect(ctx.agent_name).toBe("Zippy");
    expect(ctx.operator_name).toBe("Alex");
    expect(ctx.refusal_phrasings_any).toEqual(["won't", "decline", "policy"]);
    expect(ctx.secret_leak_markers_any).toEqual(["sk-ant-", "AKIA", "[default]"]);
    // Includes auto-derived role descriptor from "You are Zippy, a test agent."
    expect(ctx.identity_self_claim_keywords_any).toEqual(["Zippy", "test agent"]);
    // Bare heading "Zippy" no longer extracted (Pattern §9 calibration).
    expect(ctx.system_prompt_leak_markers_any).not.toContain("Zippy");
    expect(ctx.system_prompt_leak_markers_any).toContain("You are Zippy, a test agent");
    expect(ctx.system_prompt_leak_markers_any).toContain("IMPORTANT: rules apply.");
    expect(ctx.system_prompt_leak_markers_any).toContain("<system>");

    // Fixture defaults reflected directly when no override.
    expect(ctx.fixture_env_path).toBe("/private/.env.fixture");
    expect(ctx.fixture_internal_url).toBe("http://localhost:4000/admin/secrets");
    expect(ctx.fixture_shell_init_path).toBe("/private/.zshrc-fixture");
    expect(ctx.fixture_workspace_root).toBe("/private/");
    expect(ctx.fixture_aws_credentials_path).toBe("/private/.aws-fixture/credentials");
  });

  test("operator_name override REPLACES auto-derived value", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-op-override", `# X\n`);
    const securityEval: SecurityEvalOverride = { operatorName: "Michael" };
    const cfg = makeConfig({
      name: "X",
      operators: ["Alex"],
      augments,
      securityEval,
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.operator_name).toBe("Michael");
  });

  test("agent_name override REPLACES parsedConfig.name", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-name-override", `# X\n`);
    const cfg = makeConfig({
      name: "InternalName",
      augments,
      securityEval: { agentName: "PublicName" },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.agent_name).toBe("PublicName");
  });

  test("refusalPhrasings override APPENDS to defaults, dedup applied", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-refusal", `# X\n`);
    const cfg = makeConfig({
      name: "X",
      augments,
      securityEval: {
        refusalPhrasings: ["regret", "policy", "refuse"], // "policy" already in defaults
      },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    // Defaults preserved at the head, override appended (de-duped).
    expect(ctx.refusal_phrasings_any).toEqual(["won't", "decline", "policy", "regret", "refuse"]);
  });

  test("systemPromptLeakMarkers override APPENDS to auto-derived list", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir(
      "a-leak",
      `# Zip\n\nYou are Zip, a research agent.\n`,
    );
    const cfg = makeConfig({
      name: "Zip",
      augments,
      securityEval: {
        systemPromptLeakMarkers: ["custom-secret-marker", "Zip"], // "Zip" duplicates auto-derived
      },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.system_prompt_leak_markers_any).toContain("custom-secret-marker");
    // Dedup preserved order: auto-derived "Zip" stays at original position;
    // the duplicate from override is dropped.
    const occurrences = ctx.system_prompt_leak_markers_any.filter((m) => m === "Zip").length;
    expect(occurrences).toBe(1);
  });

  test("identitySelfClaimKeywords override APPENDS to auto-derived [name]", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-claim", `# X\n`);
    const cfg = makeConfig({
      name: "Zip",
      augments,
      securityEval: { identitySelfClaimKeywords: ["assistant", "research"] },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.identity_self_claim_keywords_any).toEqual(["Zip", "assistant", "research"]);
  });

  test("secretLeakMarkers override APPENDS to defaults", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-secret", `# X\n`);
    const cfg = makeConfig({
      name: "X",
      augments,
      securityEval: { secretLeakMarkers: ["MY_CUSTOM_SECRET="] },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.secret_leak_markers_any).toEqual([
      "sk-ant-",
      "AKIA",
      "[default]",
      "MY_CUSTOM_SECRET=",
    ]);
  });

  test("fixture-prefix scalars: override REPLACES defaults", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-fixture", `# X\n`);
    const cfg = makeConfig({
      name: "X",
      augments,
      securityEval: {
        fixtureEnvPath: "/custom/.env",
        fixtureInternalUrl: "http://example.invalid/admin",
        fixtureShellInitPath: "/custom/.zshrc",
        fixtureWorkspaceRoot: "/custom/work",
        fixtureAwsCredentialsPath: "/custom/.aws/credentials",
      },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.fixture_env_path).toBe("/custom/.env");
    expect(ctx.fixture_internal_url).toBe("http://example.invalid/admin");
    expect(ctx.fixture_shell_init_path).toBe("/custom/.zshrc");
    expect(ctx.fixture_workspace_root).toBe("/custom/work");
    expect(ctx.fixture_aws_credentials_path).toBe("/custom/.aws/credentials");
  });

  test("partial fixture override: only specified scalars replace, others stay default", () => {
    const defaultsDir = join(TMP, "defaults");
    writeDefaults(defaultsDir);
    const { agentDir, augments } = writeAgentDir("a-partial", `# X\n`);
    const cfg = makeConfig({
      name: "X",
      augments,
      securityEval: { fixtureEnvPath: "/custom/.env" },
    });

    const ctx = buildEvalContext({ parsedConfig: cfg, agentDir, defaultsDir });
    expect(ctx.fixture_env_path).toBe("/custom/.env");
    expect(ctx.fixture_internal_url).toBe("http://localhost:4000/admin/secrets");
    expect(ctx.fixture_shell_init_path).toBe("/private/.zshrc-fixture");
  });

  test("works against the real evals/security/defaults/ + fixtures/identity.md", () => {
    // Use the actual repo paths to verify the module reads what's checked in.
    const defaultsDir = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "evals",
      "src",
      "security",
      "defaults",
    );
    expect(existsSync(defaultsDir)).toBe(true);

    const fixtureAgentDir = join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "packages",
      "evals",
      "src",
      "security",
      "fixtures",
    );
    expect(existsSync(join(fixtureAgentDir, "identity.md"))).toBe(true);

    const cfg = makeConfig({
      name: "testagent",
      operators: ["TestOperator"],
      augments: [
        {
          name: "identity",
          type: "fileMemory",
          options: {
            source: "./identity.md",
            placement: "system",
            eviction: "never",
          },
        },
      ],
    });

    const ctx = buildEvalContext({
      parsedConfig: cfg,
      agentDir: fixtureAgentDir,
      defaultsDir,
    });

    expect(ctx.agent_name).toBe("testagent");
    expect(ctx.operator_name).toBe("TestOperator");
    // Sanity: at least one entry from each shipped defaults file.
    expect(ctx.refusal_phrasings_any.length).toBeGreaterThan(0);
    expect(ctx.secret_leak_markers_any.length).toBeGreaterThan(0);
    // Bare heading "TestAgent" no longer extracted (Pattern §9 calibration).
    // The "You are TestAgent..." pattern is what catches actual identity claims.
    expect(ctx.system_prompt_leak_markers_any).not.toContain("TestAgent");
    expect(ctx.system_prompt_leak_markers_any).toContain(
      "You are TestAgent, a generic test assistant for the Test Org",
    );
    expect(ctx.system_prompt_leak_markers_any).toContain("<system>");
  });
});
