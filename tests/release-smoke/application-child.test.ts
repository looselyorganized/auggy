import { expect, test } from "bun:test";
import {
  APPLICATION_BOUNDS,
  startApplicationChild,
} from "../../scripts/release-smoke/application-child";

const options = {
  command: [process.execPath, "--no-env-file", "--eval", "process.exit(0)"],
  cwd: process.cwd(),
  env: { PATH: "/usr/bin:/bin" },
  secrets: [],
};
test("ordinary children retain 120s ceiling while deployment profile has a finite explicit cap", async () => {
  expect(() => startApplicationChild({ ...options, timeoutMs: 120001 })).toThrow("lifetime bound");
  expect(() =>
    startApplicationChild({
      ...options,
      lifetimeProfile: "hosted-deployment",
      timeoutMs: APPLICATION_BOUNDS.deploymentMs + 1,
    }),
  ).toThrow("lifetime bound");
  const result = await startApplicationChild({
    ...options,
    lifetimeProfile: "hosted-deployment",
    timeoutMs: APPLICATION_BOUNDS.deploymentMs,
  }).finish();
  expect(result.exitCode).toBe(0);
  expect(result.cleanupConfirmed).toBe(true);
});
test("deployment profile retains timeout and process-group reaping", async () => {
  const result = await startApplicationChild({
    ...options,
    command: [process.execPath, "--no-env-file", "--eval", "setInterval(() => {}, 1000)"],
    lifetimeProfile: "hosted-deployment",
    timeoutMs: 100,
  }).finish();
  expect(result.timedOut).toBe(true);
  expect(result.cleanupConfirmed).toBe(true);
  expect(result.orphanedGroup).toBe(false);
});
