import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseHostedArguments } from "../../scripts/release-smoke/hosted-runner";
import { stoppedScenarioInstance } from "../../scripts/release-smoke/hosted-driver";
import { createHostedContext, hostedInputSchema } from "../../scripts/release-smoke/hosted-context";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function context() {
  const root = mkdtempSync(join(realpathSync(tmpdir()), "m5-runner-test-"));
  roots.push(root);
  const env = join(root, "fixture.env");
  writeFileSync(env, "AUGGY_AUTH_SECRET=private-fixture-secret\n", { mode: 0o600 });
  const input = hostedInputSchema.parse({
    version: 1,
    workspaceId: "00000000-0000-4000-8000-000000000001",
    revision: "a".repeat(40),
    baselineConsumer: root,
    editedConsumer: root,
    environmentFile: env,
    knownHostsFile: join(root, "known_hosts"),
    packages: [
      { name: "auggy", path: "core.tgz", sha256: "a".repeat(64) },
      { name: "@auggy/anthropic", path: "provider.tgz", sha256: "b".repeat(64) },
    ],
  });
  return createHostedContext(input, join(root, "run"));
}

test("hosted execution is explicit and malformed/duplicate flags fail before allocation", () => {
  const base = ["--scenario", "polling", "--input", "input.json", "--out", "/tmp/new"];
  expect(parseHostedArguments(base).execute).toBe(false);
  expect(parseHostedArguments([...base, "--execute"]).execute).toBe(true);
  for (const args of [
    [...base, "--execute", "--execute"],
    [...base, "--scenario", "http"],
    [...base, "--unknown"],
    ["--scenario", "all"],
    [],
  ])
    expect(() => parseHostedArguments(args)).toThrow();
});
test("stopped proof preserves the observed status and refuses substituted or live instances", () => {
  const id = "00000000-0000-4000-8000-000000000001";
  for (const status of ["STOPPED", "EXITED", "REMOVED"] as const)
    expect(stoppedScenarioInstance(id, [{ id, status }])).toEqual({ id, status });
  expect(() => stoppedScenarioInstance(id, [{ id, status: "RUNNING" }])).toThrow();
  expect(() =>
    stoppedScenarioInstance(id, [
      { id: "00000000-0000-4000-8000-000000000002", status: "STOPPED" },
    ]),
  ).toThrow();
  expect(() => stoppedScenarioInstance(id, [])).toThrow();
  expect(
    stoppedScenarioInstance(id, [
      { id, status: "EXITED" },
      { id: "00000000-0000-4000-8000-000000000002", status: "STOPPED" },
    ]).status,
  ).toBe("EXITED");
  expect(() =>
    stoppedScenarioInstance(id, [
      { id, status: "STOPPED" },
      { id: "00000000-0000-4000-8000-000000000002", status: "RUNNING" },
    ]),
  ).toThrow();
  expect(() =>
    stoppedScenarioInstance(id, [
      { id, status: "STOPPED" },
      { id, status: "STOPPED" },
    ]),
  ).toThrow();
});

test("readable error evidence redacts decoded strings and nested keys", () => {
  const ctx = context();
  ctx.save("failure.json", {
    error: "backup refused private-fixture-secret",
    nested: { "private-fixture-secret": "Bearer exposed-token" },
  });
  const text = readFileSync(join(ctx.root, "evidence/failure.json"), "utf8");
  expect(text).toContain("backup refused");
  expect(text).not.toContain("private-fixture-secret");
  expect(text).not.toContain("exposed-token");
  expect(() => ctx.save("failure.json", {})).toThrow();
  expect(() => ctx.save("../escape.json", {})).toThrow();
});

test("a failed child leaves bounded readable diagnostics and cannot report success", async () => {
  const ctx = context();
  await expect(
    ctx.command("forced-failure", [
      process.execPath,
      "-e",
      "console.error('private-fixture-secret deliberate failure'); process.exit(2)",
    ]),
  ).rejects.toThrow("exit 2");
  const value = JSON.parse(
    readFileSync(join(ctx.root, "evidence/0001-forced-failure.json"), "utf8"),
  );
  expect(value.exitCode).toBe(2);
  expect(value.cleanupConfirmed).toBe(true);
  expect(value.stderr).toContain("deliberate failure");
  expect(value.stderr).not.toContain("private-fixture-secret");
});
