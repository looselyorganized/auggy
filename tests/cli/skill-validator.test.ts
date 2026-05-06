/**
 * Tests for the boot-time skill validator.
 *
 * Per PR α task 7 / ADR-025 Decision 5 / spec §H + §"Decision 7":
 *  - Warning fires when a tool-providing augment is missing its skill
 *  - Warning does NOT fire when the skill is present
 *  - Tool-less augments (fileMemory) never warn
 *  - Multiple missing skills yield one warning each (one block per augment)
 *  - Mixed (some present, some missing) only warns on the missing ones
 *  - Agent boot still succeeds (resolveAugments returns; no throw)
 *  - Warning names the augment FOLDER (e.g. "web-fetch") rather than the
 *    operator's `name:` field (e.g. "fetch") — tied to `auggy add-skill`
 */

import { describe, test, expect, beforeEach, afterEach, spyOn } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveAugments } from "../../src/cli/augment-resolver";
import type { AugmentConfig } from "../../src/cli/types";

const TMP = join(import.meta.dir, ".tmp-skill-validator-test");

let warnSpy: ReturnType<typeof spyOn>;

beforeEach(() => {
  rmSync(TMP, { recursive: true, force: true });
  mkdirSync(TMP, { recursive: true });
  warnSpy = spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  warnSpy.mockRestore();
  rmSync(TMP, { recursive: true, force: true });
});

/**
 * Helper: write a populated SKILL.md at the standard path inside the test
 * agent dir. Mirrors what `auggy create` / `auggy add-skill` would do.
 */
function writeSkillFile(folder: string, body: string = "# skill") {
  const dir = join(TMP, "skills", folder);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), body);
}

/**
 * Helper: collect every warning message captured by the spy as a single
 * concatenated string. Easier to assert against contains() than walking
 * the .calls array index-by-index.
 */
function allWarnings(): string {
  return warnSpy.mock.calls.map((args: unknown[]) => args.join(" ")).join("\n---\n");
}

function warningCount(): number {
  return warnSpy.mock.calls.length;
}

// ---------------------------------------------------------------------------
// Case 1: warning fires when expected
// ---------------------------------------------------------------------------

describe("skill-validator — warning fires when skill missing", () => {
  test("web-fetch with no skill on disk → warning names augment + tool count + remediation", async () => {
    const configs: AugmentConfig[] = [{ name: "fetch", type: "webFetch", options: {} }];

    await resolveAugments(configs, TMP);

    expect(warningCount()).toBe(1);
    const warnings = allWarnings();
    expect(warnings).toContain("[augment-resolver]");
    expect(warnings).toContain('augment "web-fetch"');
    expect(warnings).toContain("1 tool");
    expect(warnings).toContain(join(TMP, "skills", "web-fetch", "SKILL.md"));
    expect(warnings).toContain("auggy add-skill web-fetch");
  });
});

// ---------------------------------------------------------------------------
// Case 2: warning does NOT fire when skill present
// ---------------------------------------------------------------------------

