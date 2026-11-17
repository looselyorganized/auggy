/** Scenario order only. Provider ownership, commands and assertions belong to the driver. */
export type HostedScenario = "http" | "polling" | "recovery-http" | "recovery-polling";
export interface HostedScenarioDriver {
  prepare(): Promise<void>;
  allocate(recovery: boolean): Promise<void>;
  exercise(generation: "baseline" | "edited" | "restored"): Promise<void>;
  stop(): Promise<void>;
  backup(): Promise<void>;
  restore(): Promise<void>;
  cleanup(): Promise<void>;
}
export interface HostedScenarioResult {
  scenario: HostedScenario;
  status: "passed" | "failed";
  completed: string[];
  failure: { phase: string; message: string } | null;
  cleanup: { status: "passed" | "failed"; message?: string };
}
/** A failed/ambiguous operation is never repeated; cleanup has its own result. */
export async function runHostedScenario(
  scenario: HostedScenario,
  driver: HostedScenarioDriver,
  record: (phase: string, status: "starting" | "passed" | "failed", error?: unknown) => void,
): Promise<HostedScenarioResult> {
  const result: HostedScenarioResult = {
    scenario,
    status: "failed",
    completed: [],
    failure: null,
    cleanup: { status: "passed" },
  };
  const step = async (phase: string, work: () => Promise<void>) => {
    record(phase, "starting");
    try {
      await work();
      result.completed.push(phase);
      record(phase, "passed");
    } catch (error) {
      result.failure = { phase, message: error instanceof Error ? error.message : String(error) };
      record(phase, "failed", error);
      throw error;
    }
  };
  try {
    const recovery = scenario.startsWith("recovery-");
    await step("prepare", () => driver.prepare());
    await step("allocate", () => driver.allocate(recovery));
    await step("baseline", () => driver.exercise("baseline"));
    await step("stop-baseline", () => driver.stop());
    if (scenario === "recovery-http") await step("backup", () => driver.backup());
    await step("replacement", () => driver.exercise("edited"));
    await step("stop-replacement", () => driver.stop());
    if (scenario === "recovery-polling") await step("backup", () => driver.backup());
    if (recovery) {
      await step("restore", () => driver.restore());
      await step("restored", () => driver.exercise("restored"));
      await step("stop-restored", () => driver.stop());
    }
  } catch {
    // The failing phase retained its error. Cleanup runs even after partial allocation.
  } finally {
    record("cleanup", "starting");
    try {
      await driver.cleanup();
      record("cleanup", "passed");
    } catch (error) {
      result.cleanup = {
        status: "failed",
        message: error instanceof Error ? error.message : String(error),
      };
      record("cleanup", "failed", error);
    }
  }
  if (!result.failure && result.cleanup.status === "passed") result.status = "passed";
  return result;
}
