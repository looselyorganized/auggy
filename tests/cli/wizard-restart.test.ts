import { describe, test, expect } from "bun:test";
import { AbortPromptError } from "@inquirer/core";
import { withEscRestart, WizardRestartRequested } from "../../src/cli/wizard-restart";

describe("withEscRestart", () => {
  test("returns the prompt's resolved value on success", async () => {
    const result = await withEscRestart(async (ctx) => {
      expect(ctx.signal).toBeInstanceOf(AbortSignal);
      return "ok";
    });
    expect(result).toBe("ok");
  });

  test("non-TTY: passes a never-aborting signal", async () => {
    // In `bun test`, process.stdin.isTTY is undefined → wrapper takes the
    // non-TTY branch, no keypress listener attached.
    const result = await withEscRestart(async (ctx) => {
      expect(ctx.signal.aborted).toBe(false);
      return 42;
    });
    expect(result).toBe(42);
  });

  test("re-throws unrelated errors verbatim", async () => {
    const error = new Error("network");
    await expect(
      withEscRestart(async () => {
        throw error;
      }),
    ).rejects.toBe(error);
  });

  test("translates AbortPromptError into WizardRestartRequested", async () => {
    await expect(
      withEscRestart(async () => {
        throw new AbortPromptError();
      }),
    ).rejects.toBeInstanceOf(WizardRestartRequested);
  });

  test("WizardRestartRequested carries the expected name", () => {
    const err = new WizardRestartRequested();
    expect(err.name).toBe("WizardRestartRequested");
    expect(err.message).toMatch(/Esc/i);
  });
});
