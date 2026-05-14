import { describe, expect, it, beforeEach, afterEach } from "bun:test";
import { resolveConfigBool } from "@/config/resolve";

describe("resolveConfigBool", () => {
  const ENV_KEY = "AUGGY_TEST_FLAG_SHOULD_NOT_LEAK";
  let originalValue: string | undefined;

  beforeEach(() => {
    originalValue = process.env[ENV_KEY];
    delete process.env[ENV_KEY];
  });

  afterEach(() => {
    if (originalValue === undefined) delete process.env[ENV_KEY];
    else process.env[ENV_KEY] = originalValue;
  });

  it("returns yaml value when set, even if env and default disagree", () => {
    process.env[ENV_KEY] = "true";
    expect(resolveConfigBool(false, ENV_KEY, () => true)).toEqual({
      value: false,
      source: "yaml",
    });
  });

  it("yaml=true wins regardless of env / default", () => {
    process.env[ENV_KEY] = "false";
    expect(resolveConfigBool(true, ENV_KEY, () => false)).toEqual({
      value: true,
      source: "yaml",
    });
  });

  it("falls through to env when yaml is undefined", () => {
    process.env[ENV_KEY] = "true";
    expect(resolveConfigBool(undefined, ENV_KEY, () => false)).toEqual({
      value: true,
      source: "env",
    });
  });

  it("env can disable when default would enable", () => {
    process.env[ENV_KEY] = "false";
    expect(resolveConfigBool(undefined, ENV_KEY, () => true)).toEqual({
      value: false,
      source: "env",
    });
  });

  it("ignores env values that aren't strictly 'true' or 'false'", () => {
    process.env[ENV_KEY] = "1";
    expect(resolveConfigBool(undefined, ENV_KEY, () => true)).toEqual({
      value: true,
      source: "default",
    });
  });

  it("ignores env values with wrong case", () => {
    process.env[ENV_KEY] = "TRUE";
    expect(resolveConfigBool(undefined, ENV_KEY, () => false)).toEqual({
      value: false,
      source: "default",
    });
  });

  it("falls through to default when both yaml and env are unset", () => {
    expect(resolveConfigBool(undefined, ENV_KEY, () => true)).toEqual({
      value: true,
      source: "default",
    });
  });

  it("defaultFn is evaluated lazily (only when yaml + env are unset)", () => {
    let calls = 0;
    const fn = () => {
      calls += 1;
      return true;
    };
    process.env[ENV_KEY] = "false";
    resolveConfigBool(undefined, ENV_KEY, fn);
    expect(calls).toBe(0);
    resolveConfigBool(true, ENV_KEY, fn);
    expect(calls).toBe(0);
    delete process.env[ENV_KEY];
    resolveConfigBool(undefined, ENV_KEY, fn);
    expect(calls).toBe(1);
  });

  it("distinguishes yaml=false (set) from yaml=undefined (unset)", () => {
    process.env[ENV_KEY] = "true";
    expect(resolveConfigBool(false, ENV_KEY, () => true)).toEqual({
      value: false,
      source: "yaml",
    });
  });
});