describe("skill-validator — no warning when skill present", () => {
  test("web-fetch with SKILL.md mounted → silent", async () => {
    writeSkillFile("web-fetch");

    const configs: AugmentConfig[] = [{ name: "fetch", type: "webFetch", options: {} }];

    await resolveAugments(configs, TMP);

    expect(warningCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 3: tool-less augment never warns
// ---------------------------------------------------------------------------

describe("skill-validator — tool-less augment exempt", () => {
  test("fileMemory has no tools → no warning regardless of skills/file-memory state", async () => {
    writeFileSync(join(TMP, "identity.md"), "# Identity");

    // No skills/file-memory dir exists. fileMemory has no `tools[]`, so
    // the validator skips it without ever probing.
    const configs: AugmentConfig[] = [
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

    await resolveAugments(configs, TMP);

    expect(warningCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Case 4: multiple missing → multiple warnings, each names its own augment
// ---------------------------------------------------------------------------

describe("skill-validator — multiple missing skills produce distinct warnings", () => {
  test("web-fetch + bash both missing → two warnings, each blames the right augment", async () => {
    const configs: AugmentConfig[] = [
      { name: "fetch", type: "webFetch", options: {} },
      {
        name: "shell",
        type: "bash",
        options: {
          // Provide enough config that bash actually exposes a tool;
          // bash with risk: "scripts-only" + no scripts has tools.length === 0
          // and would fail to construct. Use restricted to surface shell_exec.
          risk: "restricted",
          allowedCommands: ["echo"],
        },
      },
    ];

    await resolveAugments(configs, TMP);

    expect(warningCount()).toBe(2);
    const warnings = allWarnings();
    expect(warnings).toContain('augment "web-fetch"');
    expect(warnings).toContain('augment "bash"');
    expect(warnings).toContain("auggy add-skill web-fetch");
    expect(warnings).toContain("auggy add-skill bash");
  });
});

// ---------------------------------------------------------------------------
// Case 5: mixed — some present, some missing
// ---------------------------------------------------------------------------

describe("skill-validator — mixed presence", () => {
  test("web-fetch has skill, bash doesn't → exactly one warning (for bash)", async () => {
    writeSkillFile("web-fetch");

    const configs: AugmentConfig[] = [
      { name: "fetch", type: "webFetch", options: {} },
      {
        name: "shell",
        type: "bash",
        options: {
          risk: "restricted",
          allowedCommands: ["echo"],
        },
      },
    ];

    await resolveAugments(configs, TMP);

    expect(warningCount()).toBe(1);
    const warnings = allWarnings();
    expect(warnings).toContain('augment "bash"');
    // Negative — silence on the augment whose skill IS present:
    expect(warnings).not.toContain('augment "web-fetch"');
  });
});

// ---------------------------------------------------------------------------
// Case 6: agent boot still succeeds when warnings fire
// ---------------------------------------------------------------------------

describe("skill-validator — boot still succeeds despite warnings", () => {
  test("resolveAugments returns the populated array even when warnings emit", async () => {
    const configs: AugmentConfig[] = [{ name: "fetch", type: "webFetch", options: {} }];

    const augments = await resolveAugments(configs, TMP);

    // No exception thrown. Augment is fully resolved + named.
    expect(augments).toHaveLength(1);
    expect(augments[0]!.name).toBe("fetch");
    expect(augments[0]!.tools).toBeDefined();
    expect(augments[0]!.tools![0]!.name).toBe("web_fetch");
    // Warning fired alongside the successful resolution.
    expect(warningCount()).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Case 7: augment FOLDER name vs operator name distinction
// ---------------------------------------------------------------------------

describe("skill-validator — folder name vs operator name", () => {
  test('operator names augment "fetch" (type webFetch); warning still says "web-fetch"', async () => {
    const configs: AugmentConfig[] = [
      // Operator-chosen name diverges from the augment folder name.
      { name: "fetch", type: "webFetch", options: {} },
    ];

    await resolveAugments(configs, TMP);

    const warnings = allWarnings();
    // The warning blames the FOLDER (web-fetch) because that's what
    // `auggy add-skill <folder>` takes — naming the operator's "fetch"
    // would dead-end the remediation hint.
    expect(warnings).toContain('augment "web-fetch"');
    expect(warnings).toContain("auggy add-skill web-fetch");
    expect(warnings).toContain("skills/web-fetch/SKILL.md");
    // The operator's chosen name MUST NOT appear in the headline blame
    // (would mislead about the remediation command).
    expect(warnings).not.toContain('augment "fetch"');
    expect(warnings).not.toContain("auggy add-skill fetch ");
  });
});

// ---------------------------------------------------------------------------
// Bonus: idempotence — repeat resolutions produce repeat (consistent) warnings
// ---------------------------------------------------------------------------

describe("skill-validator — idempotent across repeat resolutions", () => {
  test("two resolveAugments calls each produce one warning, identical message", async () => {
    const configs: AugmentConfig[] = [{ name: "fetch", type: "webFetch", options: {} }];

    await resolveAugments(configs, TMP);
    const firstCalls = warnSpy.mock.calls.length;
    const firstMessage = warnSpy.mock.calls[0]?.[0];

    await resolveAugments(configs, TMP);
    const secondCalls = warnSpy.mock.calls.length;
    const secondMessage = warnSpy.mock.calls[firstCalls]?.[0];

    expect(secondCalls - firstCalls).toBe(1);
    expect(secondMessage).toBe(firstMessage);
  });
});

// ---------------------------------------------------------------------------
// Bonus: custom augments do not get the validator's warning
// ---------------------------------------------------------------------------

describe("skill-validator — custom augments not validated", () => {
  test("custom augment exposing tools but with no folder map → no validator warning", async () => {
    const customPath = join(TMP, "custom-tool-augment.ts");
    writeFileSync(
      customPath,
      `import { defineTool } from "../../../src/helpers";
       import { z } from "zod";

       const fakeTool = defineTool({
         name: "fake_tool",
         description: "noop",
         category: "meta",
         input: z.object({}),
         execute: async () => "ok",
       });

       export default function() {
         return {
           name: "custom",
           capabilities: ["tools"],
           tools: [fakeTool],
         };
       }`,
    );

    const configs: AugmentConfig[] = [
      {
        name: "my-custom",
        type: "custom",
        source: "./custom-tool-augment.ts",
        options: {},
      },
    ];

    await resolveAugments(configs, TMP);

    // The custom augment HAS tools.length > 0 but the validator skips
    // custom augments by convention — operator owns their own teaching.
    expect(warningCount()).toBe(0);
  });
});
