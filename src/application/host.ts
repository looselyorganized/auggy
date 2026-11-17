import { dirname, relative, resolve, sep } from "node:path";
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
  PhasedApplicationHost,
  PreparedAgentConfiguration,
  ManagedModel,
  ManagedAugments,
  ManagedAgent,
  ManagedTransport,
  ModelClient,
} from "../types";
import { parseConfig } from "../cli/config-parser";
import type { ParsedConfig } from "../cli/types";
import { resolveEngine } from "../cli/engine-resolver";
import {
  resolveAugments,
  resolveManagedExternalAuthReplayConfiguration,
} from "../cli/augment-resolver";
import {
  createDurableJobsRuntimeIfEnabled,
  type ConfiguredDurableJobsRuntime,
} from "../cli/durable-jobs-runtime";
import { resolveApplicationDefinition } from "../cli/application-definition";
import { createManagedWebTransport, type ManagedWebTransport } from "../transports/web-transport";
import { enumerateDistributedCoordinationBlockers } from "../coordination/topology";
import type { HostedAgentInstance } from "./hosted-agent";
import { createHostedAgent } from "../agent";
import { acquireRuntimeOwnership, type RuntimeOwnershipOptions } from "./runtime-ownership";
import { hasConfirmedCleanup } from "./cleanup-proof";
import { DEPLOYMENT_MANIFEST_ENV } from "../cli/deploy/contracts";
import { readDeploymentManifest } from "../cli/deploy/manifest";
import { reconcileDeploymentProfile } from "../cli/deploy/profile";

export interface ApplicationHostOptions extends RuntimeOwnershipOptions {
  configPath: string;
  compose?: AgentComposer;
  legacy?: boolean;
  onConfigured?: (config: ParsedConfig) => void;
  /** Package tests can control factory timing without replacing the guarded agent. */
  factories?: { resolveEngine?: typeof resolveEngine; resolveAugments?: typeof resolveAugments };
}

export type OwnedApplicationHost = ManagedApplicationHost &
  PhasedApplicationHost & {
    readonly isReady: boolean;
    readonly readiness: ApplicationReady | undefined;
    readonly closed: Promise<HostStopResult>;
  };

