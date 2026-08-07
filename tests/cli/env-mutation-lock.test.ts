import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  acquireAgentEnvMutationLock,
  isAgentEnvMutationLockSupportedPlatform,
  withAgentEnvMutationLockSync,
} from "../../src/cli/env-mutation-lock";

const roots: string[] = [];

function tempAgent(): string {
  const root = mkdtempSync(join(tmpdir(), "auggy-env-lock-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("agent environment mutation lock", () => {
  test("makes the supported credential-mutation platforms explicit", () => {
    expect(isAgentEnvMutationLockSupportedPlatform("darwin")).toBe(true);
    expect(isAgentEnvMutationLockSupportedPlatform("linux")).toBe(true);
    expect(isAgentEnvMutationLockSupportedPlatform("win32")).toBe(false);
    expect(isAgentEnvMutationLockSupportedPlatform("freebsd")).toBe(false);
  });

  test("fails immediately on contention, creates no artifact, and is reusable after release", () => {
    const root = tempAgent();
    const first = acquireAgentEnvMutationLock(root);
    expect(() => acquireAgentEnvMutationLock(root)).toThrow(/being updated by another Auggy/);
    expect(readdirSync(root)).toEqual([]);
    first.release();

    const second = acquireAgentEnvMutationLock(root);
    second.release();
    expect(readdirSync(root)).toEqual([]);
  });

  test("releases the lease in finally after a mutation throws", () => {
    const root = tempAgent();
    expect(() =>
      withAgentEnvMutationLockSync(root, () => {
        throw new Error("mutation failed");
      }),
    ).toThrow("mutation failed");

    const lease = acquireAgentEnvMutationLock(root);
    lease.release();
  });

  test("rejects a non-directory target without modifying it", () => {
    const root = tempAgent();
    const file = join(root, "not-an-agent-directory");
    writeFileSync(file, "sentinel");

    expect(() => acquireAgentEnvMutationLock(file)).toThrow(/could not acquire/i);
    expect(readdirSync(root)).toEqual(["not-an-agent-directory"]);
  });
});
