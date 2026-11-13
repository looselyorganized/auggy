import { dirname, resolve } from "node:path";
import type {
  AgentComposer,
  AgentComposition,
  AgentConfig,
  AgentExecutionOptions,
  ApplicationReady,
  Augment,
  HostCleanupFailureCode,
  HostStopResult,
  ManagedApplicationHost,
  PreparedApplication,
} from "../types";
import { parseConfig } from "../cli/config-parser";
import type { ParsedConfig } from "../cli/types";
import { resolveEngine } from "../cli/engine-resolver";
import { resolveAugments } from "../cli/augment-resolver";
import {
  createDurableJobsRuntimeIfEnabled,
  type ConfiguredDurableJobsRuntime,
} from "../cli/durable-jobs-runtime";
import { resolveApplicationDefinition } from "../cli/application-definition";
import { createManagedWebTransport, type ManagedWebTransport } from "../transports/web-transport";
import { enumerateDistributedCoordinationBlockers } from "../coordination/topology";
import type { HostedAgentInstance } from "./hosted-agent";
import { acquireRuntimeOwnership, type RuntimeOwnershipOptions } from "./runtime-ownership";
import { hasConfirmedCleanup } from "./cleanup-proof";

export interface ApplicationHostOptions extends RuntimeOwnershipOptions {
  configPath: string;
  compose?: AgentComposer;
  legacy?: boolean;
  onConfigured?: (config: ParsedConfig) => void;
  /** Package tests can control factory timing without replacing the guarded agent. */
  factories?: { resolveEngine?: typeof resolveEngine; resolveAugments?: typeof resolveAugments };
}

export interface OwnedApplicationHost extends ManagedApplicationHost {
  readonly isReady: boolean;
  readonly readiness: ApplicationReady | undefined;
  readonly closed: Promise<HostStopResult>;
}

