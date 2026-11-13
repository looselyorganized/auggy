import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { createPostgresTestGate } from "../helpers/postgres-required-mode";

const requiredEnvironment = {
  AUGGY_REQUIRE_POSTGRES_TESTS: "1",
  AUGGY_TEST_POSTGRES_URL: "postgresql://localhost/test",
};

describe("required PostgreSQL integration coverage", () => {
  test("ordinary local runs retain optional database skips", () => {
    const gate = createPostgresTestGate({});
    expect(gate.required).toBeFalse();
    expect(gate.url).toBeUndefined();
    gate.track(async () => {});
    expect(gate.verifyComplete()).toMatchObject({ registered: 1, completed: 0 });
  });

  test.each([undefined, "", "  "])("rejects missing required URL %j", (url) => {
    expect(() =>
      createPostgresTestGate({ AUGGY_REQUIRE_POSTGRES_TESTS: "1", AUGGY_TEST_POSTGRES_URL: url }),
    ).toThrow("need AUGGY_TEST_POSTGRES_URL");
  });

  test("rejects misspelled required-mode flags", () => {
    expect(() => createPostgresTestGate({ AUGGY_REQUIRE_POSTGRES_TESTS: "true" })).toThrow(
      "must equal 1",
    );
  });

  test("requires a live server version and completion of every registered test", async () => {
    const gate = createPostgresTestGate(requiredEnvironment);
    const first = gate.track(async () => {});
    const skipped = gate.track(async () => {});
    await first();
    expect(() => gate.verifyComplete()).toThrow("did not complete");
    gate.verifyServerVersion(170010);
    expect(() => gate.verifyComplete()).toThrow("did not complete");
    await skipped();
    expect(gate.verifyComplete()).toEqual({
      required: true,
      registered: 2,
      completed: 2,
      serverVersion: 170010,
    });
  });

  test("rejects an empty suite and does not count a failed case as completed", async () => {
    const gate = createPostgresTestGate(requiredEnvironment);
    gate.verifyServerVersion(170010);
    expect(() => gate.verifyComplete()).toThrow("did not complete");
    const failed = gate.track(async () => {
      throw new Error("case failed");
    });
    await expect(failed()).rejects.toThrow("case failed");
    expect(() => gate.verifyComplete()).toThrow("did not complete");
  });

  test.each([undefined, null, "170010", 160010, 180000, 170000.5])(
    "rejects unsupported or unverified server version %j",
    (version) => {
      expect(() =>
        createPostgresTestGate(requiredEnvironment).verifyServerVersion(version),
      ).toThrow("PostgreSQL 17");
    },
  );

  test("actual integration entrypoint fails instead of skipping when required URL is absent", () => {
    const result = spawnSync(
      process.execPath,
      ["test", "tests/coordination/postgres-distributed-turn-coordinator.test.ts"],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: { ...process.env, AUGGY_REQUIRE_POSTGRES_TESTS: "1", AUGGY_TEST_POSTGRES_URL: "" },
        encoding: "utf8",
        timeout: 10_000,
        maxBuffer: 64 * 1024,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Required PostgreSQL tests need AUGGY_TEST_POSTGRES_URL");
  });
});
