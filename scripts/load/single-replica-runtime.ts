/**
 * Bounded, secret-free load evidence for one real Auggy runtime process.
 *
 * This runner starts `defineAgent` and exercises its scheduler, turn loop,
 * tools, outbound delivery, drain, and restart paths. It is not a provider
 * benchmark, an HTTP idempotency test, or evidence that replicas are safe.
 */

import { readdirSync } from "node:fs";
import { arch, cpus, platform, totalmem } from "node:os";
import { defineAgent } from "../../src/agent";
import { isOutcomeUnknownError } from "../../src/outcome-unknown";
import type {
  AssembledPrompt,
  Augment,
  InboundMessage,
  ModelClient,
  ModelResponse,
  RuntimeOperationalSnapshot,
  TransportKernel,
  TurnTrigger,
} from "../../src/types";
import { z } from "zod";

export type SingleReplicaLoadProfile = "concierge" | "order-support";

export interface SingleReplicaLoadOptions {
  profile: SingleReplicaLoadProfile;
  seed?: number;
  requests?: number;
  threads?: number;
  maxConcurrent?: number;
  maxQueued?: number;
  providerLatencyMs?: number;
  deliveryLatencyMs?: number;
  providerTimeoutMs?: number;
  /** Cancel every Nth queued candidate after the first turn starts. Zero disables. */
  cancelEvery?: number;
  /** Make every Nth request's first inference ignore cancellation forever. Zero disables. */
  stallEvery?: number;
}

export interface SingleReplicaLoadReport {
  schemaVersion: 1;
  mode: "single-replica-runtime";
  topology: "one-process-one-logical-agent";
  profile: SingleReplicaLoadProfile;
  environment: {
    bunVersion: string;
    platform: string;
    arch: string;
    logicalCpuCount: number;
    totalMemoryBytes: number;
    fdSource: "procfs" | "unavailable";
  };
  config: Required<SingleReplicaLoadOptions>;
  result: {
    requested: number;
    completed: number;
    failed: number;
    canceled: number;
    rejected: number;
    outcomeUnknown: number;
    elapsedMs: number;
    observedTurnsPerSecond: number;
    latencyMs: { p50: number; p95: number; p99: number; max: number };
    activePeak: number;
    queuedPeak: number;
    oldestQueueWaitPeakMs: number;
    providerActivePeak: number;
    providerActiveAtEnd: number;
    deliveryActivePeak: number;
    sameThreadOverlap: number;
    duplicateToolEffects: number;
    toolEffects: number;
    drainActiveTurnHeld: boolean;
    drainProbeRejected: boolean;
    restartProbeCompleted: boolean;
  };
  resources: {
    rssBytes: { baseline: number; peak: number; end: number; delta: number };
    heapUsedBytes: { baseline: number; peak: number; end: number; delta: number };
    openFileDescriptors: {
      baseline: number | null;
      peak: number | null;
      end: number | null;
      delta: number | null;
    };
  };
  terminalSnapshot: RuntimeOperationalSnapshot;
  invariantFailures: string[];
  interpretation: "machine-specific-evidence-not-a-capacity-guarantee";
}

const MAX_REQUESTS = 10_000;
const MAX_THREADS = 1_000;
const MAX_CONCURRENT = 256;
const MAX_QUEUED = 10_000;
const MAX_LATENCY_MS = 10_000;
const MAX_PROVIDER_TIMEOUT_MS = 600_000;

interface NormalizedOptions extends Required<SingleReplicaLoadOptions> {}

interface WorkDescriptor {
  requestId: number;
  threadIndex: number;
}

function assertInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite integer between ${min} and ${max}`);
  }
}

function normalizeOptions(input: SingleReplicaLoadOptions): NormalizedOptions {
  if (input.profile !== "concierge" && input.profile !== "order-support") {
    throw new Error("profile must be concierge or order-support");
  }
  const requests = input.requests ?? 240;
  const threads = input.threads ?? Math.min(32, requests);
  const maxConcurrent = input.maxConcurrent ?? 4;
  const maxQueued = input.maxQueued ?? requests;
  const providerLatencyMs = input.providerLatencyMs ?? 2;
  const deliveryLatencyMs = input.deliveryLatencyMs ?? 1;
  const providerTimeoutMs = input.providerTimeoutMs ?? 1_000;
  const seed = input.seed ?? 20260725;
  const cancelEvery = input.cancelEvery ?? 0;
  const stallEvery = input.stallEvery ?? 0;

  assertInteger(seed, "seed", 0, 0xffffffff);
  assertInteger(requests, "requests", 1, MAX_REQUESTS);
  assertInteger(threads, "threads", 1, Math.min(MAX_THREADS, requests));
  assertInteger(maxConcurrent, "maxConcurrent", 1, MAX_CONCURRENT);
  assertInteger(maxQueued, "maxQueued", 0, MAX_QUEUED);
  assertInteger(providerLatencyMs, "providerLatencyMs", 0, MAX_LATENCY_MS);
  assertInteger(deliveryLatencyMs, "deliveryLatencyMs", 0, MAX_LATENCY_MS);
  assertInteger(providerTimeoutMs, "providerTimeoutMs", 1, MAX_PROVIDER_TIMEOUT_MS);
  assertInteger(cancelEvery, "cancelEvery", 0, MAX_REQUESTS);
  assertInteger(stallEvery, "stallEvery", 0, MAX_REQUESTS);
  if (stallEvery > 0 && providerTimeoutMs > 30_000) {
    throw new Error("providerTimeoutMs must be at most 30000 when stallEvery is enabled");
  }

  return {
    profile: input.profile,
    seed,
    requests,
    threads,
    maxConcurrent,
    maxQueued,
    providerLatencyMs,
    deliveryLatencyMs,
    providerTimeoutMs,
    cancelEvery,
    stallEvery,
  };
}

function createRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function makeWorkload(options: NormalizedOptions): WorkDescriptor[] {
  const random = createRandom(options.seed);
  return Array.from({ length: options.requests }, (_, requestId) => ({
    requestId,
    threadIndex:
      requestId < Math.min(options.threads, options.maxConcurrent)
        ? requestId
        : Math.floor(random() * options.threads),
  }));
}

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (ms === 0) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, ms);
    const abort = () => {
      clearTimeout(timer);
      reject(signal?.reason ?? new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", abort, { once: true });
  });
}

function percentile(samples: readonly number[], quantile: number): number {
  if (samples.length === 0) return 0;
  const ordered = [...samples].sort((left, right) => left - right);
  const index = Math.min(ordered.length - 1, Math.ceil(ordered.length * quantile) - 1);
  return Number(ordered[index]!.toFixed(3));
}

function requestDetails(prompt: AssembledPrompt): WorkDescriptor {
  const raw = [...prompt.messages].reverse().find((message) => message.role === "user")?.content;
  if (!raw) throw new Error("load fixture received no user request");
  const parsed = JSON.parse(raw) as Partial<WorkDescriptor>;
  if (!Number.isSafeInteger(parsed.requestId) || !Number.isSafeInteger(parsed.threadIndex)) {
    throw new Error("load fixture received an invalid request envelope");
  }
  return parsed as WorkDescriptor;
}

function hasToolResultForCurrentRequest(prompt: AssembledPrompt): boolean {
  const lastUser = prompt.messages.findLastIndex((message) => message.role === "user");
  return prompt.messages.slice(lastUser + 1).some((message) => message.role === "tool_result");
}

function response(content: string, toolCalls?: ModelResponse["toolCalls"]): ModelResponse {
  return {
    content,
    ...(toolCalls && toolCalls.length > 0 ? { toolCalls } : {}),
    finishReason: toolCalls && toolCalls.length > 0 ? "tool_use" : "end_turn",
    inputTokens: 8,
    outputTokens: 4,
  };
}

function trigger(work: WorkDescriptor): TurnTrigger {
  const peer = {
    id: "load-peer",
    kind: "human" as const,
    trustLevel: "creator" as const,
    sourceAugment: "runtime-load",
  };
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    threadId: `runtime-load-thread-${work.threadIndex}`,
    timestamp: Date.now(),
    source: "runtime-load",
    peer,
    payload: {
      parts: [{ kind: "text", text: JSON.stringify(work) }],
      sourceAugment: "runtime-load",
      peer,
      timestamp: Date.now(),
    } satisfies InboundMessage,
  };
}

function countOpenFileDescriptors(): number | null {
  if (platform() !== "linux") return null;
  try {
    return readdirSync("/proc/self/fd").length;
  } catch {
    return null;
  }
}

/** Run one bounded workload against a real, in-process Auggy runtime. */
export async function runSingleReplicaRuntimeLoad(
  input: SingleReplicaLoadOptions,
): Promise<SingleReplicaLoadReport> {
  const config = normalizeOptions(input);
  const work = makeWorkload(config);
  const firstExecution = deferred();
  const drainStarted = deferred();
  const drainRelease = deferred();
  const toolEffects = new Map<number, number>();
  const providerActiveThreads = new Map<number, number>();
  const latencies: number[] = [];
  let kernel: TransportKernel | undefined;
  let agent: ReturnType<typeof defineAgent> | undefined;
  let activePeak = 0;
  let queuedPeak = 0;
  let oldestQueueWaitPeakMs = 0;
  let providerActive = 0;
  let providerActivePeak = 0;
  let deliveryActive = 0;
  let deliveryActivePeak = 0;
  let sameThreadOverlap = 0;
  let memoryBaseline = { rssBytes: 0, heapUsedBytes: 0 };
  let memoryPeak = { rssBytes: 0, heapUsedBytes: 0 };
  let fdBaseline: number | null = null;
  let fdPeak: number | null = null;
  let sampleCount = 0;

  const sample = () => {
    if (!agent) return;
    const snapshot = agent.operationalSnapshot();
    activePeak = Math.max(activePeak, snapshot.scheduler.activeTurns);
    queuedPeak = Math.max(queuedPeak, snapshot.scheduler.queuedTurns);
    oldestQueueWaitPeakMs = Math.max(oldestQueueWaitPeakMs, snapshot.scheduler.oldestQueueWaitMs);
    memoryPeak.rssBytes = Math.max(memoryPeak.rssBytes, snapshot.memory.rssBytes);
    memoryPeak.heapUsedBytes = Math.max(memoryPeak.heapUsedBytes, snapshot.memory.heapUsedBytes);
    sampleCount++;
    if (sampleCount % 64 === 0) {
      const descriptors = countOpenFileDescriptors();
      if (descriptors !== null) fdPeak = Math.max(fdPeak ?? descriptors, descriptors);
    }
  };

  const model: ModelClient = {
    maxContextTokens: 100_000,
    countTokens: (text) => Math.ceil(text.length / 4),
    async complete(prompt, options) {
      const details = requestDetails(prompt);
      const firstInference = !hasToolResultForCurrentRequest(prompt);
      const threadProviderActive = providerActiveThreads.get(details.threadIndex) ?? 0;
      if (threadProviderActive > 0) sameThreadOverlap++;
      providerActiveThreads.set(details.threadIndex, threadProviderActive + 1);
      providerActive++;
      providerActivePeak = Math.max(providerActivePeak, providerActive);
      sample();
      if (
        firstInference &&
        config.stallEvery > 0 &&
        details.requestId < config.requests &&
        details.requestId % config.stallEvery === 0
      ) {
        // Deliberately non-cooperative. The real kernel must fence the late
        // attempt and release capacity; the report exposes it as still active.
        return new Promise<ModelResponse>(() => {});
      }
      try {
        if (details.requestId === config.requests) {
          drainStarted.resolve();
          await drainRelease.promise;
          options?.signal?.throwIfAborted();
        }
        await delay(config.providerLatencyMs, options?.signal);
        options?.onDelta?.({ kind: "text_delta", text: "bounded" });
        if (config.profile === "order-support" && firstInference) {
          return response("", [
            {
              name: "order_lookup",
              arguments: { requestId: details.requestId },
            },
          ]);
        }
        return response("completed");
      } finally {
        providerActive--;
        const remaining = (providerActiveThreads.get(details.threadIndex) ?? 1) - 1;
        if (remaining === 0) providerActiveThreads.delete(details.threadIndex);
        else providerActiveThreads.set(details.threadIndex, remaining);
        sample();
      }
    },
  };

  const transport: Augment = {
    name: "runtime-load",
    transport: {
      concurrency: config.maxConcurrent,
      maxQueueDepth: config.maxQueued,
      identify: () => null,
      async register(runtimeKernel) {
        kernel = runtimeKernel;
        runtimeKernel.onOutbound(async (_peer, _message, context) => {
          deliveryActive++;
          deliveryActivePeak = Math.max(deliveryActivePeak, deliveryActive);
          sample();
          try {
            await delay(config.deliveryLatencyMs, context?.signal);
          } finally {
            deliveryActive--;
            sample();
          }
        });
      },
    },
  };
  const augments: Augment[] = [transport];
  if (config.profile === "order-support") {
    augments.push({
      name: "order-support-fixture",
      tools: [
        {
          name: "order_lookup",
          description: "Deterministic load-fixture order lookup",
          category: "load-fixture",
          input: z.object({
            requestId: z
              .number()
              .int()
              .nonnegative()
              .max(MAX_REQUESTS + 2),
          }),
          async execute({ requestId }) {
            toolEffects.set(requestId, (toolEffects.get(requestId) ?? 0) + 1);
            return "order found";
          },
        },
      ],
    });
  }

  agent = defineAgent(
    {
      name: "single-replica-runtime-load",
      model: "deterministic-fixture",
      augments,
      providerRequestTimeoutMs: config.providerTimeoutMs,
      turnScheduling: {
        maxConcurrent: config.maxConcurrent,
        maxQueued: config.maxQueued,
        maxQueuedPerThread: config.maxQueued,
        maxCausalDepth: 2,
      },
    },
    model,
  );
  await agent.start();
  try {
    if (!kernel) throw new Error("load transport did not register");
    const baseline = agent.operationalSnapshot();
    memoryBaseline = {
      rssBytes: baseline.memory.rssBytes,
      heapUsedBytes: baseline.memory.heapUsedBytes,
    };
    memoryPeak = { ...memoryBaseline };
    fdBaseline = countOpenFileDescriptors();
    fdPeak = fdBaseline;

    const startedAt = performance.now();
    const controllers = work.map(() => new AbortController());
    const submissions = work.map((descriptor, index) => {
      const submittedAt = performance.now();
      const pending = kernel!.handleInbound(trigger(descriptor), {
        signal: controllers[index]!.signal,
        onExecutionStart() {
          firstExecution.resolve();
          sample();
        },
      });
      return pending.finally(() => {
        latencies.push(performance.now() - submittedAt);
        sample();
      });
    });

    sample();
    await firstExecution.promise;
    for (let index = 0; index < controllers.length; index++) {
      if (
        config.cancelEvery > 0 &&
        index >= config.maxConcurrent &&
        index % config.cancelEvery === 0
      ) {
        controllers[index]!.abort(new DOMException("Load fixture cancellation", "AbortError"));
      }
    }

    const settled = await Promise.allSettled(submissions);
    const drainActive = kernel.handleInbound(
      trigger({ requestId: config.requests, threadIndex: config.threads }),
    );
    const drainActiveTurnHeld =
      (await Promise.race([
        drainStarted.promise.then(() => true),
        drainActive.then(
          () => false,
          () => false,
        ),
      ])) === true;
    const stopping = agent.stop();
    const drainProbe = await kernel.handleInbound(
      trigger({ requestId: config.requests + 1, threadIndex: config.threads + 1 }),
    );
    drainRelease.resolve();
    await drainActive.catch(() => undefined);
    await stopping;
    const elapsedMs = performance.now() - startedAt;
    const terminalSnapshot = agent.operationalSnapshot();
    const memoryEnd = {
      rssBytes: terminalSnapshot.memory.rssBytes,
      heapUsedBytes: terminalSnapshot.memory.heapUsedBytes,
    };
    const fdEnd = countOpenFileDescriptors();
    if (fdEnd !== null) fdPeak = Math.max(fdPeak ?? fdEnd, fdEnd);

    let completed = 0;
    let failed = 0;
    let canceled = 0;
    let rejected = 0;
    let outcomeUnknown = 0;
    for (let index = 0; index < settled.length; index++) {
      const item = settled[index]!;
      if (item.status === "rejected") {
        if (isOutcomeUnknownError(item.reason)) outcomeUnknown++;
        else if (controllers[index]!.signal.aborted) canceled++;
        else failed++;
        continue;
      }
      const result = item.value;
      if (result.outcomeUnknown) outcomeUnknown++;
      else if (result.status === "canceled") canceled++;
      else if (result.status === "rejected") rejected++;
      else if (result.success) completed++;
      else failed++;
    }

    await agent.start();
    const restartProbeCompleted = await kernel
      .handleInbound(trigger({ requestId: config.requests + 2, threadIndex: config.threads + 2 }))
      .then(
        (probe) => probe.success && probe.status === "completed",
        () => false,
      );
    await agent.stop();

    const workloadToolEffects = [...toolEffects.entries()].filter(
      ([requestId]) => requestId < config.requests,
    );
    const duplicateToolEffects = workloadToolEffects.filter(([, count]) => count > 1).length;
    const terminalCount = completed + failed + canceled + rejected + outcomeUnknown;
    const invariantFailures: string[] = [];
    if (terminalCount !== config.requests) {
      invariantFailures.push(
        `terminal classifications ${terminalCount} != requested ${config.requests}`,
      );
    }
    if (activePeak > config.maxConcurrent) {
      invariantFailures.push(
        `active peak ${activePeak} exceeds configured ${config.maxConcurrent}`,
      );
    }
    if (queuedPeak > config.maxQueued) {
      invariantFailures.push(`queued peak ${queuedPeak} exceeds configured ${config.maxQueued}`);
    }
    if (sameThreadOverlap > 0) invariantFailures.push("same-thread turn overlap observed");
    if (duplicateToolEffects > 0) invariantFailures.push("duplicate tool effect observed");
    const detachedProviderBound = Math.max(2, config.maxConcurrent) + config.maxConcurrent - 1;
    if (providerActivePeak > detachedProviderBound) {
      invariantFailures.push(
        `provider active peak ${providerActivePeak} exceeds detached-work bound ${detachedProviderBound}`,
      );
    }
    if (
      terminalSnapshot.scheduler.activeTurns !== 0 ||
      terminalSnapshot.scheduler.queuedTurns !== 0
    ) {
      invariantFailures.push("scheduler did not drain to zero");
    }
    if (terminalSnapshot.responseDelivery.inFlight !== 0 || deliveryActive !== 0) {
      invariantFailures.push("response delivery did not drain to zero");
    }
    if (drainProbe.rejection?.reason !== "runtime-stopping") {
      invariantFailures.push("new work was not rejected during drain");
    }
    if (!drainActiveTurnHeld) {
      invariantFailures.push("provider circuit prevented the held drain probe from starting");
    }
    if (!restartProbeCompleted) {
      invariantFailures.push("restart probe did not complete");
    }
    if (config.cancelEvery === 0 && config.stallEvery === 0) {
      if (failed + canceled + outcomeUnknown !== 0) {
        invariantFailures.push("baseline workload had an unexpected terminal outcome");
      }
      if (config.profile === "order-support" && workloadToolEffects.length !== completed) {
        invariantFailures.push(
          "completed order-support turns did not each execute one tool effect",
        );
      }
      if (providerActive !== 0) invariantFailures.push("baseline provider work remained active");
    }

    const latencyMax = latencies.length === 0 ? 0 : Math.max(...latencies);
    const report: SingleReplicaLoadReport = {
      schemaVersion: 1,
      mode: "single-replica-runtime",
      topology: "one-process-one-logical-agent",
      profile: config.profile,
      environment: {
        bunVersion: Bun.version,
        platform: platform(),
        arch: arch(),
        logicalCpuCount: cpus().length,
        totalMemoryBytes: totalmem(),
        fdSource: fdBaseline === null ? "unavailable" : "procfs",
      },
      config,
      result: {
        requested: config.requests,
        completed,
        failed,
        canceled,
        rejected,
        outcomeUnknown,
        elapsedMs: Number(elapsedMs.toFixed(3)),
        observedTurnsPerSecond: Number(((completed * 1_000) / Math.max(1, elapsedMs)).toFixed(3)),
        latencyMs: {
          p50: percentile(latencies, 0.5),
          p95: percentile(latencies, 0.95),
          p99: percentile(latencies, 0.99),
          max: Number(latencyMax.toFixed(3)),
        },
        activePeak,
        queuedPeak,
        oldestQueueWaitPeakMs: Number(oldestQueueWaitPeakMs.toFixed(3)),
        providerActivePeak,
        providerActiveAtEnd: providerActive,
        deliveryActivePeak,
        sameThreadOverlap,
        duplicateToolEffects,
        toolEffects: workloadToolEffects.reduce((total, [, count]) => total + count, 0),
        drainActiveTurnHeld,
        drainProbeRejected: drainProbe.rejection?.reason === "runtime-stopping",
        restartProbeCompleted,
      },
      resources: {
        rssBytes: {
          baseline: memoryBaseline.rssBytes,
          peak: memoryPeak.rssBytes,
          end: memoryEnd.rssBytes,
          delta: memoryEnd.rssBytes - memoryBaseline.rssBytes,
        },
        heapUsedBytes: {
          baseline: memoryBaseline.heapUsedBytes,
          peak: memoryPeak.heapUsedBytes,
          end: memoryEnd.heapUsedBytes,
          delta: memoryEnd.heapUsedBytes - memoryBaseline.heapUsedBytes,
        },
        openFileDescriptors: {
          baseline: fdBaseline,
          peak: fdPeak,
          end: fdEnd,
          delta: fdBaseline === null || fdEnd === null ? null : fdEnd - fdBaseline,
        },
      },
      terminalSnapshot,
      invariantFailures,
      interpretation: "machine-specific-evidence-not-a-capacity-guarantee",
    };
    return report;
  } finally {
    // Fault profiles deliberately create promises that never settle. Always
    // release fixture barriers and stop listeners even if a probe or assertion
    // throws so a valid bounded run cannot strand the caller.
    drainRelease.resolve();
    await agent.stop().catch(() => undefined);
  }
}

function parseCliArgs(args: readonly string[]): SingleReplicaLoadOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error("expected --name=value argument");
    if (values.has(match[1]!)) throw new Error(`duplicate --${match[1]} argument`);
    values.set(match[1]!, match[2]!);
  }
  const allowed = new Set([
    "profile",
    "seed",
    "requests",
    "threads",
    "max-concurrent",
    "max-queued",
    "provider-latency-ms",
    "delivery-latency-ms",
    "provider-timeout-ms",
    "cancel-every",
    "stall-every",
  ]);
  for (const name of values.keys()) {
    if (!allowed.has(name)) throw new Error(`unknown --${name} argument`);
  }
  const profile = values.get("profile") as SingleReplicaLoadProfile | undefined;
  if (!profile) throw new Error("--profile=concierge|order-support is required");
  const number = (name: string): number | undefined => {
    const value = values.get(name);
    return value === undefined ? undefined : Number(value);
  };
  return {
    profile,
    seed: number("seed"),
    requests: number("requests"),
    threads: number("threads"),
    maxConcurrent: number("max-concurrent"),
    maxQueued: number("max-queued"),
    providerLatencyMs: number("provider-latency-ms"),
    deliveryLatencyMs: number("delivery-latency-ms"),
    providerTimeoutMs: number("provider-timeout-ms"),
    cancelEvery: number("cancel-every"),
    stallEvery: number("stall-every"),
  };
}

if (import.meta.main) {
  try {
    const report = await runSingleReplicaRuntimeLoad(parseCliArgs(process.argv.slice(2)));
    console.log(JSON.stringify(report));
    if (report.invariantFailures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid runtime load input");
    process.exitCode = 2;
  }
}
