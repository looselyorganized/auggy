import { expect, test } from "bun:test";
import {
  runHostedScenario,
  type HostedScenarioDriver,
} from "../../scripts/release-smoke/hosted-scenarios";

function fake(fail?: string) {
  const calls: string[] = [];
  const call = async (name: string) => {
    calls.push(name);
    if (fail?.split(",").includes(name)) throw Error(`${name} refused`);
  };
  const driver: HostedScenarioDriver = {
    prepare: () => call("prepare"),
    allocate: (recovery) => call(recovery ? "allocate-recovery" : "allocate"),
    exercise: (generation) => call(generation),
    stop: () => call("stop"),
    backup: () => call("backup"),
    restore: () => call("restore"),
    cleanup: () => call("cleanup"),
  };
  return { calls, driver };
}

test("hosting scenarios run independently without recovery allocation or commands", async () => {
  for (const scenario of ["http", "polling"] as const) {
    const { calls, driver } = fake();
    const result = await runHostedScenario(scenario, driver, () => {});
    expect(result.status).toBe("passed");
    expect(calls).toEqual(["prepare", "allocate", "baseline", "stop", "edited", "stop", "cleanup"]);
  }
});

test("recovery backs up older state before replacement and uses a distinct recovery allocation", async () => {
  const { calls, driver } = fake();
  expect((await runHostedScenario("recovery-http", driver, () => {})).status).toBe("passed");
  expect(calls).toEqual([
    "prepare",
    "allocate-recovery",
    "baseline",
    "stop",
    "backup",
    "edited",
    "stop",
    "restore",
    "restored",
    "stop",
    "cleanup",
  ]);
});

test.each(["prepare", "allocate", "baseline", "stop", "edited"])(
  "%s failure retains the failing phase, stops work and cleans up exactly once",
  async (failure) => {
    const { calls, driver } = fake(failure);
    const events: string[] = [];
    const result = await runHostedScenario("http", driver, (phase, status) => {
      events.push(`${phase}:${status}`);
    });
    expect(result.status).toBe("failed");
    expect(result.failure?.message).toBe(`${failure} refused`);
    expect(result.cleanup.status).toBe("passed");
    expect(calls.at(-1)).toBe("cleanup");
    expect(calls.filter((call) => call === failure)).toHaveLength(1);
    expect(calls.filter((call) => call === "cleanup")).toHaveLength(1);
    expect(events).toContain(`${result.failure!.phase}:failed`);
  },
);

test("cleanup failure cannot convert failed or successful execution into acceptance", async () => {
  for (const failure of ["cleanup", "baseline,cleanup"]) {
    const { driver } = fake(failure);
    const result = await runHostedScenario("polling", driver, () => {});
    expect(result.status).toBe("failed");
    expect(result.cleanup).toEqual({ status: "failed", message: "cleanup refused" });
    expect(result.failure?.message ?? null).toBe(
      failure.startsWith("baseline") ? "baseline refused" : null,
    );
  }
});
