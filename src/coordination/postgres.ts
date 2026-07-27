import { migratePostgresCoordinator, type PostgresMigrationExecutor } from "./migrations";
import { createSecurePostgresCoordinationClient } from "./postgres-url";
import type {
  AdmitResult,
  ClaimResult,
  CoordinationOutcomeUnknownReason,
  CoordinationRequestState,
  DistributedCoordinationEvent,
  DistributedCoordinatorConfig,
  DistributedCoordinatorHealth,
  DistributedEventPage,
  DistributedPruneResult,
  DistributedReplayResult,
  DistributedRequestStatus,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  LeaseResult,
  RegistrationResult,
} from "./types";

type Row = Record<string, unknown>;
const MAX_CAPACITY = 1_000_000;
const MAX_LEASE_MS = 3_600_000;
const MAX_EVENT_PAGE = 500;
const MAX_PRUNE_BATCH = 1_000;
const MAX_BIGINT = 9_223_372_036_854_775_807n;
const OUTCOME_UNKNOWN_REASONS = new Set<CoordinationOutcomeUnknownReason>([
  "coordinator-unavailable",
  "effect-outcome-unknown",
  "execution-failed-after-start",
  "lease-lost",
]);

interface SqlTransaction extends PostgresMigrationExecutor {
  begin<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
}

interface LocalOwnedOperation {
  attempt: number;
  bindingHash: string;
  controller: AbortController;
  phase: "queued" | "active";
  sourceId: string;
  threadId: string;
}

export interface PostgresCoordinatorOptions extends DistributedCoordinatorConfig {
  /** Connection string for a dedicated coordination database/role. */
  url?: string;
  /** Injectable only for tests and hosts that own their Bun.SQL lifecycle. */
  sql?: SqlTransaction;
}

function text(row: Row, key: string): string {
  const value = row[key];
  if (typeof value !== "string") throw new Error(`invalid coordinator database row: ${key}`);
  return value;
}

function number(row: Row, key: string): number {
  const value = row[key];
  if (
    typeof value !== "number" &&
    typeof value !== "bigint" &&
    (typeof value !== "string" || !/^-?(0|[1-9][0-9]*)$/.test(value))
  ) {
    throw new Error(`invalid coordinator database row: ${key}`);
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error(`invalid coordinator database row: ${key}`);
  return parsed;
}

function date(row: Row, key: string): number {
  const value = row[key];
  const parsed = value instanceof Date ? value.getTime() : new Date(String(value)).getTime();
  if (!Number.isFinite(parsed)) throw new Error(`invalid coordinator database row: ${key}`);
  return parsed;
}

function bool(row: Row, key: string): boolean {
  const value = row[key];
  if (typeof value !== "boolean") throw new Error(`invalid coordinator database row: ${key}`);
  return value;
}

function bytes(row: Row, key: string): Uint8Array {
  const value = row[key];
  if (!(value instanceof Uint8Array)) throw new Error(`invalid coordinator database row: ${key}`);
  return new Uint8Array(value);
}

function validReplayResult(result: DistributedReplayResult): boolean {
  if (result.contentType !== "application/json" || !(result.body instanceof Uint8Array)) {
    return false;
  }
  try {
    JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(result.body));
    return true;
  } catch {
    return false;
  }
}

async function waitDelay(milliseconds: number, signal?: AbortSignal): Promise<boolean> {
  if (signal?.aborted) return false;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", aborted);
      resolve(true);
    }, milliseconds);
    const aborted = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
      resolve(false);
    };
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

function isTerminal(
  state: string,
): state is Exclude<CoordinationRequestState, "queued" | "active"> {
  return (
    state === "completed" ||
    state === "failed" ||
    state === "canceled" ||
    state === "outcome_unknown"
  );
}

function assertIdentifier(name: string, value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$/.test(value)) throw new Error(`${name} is invalid`);
}

function assertRequest(request: DistributedTurnRequest): void {
  assertIdentifier("requestId", request.requestId);
  assertIdentifier("threadId", request.threadId);
  assertIdentifier("source.id", request.source.id);
  if (
    !Number.isSafeInteger(request.source.maxConcurrent) ||
    request.source.maxConcurrent < 1 ||
    request.source.maxConcurrent > MAX_CAPACITY
  )
    throw new Error("source.maxConcurrent is invalid");
  if (
    !Number.isSafeInteger(request.source.maxQueued) ||
    request.source.maxQueued < 0 ||
    request.source.maxQueued > MAX_CAPACITY
  )
    throw new Error("source.maxQueued is invalid");
  if (!/^[A-Za-z0-9_-]{16,160}$/.test(request.bindingHash))
    throw new Error("bindingHash must be a one-way canonical request hash");
}

/**
 * PostgreSQL-backed coordinator. All decisions use clock_timestamp() inside a
 * locked transaction; process clocks, advisory locks, and client IPs are not
 * authority. The constructor does not perform DDL: provision explicitly with
 * migrate().
 */
export class PostgresDistributedTurnCoordinator implements DistributedTurnCoordinator {
  readonly #config: DistributedCoordinatorConfig;
  readonly #sql: SqlTransaction;
  readonly #ownsSql: boolean;
  readonly #sessionId: string;
  readonly #owned = new Map<string, LocalOwnedOperation>();
  #invalidated = false;

