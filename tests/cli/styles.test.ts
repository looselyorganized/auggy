import { describe, expect, test } from "bun:test";
import {
  errorLabel,
  failureMark,
  infoLabel,
  successMark,
  warningLabel,
} from "../../src/cli/_shared/styles";

describe("CLI styles", () => {
  test("keeps status markers plain without color", () => {
    expect(successMark({ color: false })).toBe("✔");
    expect(failureMark({ color: false })).toBe("✖");
    expect(infoLabel({ color: false })).toBe("INFO");
    expect(warningLabel({ color: false })).toBe("WARN");
    expect(errorLabel({ color: false })).toBe("ERROR");
  });

  test("colors status markers for TTY output", () => {
    expect(successMark({ color: true })).toBe("\x1b[32m✔\x1b[0m");
    expect(failureMark({ color: true })).toBe("\x1b[31m✖\x1b[0m");
    expect(infoLabel({ color: true })).toBe("\x1b[36mINFO\x1b[0m");
    expect(warningLabel({ color: true })).toBe("\x1b[33mWARN\x1b[0m");
    expect(errorLabel({ color: true })).toBe("\x1b[31mERROR\x1b[0m");
  });
});
