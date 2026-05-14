import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { extractBearerFromEnv } from "../../src/lib/bearer";

let dir: string;

beforeEach(() => {
  // mkdtempSync uses kernel-generated suffix → atomic, unpredictable, no
  // CodeQL js/insecure-temporary-file warnings on writes inside.
  dir = mkdtempSync(join(tmpdir(), "bearer-test-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("extractBearerFromEnv", () => {
  it("returns null when .env file is missing", () => {
    expect(extractBearerFromEnv(dir)).toBeNull();
  });

  it("extracts an unquoted bearer", () => {
    writeFileSync(join(dir, ".env"), "AUGGY_WEB_TOKEN=abc123\n");
    expect(extractBearerFromEnv(dir)).toBe("abc123");
  });

  it("extracts a double-quoted bearer", () => {
    writeFileSync(join(dir, ".env"), `AUGGY_WEB_TOKEN="abc 123"\n`);
    expect(extractBearerFromEnv(dir)).toBe("abc 123");
  });

  it("extracts a single-quoted bearer", () => {
    writeFileSync(join(dir, ".env"), `AUGGY_WEB_TOKEN='abc 123'\n`);
    expect(extractBearerFromEnv(dir)).toBe("abc 123");
  });

  it("ignores comment lines starting with #", () => {
    writeFileSync(join(dir, ".env"), `# AUGGY_WEB_TOKEN=ignored\nAUGGY_WEB_TOKEN=real\n`);
    expect(extractBearerFromEnv(dir)).toBe("real");
  });

  it("returns null when AUGGY_WEB_TOKEN is absent", () => {
    writeFileSync(join(dir, ".env"), `OTHER_VAR=x\n`);
    expect(extractBearerFromEnv(dir)).toBeNull();
  });

  it("trims surrounding whitespace from value", () => {
    writeFileSync(join(dir, ".env"), `AUGGY_WEB_TOKEN=   abc   \n`);
    expect(extractBearerFromEnv(dir)).toBe("abc");
  });

  it("handles CRLF line endings", () => {
    writeFileSync(join(dir, ".env"), `OTHER=x\r\nAUGGY_WEB_TOKEN=abc\r\n`);
    expect(extractBearerFromEnv(dir)).toBe("abc");
  });

  it("returns first AUGGY_WEB_TOKEN if duplicated", () => {
    writeFileSync(join(dir, ".env"), `AUGGY_WEB_TOKEN=first\nAUGGY_WEB_TOKEN=second\n`);
    expect(extractBearerFromEnv(dir)).toBe("first");
  });
});
