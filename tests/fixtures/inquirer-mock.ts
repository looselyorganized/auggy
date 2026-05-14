import { mock } from "bun:test";

/**
 * Drive `@inquirer/prompts` non-interactively from a test.
 *
 * Several CLI commands (`auggy create`, `auggy add`, `auggy remove`)
 * prompt the operator via `@inquirer/prompts`. To exercise these flows
 * from tests, we register a `mock.module("@inquirer/prompts", ...)`
 * stub that reads pre-supplied answers off the `answers` reference
 * passed in here. The stub MUST be registered BEFORE the command
 * module is imported — otherwise the command's bound `select`/`input`/
 * `checkbox`/`confirm` references will point at the real prompts.
 *
 * Usage pattern (mock-then-import):
 *
 *   const answers: Answers = {};
 *   mockInquirerPrompts(() => answers);
 *   const { runCreate } = await import("../../src/cli/commands/create");
 *
 * Each test then mutates `answers` to drive the next call.
 */

export interface Answers {
  /** `auggy create` provider prompt. Defaults to "anthropic". */
  provider?: string;
  /** `auggy create` model prompt. Defaults to "claude-sonnet-4-6". */
  model?: string;
  /** `auggy create` operator-name input. Defaults to "tester". */
  operatorName?: string;
  /** `auggy create` agent-purpose input. Defaults to "testing". */
  purpose?: string;
  /** Catalog entry `type`s to include in the augment checkbox selection. */
  augmentTypes?: string[];
}

/**
 * Register a `mock.module("@inquirer/prompts", ...)` that reads from the
 * `answers` ref. Pass a getter (rather than the object directly) so the
 * mock always observes the test's latest mutation; closures captured at
 * registration time would otherwise freeze the initial values.
 */
export function mockInquirerPrompts(getAnswers: () => Answers): void {
  mock.module("@inquirer/prompts", () => ({
    select: async (config: {
      message: string;
      choices: Array<{ name?: string; value: unknown }>;
    }) => {
      const answers = getAnswers();
      if (config.message.startsWith("Engine provider")) return answers.provider ?? "anthropic";
      if (config.message.startsWith("Model:")) return answers.model ?? "claude-sonnet-4-6";
      return config.choices[0]?.value;
    },
    input: async (config: { message: string; default?: string }) => {
      const answers = getAnswers();
      if (config.message.startsWith("Operator name")) return answers.operatorName ?? "tester";
      if (config.message.startsWith("Agent purpose")) return answers.purpose ?? "testing";
      return config.default ?? "";
    },
    checkbox: async (config: {
      choices: Array<{
        value: { type: string };
        checked?: boolean;
        disabled?: string | boolean;
      }>;
    }) => {
      // Required entries are pre-checked + disabled in the create flow; treat
      // the test's augmentTypes list as additional optional selections on top.
      // `auggy add` doesn't set `checked` on any choice (available list is
      // already post-filter), so the OR collapses to `wanted.has(...)` there.
      const wanted = new Set(getAnswers().augmentTypes ?? []);
      return config.choices
        .filter((c) => c.checked || wanted.has(c.value.type))
        .map((c) => c.value);
    },
    confirm: async (config: { default?: boolean }) => config.default ?? false,
  }));
}