  constructor(options: PostgresCoordinatorOptions) {
    if (!options.sql && !options.url) throw new Error("Postgres coordination requires url or sql");
    if (
      !Number.isSafeInteger(options.maxConcurrent) ||
      options.maxConcurrent < 1 ||
      options.maxConcurrent > MAX_CAPACITY
    )
      throw new Error("maxConcurrent must be positive");
    if (
      !Number.isSafeInteger(options.maxQueued) ||
      options.maxQueued < 0 ||
      options.maxQueued > MAX_CAPACITY
    )
      throw new Error("maxQueued must not be negative");
    if (
      !Number.isSafeInteger(options.maxQueuedPerThread) ||
      options.maxQueuedPerThread < 0 ||
      options.maxQueuedPerThread > options.maxQueued
    )
      throw new Error("maxQueuedPerThread must be between zero and maxQueued");
    if (
      !Number.isSafeInteger(options.leaseMs) ||
      options.leaseMs < 1 ||
      options.leaseMs > MAX_LEASE_MS
    )
      throw new Error("leaseMs must be positive");
    if (
      !Number.isSafeInteger(options.retention?.terminalRequestRetentionMs) ||
      options.retention.terminalRequestRetentionMs < 60_000 ||
      options.retention.terminalRequestRetentionMs > 31_536_000_000 ||
      !Number.isSafeInteger(options.retention.maxTerminalRequests) ||
      options.retention.maxTerminalRequests < 1 ||
      options.retention.maxTerminalRequests > MAX_CAPACITY ||
      !Number.isSafeInteger(options.retention.eventRetentionMs) ||
      options.retention.eventRetentionMs < 60_000 ||
      options.retention.eventRetentionMs > 31_536_000_000 ||
      !Number.isSafeInteger(options.retention.maxEvents) ||
      options.retention.maxEvents < 1 ||
      options.retention.maxEvents > MAX_CAPACITY
    ) {
      throw new Error("coordination retention policy is invalid");
    }
    if (
      !Number.isSafeInteger(options.result?.maxReplayBytes) ||
      options.result.maxReplayBytes < 1_024 ||
      options.result.maxReplayBytes > 1_048_576
    ) {
      throw new Error("coordination replay policy is invalid");
    }
    if (
      !Number.isSafeInteger(options.compatibility?.protocolVersion) ||
      options.compatibility.protocolVersion < 1 ||
      options.compatibility.protocolVersion > MAX_CAPACITY ||
      !/^[0-9a-f]{64}$/.test(options.compatibility.protocolFingerprint) ||
      !/^[0-9a-f]{64}$/.test(options.compatibility.configurationFingerprint)
    ) {
      throw new Error("coordinator compatibility contract is invalid");
    }
    if (
      options.compatibility.upgradeFrom &&
      (!Number.isSafeInteger(options.compatibility.upgradeFrom.protocolVersion) ||
        options.compatibility.upgradeFrom.protocolVersion + 1 !==
          options.compatibility.protocolVersion ||
        !/^[0-9a-f]{64}$/.test(options.compatibility.upgradeFrom.protocolFingerprint) ||
        !/^[0-9a-f]{64}$/.test(options.compatibility.upgradeFrom.configurationFingerprint))
    ) {
      throw new Error("coordinator compatibility upgrade contract is invalid");
    }
    assertIdentifier("namespace", options.namespace);
    assertIdentifier("instanceId", options.instanceId);
    if (!/^[0-9a-f]{64}$/.test(options.buildFingerprint)) {
      throw new Error("buildFingerprint must be a secret-free SHA-256 digest");
    }
    if (!Array.isArray(options.sources) || options.sources.length > 256) {
      throw new Error("coordinator sources exceed supported bounds");
    }
    const sourceIds = new Set<string>();
    for (const source of options.sources) {
      assertIdentifier("source.id", source.id);
      if (
        !Number.isSafeInteger(source.maxConcurrent) ||
        source.maxConcurrent < 1 ||
        source.maxConcurrent > MAX_CAPACITY ||
        !Number.isSafeInteger(source.maxQueued) ||
        source.maxQueued < 0 ||
        source.maxQueued > MAX_CAPACITY
      ) {
        throw new Error("coordinator source policy is invalid");
      }
      if (sourceIds.has(source.id)) throw new Error("coordinator source ids must be unique");
      sourceIds.add(source.id);
    }
    this.#config = { ...options, sources: options.sources.map((source) => ({ ...source })) };
    this.#sessionId = new Bun.CryptoHasher("sha256").update(crypto.randomUUID()).digest("hex");
    this.#ownsSql = !options.sql;
    this.#sql = (options.sql ??
      createSecurePostgresCoordinationClient(options.url!)) as unknown as SqlTransaction;
  }

  async migrate(): Promise<void> {
    await migratePostgresCoordinator(this.#sql);
  }

  async close(): Promise<void> {
    this.abortAllOwned("coordinator-closed");
    if (this.#ownsSql) await (this.#sql as unknown as { close: () => Promise<void> }).close();
  }

  async register(): Promise<RegistrationResult> {
    return this.safe<RegistrationResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx, true, true);
        const inserted = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_instances (namespace, instance_id, session_id, build_fingerprint, accepting, draining, lease_expires_at) VALUES ($1, $2, $3, $4, TRUE, FALSE, clock_timestamp() + ($5 * interval '1 millisecond')) ON CONFLICT (namespace, instance_id) DO NOTHING RETURNING session_id",
          [
            this.#config.namespace,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.buildFingerprint,
            this.#config.leaseMs,
          ],
        );
        if (!inserted[0]) {
          const existing = await tx.unsafe<Row>(
            "SELECT session_id, build_fingerprint, lease_expires_at > clock_timestamp() AS live FROM public.auggy_coordination_instances WHERE namespace = $1 AND instance_id = $2 FOR UPDATE",
            [this.#config.namespace, this.#config.instanceId],
          );
          const row = existing[0];
          if (
            !row ||
            text(row, "session_id") !== this.#sessionId ||
            text(row, "build_fingerprint") !== this.#config.buildFingerprint ||
            !bool(row, "live")
          ) {
            return { status: "conflict" };
          }
          await tx.unsafe(
            "UPDATE public.auggy_coordination_instances SET lease_expires_at = clock_timestamp() + ($3 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $4",
            [
              this.#config.namespace,
              this.#config.instanceId,
              this.#config.leaseMs,
              this.#sessionId,
            ],
          );
        }
        await this.provisionSources(tx);
        return { status: "registered" };
      }),
    );
  }

  async heartbeatInstance(): Promise<LeaseResult> {
    return this.safe<LeaseResult>(
      { status: "unavailable" },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          const instance = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_instances SET lease_expires_at = clock_timestamp() + ($4 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND build_fingerprint = $5 AND lease_expires_at > clock_timestamp() RETURNING instance_id",
            [
              this.#config.namespace,
              this.#config.instanceId,
              this.#sessionId,
              this.#config.leaseMs,
              this.#config.buildFingerprint,
            ],
          );
          if (!instance[0]) return { status: "stale" };
          return { status: "ok" };
        }),
      (result) => {
        if (result.status !== "ok") this.abortAllOwned("coordinator-authority-lost");
      },
    );
  }

  async admit(request: DistributedTurnRequest): Promise<AdmitResult> {
    const result = await this.safe<AdmitResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const limits = await this.#lockNamespace(tx);
        const instance = await this.registeredInstance(tx);
        if (!instance) throw new Error("coordinator instance is not registered");
        await this.#expireActive(tx);
        const existing = await tx.unsafe<Row>(
          "SELECT thread_id, source_id, binding_hash, state, queue_generation, queue_expires_at <= clock_timestamp() AS queue_expired FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        if (existing[0]) {
          const row = existing[0];
          if (
            text(row, "thread_id") !== request.threadId ||
            text(row, "source_id") !== request.source.id ||
            text(row, "binding_hash") !== request.bindingHash
          ) {
            return { status: "conflict" };
          }
          if (text(row, "state") === "queued" && row.queue_expired === true) {
            if (!instance.accepting || instance.draining) {
              return { status: "rejected", reason: "draining" };
            }
            const adopted = await tx.unsafe<Row>(
              "UPDATE public.auggy_coordination_requests SET queue_owner_instance = $3, queue_owner_session = $4, queue_generation = queue_generation + 1, queue_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND state = 'queued' AND queue_expires_at <= clock_timestamp() RETURNING request_id",
              [
                this.#config.namespace,
                request.requestId,
                this.#config.instanceId,
                this.#sessionId,
                this.#config.leaseMs,
              ],
            );
            if (!adopted[0]) return { status: "joined", state: "queued" };
            return { status: "adopted", attempt: number(row, "queue_generation") + 1 };
          }
          return {
            status: "joined",
            state: text(row, "state") as CoordinationRequestState,
          };
        }
        if (!instance.accepting || instance.draining) {
          return { status: "rejected", reason: "draining" };
        }
        await this.#cancelExpiredQueued(tx);
        const incidents = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS count FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'outcome_unknown'",
          [this.#config.namespace],
        );
        if (number(incidents[0]!, "count") >= this.#config.retention.maxTerminalRequests) {
          return { status: "rejected", reason: "incident-capacity" };
        }
        const policy = await this.sourcePolicy(tx, request.source);
        const threadState = await tx.unsafe<Row>(
          "SELECT quarantined FROM public.auggy_coordination_threads WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, request.threadId],
        );
        if (threadState[0] && bool(threadState[0], "quarantined")) {
          return { status: "rejected", reason: "thread-quarantined" };
        }
        const queue = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS total, count(*) FILTER (WHERE source_id = $2)::integer AS source_total, count(*) FILTER (WHERE thread_id = $3)::integer AS thread_total FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'queued'",
          [this.#config.namespace, request.source.id, request.threadId],
        );
        const count = queue[0];
        if (!count) throw new Error("missing queue count");
        const active = await tx.unsafe<Row>(
          "SELECT count(*)::integer AS total, count(*) FILTER (WHERE source_id = $2)::integer AS source_total, bool_or(thread_id = $3) AS thread_busy FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'active'",
          [this.#config.namespace, policy.id, request.threadId],
        );
        const activeCount = active[0];
        if (!activeCount) throw new Error("missing active count");
        const globalDirectSlot =
          number(count, "total") === 0 &&
          number(activeCount, "total") < limits.maxConcurrent &&
          activeCount.thread_busy !== true;
        const sourceDirectSlot =
          number(count, "source_total") === 0 &&
          number(activeCount, "source_total") < policy.maxConcurrent;
        if (number(count, "total") >= limits.maxQueued && !globalDirectSlot)
          return { status: "rejected", reason: "global-capacity" };
        if (number(count, "source_total") >= policy.maxQueued && !sourceDirectSlot)
          return { status: "rejected", reason: "source-capacity" };
        if (
          number(count, "thread_total") >= limits.maxQueuedPerThread &&
          !(number(count, "thread_total") === 0 && globalDirectSlot && sourceDirectSlot)
        ) {
          return { status: "rejected", reason: "thread-capacity" };
        }
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_requests (namespace, request_id, thread_id, source_id, binding_hash, state, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at) VALUES ($1, $2, $3, $4, $5, 'queued', $6, $7, 1, clock_timestamp() + ($8 * interval '1 millisecond'))",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            policy.id,
            request.bindingHash,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.leaseMs,
          ],
        );
        return { status: "admitted", attempt: 1 };
      }),
    );
    if (result.status === "admitted" || result.status === "adopted") {
      this.trackOwned(request, "queued", result.attempt);
    }
    return result;
  }

  async heartbeatQueued(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
    attempt = 1,
  ): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET queue_expires_at = clock_timestamp() + ($9 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND state = 'queued' AND queue_owner_instance = $6 AND queue_owner_session = $7 AND queue_generation = $8 AND queue_expires_at > clock_timestamp() RETURNING request_id",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            request.source.id,
            request.bindingHash,
            this.#config.instanceId,
            this.#sessionId,
            attempt,
            this.#config.leaseMs,
          ],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
    if (result.status !== "ok") {
      this.abortOwnedAttempt(request.requestId, attempt, "queue-ownership-lost");
    }
    return result;
  }

  async abandon(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
    attempt = 1,
  ): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>(
      { status: "unavailable" },
      async () =>
        this.transaction(async (tx) => {
          assertRequest(request);
          await this.#lockNamespace(tx);
          if (!(await this.registeredInstance(tx))) return { status: "stale" };
          const rows = await tx.unsafe<Row>(
            "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND queue_generation = $8 AND ((state = 'queued' AND queue_owner_instance = $6 AND queue_owner_session = $7 AND queue_expires_at > clock_timestamp()) OR (state = 'active' AND owner_instance = $6 AND owner_session = $7 AND execution_started_at IS NULL AND lease_expires_at > clock_timestamp())) RETURNING request_id",
            [
              this.#config.namespace,
              request.requestId,
              request.threadId,
              request.source.id,
              request.bindingHash,
              this.#config.instanceId,
              this.#sessionId,
              attempt,
            ],
          );
          return rows[0] ? { status: "ok" } : { status: "stale" };
        }),
      undefined,
      true,
    );
    if (result.status === "ok") {
      this.abortOwnedAttempt(request.requestId, attempt, "pre-start-abandoned");
    }
    return result;
  }

  async claim(request: DistributedTurnRequest, attempt = 1): Promise<ClaimResult> {
    const result = await this.safe<ClaimResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const limits = await this.#lockNamespace(tx);
        const instance = await this.registeredInstance(tx);
        if (!instance) throw new Error("coordinator instance is not registered");
        await this.#expireActive(tx);
        const found = await tx.unsafe<Row>(
          "SELECT state, thread_id, source_id, binding_hash, fence, owner_instance, owner_session, lease_expires_at, queue_owner_instance, queue_owner_session, queue_generation, queue_expires_at <= clock_timestamp() AS queue_expired FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        const row = found[0];
        if (
          !row ||
          text(row, "thread_id") !== request.threadId ||
          text(row, "source_id") !== request.source.id ||
          text(row, "binding_hash") !== request.bindingHash
        )
          return { status: "conflict" };
        const state = text(row, "state");
        if (state === "outcome_unknown") return { status: "quarantined" };
        if (isTerminal(state)) return { status: "terminal", state };
        if (state === "active") return { status: "waiting" };
        const sameQueueOwner =
          row.queue_owner_instance === this.#config.instanceId &&
          row.queue_owner_session === this.#sessionId;
        if (
          !Number.isSafeInteger(attempt) ||
          attempt <= 0 ||
          number(row, "queue_generation") !== attempt
        ) {
          return { status: "stale" };
        }
        if (!sameQueueOwner)
          return row.queue_expired === true ? { status: "stale" } : { status: "waiting" };
        if (row.queue_expired === true) return { status: "stale" };
        if (!instance.accepting || instance.draining) return { status: "waiting" };
        await this.#cancelExpiredQueued(tx, request.requestId);
        const policy = await this.sourcePolicy(tx, request.source);
        const thread = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_threads (namespace, thread_id) VALUES ($1, $2) ON CONFLICT (namespace, thread_id) DO UPDATE SET updated_at = clock_timestamp() RETURNING quarantined",
          [this.#config.namespace, request.threadId],
        );
        if (!thread[0]) throw new Error("missing thread row");
        if (bool(thread[0], "quarantined")) return { status: "quarantined" };
        const capacity = await tx.unsafe<Row>(
          "SELECT count(*) FILTER (WHERE state = 'active')::integer AS active, count(*) FILTER (WHERE state = 'active' AND source_id = $2)::integer AS source_active FROM public.auggy_coordination_requests WHERE namespace = $1",
          [this.#config.namespace, policy.id],
        );
        const current = capacity[0];
        const fairHead = await tx.unsafe<Row>(
          "WITH thread_heads AS (SELECT DISTINCT ON (thread_id) request_id, thread_id, source_id, queued_at FROM public.auggy_coordination_requests WHERE namespace = $1 AND state = 'queued' ORDER BY thread_id, queued_at, request_id), eligible AS (SELECT heads.request_id, heads.queued_at FROM thread_heads heads JOIN public.auggy_coordination_sources source_policy ON source_policy.namespace = $1 AND source_policy.source_id = heads.source_id WHERE NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests active_thread WHERE active_thread.namespace = $1 AND active_thread.thread_id = heads.thread_id AND active_thread.state = 'active') AND (SELECT count(*) FROM public.auggy_coordination_requests active_source WHERE active_source.namespace = $1 AND active_source.source_id = heads.source_id AND active_source.state = 'active') < source_policy.max_concurrent) SELECT request_id FROM eligible ORDER BY queued_at, request_id LIMIT 1",
          [this.#config.namespace],
        );
        if (!fairHead[0] || text(fairHead[0], "request_id") !== request.requestId)
          return { status: "waiting" };
        if (
          !current ||
          number(current, "active") >= limits.maxConcurrent ||
          number(current, "source_active") >= policy.maxConcurrent
        )
          return { status: "waiting" };
        const fenced = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_namespaces SET next_fence = next_fence + 1, updated_at = clock_timestamp() WHERE namespace = $1 RETURNING next_fence",
          [this.#config.namespace],
        );
        const fence = number(fenced[0]!, "next_fence");
        await tx.unsafe(
          "UPDATE public.auggy_coordination_threads SET next_fence = $3, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, request.threadId, fence],
        );
        const claimed = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'active', fence = $3, owner_instance = $4, owner_session = $5, lease_expires_at = clock_timestamp() + ($6 * interval '1 millisecond'), execution_started_at = NULL, queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND state = 'queued' AND queue_generation = $7 AND queue_owner_instance = $4 AND queue_owner_session = $5 RETURNING lease_expires_at, queue_generation",
          [
            this.#config.namespace,
            request.requestId,
            fence,
            this.#config.instanceId,
            this.#sessionId,
            this.#config.leaseMs,
            attempt,
          ],
        );
        if (!claimed[0]) return { status: "waiting" };
        return {
          status: "acquired",
          lease: this.lease(
            request,
            number(claimed[0]!, "queue_generation"),
            fence,
            date(claimed[0]!, "lease_expires_at"),
          ),
        };
      }),
    );
    if (result.status === "acquired") this.trackOwned(request, "active", result.lease.attempt);
    return result;
  }

  ownedSignal(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): AbortSignal {
    if (this.#invalidated) return this.unavailableSignal();
    try {
      assertRequest(request);
    } catch {
      return this.unavailableSignal();
    }
    const operation = this.#owned.get(request.requestId);
    return operation &&
      operation.bindingHash === request.bindingHash &&
      operation.threadId === request.threadId &&
      operation.sourceId === request.source.id
      ? operation.controller.signal
      : this.unavailableSignal();
  }

  invalidateLocalAuthority(): void {
    if (this.#invalidated) return;
    this.#invalidated = true;
    this.abortAllOwned("coordinator-authority-lost");
  }

  async markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult> {
    const result = await this.updateLease(
      lease,
      "execution_started_at = clock_timestamp(), updated_at = clock_timestamp()",
      [],
    );
    if (result.status !== "ok") this.abortOwned(lease.requestId, "lease-ownership-lost");
    return result;
  }

  async heartbeat(lease: DistributedTurnLease): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET lease_expires_at = clock_timestamp() + ($1 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $2 AND request_id = $3 AND thread_id = $4 AND source_id = $5 AND state = 'active' AND queue_generation = $6 AND fence = $7 AND owner_instance = $8 AND owner_session = $9 AND lease_expires_at > clock_timestamp() RETURNING lease_expires_at",
          [
            this.#config.leaseMs,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        return rows[0]
          ? { status: "ok", lease: { ...lease, expiresAt: date(rows[0], "lease_expires_at") } }
          : { status: "stale" };
      }),
    );
    if (result.status !== "ok") this.abortOwned(lease.requestId, "lease-ownership-lost");
    return result;
  }

  async complete(
    lease: DistributedTurnLease,
    replayResult: DistributedReplayResult,
  ): Promise<LeaseResult> {
    if (!validReplayResult(replayResult)) {
      return { status: "rejected", reason: "invalid-result" };
    }
    if (replayResult.body.byteLength > this.#config.result.maxReplayBytes) {
      return { status: "rejected", reason: "result-too-large" };
    }
    const result = await this.updateLease(
      lease,
      "state = 'completed', result_body = $1, result_content_type = $2, result_version = 1, terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp()",
      [new Uint8Array(replayResult.body), replayResult.contentType],
    );
    if (result.status === "ok") this.abortOwned(lease.requestId, "settled");
    else if (result.status === "unavailable") {
      this.abortOwned(lease.requestId, "coordinator-authority-lost");
    } else if (result.status !== "rejected") {
      this.abortOwned(lease.requestId, "lease-ownership-lost");
    }
    return result;
  }

  async fail(lease: DistributedTurnLease): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = CASE WHEN execution_started_at IS NULL THEN 'failed' ELSE 'outcome_unknown' END, terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() RETURNING thread_id, fence, execution_started_at IS NOT NULL AS ambiguous",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        const row = rows[0];
        if (!row) return { status: "stale" };
        if (!bool(row, "ambiguous")) return { status: "ok" };
        await this.recordQuarantine(
          tx,
          lease.threadId,
          lease.requestId,
          lease.fence,
          "execution-failed-after-start",
        );
        return { status: "outcome-unknown" };
      }),
    );
    this.abortOwned(
      lease.requestId,
      result.status === "ok"
        ? "settled"
        : result.status === "outcome-unknown"
          ? "outcome-unknown"
          : result.status === "unavailable"
            ? "coordinator-authority-lost"
            : "lease-ownership-lost",
    );
    return result;
  }

  async markOutcomeUnknown(
    lease: DistributedTurnLease,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<LeaseResult> {
    if (!this.validLease(lease) || !OUTCOME_UNKNOWN_REASONS.has(reasonCode)) {
      return { status: "stale" };
    }
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'outcome_unknown', terminal_at = clock_timestamp(), owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND state = 'active' AND queue_generation = $5 AND fence = $6 AND owner_instance = $7 AND owner_session = $8 AND lease_expires_at > clock_timestamp() RETURNING request_id",
          [
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        if (!rows[0]) return { status: "stale" };
        await this.recordQuarantine(tx, lease.threadId, lease.requestId, lease.fence, reasonCode);
        return { status: "outcome-unknown" };
      }),
    );
    this.abortOwned(
      lease.requestId,
      result.status === "outcome-unknown"
        ? "outcome-unknown"
        : result.status === "unavailable"
          ? "coordinator-authority-lost"
          : "lease-ownership-lost",
    );
    return result;
  }

  async status(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
  ): Promise<DistributedRequestStatus> {
    return this.safe<DistributedRequestStatus>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          "SELECT state, thread_id, source_id, binding_hash, CASE WHEN result_body IS NULL THEN NULL ELSE octet_length(result_body) END AS result_bytes FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2",
          [this.#config.namespace, request.requestId],
        );
        const row = rows[0];
        if (!row) return { status: "missing" };
        if (
          text(row, "thread_id") !== request.threadId ||
          text(row, "source_id") !== request.source.id ||
          text(row, "binding_hash") !== request.bindingHash
        ) {
          return { status: "conflict" };
        }
        const state = text(row, "state");
        if (state === "queued" || state === "active") return { status: "pending", state };
        if (state === "outcome_unknown") return { status: "quarantined" };
        if (state === "failed" || state === "canceled") return { status: "terminal", state };
        if (state !== "completed") throw new Error("invalid request state");
        const resultBytes = number(row, "result_bytes");
        if (resultBytes > this.#config.result.maxReplayBytes) {
          throw new Error("stored replay exceeds configured limit");
        }
        const replayRows = await tx.unsafe<Row>(
          "SELECT result_body, result_content_type, result_version FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 AND thread_id = $3 AND source_id = $4 AND binding_hash = $5 AND state = 'completed'",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            request.source.id,
            request.bindingHash,
          ],
        );
        const replayRow = replayRows[0];
        if (
          !replayRow ||
          text(replayRow, "result_content_type") !== "application/json" ||
          number(replayRow, "result_version") !== 1
        ) {
          throw new Error("missing completed replay result");
        }
        const result = {
          body: bytes(replayRow, "result_body"),
          contentType: "application/json" as const,
        };
        if (result.body.byteLength !== resultBytes || !validReplayResult(result)) {
          throw new Error("invalid completed replay result");
        }
        return { status: "completed", result };
      }),
    );
  }

  async wait(
    request: Pick<DistributedTurnRequest, "requestId" | "threadId" | "source" | "bindingHash">,
    options: { signal?: AbortSignal; timeoutMs: number; pollMs: number },
  ): Promise<DistributedRequestStatus> {
    if (
      !Number.isSafeInteger(options.timeoutMs) ||
      options.timeoutMs < 0 ||
      options.timeoutMs > 300_000 ||
      !Number.isSafeInteger(options.pollMs) ||
      options.pollMs < 10 ||
      options.pollMs > 1_000
    ) {
      return { status: "unavailable" };
    }
    const deadline = Date.now() + options.timeoutMs;
    while (true) {
      if (options.signal?.aborted) return { status: "wait-aborted" };
      const status = await this.status(request);
      if (status.status !== "pending") return status;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return { status: "wait-timeout" };
      if (!(await waitDelay(Math.min(options.pollMs, remaining), options.signal))) {
        return { status: "wait-aborted" };
      }
    }
  }

  async events(options: { afterEventId?: string; limit: number }): Promise<DistributedEventPage> {
    if (
      !Number.isSafeInteger(options.limit) ||
      options.limit < 1 ||
      options.limit > MAX_EVENT_PAGE
    ) {
      return { status: "unavailable" };
    }
    let afterEventId = "0";
    if (options.afterEventId !== undefined) {
      if (!/^(0|[1-9][0-9]{0,18})$/.test(options.afterEventId)) {
        return { status: "unavailable" };
      }
      if (BigInt(options.afterEventId) > MAX_BIGINT) return { status: "unavailable" };
      afterEventId = options.afterEventId;
    }
    return this.safe<DistributedEventPage>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        const rows = await tx.unsafe<Row>(
          "SELECT created_at, event_id::text AS event_id, event_type, fence, reason, request_id, thread_id FROM public.auggy_coordination_events WHERE namespace = $1 AND event_id > $2::bigint ORDER BY event_id LIMIT $3",
          [this.#config.namespace, afterEventId, options.limit],
        );
        const events = rows.map((row): DistributedCoordinationEvent => {
          const eventType = text(row, "event_type");
          if (eventType !== "operator_recovery" && eventType !== "outcome_unknown") {
            throw new Error("invalid coordinator event type");
          }
          const reasonCode = text(row, "reason");
          if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reasonCode)) {
            throw new Error("invalid coordinator event reason");
          }
          return {
            createdAt: new Date(date(row, "created_at")).toISOString(),
            eventId: text(row, "event_id"),
            eventType,
            ...(row.fence === null ? {} : { fence: number(row, "fence") }),
            reasonCode,
            ...(row.request_id === null ? {} : { requestId: text(row, "request_id") }),
            threadId: text(row, "thread_id"),
          };
        });
        return {
          status: "ok",
          events,
          ...(events.length > 0 ? { nextEventId: events.at(-1)!.eventId } : {}),
        };
      }),
    );
  }

  async prune(batchSize: number): Promise<DistributedPruneResult> {
    if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_PRUNE_BATCH) {
      return { status: "unavailable" };
    }
    return this.safe<DistributedPruneResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) {
          throw new Error("coordinator instance is not registered");
        }
        await this.#expireActive(tx);
        await this.#cancelExpiredQueued(tx);
        const requestRows = await tx.unsafe<Row>(
          "WITH ranked AS (SELECT request_id, terminal_at, row_number() OVER (ORDER BY terminal_at DESC, request_id DESC) AS newest_rank FROM public.auggy_coordination_requests WHERE namespace = $1 AND state IN ('completed', 'failed', 'canceled')), victims AS (SELECT request_id FROM ranked WHERE terminal_at <= clock_timestamp() - ($2 * interval '1 millisecond') OR newest_rank > $3 ORDER BY terminal_at, request_id LIMIT $4), deleted AS (DELETE FROM public.auggy_coordination_requests request USING victims WHERE request.namespace = $1 AND request.request_id = victims.request_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [
            this.#config.namespace,
            this.#config.retention.terminalRequestRetentionMs,
            this.#config.retention.maxTerminalRequests,
            batchSize,
          ],
        );
        const threadRows = await tx.unsafe<Row>(
          "WITH victims AS (SELECT thread.thread_id FROM public.auggy_coordination_threads thread WHERE thread.namespace = $1 AND NOT thread.quarantined AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.thread_id = thread.thread_id) ORDER BY thread.thread_id LIMIT $2), deleted AS (DELETE FROM public.auggy_coordination_threads thread USING victims WHERE thread.namespace = $1 AND thread.thread_id = victims.thread_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [this.#config.namespace, batchSize],
        );
        const eventRows = await tx.unsafe<Row>(
          "WITH eligible AS (SELECT event.event_id, event.created_at FROM public.auggy_coordination_events event WHERE event.namespace = $1 AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND request.request_id = event.request_id AND request.state = 'outcome_unknown')), ranked AS (SELECT event_id, created_at, row_number() OVER (ORDER BY event_id DESC) AS newest_rank FROM eligible), victims AS (SELECT event_id FROM ranked WHERE created_at <= clock_timestamp() - ($2 * interval '1 millisecond') OR newest_rank > $3 ORDER BY event_id LIMIT $4), deleted AS (DELETE FROM public.auggy_coordination_events event USING victims WHERE event.namespace = $1 AND event.event_id = victims.event_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [
            this.#config.namespace,
            this.#config.retention.eventRetentionMs,
            this.#config.retention.maxEvents,
            batchSize,
          ],
        );
        const instanceRows = await tx.unsafe<Row>(
          "WITH victims AS (SELECT instance.instance_id FROM public.auggy_coordination_instances instance WHERE instance.namespace = $1 AND instance.instance_id <> $2 AND instance.lease_expires_at <= clock_timestamp() AND NOT EXISTS (SELECT 1 FROM public.auggy_coordination_requests request WHERE request.namespace = $1 AND ((request.owner_instance = instance.instance_id AND request.owner_session = instance.session_id) OR (request.queue_owner_instance = instance.instance_id AND request.queue_owner_session = instance.session_id))) ORDER BY instance.registered_at, instance.instance_id LIMIT $3), deleted AS (DELETE FROM public.auggy_coordination_instances instance USING victims WHERE instance.namespace = $1 AND instance.instance_id = victims.instance_id RETURNING 1) SELECT count(*)::integer AS count FROM deleted",
          [this.#config.namespace, this.#config.instanceId, batchSize],
        );
        return {
          status: "ok",
          events: number(eventRows[0]!, "count"),
          instances: number(instanceRows[0]!, "count"),
          requests: number(requestRows[0]!, "count"),
          threads: number(threadRows[0]!, "count"),
        };
      }),
    );
  }

  async recover(threadId: string, expectedFence: number, reason: string): Promise<LeaseResult> {
    assertIdentifier("threadId", threadId);
    if (!/^[a-z0-9][a-z0-9._:-]{0,63}$/.test(reason)) {
      throw new Error("recovery reason must be a fixed secret-free reason code");
    }
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const threads = await tx.unsafe<Row>(
          "SELECT thread_id FROM public.auggy_coordination_threads WHERE namespace = $1 AND thread_id = $2 AND quarantined = TRUE AND quarantine_fence = $3 FOR UPDATE",
          [this.#config.namespace, threadId, expectedFence],
        );
        if (!threads[0]) return { status: "stale" };
        const incidents = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'failed', terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2 AND fence = $3 AND state = 'outcome_unknown' RETURNING request_id",
          [this.#config.namespace, threadId, expectedFence],
        );
        const incident = incidents[0];
        if (!incident) return { status: "stale" };
        await tx.unsafe(
          "UPDATE public.auggy_coordination_threads SET quarantined = FALSE, quarantine_fence = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
          [this.#config.namespace, threadId],
        );
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_events (namespace, thread_id, request_id, fence, event_type, reason) VALUES ($1, $2, $3, $4, 'operator_recovery', $5)",
          [this.#config.namespace, threadId, text(incident, "request_id"), expectedFence, reason],
        );
        return { status: "ok" };
      }),
    );
  }

  async beginDrain(): Promise<LeaseResult> {
    const result = await this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        const drained = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_instances SET accepting = FALSE, draining = TRUE, updated_at = clock_timestamp() WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND lease_expires_at > clock_timestamp() RETURNING instance_id",
          [this.#config.namespace, this.#config.instanceId, this.#sessionId],
        );
        if (!drained[0]) return { status: "stale" };
        await tx.unsafe(
          "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'queued' AND queue_owner_instance = $2 AND queue_owner_session = $3",
          [this.#config.namespace, this.#config.instanceId, this.#sessionId],
        );
        return { status: "ok" };
      }),
    );
    if (result.status === "ok") this.abortOwnedPhase("queued", "draining");
    else this.abortAllOwned("coordinator-authority-lost");
    return result;
  }

  async health(): Promise<DistributedCoordinatorHealth> {
    const result = await this.safe<DistributedCoordinatorHealth>(
      { status: "unavailable", active: 0, queued: 0, quarantined: 0 },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          const instance = await this.registeredInstance(tx);
          if (!instance) throw new Error("coordinator instance is not registered");
          await this.#expireActive(tx);
          await this.#cancelExpiredQueued(tx);
          const rows = await tx.unsafe<Row>(
            "SELECT count(*) FILTER (WHERE state = 'active')::integer AS active, count(*) FILTER (WHERE state = 'queued')::integer AS queued, (SELECT count(*)::integer FROM public.auggy_coordination_threads WHERE namespace = $1 AND quarantined) AS quarantined FROM public.auggy_coordination_requests WHERE namespace = $1",
            [this.#config.namespace],
          );
          const row = rows[0];
          if (!row) throw new Error("missing coordinator health row");
          return {
            status: instance.draining ? "draining" : "healthy",
            active: number(row, "active"),
            queued: number(row, "queued"),
            quarantined: number(row, "quarantined"),
          };
        }),
    );
    if (result.status === "unavailable") this.abortAllOwned("coordinator-authority-lost");
    return result;
  }

  async #lockNamespace(
    tx: SqlTransaction,
    create = false,
    allowQuiescentUpgrade = false,
  ): Promise<
    Pick<DistributedCoordinatorConfig, "maxConcurrent" | "maxQueued" | "maxQueuedPerThread">
  > {
    if (create) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_namespaces (namespace, max_concurrent, max_queued, max_queued_per_thread, lease_ms, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (namespace) DO NOTHING",
        [
          this.#config.namespace,
          this.#config.maxConcurrent,
          this.#config.maxQueued,
          this.#config.maxQueuedPerThread,
          this.#config.leaseMs,
          this.#config.compatibility.protocolVersion,
          this.#config.compatibility.protocolFingerprint,
          this.#config.compatibility.configurationFingerprint,
          this.#config.retention.terminalRequestRetentionMs,
          this.#config.retention.maxTerminalRequests,
          this.#config.retention.eventRetentionMs,
          this.#config.retention.maxEvents,
          this.#config.result.maxReplayBytes,
        ],
      );
      await tx.unsafe(
        "UPDATE public.auggy_coordination_namespaces SET lease_ms = $2, updated_at = clock_timestamp() WHERE namespace = $1 AND lease_ms IS NULL",
        [this.#config.namespace, this.#config.leaseMs],
      );
    }
    const policy = await tx.unsafe<Row>(
      "SELECT max_concurrent, max_queued, max_queued_per_thread, lease_ms, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes FROM public.auggy_coordination_namespaces WHERE namespace = $1 FOR UPDATE",
      [this.#config.namespace],
    );
    const row = policy[0];
    if (!row) throw new Error("missing namespace policy row");
    const stored = {
      maxConcurrent: number(row, "max_concurrent"),
      maxQueued: number(row, "max_queued"),
      maxQueuedPerThread: number(row, "max_queued_per_thread"),
      leaseMs: number(row, "lease_ms"),
      protocolVersion: number(row, "protocol_version"),
      protocolFingerprint: text(row, "protocol_fingerprint"),
      configurationFingerprint: text(row, "configuration_fingerprint"),
      terminalRequestRetentionMs: number(row, "terminal_request_retention_ms"),
      maxTerminalRequests: number(row, "max_terminal_requests"),
      eventRetentionMs: number(row, "event_retention_ms"),
      maxEvents: number(row, "max_events"),
      maxReplayBytes: number(row, "max_replay_bytes"),
    };
    const basePolicyMatches =
      stored.maxConcurrent === this.#config.maxConcurrent &&
      stored.maxQueued === this.#config.maxQueued &&
      stored.maxQueuedPerThread === this.#config.maxQueuedPerThread &&
      stored.leaseMs === this.#config.leaseMs &&
      stored.terminalRequestRetentionMs === this.#config.retention.terminalRequestRetentionMs &&
      stored.maxTerminalRequests === this.#config.retention.maxTerminalRequests &&
      stored.eventRetentionMs === this.#config.retention.eventRetentionMs &&
      stored.maxEvents === this.#config.retention.maxEvents &&
      stored.maxReplayBytes === this.#config.result.maxReplayBytes;
    let compatibilityMatches =
      stored.protocolVersion === this.#config.compatibility.protocolVersion &&
      stored.protocolFingerprint === this.#config.compatibility.protocolFingerprint &&
      stored.configurationFingerprint === this.#config.compatibility.configurationFingerprint;
    const predecessor = this.#config.compatibility.upgradeFrom;
    if (
      !compatibilityMatches &&
      allowQuiescentUpgrade &&
      basePolicyMatches &&
      predecessor &&
      stored.protocolVersion === predecessor.protocolVersion &&
      stored.protocolFingerprint === predecessor.protocolFingerprint &&
      stored.configurationFingerprint === predecessor.configurationFingerprint
    ) {
      const activity = await tx.unsafe<Row>(
        "SELECT count(*) FILTER (WHERE lease_expires_at > clock_timestamp())::integer AS live_instances, (SELECT count(*)::integer FROM public.auggy_coordination_requests WHERE namespace = $1 AND state IN ('queued', 'active')) AS pending_requests FROM public.auggy_coordination_instances WHERE namespace = $1",
        [this.#config.namespace],
      );
      const quiescent =
        activity[0] &&
        number(activity[0], "live_instances") === 0 &&
        number(activity[0], "pending_requests") === 0;
      if (quiescent) {
        const upgraded = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_namespaces SET protocol_version = $5, protocol_fingerprint = $6, configuration_fingerprint = $7, updated_at = clock_timestamp() WHERE namespace = $1 AND protocol_version = $2 AND protocol_fingerprint = $3 AND configuration_fingerprint = $4 RETURNING namespace",
          [
            this.#config.namespace,
            predecessor.protocolVersion,
            predecessor.protocolFingerprint,
            predecessor.configurationFingerprint,
            this.#config.compatibility.protocolVersion,
            this.#config.compatibility.protocolFingerprint,
            this.#config.compatibility.configurationFingerprint,
          ],
        );
        if (upgraded[0]) {
          await tx.unsafe(
            "DELETE FROM public.auggy_coordination_instances WHERE namespace = $1 AND lease_expires_at <= clock_timestamp()",
            [this.#config.namespace],
          );
          compatibilityMatches = true;
        }
      }
    }
    if (!basePolicyMatches || !compatibilityMatches) {
      throw new Error("coordinator namespace policy mismatch");
    }
    return stored;
  }

  async registeredInstance(
    tx: SqlTransaction,
  ): Promise<{ accepting: boolean; draining: boolean } | undefined> {
    const rows = await tx.unsafe<Row>(
      "SELECT accepting, draining FROM public.auggy_coordination_instances WHERE namespace = $1 AND instance_id = $2 AND session_id = $3 AND build_fingerprint = $4 AND lease_expires_at > clock_timestamp() FOR UPDATE",
      [
        this.#config.namespace,
        this.#config.instanceId,
        this.#sessionId,
        this.#config.buildFingerprint,
      ],
    );
    const row = rows[0];
    return row ? { accepting: bool(row, "accepting"), draining: bool(row, "draining") } : undefined;
  }

  async provisionSources(tx: SqlTransaction): Promise<void> {
    for (const source of this.#config.sources) {
      await tx.unsafe(
        "INSERT INTO public.auggy_coordination_sources (namespace, source_id, max_concurrent, max_queued) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, source_id) DO NOTHING",
        [this.#config.namespace, source.id, source.maxConcurrent, source.maxQueued],
      );
    }
    const rows = await tx.unsafe<Row>(
      "SELECT source_id, max_concurrent, max_queued FROM public.auggy_coordination_sources WHERE namespace = $1 ORDER BY source_id FOR UPDATE",
      [this.#config.namespace],
    );
    const expected = [...this.#config.sources].sort((left, right) =>
      left.id.localeCompare(right.id),
    );
    if (
      rows.length !== expected.length ||
      rows.some((row, index) => {
        const source = expected[index];
        return (
          !source ||
          text(row, "source_id") !== source.id ||
          number(row, "max_concurrent") !== source.maxConcurrent ||
          number(row, "max_queued") !== source.maxQueued
        );
      })
    ) {
      throw new Error("coordinator source policy mismatch");
    }
  }

  /** Trusted runtime integration provisions immutable source policy per namespace. */
  async sourcePolicy(
    tx: SqlTransaction,
    incoming: DistributedTurnRequest["source"],
  ): Promise<DistributedTurnRequest["source"]> {
    const rows = await tx.unsafe<Row>(
      "SELECT source_id, max_concurrent, max_queued FROM public.auggy_coordination_sources WHERE namespace = $1 AND source_id = $2",
      [this.#config.namespace, incoming.id],
    );
    const row = rows[0];
    if (!row) throw new Error("missing source policy row");
    const stored = {
      id: text(row, "source_id"),
      maxConcurrent: number(row, "max_concurrent"),
      maxQueued: number(row, "max_queued"),
    };
    if (
      stored.maxConcurrent !== incoming.maxConcurrent ||
      stored.maxQueued !== incoming.maxQueued
    ) {
      throw new Error("coordinator source policy mismatch");
    }
    return stored;
  }

  async #expireActive(tx: SqlTransaction): Promise<void> {
    const expired = await tx.unsafe<Row>(
      "UPDATE public.auggy_coordination_requests SET state = CASE WHEN execution_started_at IS NULL THEN 'queued' ELSE 'outcome_unknown' END, queue_owner_instance = CASE WHEN execution_started_at IS NULL THEN owner_instance ELSE NULL END, queue_owner_session = CASE WHEN execution_started_at IS NULL THEN owner_session ELSE NULL END, queue_generation = CASE WHEN execution_started_at IS NULL THEN queue_generation + 1 ELSE queue_generation END, queue_expires_at = CASE WHEN execution_started_at IS NULL THEN clock_timestamp() ELSE NULL END, fence = CASE WHEN execution_started_at IS NULL THEN NULL ELSE fence END, owner_instance = NULL, owner_session = NULL, lease_expires_at = NULL, terminal_at = CASE WHEN execution_started_at IS NULL THEN NULL ELSE clock_timestamp() END, updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'active' AND lease_expires_at <= clock_timestamp() RETURNING request_id, thread_id, fence, execution_started_at",
      [this.#config.namespace],
    );
    for (const row of expired) {
      if (row.execution_started_at === null) continue;
      await this.recordQuarantine(
        tx,
        text(row, "thread_id"),
        text(row, "request_id"),
        number(row, "fence"),
        "lease-lost",
      );
    }
  }

  async recordQuarantine(
    tx: SqlTransaction,
    threadId: string,
    requestId: string,
    fence: number,
    reasonCode: CoordinationOutcomeUnknownReason,
  ): Promise<void> {
    await tx.unsafe(
      "UPDATE public.auggy_coordination_threads SET quarantined = TRUE, quarantine_fence = $3, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
      [this.#config.namespace, threadId, fence],
    );
    await tx.unsafe(
      "INSERT INTO public.auggy_coordination_events (namespace, thread_id, request_id, fence, event_type, reason) VALUES ($1, $2, $3, $4, 'outcome_unknown', $5)",
      [this.#config.namespace, threadId, requestId, fence, reasonCode],
    );
  }

  async #cancelExpiredQueued(tx: SqlTransaction, exceptRequestId?: string): Promise<void> {
    await tx.unsafe(
      "UPDATE public.auggy_coordination_requests SET state = 'canceled', queue_owner_instance = NULL, queue_owner_session = NULL, queue_expires_at = NULL, terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'queued' AND queue_expires_at <= clock_timestamp() AND ($2::text IS NULL OR request_id <> $2)",
      [this.#config.namespace, exceptRequestId ?? null],
    );
  }

  async updateLease(
    lease: DistributedTurnLease,
    set: string,
    values: unknown[],
  ): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        if (!(await this.registeredInstance(tx))) return { status: "stale" };
        await this.#expireActive(tx);
        const rows = await tx.unsafe<Row>(
          `UPDATE public.auggy_coordination_requests SET ${set} WHERE namespace = $${values.length + 1} AND request_id = $${values.length + 2} AND thread_id = $${values.length + 3} AND source_id = $${values.length + 4} AND state = 'active' AND queue_generation = $${values.length + 5} AND fence = $${values.length + 6} AND owner_instance = $${values.length + 7} AND owner_session = $${values.length + 8} AND lease_expires_at > clock_timestamp() RETURNING request_id`,
          [
            ...values,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.attempt,
            lease.fence,
            this.#config.instanceId,
            this.#sessionId,
          ],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
  }

  lease(
    request: DistributedTurnRequest,
    attempt: number,
    fence: number,
    expiresAt: number,
  ): DistributedTurnLease {
    return {
      namespace: this.#config.namespace,
      requestId: request.requestId,
      threadId: request.threadId,
      sourceId: request.source.id,
      instanceId: this.#config.instanceId,
      attempt,
      fence,
      expiresAt,
    };
  }

  validLease(lease: DistributedTurnLease): boolean {
    return (
      lease.namespace === this.#config.namespace &&
      lease.instanceId === this.#config.instanceId &&
      Number.isSafeInteger(lease.attempt) &&
      lease.attempt > 0 &&
      Number.isSafeInteger(lease.fence) &&
      lease.fence > 0 &&
      (() => {
        try {
          assertIdentifier("requestId", lease.requestId);
          assertIdentifier("threadId", lease.threadId);
          assertIdentifier("sourceId", lease.sourceId);
          return true;
        } catch {
          return false;
        }
      })()
    );
  }

  trackOwned(
    request: DistributedTurnRequest,
    phase: LocalOwnedOperation["phase"],
    attempt: number,
  ): void {
    if (this.#invalidated) return;
    const existing = this.#owned.get(request.requestId);
    if (
      existing &&
      !existing.controller.signal.aborted &&
      existing.bindingHash === request.bindingHash &&
      existing.threadId === request.threadId &&
      existing.sourceId === request.source.id
    ) {
      existing.phase = phase;
      existing.attempt = attempt;
      return;
    }
    existing?.controller.abort("ownership-replaced");
    this.#owned.set(request.requestId, {
      attempt,
      bindingHash: request.bindingHash,
      controller: new AbortController(),
      phase,
      sourceId: request.source.id,
      threadId: request.threadId,
    });
  }

  abortOwned(requestId: string, reason: string): void {
    const operation = this.#owned.get(requestId);
    if (!operation) return;
    operation.controller.abort(reason);
    this.#owned.delete(requestId);
  }

  abortOwnedPhase(phase: LocalOwnedOperation["phase"], reason: string): void {
    for (const [requestId, operation] of this.#owned) {
      if (operation.phase === phase) this.abortOwned(requestId, reason);
    }
  }

  abortOwnedAttempt(requestId: string, attempt: number, reason: string): void {
    const operation = this.#owned.get(requestId);
    if (operation?.attempt === attempt) {
      this.abortOwned(requestId, reason);
    }
  }

  abortAllOwned(reason: string): void {
    for (const requestId of [...this.#owned.keys()]) this.abortOwned(requestId, reason);
  }

  unavailableSignal(): AbortSignal {
    const controller = new AbortController();
    controller.abort("not-owned");
    return controller.signal;
  }

  async transaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      // With pg_catalog omitted, PostgreSQL searches it implicitly before the
      // fixed schema. A role- or URL-supplied search_path cannot shadow either
      // built-in functions or coordination relations for this transaction.
      await tx.unsafe("SET LOCAL search_path TO public");
      return callback(tx);
    });
  }

  async safe<T>(
    fallback: T,
    callback: () => Promise<T>,
    observe?: (result: T) => void,
    allowAfterInvalidation = false,
  ): Promise<T> {
    if (this.#invalidated && !allowAfterInvalidation) {
      observe?.(fallback);
      return fallback;
    }
    try {
      const result = await callback();
      observe?.(result);
      return result;
    } catch {
      observe?.(fallback);
      return fallback;
    }
  }
}
