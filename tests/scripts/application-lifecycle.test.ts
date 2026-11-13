import { expect, test } from "bun:test";
import { assertApplicationLifecycleResult } from "../../scripts/release-smoke/application-lifecycle";

const clean = {
  cleanupConfirmed: true,
  timedOut: false,
  spawnFailed: false,
  exceededOutput: false,
  orphanedGroup: false,
  exitCode: 1,
  signal: null,
  stdout:
    "application-lifecycle-actual-augment-boot\napplication-lifecycle-actual-augment-shutdown\n",
  stderr: "",
};
const expected = { exitCode: 1, signal: null, boots: 1, shutdowns: 1 };

test("lifecycle evidence requires confirmed reap and exact exit semantics", () => {
  expect(() => assertApplicationLifecycleResult(clean, expected)).not.toThrow();
  for (const change of [
    { cleanupConfirmed: false },
    { timedOut: true },
    { spawnFailed: true },
    { exceededOutput: true },
    { orphanedGroup: true },
    { exitCode: 0 },
    { signal: "SIGKILL" as const },
  ])
    expect(() => assertApplicationLifecycleResult({ ...clean, ...change }, expected)).toThrow();
});

test("duplicate or quoted shutdown markers cannot prove exactly-once cleanup", () => {
  for (const stdout of [
    `${clean.stdout}application-lifecycle-actual-augment-shutdown\n`,
    'application-lifecycle-actual-augment-boot\nthrow new Error("application-lifecycle-actual-augment-shutdown");\n',
    "application-lifecycle-actual-augment-boot\n",
  ])
    expect(() => assertApplicationLifecycleResult({ ...clean, stdout }, expected)).toThrow();
  expect(() =>
    assertApplicationLifecycleResult(
      { ...clean, exitCode: 137, stdout: "application-lifecycle-actual-augment-boot\n" },
      { exitCode: 137, signal: null, boots: 1, shutdowns: 0 },
    ),
  ).not.toThrow();
});

test("startup fault evidence requires the anchored thrown error, not a source code frame", () => {
  const fault = { ...expected, fault: "after-start" as const };
  for (const stderr of [
    '12 | throw new Error("application-lifecycle-after-start-fault");',
    "Error: unrelated listener failure",
    "Error: application-lifecycle-prepare-fault",
  ])
    expect(() => assertApplicationLifecycleResult({ ...clean, stderr }, fault)).toThrow();
  for (const stderr of [
    "error: application-lifecycle-after-start-fault\n    at main (...)",
    "Error: application-lifecycle-after-start-fault\n",
  ])
    expect(() => assertApplicationLifecycleResult({ ...clean, stderr }, fault)).not.toThrow();
});
