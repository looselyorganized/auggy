/** One explicit hosted scenario. Default is local preparation; --execute allocates isolated resources. */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { createHostedContext, readHostedInput } from "./hosted-context";
import { createHostedDriver } from "./hosted-driver";
import { runHostedScenario } from "./hosted-scenarios";

export function parseHostedArguments(args: readonly string[]) {
  const values: Record<string, string> = {};
  let execute = false;
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    if (flag === "--execute") {
      if (execute) throw Error("Duplicate --execute");
      execute = true;
      continue;
    }
    if (
      !["--scenario", "--input", "--out"].includes(flag) ||
      values[flag] !== undefined ||
      !args[i + 1] ||
      args[i + 1]!.startsWith("--")
    )
      throw Error(
        "Use --scenario http|polling|recovery-http|recovery-polling --input <json> --out <new-directory> [--execute]",
      );
    values[flag] = args[++i]!;
  }
  return {
    scenario: z
      .enum(["http", "polling", "recovery-http", "recovery-polling"])
      .parse(values["--scenario"]),
    input: z.string().min(1).parse(values["--input"]),
    output: z.string().min(1).parse(values["--out"]),
    execute,
  };
}
export async function main(args: readonly string[]) {
  const options = parseHostedArguments(args);
  const ctx = createHostedContext(readHostedInput(options.input), options.output);
  const driver = createHostedDriver(ctx, options.scenario);
  try {
    if (!options.execute) {
      await driver.prepare();
      ctx.save("result.json", {
        status: "prepared",
        scenario: options.scenario,
        hostedResourcesCreated: false,
      });
      console.log(
        JSON.stringify({
          status: "prepared",
          scenario: options.scenario,
          hostedResourcesCreated: false,
          output: ctx.root,
        }),
      );
      for (const name of ["work", "tmp", "home", "auth", "maintenance-context"])
        rmSync(join(ctx.root, name), { recursive: true, force: true });
      return 0;
    }
    ctx.save("input.json", {
      ...ctx.input,
      scenario: options.scenario,
      runId: ctx.runId,
      executionRequested: true,
      resourceLimits: {
        services: options.scenario.startsWith("recovery-") ? 2 : 1,
        volumes: options.scenario.startsWith("recovery-") ? 2 : 1,
        cpu: 4,
        memoryBytes: 4000000000,
        volumeMB: 50000,
        monitoredSpendUSD: 5,
        cleanupSeconds: 600,
      },
    });
    const result = await runHostedScenario(options.scenario, driver, (...event) =>
      ctx.event(...event),
    );
    ctx.save("result.json", result);
    console.log(
      JSON.stringify({
        scenario: result.scenario,
        status: result.status,
        cleanup: result.cleanup.status,
        output: ctx.root,
      }),
    );
    // Original fixture inputs and selected archives remain outside this run.
    // Keep readable evidence, rather than another copy of installed dependencies or credentials.
    if (result.cleanup.status === "passed")
      for (const name of ["work", "tmp", "home", "auth", "maintenance-context"])
        rmSync(join(ctx.root, name), { recursive: true, force: true });
    return result.status === "passed" ? 0 : 1;
  } catch (error) {
    ctx.event("runner", "failed", error);
    if (!options.execute) {
      ctx.save("result.json", {
        status: "failed",
        scenario: options.scenario,
        phase: "prepare",
        hostedResourcesCreated: false,
        error: error instanceof Error ? error.message : String(error),
      });
      for (const name of ["work", "tmp", "home", "auth", "maintenance-context"])
        rmSync(join(ctx.root, name), { recursive: true, force: true });
    }
    return 1;
  } finally {
    ctx.close();
  }
}
if (import.meta.main) process.exitCode = await main(process.argv.slice(2));
