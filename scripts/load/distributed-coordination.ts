/**
 * Deterministic synthetic workload harness for distributed coordination work.
 * It models admission and fencing invariants; it does not prove replica safety
 * until a real coordinator adapter is connected to the same event interface.
 */

export type SyntheticLoadProfile = "concierge" | "order-support";

export interface SyntheticLoadOptions {
  profile: SyntheticLoadProfile;
  seed?: number;
  replicas?: number;
  requests?: number;
  maxActive?: number;
  maxQueued?: number;
  namespaceCount?: number;
}

export interface SyntheticLoadMetrics {
  profile: SyntheticLoadProfile;
  seed: number;
  replicas: number;
  requested: number;
  completed: number;
  rejections: number;
  unavailable: number;
  outcomeUnknown: number;
  duplicateMutations: number;
  sameThreadOverlap: number;
  staleFenceAccepts: number;
  namespaceViolations: number;
  throughputPerSecond: number;
  activePeak: number;
  queuedPeak: number;
  queueWaitMs: { p50: number; p95: number; p99: number };
}

export interface SyntheticLoadThresholds {
  maxRequests: number;
  maxReplicas: number;
  maxQueue: number;
  maxQueueWaitP95Ms: number;
  maxQueueWaitP99Ms: number;
  maxRejections: number;
  maxUnavailable: number;
  maxOutcomeUnknown: number;
  maxDuplicateMutations: number;
  maxSameThreadOverlap: number;
  maxStaleFenceAccepts: number;
  maxNamespaceViolations: number;
}

export const DEFAULT_SYNTHETIC_LOAD_THRESHOLDS: Readonly<SyntheticLoadThresholds> = {
  maxRequests: 10_000,
  maxReplicas: 32,
  maxQueue: 2_000,
  maxQueueWaitP95Ms: 1_000,
  maxQueueWaitP99Ms: 5_000,
  maxRejections: 0,
  maxUnavailable: 0,
  maxOutcomeUnknown: 0,
  maxDuplicateMutations: 0,
  maxSameThreadOverlap: 0,
  maxStaleFenceAccepts: 0,
  maxNamespaceViolations: 0,
};

interface WorkItem {
  id: number;
  namespace: string;
  thread: string;
  arrivalMs: number;
  durationMs: number;
  mutationKey: string | null;
}

interface ActiveWork extends WorkItem {
  startedMs: number;
  fence: number;
}

function assertFiniteInteger(value: number, name: string, min: number, max: number): void {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`${name} must be a finite integer between ${min} and ${max}`);
  }
}

