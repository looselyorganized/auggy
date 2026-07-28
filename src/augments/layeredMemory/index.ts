import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  AdminActionResult,
  AdminInfoBlock,
  Augment,
  CostResult,
  DistributedMemoryPolicyV1,
  ExecutionAuthorityV1,
  ExecutionTraceContextV1,
  InternalTurnContext,
  MemoryEntry,
  MemoryForgetOpts,
  MemoryForgetResult,
  MemoryQueryOpts,
  MemoryWriteResult,
  MemoryWriteOpts,
  PeerIdentity,
  SchedulerContext,
  Transcript,
  TurnResult,
  TurnTrigger,
} from "../../types";
import { canonicalMemoryNamespace } from "../memory-namespace";
import {
  createBuffer,
  type ExtractionBuffer,
  type ExtractionBufferLimits,
} from "./extractor/buffer";
import { type ExtractionFrequencyConfig, shouldExtract } from "./extractor/frequency";
import {
  type ExtractionEngine,
  type ExtractionResult,
  handleExtractionTurn,
} from "./extractor/inject-handler";
import { createSqliteStore } from "./storage/sqlite-store";
import { createSupabaseStore, type LayeredSupabaseClient } from "./storage/supabase-store";
import type { MemoryStore, StoreEntry } from "./storage/types";
import { emptyTrace } from "../../kernel/trace-emitter";
import { deriveNestedOperationId } from "../../kernel/execution-context";
import { isOutcomeUnknownError } from "../../outcome-unknown";
import {
  declareDistributedLayeredMemoryPolicy,
  distributedLayeredMemoryBinding,
  type DistributedLayeredMemoryBinding,
  type DistributedLayeredMemoryExecution,
} from "./distributed-runtime";
import { decodeDistributedMemoryDocument } from "../../coordination/memory-policy";
import type { DistributedMemoryMutationV1 } from "../../coordination/types";

/**
 * Optional auto-save block (PR β / ADR-018 Phase 2). When `enabled` is
 * true (the default), the augment registers two hooks per ADR-027:
 *
 *  - `scheduleAfterTurn`: fires after every user-facing turn, runs the
 *    per-trust-level frequency dispatcher, and either skips, buffers,
 *    or admits an internal extraction turn via `ctx.inject(...)`.
 *  - `handleInternalTurn`: claims triggers whose `source ===
 *    "layered-memory.autoSave"` and runs the extraction LLM call inside
 *    the admitted turn, so cost flows through the standard turn-loop
 *    machinery (turn-gate prepare/confirm + commit) — closing the
 *    cost-attribution gap Codex Critical-2 flagged. The handler returns
 *    a TurnResult whose `trace.inferenceSteps[]` carries the priced
 *    cost the engine reported; `runCostCommit` aggregates and the
 *    budgets augment commits identically to a user-facing turn.
 */
export interface LayeredMemoryAutoSaveOptions {
  enabled?: boolean;
  extractionFrequency?: ExtractionFrequencyConfig;
  everyNTurns?: number;
  confidenceThreshold?: number;
  /**
   * Operator-supplied path to a custom extraction prompt template. The
   * template must contain a `{{TRANSCRIPT}}` token the handler replaces
   * with the rendered transcript. When absent, the bundled
   * `extractor/prompt.md` ships as the default.
   */
  promptTemplate?: string;
  /**
   * Dedicated extraction engine. Required for auto-save to perform
   * extraction. Memorist Decision 6 anticipates this engine being a
   * cheaper Haiku-priced adapter while the user-facing agent runs on
   * Sonnet — keep this knob explicit so operators don't accidentally
   * route extraction through the (more expensive) primary engine.
   */
  engine?: ExtractionEngine;
  /** Finite process-memory limits for deferred anonymous transcripts. */
  bufferLimits?: Partial<ExtractionBufferLimits>;
}

export interface LayeredMemoryOptions {
  backend: "sqlite" | "supabase" | "coordinator";
  namespace: string;
  retentionDays?: number;
  // SQLite-specific
  dbPath?: string;
  // Supabase-specific
  client?: LayeredSupabaseClient;
  table?: string;
  // PR β
  autoSave?: LayeredMemoryAutoSaveOptions;
  /**
   * Exact immutable coordinator partition for this namespace. This is only a
   * declaration: the agent binds it after the coordinator confirms the same
   * policy at startup. It never carries a database credential.
   */
  distributedPolicy?: DistributedMemoryPolicyV1;
}

/**
 * Trigger source string used by both the auto-save scheduler and the
 * internal-turn handler. Kept as a constant so the dispatch routing
 * key has exactly one definition site.
 */
const AUTO_SAVE_TRIGGER_SOURCE = "layered-memory.autoSave";

/**
 * Default per-trust-level frequency config — Decision 3 of the memorist
 * design with Codex 2nd-pass Important-2 calibration applied (`agent`
 * defaults to `every-N-turns` rather than `every-turn`).
 */
const DEFAULT_FREQUENCY_CONFIG: ExtractionFrequencyConfig = {
  creator: "every-turn",
  agent: "every-N-turns",
  public: { recognized: "every-turn", anonymous: "session-end-only" },
};

const DEFAULT_EVERY_N_TURNS = 3;
const DEFAULT_CONFIDENCE_THRESHOLD = 0.5;

/**
 * Synthetic model label that surfaces in the trace's inference-step
 * record for an extraction turn. Distinct from the user-facing agent's
 * model so trace consumers can differentiate extraction spend from
 * primary spend.
 */
const EXTRACTION_MODEL_LABEL = "layered-memory.extraction-engine";

function storeEntryToMemoryEntry(e: StoreEntry): MemoryEntry {
  return {
    label: e.label,
    content: e.content,
    peerId: e.peerId ?? undefined,
    trustLevel: e.trustLevel ?? undefined,
    createdAt: e.createdAt,
    supersededBy: e.supersededBy ?? undefined,
    retentionClass: e.retentionClass,
    isVerbatim: e.isVerbatim,
    origin: e.origin,
  };
}

