import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  Augment,
  MemoryEntry,
  MemoryQueryOpts,
  MemoryWriteOpts,
  SchedulerContext,
  Transcript,
  TurnResult,
} from "../../types";
import { createBuffer, type ExtractionBuffer } from "./extractor/buffer";
import { type ExtractionFrequencyConfig, shouldExtract } from "./extractor/frequency";
import { type ExtractionEngine, handleExtractionTurn } from "./extractor/inject-handler";
import { createSqliteStore } from "./storage/sqlite-store";
import { createSupabaseStore, type LayeredSupabaseClient } from "./storage/supabase-store";
import type { MemoryStore, StoreEntry } from "./storage/types";

/**
 * Optional auto-save block (PR β / ADR-018 Phase 2). When `enabled` is
 * true (the default), the augment registers a `scheduleAfterTurn` hook
 * (per ADR-027) that runs the per-trust-level frequency dispatcher, then
 * either skips, buffers, or runs extraction for the just-completed turn.
 *
 * Phase 2b note (this commit): when the dispatcher returns "extract",
 * the augment calls `handleExtractionTurn` directly using the configured
 * extraction engine — see "Architectural decision" in the PR β plan +
 * spec Decision 5. The spec's preferred path routes the extraction call
 * through `ctx.inject` (option a) so cost flows through the existing
 * budgets path; that requires kernel surface beyond ADR-027 (an
 * internal-trigger handler registry). Phase 2b ships option (b) — the
 * inline path — and logs `console.warn` to surface the deferred
 * cost-attribution. Option (a) is a future Phase 2c upgrade.
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
   * Optional dedicated extraction engine. When absent in Phase 2b, the
   * `decision === "extract"` branch logs a warning and skips —
   * extraction has no cost-flow path yet without an engine wired
   * through scheduleAfterTurn's context. Phase 2c surfaces the agent's
   * primary engine on `SchedulerContext` (or via ctx.inject path) so
   * this option becomes a true override rather than a hard requirement.
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
 * the augment itself injected. Used as the recursion guard so a future
 * option-(a) wiring (extraction via `ctx.inject`) does not recurse.
 *
 * Phase 2b ships option (b) — extraction runs synchronously inside
 * `scheduleAfterTurn` without going through `ctx.inject`, so no
 * additional turn is created and no recursion is possible. The guard is
 * kept as defense-in-depth: it costs nothing and protects future
 * Phase 2c upgrades from accidentally creating an extraction-on-
 * extraction loop.
 */
function isAutoSaveTurn(result: TurnResult): boolean {
  return (
    result.trace.trigger.type === "internal" &&
    result.trace.trigger.sourceAugment === "layered-memory.autoSave"
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
 * Extraction execution path (option b). Calls the extraction engine,
 * parses the response, and writes each fact via the store's
 * `writeAutoSavedEntry`. Best-effort — engine errors, parse errors, and
 * individual write errors are logged and swallowed.
 *
 * Phase 2c will route this through `ctx.inject` so cost flows into the
 * budgets store via `turnGate.commit`. Phase 2b logs a one-time warning
 * to surface the deferral.
 */
async function runInlineExtraction(args: {
  transcript: Transcript;
  engine: ExtractionEngine;
  promptTemplate: string;
  store: MemoryStore;
  prefix: string;
  peerId: string;
  confidenceThreshold: number;
  modelLabel: string;
}): Promise<void> {
  const result = await handleExtractionTurn({
    transcript: args.transcript,
    engine: args.engine,
    promptTemplate: args.promptTemplate,
  });
  if (!result.success) {
    console.warn(
      `[layered-memory.autoSave] extraction failed (turn=${args.transcript.turnId}): ${result.error}`,
    );
    return;
  }
  for (const [idx, fact] of result.facts.entries()) {
    if (fact.confidence < args.confidenceThreshold) {
      // Below threshold: log + skip rather than write a low-signal
      // entry. Spec Decision 7 leaves a knob for "write but flag" — at
      // Phase 2b we err on the side of fewer writes; future calibration
      // can revisit once eval data exists.
      continue;
    }
    try {
      await args.store.writeAutoSavedEntry({
        peerId: args.peerId,
        label: buildAutoSaveLabel(args.prefix, args.peerId, args.transcript.turnId, idx),
        content: fact.object,
        subject: fact.subject,
        predicate: fact.predicate,
        object: fact.object,
        confidence: fact.confidence,
        retentionClass: "operational",
        isVerbatim: fact.isVerbatim,
        sourceTurnId: args.transcript.turnId,
        model: args.modelLabel,
      });
    } catch (err) {
      console.warn(
        `[layered-memory.autoSave] writeAutoSavedEntry failed for fact ${idx}: ${(err as Error).message}`,
      );
    }
  }
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
  // every-N-turns dispatcher.
  const autoSaveEnabled = opts.autoSave?.enabled ?? true;
  const buffer: ExtractionBuffer = createBuffer();
  const turnIndexes = new Map<string, number>();
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

  // Phase 2b deferral notice. Surface once at boot (rather than per-turn)
  // so operators see the cost-attribution gap clearly without flooding
  // logs. Phase 2c upgrades to option (a) and removes this warning.
  let warnedDeferralOnce = false;
  function warnDeferralOnce(): void {
    if (warnedDeferralOnce) return;
    warnedDeferralOnce = true;
    console.warn(
      "[layered-memory.autoSave] running in Phase 2b inline mode — extraction calls bypass the turn-loop budgets path; cost-attribution-through-budgets is deferred to Phase 2c (see ADR-027 + PR β plan)",
    );
  }

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
   * Post-turn auto-save dispatcher. ADR-027 delivers `result` + `ctx`
   * after every user-facing turn (and after every injected turn,
   * including any future option-(a) extraction injection). The hook is
   * best-effort — errors are caught and logged, never propagated.
   */
  async function scheduleAfterTurn(result: TurnResult, ctx: SchedulerContext): Promise<void> {
    if (!autoSaveEnabled) return;
    if (!promptTemplate) return;
    // Recursion guard: skip extraction-initiated turns (defense-in-depth
    // for a future option-(a) wiring; see isAutoSaveTurn comment).
    if (isAutoSaveTurn(result)) return;

    const transcript = await ctx.getCompletedTranscript();
    if (!transcript) return; // turn was compacted before the hook ran
    if (!transcript.peer) return; // no peer, no scoped namespace to write under

    const peerId = transcript.peer.id;
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
      // No engine wired yet — Phase 2c will surface the agent's primary
      // engine. For Phase 2b, log once and skip. The frequency dispatcher
      // already advanced the turnIndex above, so subsequent turns still
      // honor the cadence even when extraction itself is a no-op.
      console.warn(
        `[layered-memory.autoSave] no extraction engine configured; skipping extraction for turn ${transcript.turnId}`,
      );
      return;
    }
    warnDeferralOnce();
    await runInlineExtraction({
      transcript,
      engine: extractionEngine,
      promptTemplate,
      store,
      prefix,
      peerId,
      confidenceThreshold,
      modelLabel: "extraction-engine",
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
    ...(autoSaveEnabled ? { scheduleAfterTurn } : {}),
    onShutdown: async () => {
      await store.close();
    },
  };
}