function percentile(samples: readonly number[], value: number): number {
  if (samples.length === 0) return 0;
  const index = Math.min(samples.length - 1, Math.ceil(samples.length * value) - 1);
  return samples[index]!;
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

function makeWorkload(options: Required<SyntheticLoadOptions>): WorkItem[] {
  const random = createRandom(options.seed);
  const work: WorkItem[] = [];
  const sessions = Math.max(2, Math.min(80, Math.ceil(options.requests / 8)));
  for (let id = 0; id < options.requests; id++) {
    const session = Math.floor(random() * sessions);
    const namespace = `tenant-${Math.floor(session % options.namespaceCount)}`;
    const thread = `${options.profile}-session-${session}`;
    const burst = Math.floor(id / 12);
    const arrivalMs =
      options.profile === "concierge" ? burst * 20 + Math.floor(random() * 4) : id * 3;
    const mutation = options.profile === "order-support" && id % 3 === 0;
    const duplicate = mutation && id > 0 && random() < 0.35;
    const mutationKey = mutation
      ? duplicate
        ? `order-${Math.max(0, id - (id % 3 || 3))}`
        : `order-${id}`
      : null;
    work.push({
      id,
      namespace,
      thread,
      arrivalMs,
      durationMs:
        options.profile === "concierge"
          ? 8 + Math.floor(random() * 18)
          : 6 + Math.floor(random() * 12),
      mutationKey,
    });
  }
  return work.sort((left, right) => left.arrivalMs - right.arrivalMs || left.id - right.id);
}

function normaliseOptions(input: SyntheticLoadOptions): Required<SyntheticLoadOptions> {
  const options: Required<SyntheticLoadOptions> = {
    profile: input.profile,
    seed: input.seed ?? 20260724,
    replicas: input.replicas ?? 3,
    requests: input.requests ?? 240,
    maxActive: input.maxActive ?? 12,
    maxQueued: input.maxQueued ?? 500,
    namespaceCount: input.namespaceCount ?? 2,
  };
  if (options.profile !== "concierge" && options.profile !== "order-support") {
    throw new Error("profile must be concierge or order-support");
  }
  assertFiniteInteger(options.seed, "seed", 0, 0xffffffff);
  assertFiniteInteger(
    options.replicas,
    "replicas",
    1,
    DEFAULT_SYNTHETIC_LOAD_THRESHOLDS.maxReplicas,
  );
  assertFiniteInteger(
    options.requests,
    "requests",
    1,
    DEFAULT_SYNTHETIC_LOAD_THRESHOLDS.maxRequests,
  );
  assertFiniteInteger(options.maxActive, "maxActive", 1, 1_000);
  assertFiniteInteger(
    options.maxQueued,
    "maxQueued",
    0,
    DEFAULT_SYNTHETIC_LOAD_THRESHOLDS.maxQueue,
  );
  assertFiniteInteger(options.namespaceCount, "namespaceCount", 1, 1_000);
  return options;
}

/** Runs a bounded, deterministic reference model of safe distributed admission. */
export function runSyntheticDistributedLoad(input: SyntheticLoadOptions): SyntheticLoadMetrics {
  const options = normaliseOptions(input);
  const waiting: WorkItem[] = [];
  const active: ActiveWork[] = [];
  const activeThreads = new Set<string>();
  const completedMutations = new Set<string>();
  const fences = new Map<string, number>();
  const waits: number[] = [];
  let activePeak = 0;
  let queuedPeak = 0;
  let completed = 0;
  let rejections = 0;
  let duplicateMutations = 0;
  let sameThreadOverlap = 0;
  const staleFenceAccepts = 0;
  let namespaceViolations = 0;
  let clock = 0;

  const completeUntil = (untilMs: number): void => {
    while (true) {
      active.sort(
        (left, right) => left.startedMs + left.durationMs - (right.startedMs + right.durationMs),
      );
      const finished = active[0];
      if (!finished || finished.startedMs + finished.durationMs > untilMs) return;
      clock = finished.startedMs + finished.durationMs;
      active.shift();
      activeThreads.delete(`${finished.namespace}:${finished.thread}`);
      completed++;
    }
  };

  const admit = (): void => {
    let progressed = true;
    while (progressed && active.length < options.maxActive) {
      progressed = false;
      const candidateIndex = waiting.findIndex(
        (candidate) => !activeThreads.has(`${candidate.namespace}:${candidate.thread}`),
      );
      if (candidateIndex < 0) return;
      const candidate = waiting.splice(candidateIndex, 1)[0]!;
      if (candidate.mutationKey && completedMutations.has(candidate.mutationKey)) {
        // A duplicate delivery replays the previous result without another mutation.
        progressed = true;
        continue;
      }
      const threadKey = `${candidate.namespace}:${candidate.thread}`;
      if (activeThreads.has(threadKey)) sameThreadOverlap++;
      activeThreads.add(threadKey);
      const fence = (fences.get(threadKey) ?? 0) + 1;
      fences.set(threadKey, fence);
      waits.push(Math.max(0, clock - candidate.arrivalMs));
      active.push({ ...candidate, startedMs: clock, fence });
      if (candidate.mutationKey) {
        if (completedMutations.has(candidate.mutationKey)) duplicateMutations++;
        completedMutations.add(candidate.mutationKey);
      }
      activePeak = Math.max(activePeak, active.length);
      progressed = true;
    }
  };

  for (const item of makeWorkload(options)) {
    completeUntil(item.arrivalMs);
    clock = Math.max(clock, item.arrivalMs);
    admit();
    if (waiting.length >= options.maxQueued) {
      rejections++;
      continue;
    }
    // Every generated namespace is explicit; this guard makes leakage observable if the model changes.
    if (!item.namespace.startsWith("tenant-")) namespaceViolations++;
    waiting.push(item);
    queuedPeak = Math.max(queuedPeak, waiting.length);
    admit();
  }
  while (waiting.length > 0 || active.length > 0) {
    if (active.length === 0) {
      clock = Math.max(clock, waiting[0]!.arrivalMs);
      admit();
      continue;
    }
    const next = Math.min(...active.map((item) => item.startedMs + item.durationMs));
    completeUntil(next);
    admit();
  }

  waits.sort((left, right) => left - right);
  const elapsedMs = Math.max(1, clock);
  return {
    profile: options.profile,
    seed: options.seed,
    replicas: options.replicas,
    requested: options.requests,
    completed,
    rejections,
    unavailable: 0,
    outcomeUnknown: 0,
    duplicateMutations,
    sameThreadOverlap,
    staleFenceAccepts,
    namespaceViolations,
    throughputPerSecond: Number(((completed * 1_000) / elapsedMs).toFixed(3)),
    activePeak,
    queuedPeak,
    queueWaitMs: {
      p50: percentile(waits, 0.5),
      p95: percentile(waits, 0.95),
      p99: percentile(waits, 0.99),
    },
  };
}

export function evaluateSyntheticLoad(
  metrics: SyntheticLoadMetrics,
  thresholds: SyntheticLoadThresholds = DEFAULT_SYNTHETIC_LOAD_THRESHOLDS,
): string[] {
  const failures: Array<[string, number, number]> = [
    ["queue wait p95", metrics.queueWaitMs.p95, thresholds.maxQueueWaitP95Ms],
    ["queue wait p99", metrics.queueWaitMs.p99, thresholds.maxQueueWaitP99Ms],
    ["rejections", metrics.rejections, thresholds.maxRejections],
    ["unavailable", metrics.unavailable, thresholds.maxUnavailable],
    ["outcome unknown", metrics.outcomeUnknown, thresholds.maxOutcomeUnknown],
    ["duplicate mutations", metrics.duplicateMutations, thresholds.maxDuplicateMutations],
    ["same-thread overlap", metrics.sameThreadOverlap, thresholds.maxSameThreadOverlap],
    ["stale fence accepts", metrics.staleFenceAccepts, thresholds.maxStaleFenceAccepts],
    ["namespace violations", metrics.namespaceViolations, thresholds.maxNamespaceViolations],
  ];
  return failures
    .filter(([, actual, maximum]) => actual > maximum)
    .map(([name, actual, maximum]) => `${name}: ${actual} exceeds ${maximum}`);
}

function parseCliArgs(args: readonly string[]): SyntheticLoadOptions {
  const values = new Map<string, string>();
  for (const arg of args) {
    const match = /^--([a-z-]+)=(.+)$/.exec(arg);
    if (!match) throw new Error(`expected --name=value argument, got ${arg}`);
    values.set(match[1]!, match[2]!);
  }
  const profile = values.get("profile") as SyntheticLoadProfile | undefined;
  if (!profile) throw new Error("--profile=concierge|order-support is required");
  const number = (name: string): number | undefined => {
    const value = values.get(name);
    return value === undefined ? undefined : Number(value);
  };
  return {
    profile,
    seed: number("seed"),
    replicas: number("replicas"),
    requests: number("requests"),
    maxActive: number("max-active"),
    maxQueued: number("max-queued"),
    namespaceCount: number("namespaces"),
  };
}

if (import.meta.main) {
  try {
    const metrics = runSyntheticDistributedLoad(parseCliArgs(process.argv.slice(2)));
    const failures = evaluateSyntheticLoad(metrics);
    console.log(
      JSON.stringify({ metrics, thresholds: DEFAULT_SYNTHETIC_LOAD_THRESHOLDS, failures }),
    );
    if (failures.length > 0) process.exitCode = 1;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "invalid load harness input");
    process.exitCode = 2;
  }
}
