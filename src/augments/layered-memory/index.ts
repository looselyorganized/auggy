import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Augment,
  CostResult,
  InternalTurnContext,
  MemoryEntry,
  MemoryQueryOpts,
  MemoryWriteOpts,
  SchedulerContext,
  Transcript,
  TurnResult,
  TurnTrigger,
} from "../../types";
import { createBuffer, type ExtractionBuffer } from "./extractor/buffer";
import { type ExtractionFrequencyConfig, shouldExtract } from "./extractor/frequency";
import { type ExtractionEngine, handleExtractionTurn } from "./extractor/inject-handler";
import { createSqliteStore } from "./storage/sqlite-store";
import { createSupabaseStore, type LayeredSupabaseClient } from "./storage/supabase-store";
import type { MemoryStore, StoreEntry } from "./storage/types";

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
}

export interface LayeredMemoryOptions {
  backend: "sqlite" | "supabase";
  namespace: string;
  retentionDays?: number;
  // SQLite-specific
  dbPath?: string;
  // Supabase-specific
  client?: LayeredSupabaseClient;
  table?: string;
  // PR β
  autoSave?: LayeredMemoryAutoSaveOptions;
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
  status: "completed" | "failed";
  cost: CostResult;
  inferenceDurationMs: number;
  inputTokens?: number;
  outputTokens?: number;
  errorMessage?: string;
  responseText?: string;
}): TurnResult {
  const turnId = args.trigger.turnId;
  const threadId = args.trigger.threadId ?? turnId;
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
    trace: {
      turnId,
      threadId,
      timestamp: Date.now(),
      duration: 0,
      trigger: {
        type: "internal",
        sourceAugment: AUTO_SAVE_TRIGGER_SOURCE,
      },
      contextAssembly: {
        augmentBlocks: [],
        preambleTokens: 0,
        toolSchemaTokens: 0,
        historyTokens: 0,
        totalTokens: 0,
        budgetUsed: 0,
      },
      toolSelection: {
        totalTools: 0,
        phase1Used: false,
        mountedTools: [],
        withheldTools: [],
      },
      inferenceSteps: [
        {
          model: EXTRACTION_MODEL_LABEL,
          inputTokens: args.inputTokens ?? 0,
          outputTokens: args.outputTokens ?? 0,
          durationMs: args.inferenceDurationMs,
          toolCalls: [],
          cost: args.cost,
        },
      ],
      capabilityChecks: [],
    },
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
}): Promise<TurnResult> {
  const inferenceStart = Date.now();
  const result = await handleExtractionTurn({
    transcript: args.transcript,
    engine: args.engine,
    promptTemplate: args.promptTemplate,
  });
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
      errorMessage: result.error,
    });
  }

  let written = 0;
  for (const [idx, fact] of result.facts.entries()) {
    if (fact.confidence < args.confidenceThreshold) {
      // Below threshold: skip rather than write a low-signal entry.
      // Spec Decision 7 leaves a knob for "write but flag" — at v1.0
      // we err on the side of fewer writes; future calibration can
      // revisit once eval data exists.
      continue;
    }
    try {
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
      written++;
    } catch (err) {
      console.warn(
        `[layered-memory.autoSave] writeAutoSavedEntry failed for fact ${idx}: ${(err as Error).message}`,
      );
    }
  }

  return buildExtractionTurnResult({
    trigger: args.trigger,
    status: "completed",
    cost,
    inferenceDurationMs,
    responseText: `extracted ${written} fact(s) from turn ${args.sourceTurnId}`,
  });
}