export function createApplicationHost(options: ApplicationHostOptions): OwnedApplicationHost {
  const configPath = resolve(options.configPath);
  const agentDir = dirname(configPath);
  const bindings: Array<{ web: ManagedWebTransport; port: number; console: boolean }> = [];
  const failures = new Set<HostCleanupFailureCode>();
  let state:
    | "created"
    | "preparing"
    | "prepared"
    | "starting"
    | "ready"
    | "draining"
    | "stopped"
    | "retained" = "created";
  let stopping = false;
  let serving = false;
  let phase: Promise<unknown> | undefined;
  let cleanup: Promise<HostStopResult> | undefined;
  let ownership: ReturnType<typeof acquireRuntimeOwnership> | undefined;
  let augments: Augment[] | undefined;
  let hosted: HostedAgentInstance | undefined;
  let jobs: ConfiguredDurableJobsRuntime | undefined;
  let constructionUnknown = false;
  let readiness: ApplicationReady | undefined;
  let finishClosed!: (result: HostStopResult) => void;
  const closed = new Promise<HostStopResult>((done) => {
    finishClosed = done;
  });

  const assertNotStopping = () => {
    if (stopping) throw new Error("[application] startup interrupted by shutdown");
  };
  const result = (unknown: boolean): HostStopResult =>
    unknown
      ? Object.freeze({
          status: "retained",
          ownership: "retained",
          reason: "outcome-unknown",
          failures: Object.freeze([...failures]),
        })
      : Object.freeze({
          status: "stopped",
          ownership: "released",
          cleanup: failures.size ? "failed" : "complete",
          failures: Object.freeze([...failures]),
        });

  function ensureCleanup(): Promise<HostStopResult> {
    stopping = true;
    serving = false;
    hosted?.closeAdmission();
    for (const binding of bindings) binding.web.closeAdmission();
    if (cleanup) return cleanup;
    state = "draining";
    const entering = phase;
    cleanup = Promise.resolve()
      .then(async () => {
        await entering?.catch(() => {});
        hosted?.closeAdmission();
        for (const binding of bindings) binding.web.closeAdmission();
        let unknown = constructionUnknown;
        try {
          await jobs?.stop();
        } catch {
          failures.add("job-stop-failed");
          unknown = true;
        }
        // Route callbacks can own augment resources without scheduling a turn.
        // Join them before any reverse-order augment shutdown closes those resources.
        for (const binding of bindings) {
          try {
            await binding.web.waitForQuiescence();
          } catch {
            failures.add("augment-shutdown-failed");
            unknown = true;
          }
        }
        if (hosted) {
          try {
            await hosted.agent.stop();
          } catch {
            failures.add("augment-shutdown-failed");
            unknown = true;
          }
          try {
            const settled = await hosted.waitForQuiescence();
            for (const code of settled.failures) failures.add(code);
            if (settled.resourceState !== "closed") unknown = true;
          } catch {
            failures.add("augment-shutdown-failed");
            unknown = true;
          }
        } else if (augments) {
          for (const augment of [...augments].reverse()) {
            try {
              await augment.onShutdown?.();
            } catch {
              failures.add("augment-shutdown-failed");
              if (!hasConfirmedCleanup(augment)) unknown = true;
            }
          }
        }
        try {
          await jobs?.waitForSettlement?.();
        } catch {
          failures.add("job-stop-failed");
          unknown = true;
        }
        for (const binding of bindings) {
          try {
            await binding.web.waitForQuiescence();
            if (binding.web.snapshot().resourceState !== "closed") unknown = true;
          } catch {
            failures.add("augment-shutdown-failed");
            unknown = true;
          }
        }
        try {
          jobs?.close();
        } catch {
          failures.add("job-close-failed");
          unknown = true;
        }
        if (!unknown) {
          try {
            ownership?.release();
          } catch {
            failures.add("resource-release-failed");
            unknown = true;
          }
        }
        state = unknown ? "retained" : "stopped";
        return result(unknown);
      })
      .catch(() => {
        state = "retained";
        failures.add("augment-shutdown-failed");
        return result(true);
      });
    void cleanup.then(finishClosed);
    return cleanup;
  }

  const host: OwnedApplicationHost = {
    get isReady() {
      return state === "ready";
    },
    get readiness() {
      return readiness;
    },
    closed,
    prepare(): Promise<PreparedApplication> {
      if (state !== "created" || stopping)
        return Promise.reject(new Error("[application] host preparation is one-shot"));
      state = "preparing";
      const work = (async (): Promise<PreparedApplication> => {
        const config = parseConfig(configPath);
        if (!options.legacy) {
          if (!config.application)
            throw new Error("[application] entrypoint declaration is required");
          resolveApplicationDefinition(configPath, config.application);
        }
        if (config.settings.coordination && enumerateDistributedCoordinationBlockers().length) {
          throw new Error(
            "[application] distributed coordination is not available for ordinary startup",
          );
        }
        options.onConfigured?.(config);
        ownership = acquireRuntimeOwnership(configPath, config, options, (acquired) => {
          ownership = acquired;
        });
        assertNotStopping();
        const model = await (options.factories?.resolveEngine ?? resolveEngine)(
          config.engine,
          agentDir,
        );
        assertNotStopping();
        let rollbackReported = false;
        try {
          augments = await (options.factories?.resolveAugments ?? resolveAugments)(
            config.augments,
            agentDir,
            {
              creator: config.creator,
              agentId: config.id,
              ...(ownership.runtimeDataRoot ? { runtimeDataRoot: ownership.runtimeDataRoot } : {}),
              selfInspection: {
                name: config.name,
                displayName: config.displayName,
                purpose: config.purpose,
                engine: { provider: config.engine.provider, model: config.engine.model },
                creator: config.creator,
              },
              webTransportFactory(webOptions, name) {
                const web = createManagedWebTransport(webOptions, {
                  name,
                  canServe: () => serving,
                });
                bindings.push({
                  web,
                  port: webOptions.port,
                  console: webOptions.adminRoute !== false,
                });
                return web.augment;
              },
              onConstructionRollback(report) {
                rollbackReported = true;
                constructionUnknown = report.resources !== "closed";
                for (const code of report.failures) failures.add(code);
              },
            },
          );
        } catch (error) {
          if (
            !rollbackReported &&
            bindings.some((binding) => binding.web.snapshot().resourceState !== "closed")
          )
            constructionUnknown = true;
          throw error;
        }
        assertNotStopping();
        let execution: AgentExecutionOptions = {};
        if (!options.legacy) {
          let issued: AgentComposition | undefined;
          let selected: AgentExecutionOptions | undefined;
          let composing = true;
          if (!options.compose) throw new Error("[application] compose callback is required");
          let composition: AgentComposition;
          try {
            composition = await options.compose(
              Object.freeze({
                compose(binding: Parameters<Parameters<AgentComposer>[0]["compose"]>[0]) {
                  if (!composing || issued)
                    throw new Error("[application] composition already consumed");
                  selected = Object.freeze({ ...binding });
                  issued = Object.freeze({}) as AgentComposition;
                  return issued;
                },
              }),
            );
          } finally {
            composing = false;
          }
          if (!issued || composition !== issued || !selected)
            throw new Error("[application] invalid composition receipt");
          execution = selected;
        }
        assertNotStopping();
        const agentConfig: AgentConfig = {
          name: config.name,
          displayName: config.displayName,
          creator: config.creator,
          purpose: config.purpose,
          model: config.engine.model,
          augments,
          contextBudget: config.settings.contextBudget,
          compactionStrategy: config.settings.compactionStrategy,
          maxInferenceLoops: config.settings.maxInferenceLoops,
          responseLimits: config.engine.responseLimits,
          providerRequestTimeoutMs: config.engine.requestTimeoutMs,
          turnScheduling: config.settings.turnScheduling,
          coordination: config.settings.coordination,
        };
        const { createHostedAgent } = await import("../agent");
        assertNotStopping();
        const instance: HostedAgentInstance = createHostedAgent(agentConfig, model, execution);
        hosted = instance;
        jobs = createDurableJobsRuntimeIfEnabled({
          jobs: config.settings.jobs,
          agent: instance.agent,
          agentDir,
          ...(ownership.runtimeDataRoot ? { runtimeDataRoot: ownership.runtimeDataRoot } : {}),
          onOperationalError: (code) => console.error(`[durable-jobs] ${code}`),
        });
        readiness = Object.freeze({
          agentName: config.name,
          http: Object.freeze(
            bindings.map(({ web, port, console: enabled }) =>
              Object.freeze({
                name: web.http.name,
                port,
                localBaseUrl: `http://localhost:${port}`,
                consoleUrl: enabled ? `http://localhost:${port}/console` : null,
              }),
            ),
          ),
        });
        state = "prepared";
        return Object.freeze({ http: Object.freeze(bindings.map((binding) => binding.web.http)) });
      })();
      phase = work;
      return work.catch((error) => {
        void ensureCleanup();
        throw error;
      });
    },
    start(input): Promise<ApplicationReady> {
      if (state !== "prepared" || stopping)
        return Promise.reject(new Error("[application] host must be prepared and started once"));
      state = "starting";
      const work = Promise.resolve().then(async () => {
        if (
          !Array.isArray(input.http) ||
          input.http.length !== bindings.length ||
          new Set(input.http).size !== input.http.length
        ) {
          throw new Error(
            "[application] exactly one listener is required per configured web transport",
          );
        }
        for (const binding of bindings) {
          const matches = input.http.filter((listener) => binding.web.ownsListener(listener));
          if (matches.length !== 1) throw new Error("[application] listener ownership conflict");
          binding.web.selectListener(matches[0]!);
        }
        assertNotStopping();
        await hosted!.agent.start();
        assertNotStopping();
        jobs?.start();
        assertNotStopping();
        hosted!.openAdmission();
        serving = true;
        state = "ready";
        return readiness!;
      });
      phase = work;
      return work.catch((error) => {
        void ensureCleanup();
        throw error;
      });
    },
    async stop(input) {
      const deadlineMs = input?.deadlineMs ?? 15_000;
      if (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0 || deadlineMs > 900_000) {
        throw new Error(
          "[application] shutdown deadline must be a positive integer no greater than 900000",
        );
      }
      const work = ensureCleanup();
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          work,
          new Promise<HostStopResult>((done) => {
            timer = setTimeout(
              () =>
                done(
                  Object.freeze({
                    status: "retained",
                    ownership: "retained",
                    reason: "deadline",
                    failures: Object.freeze([...failures]),
                  }),
                ),
              deadlineMs,
            );
          }),
        ]);
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    },
  };
  return Object.freeze(host);
}