export function createApplicationHost(options: ApplicationHostOptions): OwnedApplicationHost {
  const configPath = resolve(options.configPath);
  const agentDir = dirname(configPath);
  const bindings: Array<{ web: ManagedWebTransport; port: number; console: boolean }> = [];
  const failures = new Set<HostCleanupFailureCode>();
  let state = "created";
  let stopping = false;
  let serving = false;
  let phase: Promise<unknown> | undefined;
  let adapterPhase: Promise<unknown> | undefined;
  let adapter = false;
  let parsed: ParsedConfig | undefined;
  let replayConfiguration:
    | ReturnType<typeof resolveManagedExternalAuthReplayConfiguration>
    | undefined;
  let configuration: PreparedAgentConfiguration | undefined;
  let modelReceipt: ManagedModel | undefined;
  let model: ModelClient | undefined;
  let augmentReceipt: ManagedAugments | undefined;
  let agentReceipt: ManagedAgent | undefined;
  let transports: readonly ManagedTransport[] | undefined;
  const transportOwners = new Map<ManagedTransport, Augment>();
  const boundTransports = new Set<ManagedTransport>();
  let httpIssued = false;
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
    const entering = [phase, adapterPhase];
    cleanup = Promise.resolve()
      .then(async () => {
        await Promise.allSettled(entering.filter((work) => work !== undefined));
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

  function assertState(expected: string): void {
    assertNotStopping();
    if (state !== expected)
      throw new Error(`[application] assembly phase requires ${expected}; stages are one-shot`);
  }

  function checkConfig(input: PreparedAgentConfiguration): void {
    if (!configuration || input !== configuration)
      throw new Error("[application] foreign configuration handle");
  }

  function stage<T>(expected: string, next: string, operation: () => T | Promise<T>): Promise<T> {
    try {
      assertState(expected);
    } catch (error) {
      return Promise.reject(error);
    }
    state = `${next}-pending`;
    const work = Promise.resolve()
      .then(() => {
        assertNotStopping();
        return operation();
      })
      .then((value) => {
        assertNotStopping();
        state = next;
        return value;
      });
    phase = work;
    return work.catch((error) => {
      void ensureCleanup();
      throw error;
    });
  }

  const host: OwnedApplicationHost = {
    get isReady() {
      return state === "ready";
    },
    get readiness() {
      return readiness;
    },
    closed,
    prepareConfiguration() {
      return stage("created", "configured", () => {
        const config = parseConfig(configPath);
        parsed = config;
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
        const deploymentManifestPath = process.env[DEPLOYMENT_MANIFEST_ENV];
        if (deploymentManifestPath !== undefined) {
          const deployment = readDeploymentManifest(deploymentManifestPath, agentDir, {
            agentId: config.id,
            agentName: config.name,
            configPath: relative(agentDir, configPath).split(sep).join("/"),
          });
          reconcileDeploymentProfile(deployment.profile, config.augments);
        }
        options.onConfigured?.(config);
        assertNotStopping();
        ownership = acquireRuntimeOwnership(configPath, config, options, (acquired) => {
          ownership = acquired;
        });
        assertNotStopping();
        replayConfiguration = resolveManagedExternalAuthReplayConfiguration(
          config.augments,
          agentDir,
          ownership.runtimeDataAdmission,
        );
        configuration = Object.freeze({
          name: config.name,
          engine: Object.freeze({ provider: config.engine.provider, model: config.engine.model }),
          augments: Object.freeze(
            config.augments.map(({ name, type }) => Object.freeze({ name, type })),
          ),
        }) as PreparedAgentConfiguration;
        return configuration;
      });
    },
    createModel(input) {
      return stage("configured", "model-created", async () => {
        checkConfig(input);
        model = await (options.factories?.resolveEngine ?? resolveEngine)(parsed!.engine, agentDir);
        assertNotStopping();
        modelReceipt = Object.freeze({
          provider: parsed!.engine.provider,
          model: parsed!.engine.model,
        }) as ManagedModel;
        return modelReceipt;
      });
    },
    createAugments(input) {
      return stage("model-created", "augments-created", async () => {
        checkConfig(input);
        const config = parsed!;
        let rollbackReported = false;
        try {
          augments = await (options.factories?.resolveAugments ?? resolveAugments)(
            replayConfiguration!.augments,
            agentDir,
            {
              creator: config.creator,
              agentId: config.id,
              runtimeDataPlatform: ownership!.platform,
              ...(ownership!.runtimeDataRoot
                ? { runtimeDataRoot: ownership!.runtimeDataRoot }
                : {}),
              selfInspection: {
                name: config.name,
                displayName: config.displayName,
                purpose: config.purpose,
                engine: { provider: config.engine.provider, model: config.engine.model },
                creator: config.creator,
              },
              webTransportFactory(webOptions, name) {
                assertNotStopping();
                const web = createManagedWebTransport(webOptions, {
                  name,
                  canServe: () => serving,
                  runtimeDataAdmission: ownership?.runtimeDataAdmission,
                  managedExternalAuthDbPaths: replayConfiguration!.dbPaths,
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
          if (!rollbackReported) constructionUnknown = true;
          throw error;
        }
        assertNotStopping();
        augmentReceipt = Object.freeze({
          names: Object.freeze(augments.map(({ name }) => name)),
        }) as ManagedAugments;
        return augmentReceipt;
      });
    },
    createAgent(input) {
      assertState("augments-created");
      try {
        checkConfig(input.config);
        if (!modelReceipt || input.model !== modelReceipt)
          throw new Error("[application] foreign model handle");
        if (!augmentReceipt || input.augments !== augmentReceipt)
          throw new Error("[application] foreign augment handle");
        if (!adapter && !input.turnProgram)
          throw new Error("[application] turn program is required");
        const config = parsed!;
        const agentConfig: AgentConfig = {
          name: config.name,
          displayName: config.displayName,
          creator: config.creator,
          purpose: config.purpose,
          model: config.engine.model,
          augments: augments!,
          contextBudget: config.settings.contextBudget,
          compactionStrategy: config.settings.compactionStrategy,
          maxInferenceLoops: config.settings.maxInferenceLoops,
          responseLimits: config.engine.responseLimits,
          providerRequestTimeoutMs: config.engine.requestTimeoutMs,
          turnScheduling: config.settings.turnScheduling,
          coordination: config.settings.coordination,
        };
        hosted = createHostedAgent(
          agentConfig,
          model!,
          {
            turnProgram: input.turnProgram,
            onTurnFinalized: input.onTurnFinalized,
          },
          { explicitTransportBindings: true },
        );
        jobs = createDurableJobsRuntimeIfEnabled({
          jobs: config.settings.jobs,
          agent: hosted.agent,
          agentDir,
          ...(ownership!.runtimeDataRoot ? { runtimeDataRoot: ownership!.runtimeDataRoot } : {}),
          onOperationalError: (code) => console.error(`[durable-jobs] ${code}`),
        });
        agentReceipt = Object.freeze({ name: config.name }) as ManagedAgent;
        state = "assembled";
        return agentReceipt;
      } catch (error) {
        void ensureCleanup();
        throw error;
      }
    },
    transportsFrom(input) {
      assertState("assembled");
      if (!augmentReceipt || input !== augmentReceipt)
        throw new Error("[application] foreign augment handle");
      if (transports) throw new Error("[application] transport enumeration is one-shot");
      transports = Object.freeze(
        augments!
          .filter((augment) => augment.transport)
          .map((augment) => {
            const descriptor = Object.freeze({
              name: augment.name,
              kind: bindings.some(({ web }) => web.augment === augment) ? "http" : "other",
            }) as ManagedTransport;
            transportOwners.set(descriptor, augment);
            return descriptor;
          }),
      );
      return transports;
    },
    bindTransport(transport, agent) {
      assertState("assembled");
      if (!agentReceipt || agent !== agentReceipt)
        throw new Error("[application] foreign agent handle");
      const augment = transportOwners.get(transport);
      if (!augment) throw new Error("[application] foreign transport handle");
      if (boundTransports.has(transport)) throw new Error("[application] transport already bound");
      hosted!.bindTransport(augment);
      boundTransports.add(transport);
    },
    httpBindings(agent) {
      assertState("assembled");
      if (!agentReceipt || agent !== agentReceipt)
        throw new Error("[application] foreign agent handle");
      if (!transports || boundTransports.size !== transports.length)
        throw new Error("[application] bind every configured transport before HTTP wiring");
      if (httpIssued) throw new Error("[application] HTTP bindings are one-shot");
      httpIssued = true;
      return Object.freeze(bindings.map(({ web }) => web.http));
    },
    prepare(): Promise<PreparedApplication> {
      if (state !== "created" || stopping)
        return Promise.reject(new Error("[application] host preparation is one-shot"));
      adapter = true;
      const work = (async () => {
        const config = await host.prepareConfiguration();
        const model = await host.createModel(config);
        const augments = await host.createAugments(config);
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
        const agent = host.createAgent({ config, model, augments, ...execution } as Parameters<
          PhasedApplicationHost["createAgent"]
        >[0]);
        for (const transport of host.transportsFrom(augments)) host.bindTransport(transport, agent);
        return Object.freeze({ http: host.httpBindings(agent) });
      })();
      adapterPhase = work;
      return work.catch((error) => {
        void ensureCleanup();
        throw error;
      });
    },
    start(input: {
      agent?: ManagedAgent;
      http: readonly import("../types").ManagedHttpListener[];
    }): Promise<ApplicationReady> {
      if (state !== "assembled" || stopping)
        return Promise.reject(new Error("[application] host must be assembled and started once"));
      return stage("assembled", "ready", async () => {
        if ((!adapter || input.agent !== undefined) && input.agent !== agentReceipt)
          throw new Error("[application] foreign agent handle");
        if (!transports || boundTransports.size !== transports.length)
          throw new Error("[application] every configured transport must be bound exactly once");
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
        readiness = Object.freeze({
          agentName: parsed!.name,
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
        return readiness;
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