function memoryDigest(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalDistributedMemoryDocument(content: string, maxEntryBytes: number): Uint8Array {
  const minimumBytes = Buffer.byteLength(JSON.stringify({ version: 1, content: "" }), "utf8");
  if (Buffer.byteLength(content, "utf8") + minimumBytes > maxEntryBytes) {
    throw new Error("distributed layered memory content exceeds coordinator bounds");
  }
  const encoded = new TextEncoder().encode(JSON.stringify({ version: 1, content }));
  if (encoded.byteLength > maxEntryBytes) {
    throw new Error("distributed layered memory content exceeds coordinator bounds");
  }
  return encoded;
}

function canonicalDistributedMemoryQuery(query: string, maxBytes: number): Uint8Array {
  if (query.length === 0) throw new Error("distributed layered memory search query is empty");
  const minimumBytes = Buffer.byteLength(JSON.stringify({ version: 1, contains: "" }), "utf8");
  if (Buffer.byteLength(query, "utf8") + minimumBytes > maxBytes) {
    throw new Error("distributed layered memory search query exceeds coordinator bounds");
  }
  const encoded = new TextEncoder().encode(JSON.stringify({ version: 1, contains: query }));
  if (encoded.byteLength > maxBytes) {
    throw new Error("distributed layered memory search query exceeds coordinator bounds");
  }
  return encoded;
}

function distributedEntryId(
  prefix: string,
  peerId: string,
  label: string,
  operationId: string,
): string {
  const peerPrefix = `${prefix}${peerId}`;
  if (label !== peerPrefix && !label.startsWith(`${peerPrefix}:`)) {
    throw new Error("distributed layered memory label is not peer-bound");
  }
  const suffix = label.slice(peerPrefix.length);
  const encodedSuffix = Buffer.from(suffix, "utf8").toString("base64url");
  const operationSuffix = Buffer.from(memoryDigest(operationId), "hex").toString("base64url");
  const entryId = `mem.${encodedSuffix}.${operationSuffix}`;
  if (entryId.length > 160) {
    throw new Error("distributed layered memory label exceeds coordinator bounds");
  }
  return entryId;
}

function distributedEntryLabel(prefix: string, peerId: string, entryId: string): string {
  const matched = /^mem\.([A-Za-z0-9_-]*)\.[A-Za-z0-9_-]{43}$/.exec(entryId);
  if (!matched) throw new Error("distributed layered memory entry identity is invalid");
  let suffix: string;
  try {
    suffix = new TextDecoder("utf-8", { fatal: true }).decode(
      Buffer.from(matched[1]!, "base64url"),
    );
  } catch {
    throw new Error("distributed layered memory entry identity is invalid");
  }
  if (
    Buffer.from(suffix, "utf8").toString("base64url") !== matched[1] ||
    suffix !== suffix.normalize("NFC") ||
    [...suffix].some((character) => {
      const code = character.codePointAt(0)!;
      return code <= 0x1f || code === 0x7f;
    }) ||
    (suffix !== "" && !suffix.startsWith(":"))
  ) {
    throw new Error("distributed layered memory entry identity is invalid");
  }
  return `${prefix}${peerId}${suffix}`;
}

/**
 * Load the extraction prompt template — operator override path takes
 * precedence; otherwise the augment's bundled `extractor/prompt.md`.
 * Returns null if neither is readable; auto-save then logs and stays
 * disabled at boot rather than failing the whole augment.
 */
function loadPromptTemplate(overridePath?: string): string | null {
  if (overridePath && existsSync(overridePath)) {
    try {
      return readFileSync(overridePath, "utf-8");
    } catch (err) {
      console.warn(
        `[layered-memory.autoSave] failed to read promptTemplate "${overridePath}": ${(err as Error).message}`,
      );
      return null;
    }
  }
  // Bundled default — sibling file inside the extractor folder.
  const bundled = join(import.meta.dir, "extractor", "prompt.md");
  if (existsSync(bundled)) {
    try {
      return readFileSync(bundled, "utf-8");
    } catch (err) {
      console.warn(
        `[layered-memory.autoSave] failed to read bundled prompt template: ${(err as Error).message}`,
      );
      return null;
    }
  }
  return null;
}

/**
 * Detect that a TurnResult corresponds to an auto-save extraction turn
 * the augment itself injected. Used as the recursion guard so the
 * scheduleAfterTurn hook (which fires on EVERY turn, including the
 * extraction turn the augment injected) does not re-enter and trigger
 * extraction-on-extraction loops.
 */
function isAutoSaveTurn(result: TurnResult): boolean {
  return (
    result.trace.trigger.type === "internal" &&
    result.trace.trigger.sourceAugment === AUTO_SAVE_TRIGGER_SOURCE
  );
}

/**
 * Build the per-peer namespaced label used for an extracted fact. The
 * shape mirrors PR α's peer-scoped discipline: `<prefix><peerId>:<turnId>:<idx>`.
 * Each fact gets a distinct suffix so they don't collide within a turn.
 */
function buildAutoSaveLabel(
  prefix: string,
  peerId: string,
  sourceTurnId: string,
  factIndex: number,
): string {
  return `${prefix}${peerId}:${sourceTurnId}:${factIndex}`;
}

/**
 * Payload shape carried on the internal trigger from `scheduleAfterTurn`
 * to `handleInternalTurn`. Kept structural (no class) so the kernel's
 * generic `TurnTrigger.payload: Record<string, unknown>` type accepts it.
 */
interface AutoSaveTriggerPayload extends Record<string, unknown> {
  transcript: Transcript;
  sourceTurnId: string;
  promptTemplate: string;
  confidenceThreshold: number;
  prefix: string;
  peerId: string;
}

function isAutoSaveTriggerPayload(
  payload: TurnTrigger["payload"],
): payload is AutoSaveTriggerPayload {
  if (!payload || typeof payload !== "object") return false;
  const p = payload as Record<string, unknown>;
  return (
    typeof p.sourceTurnId === "string" &&
    typeof p.promptTemplate === "string" &&
    typeof p.confidenceThreshold === "number" &&
    typeof p.prefix === "string" &&
    typeof p.peerId === "string" &&
    p.transcript !== undefined
  );
}

/**
 * Build the TurnResult the kernel turn-loop folds into the kernel
 * trace. The `trace.inferenceSteps[]` carries the priced (or unpriced)
 * extraction cost; the kernel's runCostCommit aggregates this and
 * turnGate.commit observes it (this is the cost-flow path that closes
 * Codex Critical-2).
 *
 * The trace is a stub — the kernel preserves its own trace fields
 * (turnId, threadId, trigger metadata, timestamps) and only consumes
 * `inferenceSteps[]` from the handler-returned trace. We populate the
 * other trace fields with zero/empty defaults so the type checks.
 */
function buildExtractionTurnResult(args: {
  trigger: TurnTrigger;
  status: "completed" | "failed" | "rejected";
  cost: CostResult;
  inferenceDurationMs: number;
  inferenceOutcome?: "completed" | "failed" | "canceled" | "outcome-unknown";
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
  responseText?: string;
  outcomeUnknown?: boolean;
}): TurnResult {
  const turnId = args.trigger.turnId;
  const threadId = args.trigger.threadId ?? turnId;
  const trace = emptyTrace({
    turnId,
    threadId,
    trigger: { type: "internal", sourceAugment: AUTO_SAVE_TRIGGER_SOURCE },
  });
  if (args.inferenceOutcome) {
    trace.inferenceSteps.push({
      model: EXTRACTION_MODEL_LABEL,
      outcome: args.inferenceOutcome,
      inputTokens: args.inputTokens ?? 0,
      outputTokens: args.outputTokens ?? 0,
      durationMs: args.inferenceDurationMs,
      toolCalls: [],
      cost: args.cost,
    });
  }
  return {
    turnId,
    success: args.status === "completed",
    status: args.status,
    response: args.responseText
      ? { parts: [{ kind: "text", text: args.responseText }] }
      : undefined,
    toolCalls: [],
    error: args.errorMessage
      ? { message: args.errorMessage, source: AUTO_SAVE_TRIGGER_SOURCE }
      : undefined,
    ...(args.outcomeUnknown ? { outcomeUnknown: true } : {}),
    trace,
  };
}

/**
 * Run the extraction body for a single internal turn. Calls the engine,
 * parses the response, writes facts via the store's writeAutoSavedEntry,
 * and returns a TurnResult whose trace.inferenceSteps[] carries the
 * priced cost the kernel turn-loop's runCostCommit will surface to
 * turnGate.commit (cost-flow contract per ADR-027 Decision 5).
 *
 * Best-effort. Engine errors and parse errors map to a failed
 * TurnResult that STILL carries the engine's reported cost (when an
 * engine billed for a malformed response, suppressing it in budgets
 * would silently break daily-cap accounting). Per-fact write failures
 * are logged and swallowed.
 */
async function runExtractionInsideTurn(args: {
  trigger: TurnTrigger;
  transcript: Transcript;
  engine: ExtractionEngine;
  promptTemplate: string;
  store: MemoryStore;
  prefix: string;
  peerId: string;
  confidenceThreshold: number;
  sourceTurnId: string;
  signal?: AbortSignal;
  executionContext?: ExecutionTraceContextV1;
  executionAuthority?: ExecutionAuthorityV1;
  operationId?: string;
}): Promise<TurnResult> {
  args.signal?.throwIfAborted();
  const inferenceStart = Date.now();
  let result: ExtractionResult;
  try {
    result = await handleExtractionTurn({
      transcript: args.transcript,
      engine: args.engine,
      promptTemplate: args.promptTemplate,
      signal: args.signal,
      executionContext: args.executionContext,
      executionAuthority: args.executionAuthority,
      operationId: deriveNestedOperationId(args.operationId, "extraction-model", 0),
    });
  } catch (error) {
    if (!isOutcomeUnknownError(error)) throw error;
    return buildExtractionTurnResult({
      trigger: args.trigger,
      status: "failed",
      cost: { priced: false, reason: "extraction inference outcome is unknown" },
      inferenceDurationMs: Date.now() - inferenceStart,
      inferenceOutcome: "outcome-unknown",
      errorMessage: "extraction inference outcome is unknown",
      outcomeUnknown: true,
    });
  }
  const inferenceDurationMs = Date.now() - inferenceStart;
  const cost: CostResult =
    result.costUsd > 0
      ? { priced: true, costUsd: result.costUsd }
      : { priced: false, reason: "extraction engine reported zero cost" };

  if (!result.success) {
    console.warn(
      `[layered-memory.autoSave] extraction failed (sourceTurn=${args.sourceTurnId}): ${result.error}`,
    );
    return buildExtractionTurnResult({
      trigger: args.trigger,
      status: "failed",
      cost,
      inferenceDurationMs,
      inferenceOutcome: result.inferenceOutcome,
      errorMessage: result.error,
    });
  }

  let written = 0;
  for (const [idx, fact] of result.facts.entries()) {
    if (args.signal?.aborted) {
      return buildExtractionTurnResult({
        trigger: args.trigger,
        status: "failed",
        cost,
        inferenceDurationMs,
        inferenceOutcome: result.inferenceOutcome,
        errorMessage: "extraction canceled after inference completed",
      });
    }
    if (fact.confidence < args.confidenceThreshold) {
      // Below threshold: skip rather than write a low-signal entry.
      // Spec Decision 7 leaves a knob for "write but flag" — at v1.0
      // we err on the side of fewer writes; future calibration can
      // revisit once eval data exists.
      continue;
    }
    try {
      if (args.signal?.aborted) {
        return buildExtractionTurnResult({
          trigger: args.trigger,
          status: "failed",
          cost,
          inferenceDurationMs,
          inferenceOutcome: result.inferenceOutcome,
          errorMessage: "extraction canceled after inference completed",
        });
      }
      await args.store.writeAutoSavedEntry({
        peerId: args.peerId,
        label: buildAutoSaveLabel(args.prefix, args.peerId, args.sourceTurnId, idx),
        content: fact.object,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        retentionClass: "operational",
        isVerbatim: fact.isVerbatim,
        sourceTurnId: args.sourceTurnId,
        model: EXTRACTION_MODEL_LABEL,
      });
      if (args.signal?.aborted) {
        return buildExtractionTurnResult({
          trigger: args.trigger,
          status: "failed",
          cost,
          inferenceDurationMs,
          inferenceOutcome: result.inferenceOutcome,
          errorMessage: "extraction canceled while persisting inferred memory",
        });
      }
      written++;
    } catch (err) {
      if (args.signal?.aborted) {
        return buildExtractionTurnResult({
          trigger: args.trigger,
          status: "failed",
          cost,
          inferenceDurationMs,
          inferenceOutcome: result.inferenceOutcome,
          errorMessage: "extraction canceled while persisting inferred memory",
        });
      }
      console.warn(
        `[layered-memory.autoSave] writeAutoSavedEntry failed for fact ${idx}: ${(err as Error).message}`,
      );
    }
  }

  if (args.signal?.aborted) {
    return buildExtractionTurnResult({
      trigger: args.trigger,
      status: "failed",
      cost,
      inferenceDurationMs,
      inferenceOutcome: result.inferenceOutcome,
      errorMessage: "extraction canceled after inference completed",
    });
  }
  return buildExtractionTurnResult({
    trigger: args.trigger,
    status: "completed",
    cost,
    inferenceDurationMs,
    inferenceOutcome: result.inferenceOutcome,
    responseText: `extracted ${written} fact(s) from turn ${args.sourceTurnId}`,
  });
}

export async function layeredMemory(opts: LayeredMemoryOptions): Promise<Augment> {
  const namespace = canonicalMemoryNamespace(opts.namespace, "layeredMemory");
  const prefix = namespace.prefix;
  const retentionDays = opts.retentionDays ?? 90;
  let augment!: Augment;

  let store: MemoryStore | undefined;
  if (opts.backend === "sqlite") {
    if (opts.distributedPolicy) {
      throw new Error(
        "layeredMemory: distributedPolicy requires the coordinator backend; import SQLite only while drained",
      );
    }
    if (!opts.dbPath) throw new Error("layeredMemory: sqlite backend requires dbPath");
    store = createSqliteStore({
      dbPath: opts.dbPath,
      retentionDays,
      namespace: namespace.namespace,
    });
  } else if (opts.backend === "supabase") {
    if (opts.distributedPolicy) {
      throw new Error(
        "layeredMemory: generic Supabase is not a fenced distributed memory authority",
      );
    }
    if (!opts.client || !opts.table) {
      throw new Error("layeredMemory: supabase backend requires client and table");
    }
    store = createSupabaseStore({
      client: opts.client,
      table: opts.table,
      retentionDays,
      namespace: namespace.namespace,
    });
  } else if (opts.backend === "coordinator") {
    if (!opts.distributedPolicy) {
      throw new Error("layeredMemory: coordinator backend requires distributedPolicy");
    }
  } else {
    throw new Error(`layeredMemory: unknown backend "${opts.backend}"`);
  }

  await store?.initialize();

  // Auto-save state (per-augment-instance — process-local). The buffer
  // accumulates session-end-only transcripts; turnIndexes drives the
  // every-N-turns dispatcher; threadPeerHistory tracks the most-recent
  // peerId observed on each threadId so the scheduler can detect an
  // anonymous→recognized promotion (Decision 5 of the memorist design).
  const autoSaveEnabled = opts.autoSave?.enabled ?? true;
  const buffer: ExtractionBuffer = createBuffer(opts.autoSave?.bufferLimits);
  const stateIdleTtlMs = opts.autoSave?.bufferLimits?.idleTtlMs ?? 30 * 60 * 1000;
  const stateMaxEntries = opts.autoSave?.bufferLimits?.maxPeers ?? 1024;
  const turnIndexes = new Map<string, { value: number; lastAccess: number }>();
  const threadPeerHistory = new Map<
    string,
    { peer: import("../../types").PeerIdentity; lastAccess: number }
  >();
  const promptTemplate = autoSaveEnabled ? loadPromptTemplate(opts.autoSave?.promptTemplate) : null;
  if (autoSaveEnabled && promptTemplate === null) {
    console.warn(
      "[layered-memory.autoSave] no prompt template available; auto-save disabled until promptTemplate is configured",
    );
  }
  const frequencyConfig = opts.autoSave?.extractionFrequency ?? DEFAULT_FREQUENCY_CONFIG;
  const everyNTurns = opts.autoSave?.everyNTurns ?? DEFAULT_EVERY_N_TURNS;
  const confidenceThreshold = opts.autoSave?.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
  const extractionEngine = opts.autoSave?.engine;

  function sweepAutoSaveState(now = Date.now()): void {
    buffer.sweep();
    const cutoff = now - stateIdleTtlMs;
    for (const [id, entry] of turnIndexes) {
      if (entry.lastAccess <= cutoff) turnIndexes.delete(id);
    }
    for (const [id, entry] of threadPeerHistory) {
      if (entry.lastAccess <= cutoff) threadPeerHistory.delete(id);
    }
  }

  type PeerBoundDistributedExecution = {
    binding: DistributedLayeredMemoryBinding;
    execution: DistributedLayeredMemoryExecution & { peer: PeerIdentity };
  };
  type PossiblyPeerlessDistributedExecution = {
    binding: DistributedLayeredMemoryBinding;
    execution: DistributedLayeredMemoryExecution;
  };

  function distributedExecution(
    options: Pick<MemoryQueryOpts, "peerId" | "executionContext" | "executionAuthority">,
  ): PeerBoundDistributedExecution | null;
  function distributedExecution(
    options: Pick<MemoryQueryOpts, "peerId" | "executionContext" | "executionAuthority">,
    allowPeerless: true,
  ): PossiblyPeerlessDistributedExecution | null;
  function distributedExecution(
    options: Pick<MemoryQueryOpts, "peerId" | "executionContext" | "executionAuthority">,
    allowPeerless = false,
  ): PeerBoundDistributedExecution | PossiblyPeerlessDistributedExecution | null {
    const binding = distributedLayeredMemoryBinding(augment);
    if (!binding) return null;
    if (!options.executionAuthority || !options.executionContext) {
      throw new Error("distributed layered memory authority is required");
    }
    const execution = binding.resolveExecution(
      options.executionContext,
      options.executionAuthority,
    );
    if (!execution) throw new Error("distributed layered memory execution is stale");
    if (!execution.peer) {
      if (!allowPeerless || options.peerId !== undefined) {
        throw new Error("distributed layered memory peer binding is denied");
      }
      return { binding, execution };
    }
    if (!options.peerId || options.peerId !== execution.peer.id) {
      throw new Error("distributed layered memory peer binding is denied");
    }
    return { binding, execution: { ...execution, peer: execution.peer } };
  }

  const search = async (query: string, queryOpts?: MemoryQueryOpts): Promise<MemoryEntry[]> => {
    const distributed = distributedExecution(queryOpts ?? {});
    if (distributed) {
      const result = await distributed.binding.coordinator.searchMemory(
        distributed.execution.lease,
        {
          policyId: distributed.binding.policy.id,
          peerBinding: distributed.execution.peerBinding,
          query: canonicalDistributedMemoryQuery(query, distributed.binding.policy.maxQueryBytes),
          limit: distributed.binding.policy.maxResults,
        },
      );
      if (result.status !== "ok") {
        throw new Error(`distributed layered memory search ${result.status}`);
      }
      return result.entries.map((entry) => {
        const document = decodeDistributedMemoryDocument(entry.body);
        if (
          entry.origin !== "operator" &&
          entry.origin !== "peer-derived" &&
          entry.origin !== "agent-derived" &&
          entry.origin !== "agent"
        ) {
          throw new Error("distributed layered memory provenance is invalid");
        }
        if (
          !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(entry.sourceTurnId) ||
          !/^[0-9a-f]{64}$/.test(entry.provenanceHash)
        ) {
          throw new Error("distributed layered memory provenance is invalid");
        }
        return {
          label: distributedEntryLabel(prefix, distributed.execution.peer.id, entry.id),
          content: document.content,
          peerId: distributed.execution.peer.id,
          trustLevel: distributed.execution.peer.trustLevel,
          createdAt: Date.parse(entry.createdAt),
          metadata: {
            sourceTurnId: entry.sourceTurnId,
            provenanceHash: entry.provenanceHash,
          },
          retentionClass: "operational" as const,
          isVerbatim: false,
          origin: entry.origin,
        };
      });
    }
    if (!store) throw new Error("distributed layered memory authority is required");
    const results = await store.search(query, queryOpts?.peerId);
    return results.map(storeEntryToMemoryEntry);
  };

  const write = async (
    label: string,
    content: string,
    writeOpts?: MemoryWriteOpts,
  ): Promise<MemoryWriteResult> => {
    if (!label.startsWith(prefix)) {
      throw new Error(
        `layeredMemory: label "${label}" does not start with namespace prefix "${prefix}"`,
      );
    }
    // Structural peer-binding: if a peerId is provided, the label MUST be
    // scoped to that peer (format: <prefix><peerId> or <prefix><peerId>:<rest>).
    // This prevents peer A from writing to a label like "ep:vis_b:1" — even if
    // they guessed it — by storing a row whose label segment claims another
    // peer. Without this, search remains peer-isolated (rows are stored with
    // the caller's peer_id, not the label's), but the database accumulates
    // misleading rows that could surface in audit/forget paths.
    const peerId = writeOpts?.peerId;
    if (peerId) {
      const peerScopedPrefix = `${prefix}${peerId}`;
      if (label !== peerScopedPrefix && !label.startsWith(`${peerScopedPrefix}:`)) {
        throw new Error(
          `layeredMemory: peer "${peerId}" cannot write to label "${label}" — labels must be scoped as "${peerScopedPrefix}" or "${peerScopedPrefix}:<topic>"`,
        );
      }
    }

    const distributed = distributedExecution(writeOpts ?? {});
    if (distributed) {
      if (!writeOpts?.operationId) {
        throw new Error("distributed layered memory write lacks an operation identity");
      }
      if (writeOpts.trustLevel && writeOpts.trustLevel !== distributed.execution.peer.trustLevel) {
        throw new Error("distributed layered memory trust binding is denied");
      }
      const operationId = writeOpts.operationId;
      const document = canonicalDistributedMemoryDocument(
        content,
        distributed.binding.policy.maxEntryBytes,
      );
      const mutation: DistributedMemoryMutationV1 = {
        version: 1,
        operationId,
        policyId: distributed.binding.policy.id,
        sourceTurnId: distributed.execution.lease.requestId,
        origin: "peer-derived",
        provenanceHash: memoryDigest(
          `auggy-layered-memory-write-v1\0${operationId}\0${distributed.execution.peerBinding.bindingHash}`,
        ),
        kind: "write",
        entryId: distributedEntryId(prefix, distributed.execution.peer.id, label, operationId),
        expectedPeerEraseEpoch: -1,
        body: document,
      };
      await distributed.execution.stageMemoryMutation(mutation);
      return { status: "staged" };
    }

    if (!store) throw new Error("distributed layered memory authority is required");
    await store.write({
      label,
      content,
      peerId: peerId ?? null,
      trustLevel: writeOpts?.trustLevel ?? null,
      createdAt: Date.now(),
      supersededBy: null,
      retentionClass: "operational",
      isVerbatim: false,
      expiresAt: null,
    });
  };

  const forget = async (
    peerId: string,
    forgetOpts?: MemoryForgetOpts,
  ): Promise<MemoryForgetResult> => {
    const distributed = distributedExecution(forgetOpts ?? {}, true);
    if (distributed) {
      if (!forgetOpts?.operationId) {
        throw new Error("distributed layered memory forget lacks an operation identity");
      }
      await distributed.execution.stageMemoryMutation({
        version: 1,
        operationId: forgetOpts.operationId,
        policyId: distributed.binding.policy.id,
        sourceTurnId: distributed.execution.lease.requestId,
        origin: "operator",
        provenanceHash: memoryDigest(
          `auggy-layered-memory-forget-v1\0${forgetOpts.operationId}\0${distributed.execution.peerBinding.bindingHash}`,
        ),
        kind: "forget",
        targetPeerId: peerId,
      });
      return { status: "staged" };
    }
    if (!store) throw new Error("distributed layered memory authority is required");
    return store.forget(peerId);
  };

  // NOTE: read() is intentionally NOT exposed on this NamespaceMemoryProvider.
  // Episodic memory is peer-scoped — direct label reads bypass that scoping
  // because the generic memory_read tool only checks origin, not peer
  // ownership of the label. Callers must use search (peer-scoped via
  // ToolExecuteContext) instead. memory_read on an "ep:" label will return
  // "does not support reading by label", which is the desired behavior.

  /**
   * Detect that an anonymous→recognized promotion has just happened on
   * `threadId` and, if so, flush the buffered anonymous-bound transcripts
   * by injecting an extraction trigger. Per the post-PR-1 fix, the flush
   * targets the NEW recognized peer-id (currentPeer), NOT the prior
   * anonymous peer-id — this preserves visitorAuth's verify-time peer-id
   * migration. Pragmatic deviation from the original "Decision 5" of the
   * memorist design (which scoped facts to their original identity);
   * once a visitor verifies, they own the conversation history they
   * participated in. See inline comment at the payload construction
   * site for full rationale.
   *
   * The trigger's `peer` field is also set to `currentPeer` (not the old
   * anon peer) so that budget caps and turn gates apply to the recognized
   * identity — preventing the anonymous peer's (possibly exhausted) caps
   * from blocking the flush.
   *
   * Detection is fail-closed: the prior turn must be public/anonymous, the
   * current turn must be public/recognized, and the transport must provide a
   * cryptographically authenticated prior-peer link matching that anonymous
   * subject. Caller-controlled ID shape is never promotion evidence.
   *
   * Best-effort. ctx.inject failures are caught and logged; the buffered
   * transcripts are dropped on failure.
   */
  async function maybeFlushOnPromotion(
    threadId: string,
    currentPeer: import("../../types").PeerIdentity,
    ctx: SchedulerContext,
  ): Promise<void> {
    const currentPeerId = currentPeer.id;
    const priorEntry = threadPeerHistory.get(threadId);
    if (!priorEntry) return; // first turn on this thread
    const priorPeer = priorEntry.peer;
    if (
      priorPeer.trustLevel !== "public" ||
      priorPeer.publicSubstate !== "anonymous" ||
      currentPeer.trustLevel !== "public" ||
      currentPeer.publicSubstate !== "recognized" ||
      currentPeer.authenticatedPriorPeerId !== priorPeer.id
    ) {
      return;
    }
    const buffered = buffer.flush(priorPeer.id);
    if (buffered.length === 0) return; // nothing to flush
    if (!extractionEngine || !promptTemplate) return; // can't extract

    // Synthesize a single combined transcript from the buffered turns
    // so one extraction call covers the whole anonymous batch (per
    // session-end-only semantics). The flush's source turnId is the
    // last buffered turn's id — that's the most recent context the
    // anonymous peer contributed before promotion.
    const last = buffered[buffered.length - 1];
    if (!last) return;
    const combinedParts = buffered.flatMap((t) => t.parts);
    // The buffered transcripts were recorded under the OLD anonymous identity —
    // preserve that in the combined transcript (historical record of what
    // the peer said while anonymous).
    const combinedTranscript: Transcript = {
      turnId: last.turnId,
      threadId: last.threadId,
      peer: last.peer,
      parts: combinedParts,
      toolCalls: buffered.flatMap((t) => t.toolCalls),
      startedAt: buffered[0]?.startedAt ?? last.startedAt,
      endedAt: last.endedAt,
    };

    const flushSourceTurnId = last.turnId;
    const payload: AutoSaveTriggerPayload = {
      transcript: combinedTranscript,
      sourceTurnId: flushSourceTurnId,
      promptTemplate,
      confidenceThreshold,
      prefix,
      // Use the NEW recognized peer-id, not the old anonymous one. By the time
      // this flush fires, visitorAuth's verify-route has already migrated
      // existing memory rows from anon_session_<uuid> to vis_<uuid> via
      // migratePeerIdOnVerify. If we wrote new facts under priorPeerId, we'd
      // recreate the orphaned-history regression that migration was designed
      // to prevent. Pragmatic deviation from "Decision 5" of the memorist
      // design (which said anonymous facts should remain anonymous): once a
      // visitor proves identity, they own the conversation history they
      // participated in.
      peerId: currentPeerId,
    };
    const trigger: TurnTrigger = {
      type: "internal",
      turnId: `auto-save-flush-${priorPeer.id}-${flushSourceTurnId}`,
      threadId,
      timestamp: Date.now(),
      source: AUTO_SAVE_TRIGGER_SOURCE,
      // Use the NEW recognized peer identity, not the old anon peer.
      // Budget caps and turn gates key off trigger.peer, so the flush
      // must target the recognized peer to get correct accounting.
      peer: currentPeer,
      payload,
    };
    try {
      await ctx.inject(trigger);
    } catch (err) {
      console.warn(
        `[layered-memory.autoSave] promotion-flush ctx.inject failed for prior peer=${priorPeer.id}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Post-turn auto-save dispatcher. ADR-027 delivers `result` + `ctx`
   * after every turn (including the extraction turns this augment
   * itself injects — those are skipped by `isAutoSaveTurn` to prevent
   * recursion).
   *
   * For decision === "extract", this hook calls `ctx.inject(...)` with
   * an internal trigger; the kernel routes that trigger to this same
   * augment's `handleInternalTurn`, which runs the extraction LLM call
   * inside the admitted turn so cost flows through `turnGate.commit`.
   * Errors during inject are caught and logged — best-effort per
   * ADR-027 Decision 2.
   *
   * Promotion flush (post-PR-1 behavior): before applying the standard
   * frequency dispatch, check whether the just-completed turn's peerId
   * differs from the prior peerId for the same threadId AND the prior
   * peerId was a verified anonymous-session subject. If so, inject a
   * one-off extraction-flush trigger targeting the NEW recognized peer
   * (see `maybeFlushOnPromotion` JSDoc for why this deviates from the
   * original "Decision 5" of the memorist design).
   */
  async function scheduleAfterTurn(result: TurnResult, ctx: SchedulerContext): Promise<void> {
    ctx.signal?.throwIfAborted();
    // Local extraction buffers and the bundled stores are not part of the
    // coordinator transaction yet. Reject the complete distributed hook
    // before reading a transcript or mutating promotion/frequency/buffer
    // state; the internal-handler check remains defense in depth.
    if (ctx.executionAuthority) return;
    if (!autoSaveEnabled) return;
    if (!promptTemplate) return;
    // No consumer exists without an extraction engine. Do not retrieve or
    // retain completed transcripts that can never be processed.
    if (!extractionEngine) return;
    // Recursion guard: skip extraction-initiated turns. Without this,
    // every injected extraction turn would itself fire scheduleAfterTurn
    // and synthesize another extraction trigger ad infinitum.
    if (isAutoSaveTurn(result)) return;

    const transcript = await ctx.getCompletedTranscript();
    ctx.signal?.throwIfAborted();
    if (!transcript) return; // turn was compacted before the hook ran
    if (!transcript.peer) return; // no peer, no scoped namespace to write under

    const peerId = transcript.peer.id;
    const threadId = transcript.threadId;

    // Expired anonymous state must disappear before promotion detection;
    // otherwise a later verification could extract data beyond the declared
    // idle-retention window.
    sweepAutoSaveState();

    // Decision 5: detect anonymous→recognized promotion and flush
    // anonymous-bound buffer BEFORE we apply the current peer's cadence.
    // Pass the full peer object so trigger.peer targets the recognized
    // identity (budget caps and turn gates key off trigger.peer).
    await maybeFlushOnPromotion(threadId, transcript.peer, ctx);
    ctx.signal?.throwIfAborted();

    // Update thread→peer history AFTER promotion detection so the
    // detector compares against the prior turn's identity.
    const now = Date.now();
    while (turnIndexes.size >= stateMaxEntries && !turnIndexes.has(peerId)) {
      const oldest = turnIndexes.keys().next().value;
      if (oldest === undefined) break;
      turnIndexes.delete(oldest);
    }
    while (threadPeerHistory.size >= stateMaxEntries && !threadPeerHistory.has(threadId)) {
      const oldest = threadPeerHistory.keys().next().value;
      if (oldest === undefined) break;
      threadPeerHistory.delete(oldest);
    }
    threadPeerHistory.delete(threadId);
    threadPeerHistory.set(threadId, { peer: { ...transcript.peer }, lastAccess: now });

    const turnIndex = turnIndexes.get(peerId)?.value ?? 0;
    turnIndexes.delete(peerId);
    turnIndexes.set(peerId, { value: turnIndex + 1, lastAccess: now });

    const decision = shouldExtract(
      {
        trustLevel: transcript.peer.trustLevel,
        publicSubstate: transcript.peer.publicSubstate,
      },
      turnIndex,
      frequencyConfig,
      everyNTurns,
    );

    if (decision === "skip") return;
    if (decision === "buffer") {
      buffer.append(peerId, transcript);
      return;
    }

    // decision === "extract"
    if (!extractionEngine) {
      // No engine configured — log once-per-turn and skip. The frequency
      // dispatcher already advanced the turnIndex above so subsequent
      // turns still honor the cadence even when extraction itself is a
      // no-op.
      console.warn(
        `[layered-memory.autoSave] no extraction engine configured; skipping extraction for turn ${transcript.turnId}`,
      );
      return;
    }

    // Inject an internal trigger; the kernel routes back to this
    // augment's handleInternalTurn (option a — extraction admits as its
    // own turn, cost flows through turnGate.commit).
    const sourceTurnId = transcript.turnId;
    const payload: AutoSaveTriggerPayload = {
      transcript,
      sourceTurnId,
      promptTemplate,
      confidenceThreshold,
      prefix,
      peerId,
    };
    const trigger: TurnTrigger = {
      type: "internal",
      turnId: `auto-save-${sourceTurnId}`,
      threadId: transcript.threadId,
      timestamp: Date.now(),
      source: AUTO_SAVE_TRIGGER_SOURCE,
      peer: transcript.peer,
      payload,
    };
    try {
      await ctx.inject(trigger);
    } catch (err) {
      // ctx.inject failures are best-effort per ADR-027 — log and move
      // on. The user-facing turn already succeeded; extraction loss is
      // operationally low-stakes (next turn will retry on cadence).
      console.warn(
        `[layered-memory.autoSave] ctx.inject failed for sourceTurn=${sourceTurnId}: ${(err as Error).message}`,
      );
    }
  }

  /**
   * ADR-027 Decision 5 internal-trigger handler. Claims triggers whose
   * `source === "layered-memory.autoSave"` and runs the extraction LLM
   * call inside the kernel's admitted turn. The returned TurnResult's
   * `trace.inferenceSteps[]` carries the priced cost; the kernel
   * turn-loop's `runCostCommit` aggregates and `turnGate.commit`
   * observes — closing Codex Critical-2.
   *
   * Returns null for any trigger this augment does not own; the kernel
   * then offers the trigger to the next augment's handleInternalTurn
   * (or falls through to the standard inference loop if no augment
   * claims).
   */
  async function handleInternalTurn(
    trigger: TurnTrigger,
    ctx: InternalTurnContext,
  ): Promise<TurnResult | null> {
    ctx.signal?.throwIfAborted();
    if (trigger.source !== AUTO_SAVE_TRIGGER_SOURCE) return null;
    if (!isAutoSaveTriggerPayload(trigger.payload)) {
      // Defensive — a stray internal trigger named auto-save without
      // the expected payload shape. Don't try to extract; surface as a
      // failed turn so the misuse is visible in trace.
      return buildExtractionTurnResult({
        trigger,
        status: "failed",
        cost: { priced: false, reason: "auto-save trigger missing required payload fields" },
        inferenceDurationMs: 0,
        errorMessage: "auto-save trigger missing required payload fields",
      });
    }
    if (ctx.executionAuthority) {
      // The bundled SQLite and Supabase memory stores do not yet share the
      // coordinator transaction/fence. Starting extraction here would permit
      // a stale replica to bill or persist after authority loss. Checkpoint 5
      // introduces the supported shared/fenced memory adapter; until then the
      // distributed path is explicitly unavailable before either effect.
      return buildExtractionTurnResult({
        trigger,
        status: "rejected",
        cost: { priced: false, reason: "distributed auto-save storage is not configured" },
        inferenceDurationMs: 0,
        errorMessage: "distributed auto-save requires a shared fenced memory adapter",
      });
    }
    if (!extractionEngine) {
      // Configuration drifted between scheduleAfterTurn-time and here
      // (e.g. operator hot-reloaded the engine to undefined). Best-effort
      // — surface as a failed turn so the trace shows it.
      return buildExtractionTurnResult({
        trigger,
        status: "failed",
        cost: { priced: false, reason: "no extraction engine configured" },
        inferenceDurationMs: 0,
        errorMessage: "no extraction engine configured",
      });
    }
    if (!store) {
      return buildExtractionTurnResult({
        trigger,
        status: "rejected",
        cost: { priced: false, reason: "distributed auto-save storage is not configured" },
        inferenceDurationMs: 0,
        errorMessage: "distributed auto-save requires coordinator-owned extraction state",
      });
    }
    return runExtractionInsideTurn({
      trigger,
      transcript: trigger.payload.transcript as Transcript,
      engine: extractionEngine,
      promptTemplate: trigger.payload.promptTemplate,
      store,
      prefix: trigger.payload.prefix,
      peerId: trigger.payload.peerId,
      confidenceThreshold: trigger.payload.confidenceThreshold,
      sourceTurnId: trigger.payload.sourceTurnId,
      signal: ctx.signal,
      executionContext: ctx.executionContext,
      executionAuthority: ctx.executionAuthority,
      operationId: ctx.operationId,
    });
  }

  function formatAge(createdAt: number): string {
    const seconds = Math.floor((Date.now() - createdAt) / 1000);
    if (seconds < 60) return `${seconds}s`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes}m`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}h`;
    return `${Math.floor(hours / 24)}d`;
  }

  async function adminInfo(): Promise<AdminInfoBlock> {
    if (distributedLayeredMemoryBinding(augment)) {
      throw new Error("distributed layered memory admin reads require coordinator authority");
    }
    if (!store) throw new Error("distributed layered memory authority is required");
    const counts = await store.countByRetentionClass();
    const entries = await store.listEntriesByPeer({ limit: 50 });
    return {
      augmentName: `layered-memory-${namespace.namespace}`,
      title: "Memory",
      sections: [
        {
          kind: "keyValue",
          rows: [
            { label: "Total entries", value: String(counts.total) },
            { label: "Operational", value: String(counts.operational) },
            { label: "Lesson", value: String(counts.lesson) },
            { label: "Namespace", value: prefix },
          ],
        },
        {
          kind: "table",
          columns: ["Peer", "Label", "Content (snippet)", "Retention", "Age"],
          rows: entries.map((e) => [
            e.peerId ?? "(no peer)",
            e.label,
            (e.content ?? "").slice(0, 80),
            e.retentionClass ?? "operational",
            formatAge(e.createdAt),
          ]),
          rowActions: [
            {
              id: "memory-erase",
              label: "Erase peer",
              confirmRequired: true,
              rowKeyColumn: 0,
            },
          ],
          caption: `Showing ${entries.length} most recent entries`,
        },
      ],
    };
  }

  const adminActions: Record<
    string,
    (params: Record<string, unknown>) => Promise<AdminActionResult>
  > = {
    "memory-erase": async (params) => {
      if (distributedLayeredMemoryBinding(augment)) {
        return {
          ok: false,
          message: "distributed layered memory admin erase requires a fenced turn",
        };
      }
      if (!store) {
        return { ok: false, message: "distributed layered memory authority is required" };
      }
      const rowKey = typeof params.rowKey === "string" ? params.rowKey : "";
      if (!rowKey || rowKey === "(no peer)") {
        return { ok: false, message: "memory-erase requires a rowKey (peer id)" };
      }
      const erased = await store.forget(rowKey);
      return { ok: true, message: `Erased ${erased} entries for ${rowKey}` };
    },
  };

  augment = {
    name: `layered-memory-${namespace.namespace}`,
    type: "layeredMemory",
    category: "memory",
    memory: {
      owns: { kind: "namespace", prefix },
      defaults: {
        mutable: true,
        origin: "peer-derived",
        priority: "normal",
        placement: "preamble",
        eviction: "drop",
        ttl: "session",
      },
      search,
      write,
      forget,
      listEntries: async (opts) => {
        if (distributedLayeredMemoryBinding(augment)) {
          throw new Error("distributed layered memory listing requires coordinator authority");
        }
        if (!store) throw new Error("distributed layered memory authority is required");
        const rows = await store.listEntriesByPeer(opts);
        return rows.map((r) => ({
          label: r.label,
          content: r.content,
          metadata: undefined,
          peerId: r.peerId ?? undefined,
          trustLevel: r.trustLevel ?? undefined,
          createdAt: r.createdAt,
          supersededBy: r.supersededBy ?? undefined,
          retentionClass: r.retentionClass,
          isVerbatim: r.isVerbatim,
          origin: r.origin,
        }));
      },
    },
    adminInfo,
    adminActions,
    ...(autoSaveEnabled ? { scheduleAfterTurn, handleInternalTurn } : {}),
    onIdle: async () => {
      sweepAutoSaveState();
    },
    onShutdown: async () => {
      buffer.clear();
      turnIndexes.clear();
      threadPeerHistory.clear();
      await store?.close();
    },
  };
  if (opts.distributedPolicy) {
    declareDistributedLayeredMemoryPolicy(augment, opts.distributedPolicy);
  }
  return augment;
}