export async function layeredMemory(opts: LayeredMemoryOptions): Promise<Augment> {
  const prefix = opts.namespace.endsWith(":") ? opts.namespace : `${opts.namespace}:`;
  const retentionDays = opts.retentionDays ?? 90;

  let store: MemoryStore;
  if (opts.backend === "sqlite") {
    if (!opts.dbPath) throw new Error("layeredMemory: sqlite backend requires dbPath");
    store = createSqliteStore({
      dbPath: opts.dbPath,
      retentionDays,
      namespace: opts.namespace,
    });
  } else if (opts.backend === "supabase") {
    if (!opts.client || !opts.table) {
      throw new Error("layeredMemory: supabase backend requires client and table");
    }
    store = createSupabaseStore({
      client: opts.client,
      table: opts.table,
      retentionDays,
      namespace: opts.namespace,
    });
  } else {
    throw new Error(`layeredMemory: unknown backend "${opts.backend}"`);
  }

  await store.initialize();

  // Auto-save state (per-augment-instance — process-local). The buffer
  // accumulates session-end-only transcripts; turnIndexes drives the
  // every-N-turns dispatcher; threadPeerHistory tracks the most-recent
  // peerId observed on each threadId so the scheduler can detect an
  // anonymous→recognized promotion (Decision 5 of the memorist design).
  const autoSaveEnabled = opts.autoSave?.enabled ?? true;
  const buffer: ExtractionBuffer = createBuffer();
  const turnIndexes = new Map<string, number>();
  const threadPeerHistory = new Map<string, string>();
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

  const search = async (query: string, queryOpts?: MemoryQueryOpts): Promise<MemoryEntry[]> => {
    const results = await store.search(query, queryOpts?.peerId);
    return results.map(storeEntryToMemoryEntry);
  };

  const write = async (
    label: string,
    content: string,
    writeOpts?: MemoryWriteOpts,
  ): Promise<void> => {
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

  const forget = async (peerId: string): Promise<number> => {
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
   * `threadId` and, if so, flush the buffered anonymous-bound
   * transcripts by injecting an extraction trigger bound to the OLD
   * anonymous peer-id. Per Decision 5 of the memorist design: facts
   * extracted from anonymous-bound transcripts must land under the OLD
   * `anon-<threadId>` peer-id namespace; the recognized peer's own
   * subsequent turns auto-save under the NEW peer-id.
   *
   * The detection rule is:
   *   - the previously-observed peerId for this threadId is `anon-<threadId>`,
   *   - the current peerId is different, AND
   *   - there are buffered transcripts under the prior anonymous peerId.
   *
   * Best-effort. ctx.inject failures are caught and logged; the buffered
   * transcripts are dropped on failure (the prior identity has no durable
   * binding the agent can return to — see spec table risk row).
   */
  async function maybeFlushOnPromotion(
    threadId: string,
    currentPeer: import("../../types").PeerIdentity,
    ctx: SchedulerContext,
  ): Promise<void> {
    const currentPeerId = currentPeer.id;
    const priorPeerId = threadPeerHistory.get(threadId);
    if (!priorPeerId) return; // first turn on this thread
    if (priorPeerId === currentPeerId) return; // same peer, no promotion
    if (priorPeerId !== `anon-${threadId}`) return; // not an anonymous→other transition
    const buffered = buffer.flush(priorPeerId);
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
      // existing memory rows from anon-<threadId> to vis_<uuid> via
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
      turnId: `auto-save-flush-${priorPeerId}-${flushSourceTurnId}`,
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
        `[layered-memory.autoSave] promotion-flush ctx.inject failed for prior peer=${priorPeerId}: ${(err as Error).message}`,
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
   * Decision 5 (anonymous→recognized promotion): before applying the
   * standard frequency dispatch, check whether the just-completed turn's
   * peerId differs from the prior peerId for the same threadId AND the
   * prior peerId was the anonymous form (`anon-<threadId>`). If so,
   * inject a one-off extraction-flush trigger bound to the OLD
   * anonymous peer so buffered facts land under the prior identity.
   */
  async function scheduleAfterTurn(result: TurnResult, ctx: SchedulerContext): Promise<void> {
    if (!autoSaveEnabled) return;
    if (!promptTemplate) return;
    // Recursion guard: skip extraction-initiated turns. Without this,
    // every injected extraction turn would itself fire scheduleAfterTurn
    // and synthesize another extraction trigger ad infinitum.
    if (isAutoSaveTurn(result)) return;

    const transcript = await ctx.getCompletedTranscript();
    if (!transcript) return; // turn was compacted before the hook ran
    if (!transcript.peer) return; // no peer, no scoped namespace to write under

    const peerId = transcript.peer.id;
    const threadId = transcript.threadId;

    // Decision 5: detect anonymous→recognized promotion and flush
    // anonymous-bound buffer BEFORE we apply the current peer's cadence.
    // Pass the full peer object so trigger.peer targets the recognized
    // identity (budget caps and turn gates key off trigger.peer).
    await maybeFlushOnPromotion(threadId, transcript.peer, ctx);

    // Update thread→peer history AFTER promotion detection so the
    // detector compares against the prior turn's identity.
    threadPeerHistory.set(threadId, peerId);

    const turnIndex = turnIndexes.get(peerId) ?? 0;
    turnIndexes.set(peerId, turnIndex + 1);

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
    _ctx: InternalTurnContext,
  ): Promise<TurnResult | null> {
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
    });
  }

  return {
    name: `layered-memory-${opts.namespace}`,
    capabilities: ["context", "tools"],
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
    },
    ...(autoSaveEnabled ? { scheduleAfterTurn, handleInternalTurn } : {}),
    onShutdown: async () => {
      await store.close();
    },
  };
}
