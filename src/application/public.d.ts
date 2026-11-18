import type { ApplicationRunner } from "../types";

/** Managed entry runner. Runtime implementation: ./runner.ts. */
export declare const runApplication: ApplicationRunner;

export type {
  AgentExecutionOptions,
  AgentComposer,
  AgentComposition,
  ApplicationDirectLaunchOptions,
  ApplicationLaunch,
  ApplicationMain,
  ApplicationReady,
  ApplicationRunner,
  ConfiguredAgentComposition,
  ConfiguredWebHttp,
  HostCleanupFailureCode,
  HostStopResult,
  ManagedApplicationHost,
  PhasedApplicationHost,
  PreparedAgentConfiguration,
  ManagedModel,
  ManagedAugments,
  ManagedAgent,
  ManagedTransport,
  AgentRunMount,
  ManagedHttpHandler,
  ManagedHttpListener,
  ManagedHttpRequest,
  PreparedApplication,
  TurnCompletion,
  TurnFinalizationObservation,
  TurnFinalizationObserver,
  TurnProgram,
  TurnProgramBinding,
  ManagedTurnSession,
} from "../types";
