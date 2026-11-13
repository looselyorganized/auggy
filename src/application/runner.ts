import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type {
  ApplicationLaunch,
  ApplicationMain,
  ApplicationReady,
  ApplicationRunner,
  HostStopResult,
} from "../types";
import { readApplicationDefinition } from "../cli/application-definition";
import { inspectProjectRuntime } from "../cli/project-runtime";
import type { ParsedConfig } from "../cli/types";
import { createApplicationHost, type OwnedApplicationHost } from "./host";
import type { RuntimeOwnershipOptions } from "./runtime-ownership";

/** Validated package CLI/operator input, never application-supplied identity. */
export interface ManagedLaunchOptions extends RuntimeOwnershipOptions {
  configPath: string;
  legacy?: boolean;
  lifetime?: "until-shutdown" | "return-after-ready";
  onReady?: (ready: ApplicationReady) => void | Promise<void>;
  onConfigured?: (config: ParsedConfig) => void;
}

export const runApplication: ApplicationRunner = async (main, direct) => {
  const definition = readApplicationDefinition(fileURLToPath(direct.config));
  if (!definition) throw new Error("[application] configured entrypoint declaration is required");
  if (realpathSync(fileURLToPath(direct.entrypoint)) !== definition.entrypointPath) {
    throw new Error("[application] direct entrypoint differs from configured entrypoint");
  }
  const selected = inspectProjectRuntime(definition.projectDir, { applicationContract: 1 });
  const packageRoot = realpathSync(fileURLToPath(new URL("../..", import.meta.url)));
  if (selected.packageRoot !== packageRoot) {
    throw new Error("[application] start with the project's explicitly installed Auggy runtime");
  }
  await runManagedApplication(main, { configPath: definition.configPath, mode: "direct" });
};

function clean(result: HostStopResult | undefined): boolean {
  return result === undefined || (result.status === "stopped" && result.cleanup === "complete");
}

/** One runner owns signals before application code obtains a host. */
export async function runManagedApplication(
  main: ApplicationMain,
  options: ManagedLaunchOptions,
): Promise<void> {
  let owned: OwnedApplicationHost | undefined;
  let terminating = false;
  let startupFailed = false;
  let signalShutdown: Promise<void> | undefined;
  const removeSignals = () => {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  };
  const onSignal = () => {
    if (signalShutdown) return;
    terminating = true;
    signalShutdown = (async () => {
      const stopped = await owned?.stop({ deadlineMs: 15_000 });
      removeSignals();
      // Retained claims are intentionally not erased before process termination.
      process.exit(!startupFailed && clean(stopped) ? 0 : 1);
    })().catch(() => {
      removeSignals();
      process.exit(1);
    });
  };
  const launch: ApplicationLaunch = Object.freeze({
    configPath: options.configPath,
    mode: options.mode,
    createHost(input: Parameters<ApplicationLaunch["createHost"]>[0]) {
      if (owned || terminating)
        throw new Error("[application] exactly one host is allowed per launch");
      // Construction acquires nothing. Assignment registers cleanup before return.
      owned = createApplicationHost({ ...options, compose: input.compose });
      return owned;
    },
  });
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    await main(launch);
    if (!owned?.isReady || !owned.readiness)
      throw new Error("[application] main returned without a ready host");
    await options.onReady?.(owned.readiness);
  } catch (error) {
    startupFailed = true;
    terminating = true;
    process.exitCode = 1;
    let stopped: HostStopResult | undefined;
    try {
      stopped = await owned?.stop({ deadlineMs: 15_000 });
    } finally {
      removeSignals();
    }
    if (stopped?.status === "retained") process.exit(1);
    throw error;
  }
  if (options.lifetime === "return-after-ready") {
    void owned.closed.then((stopped) => {
      removeSignals();
      if (!clean(stopped)) {
        process.exitCode = 1;
        if (stopped.status === "retained") process.exit(1);
      }
    });
    return;
  }
  const stopped = await owned.closed;
  removeSignals();
  if (!clean(stopped)) {
    process.exitCode = 1;
    if (stopped.status === "retained") process.exit(1);
  }
}

/** Legacy runDev returns after readiness while the same runner retains signals. */
export async function runLegacyApplication(options: ManagedLaunchOptions): Promise<void> {
  await runManagedApplication(
    async (launch) => {
      const host = launch.createHost({
        compose: () => {
          throw new Error("legacy composition is package-owned");
        },
      });
      const prepared = await host.prepare();
      await host.start({
        http: prepared.http.map((web) =>
          web.createListener({
            routes: [{ method: "POST", path: "/agent/run", handle: web.agentRun }],
            fallback: web.fallback,
          }),
        ),
      });
    },
    { ...options, legacy: true, lifetime: "return-after-ready" },
  );
}
