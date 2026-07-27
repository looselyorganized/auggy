import { migratePostgresCoordinator, type PostgresMigrationExecutor } from "./migrations";
import { createSecurePostgresCoordinationClient } from "./postgres-url";
import type {
  AdmitResult,
  ClaimResult,
  CoordinationRequestState,
  DistributedCoordinatorConfig,
  DistributedCoordinatorHealth,
  DistributedTurnCoordinator,
  DistributedTurnLease,
  DistributedTurnRequest,
  LeaseResult,
} from "./types";

type Row = Record<string, unknown>;
const MAX_CAPACITY = 1_000_000;
const MAX_LEASE_MS = 3_600_000;

interface SqlTransaction extends PostgresMigrationExecutor {
  begin<T>(callback: (transaction: SqlTransaction) => Promise<T>): Promise<T>;
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
  const parsed = typeof value === "number" ? value : Number(value);
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
    assertIdentifier("namespace", options.namespace);
    assertIdentifier("instanceId", options.instanceId);
    this.#config = options;
    this.#ownsSql = !options.sql;
    this.#sql = (options.sql ??
      createSecurePostgresCoordinationClient(options.url!)) as unknown as SqlTransaction;
  }

  async migrate(): Promise<void> {
    await migratePostgresCoordinator(this.#sql);
  }

  async close(): Promise<void> {
    if (this.#ownsSql) await (this.#sql as unknown as { close: () => Promise<void> }).close();
  }

  async admit(request: DistributedTurnRequest): Promise<AdmitResult> {
    return this.safe<AdmitResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const limits = await this.#lockNamespace(tx);
        await this.#expire(tx);
        const policy = await this.sourcePolicy(tx, request.source);
        const existing = await tx.unsafe<Row>(
          "SELECT thread_id, source_id, binding_hash, state FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        if (existing[0]) {
          const row = existing[0];
          return text(row, "thread_id") === request.threadId &&
            text(row, "source_id") === request.source.id &&
            text(row, "binding_hash") === request.bindingHash
            ? { status: "joined", state: text(row, "state") as CoordinationRequestState }
            : { status: "conflict" };
        }
        if (await this.instanceDraining(tx)) return { status: "rejected", reason: "draining" };
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
          "INSERT INTO public.auggy_coordination_requests (namespace, request_id, thread_id, source_id, binding_hash, state) VALUES ($1, $2, $3, $4, $5, 'queued')",
          [
            this.#config.namespace,
            request.requestId,
            request.threadId,
            policy.id,
            request.bindingHash,
          ],
        );
        return { status: "admitted" };
      }),
    );
  }

  async claim(request: DistributedTurnRequest): Promise<ClaimResult> {
    return this.safe<ClaimResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        assertRequest(request);
        const limits = await this.#lockNamespace(tx);
        await this.#expire(tx);
        const policy = await this.sourcePolicy(tx, request.source);
        const found = await tx.unsafe<Row>(
          "SELECT state, thread_id, source_id, binding_hash, fence, owner_instance, lease_expires_at FROM public.auggy_coordination_requests WHERE namespace = $1 AND request_id = $2 FOR UPDATE",
          [this.#config.namespace, request.requestId],
        );
        const row = found[0];
        if (
          !row ||
          text(row, "thread_id") !== request.threadId ||
          text(row, "source_id") !== policy.id ||
          text(row, "binding_hash") !== request.bindingHash
        )
          return { status: "conflict" };
        const state = text(row, "state");
        if (state === "outcome_unknown") return { status: "quarantined" };
        if (isTerminal(state)) return { status: "terminal", state };
        if (state === "active") return { status: "waiting" };
        if (await this.instanceDraining(tx)) return { status: "waiting" };
        const thread = await tx.unsafe<Row>(
          "INSERT INTO public.auggy_coordination_threads (namespace, thread_id) VALUES ($1, $2) ON CONFLICT (namespace, thread_id) DO UPDATE SET updated_at = clock_timestamp() RETURNING quarantined, next_fence",
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
          "UPDATE public.auggy_coordination_threads SET next_fence = next_fence + 1, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2 RETURNING next_fence",
          [this.#config.namespace, request.threadId],
        );
        const fence = number(fenced[0]!, "next_fence");
        const claimed = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'active', fence = $3, owner_instance = $4, lease_expires_at = clock_timestamp() + ($5 * interval '1 millisecond'), execution_started_at = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 RETURNING lease_expires_at",
          [
            this.#config.namespace,
            request.requestId,
            fence,
            this.#config.instanceId,
            this.#config.leaseMs,
          ],
        );
        return {
          status: "acquired",
          lease: this.lease(request, fence, date(claimed[0]!, "lease_expires_at")),
        };
      }),
    );
  }

  async markExecutionStarted(lease: DistributedTurnLease): Promise<LeaseResult> {
    return this.updateLease(
      lease,
      "execution_started_at = clock_timestamp(), updated_at = clock_timestamp()",
      [],
    );
  }

  async heartbeat(lease: DistributedTurnLease): Promise<LeaseResult> {
    if (!this.validLease(lease)) return { status: "stale" };
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        await this.#expire(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET lease_expires_at = clock_timestamp() + ($1 * interval '1 millisecond'), updated_at = clock_timestamp() WHERE namespace = $2 AND request_id = $3 AND thread_id = $4 AND source_id = $5 AND state = 'active' AND fence = $6 AND owner_instance = $7 AND lease_expires_at > clock_timestamp() RETURNING lease_expires_at",
          [
            this.#config.leaseMs,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.fence,
            this.#config.instanceId,
          ],
        );
        return rows[0]
          ? { status: "ok", lease: { ...lease, expiresAt: date(rows[0], "lease_expires_at") } }
          : { status: "stale" };
      }),
    );
  }

  async complete(lease: DistributedTurnLease): Promise<LeaseResult> {
    return this.terminal(lease, "completed");
  }

  async fail(lease: DistributedTurnLease): Promise<LeaseResult> {
    return this.terminal(lease, "failed");
  }

  async cancel(
    request: Pick<DistributedTurnRequest, "requestId" | "bindingHash">,
  ): Promise<LeaseResult> {
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_requests SET state = 'canceled', terminal_at = clock_timestamp(), updated_at = clock_timestamp() WHERE namespace = $1 AND request_id = $2 AND binding_hash = $3 AND state = 'queued' RETURNING request_id",
          [this.#config.namespace, request.requestId, request.bindingHash],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
  }

  async recover(threadId: string, expectedFence: number, reason: string): Promise<LeaseResult> {
    assertIdentifier("threadId", threadId);
    if (reason.trim().length < 3 || reason.length > 160)
      throw new Error("recovery reason must be a concise operator audit record");
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        await this.#expire(tx);
        const rows = await tx.unsafe<Row>(
          "UPDATE public.auggy_coordination_threads SET quarantined = FALSE, quarantine_fence = NULL, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2 AND quarantined = TRUE AND quarantine_fence = $3 RETURNING thread_id",
          [this.#config.namespace, threadId, expectedFence],
        );
        if (!rows[0]) return { status: "stale" };
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_events (namespace, thread_id, fence, event_type, reason) VALUES ($1, $2, $3, 'operator_recovery', $4)",
          [this.#config.namespace, threadId, expectedFence, reason],
        );
        return { status: "ok" };
      }),
    );
  }

  async setDraining(draining: boolean): Promise<LeaseResult> {
    return this.safe<LeaseResult>({ status: "unavailable" }, async () =>
      this.transaction(async (tx) => {
        await this.#lockNamespace(tx);
        await tx.unsafe(
          "INSERT INTO public.auggy_coordination_instances (namespace, instance_id, draining) VALUES ($1, $2, $3) ON CONFLICT (namespace, instance_id) DO UPDATE SET draining = EXCLUDED.draining, updated_at = clock_timestamp()",
          [this.#config.namespace, this.#config.instanceId, draining],
        );
        return { status: "ok" };
      }),
    );
  }

  async health(): Promise<DistributedCoordinatorHealth> {
    return this.safe<DistributedCoordinatorHealth>(
      { status: "unavailable", active: 0, queued: 0, quarantined: 0 },
      async () =>
        this.transaction(async (tx) => {
          await this.#lockNamespace(tx);
          await this.#expire(tx);
          const draining = await this.instanceDraining(tx);
          const rows = await tx.unsafe<Row>(
            "SELECT count(*) FILTER (WHERE state = 'active')::integer AS active, count(*) FILTER (WHERE state = 'queued')::integer AS queued, (SELECT count(*)::integer FROM public.auggy_coordination_threads WHERE namespace = $1 AND quarantined) AS quarantined FROM public.auggy_coordination_requests WHERE namespace = $1",
            [this.#config.namespace],
          );
          const row = rows[0];
          if (!row) throw new Error("missing coordinator health row");
          return {
            status: draining ? "draining" : "healthy",
            active: number(row, "active"),
            queued: number(row, "queued"),
            quarantined: number(row, "quarantined"),
          };
        }),
    );
  }

  async #lockNamespace(
    tx: SqlTransaction,
  ): Promise<
    Pick<DistributedCoordinatorConfig, "maxConcurrent" | "maxQueued" | "maxQueuedPerThread">
  > {
    await tx.unsafe(
      "INSERT INTO public.auggy_coordination_namespaces (namespace, max_concurrent, max_queued, max_queued_per_thread, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) ON CONFLICT (namespace) DO NOTHING",
      [
        this.#config.namespace,
        this.#config.maxConcurrent,
        this.#config.maxQueued,
        this.#config.maxQueuedPerThread,
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
    const policy = await tx.unsafe<Row>(
      "SELECT max_concurrent, max_queued, max_queued_per_thread, protocol_version, protocol_fingerprint, configuration_fingerprint, terminal_request_retention_ms, max_terminal_requests, event_retention_ms, max_events, max_replay_bytes FROM public.auggy_coordination_namespaces WHERE namespace = $1 FOR UPDATE",
      [this.#config.namespace],
    );
    const row = policy[0];
    if (!row) throw new Error("missing namespace policy row");
    const stored = {
      maxConcurrent: number(row, "max_concurrent"),
      maxQueued: number(row, "max_queued"),
      maxQueuedPerThread: number(row, "max_queued_per_thread"),
      protocolVersion: number(row, "protocol_version"),
      protocolFingerprint: text(row, "protocol_fingerprint"),
      configurationFingerprint: text(row, "configuration_fingerprint"),
      terminalRequestRetentionMs: number(row, "terminal_request_retention_ms"),
      maxTerminalRequests: number(row, "max_terminal_requests"),
      eventRetentionMs: number(row, "event_retention_ms"),
      maxEvents: number(row, "max_events"),
      maxReplayBytes: number(row, "max_replay_bytes"),
    };
    if (
      stored.maxConcurrent !== this.#config.maxConcurrent ||
      stored.maxQueued !== this.#config.maxQueued ||
      stored.maxQueuedPerThread !== this.#config.maxQueuedPerThread ||
      stored.protocolVersion !== this.#config.compatibility.protocolVersion ||
      stored.protocolFingerprint !== this.#config.compatibility.protocolFingerprint ||
      stored.configurationFingerprint !== this.#config.compatibility.configurationFingerprint ||
      stored.terminalRequestRetentionMs !== this.#config.retention.terminalRequestRetentionMs ||
      stored.maxTerminalRequests !== this.#config.retention.maxTerminalRequests ||
      stored.eventRetentionMs !== this.#config.retention.eventRetentionMs ||
      stored.maxEvents !== this.#config.retention.maxEvents ||
      stored.maxReplayBytes !== this.#config.result.maxReplayBytes
    ) {
      throw new Error("coordinator namespace policy mismatch");
    }
    return stored;
  }

  async instanceDraining(tx: SqlTransaction): Promise<boolean> {
    const instance = await tx.unsafe<Row>(
      "INSERT INTO public.auggy_coordination_instances (namespace, instance_id) VALUES ($1, $2) ON CONFLICT (namespace, instance_id) DO UPDATE SET updated_at = clock_timestamp() RETURNING draining",
      [this.#config.namespace, this.#config.instanceId],
    );
    return instance[0] !== undefined && bool(instance[0], "draining");
  }

  /** Trusted runtime integration provisions immutable source policy per namespace. */
  async sourcePolicy(
    tx: SqlTransaction,
    incoming: DistributedTurnRequest["source"],
  ): Promise<DistributedTurnRequest["source"]> {
    await tx.unsafe(
      "INSERT INTO public.auggy_coordination_sources (namespace, source_id, max_concurrent, max_queued) VALUES ($1, $2, $3, $4) ON CONFLICT (namespace, source_id) DO NOTHING",
      [this.#config.namespace, incoming.id, incoming.maxConcurrent, incoming.maxQueued],
    );
    const rows = await tx.unsafe<Row>(
      "SELECT source_id, max_concurrent, max_queued FROM public.auggy_coordination_sources WHERE namespace = $1 AND source_id = $2 FOR UPDATE",
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

  async #expire(tx: SqlTransaction): Promise<void> {
    const expired = await tx.unsafe<Row>(
      "UPDATE public.auggy_coordination_requests SET state = CASE WHEN execution_started_at IS NULL THEN 'queued' ELSE 'outcome_unknown' END, owner_instance = NULL, lease_expires_at = NULL, terminal_at = CASE WHEN execution_started_at IS NULL THEN NULL ELSE clock_timestamp() END, updated_at = clock_timestamp() WHERE namespace = $1 AND state = 'active' AND lease_expires_at <= clock_timestamp() RETURNING thread_id, fence, execution_started_at",
      [this.#config.namespace],
    );
    for (const row of expired) {
      if (row.execution_started_at === null) continue;
      await tx.unsafe(
        "UPDATE public.auggy_coordination_threads SET quarantined = TRUE, quarantine_fence = $3, updated_at = clock_timestamp() WHERE namespace = $1 AND thread_id = $2",
        [this.#config.namespace, text(row, "thread_id"), number(row, "fence")],
      );
    }
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
        const rows = await tx.unsafe<Row>(
          `UPDATE public.auggy_coordination_requests SET ${set} WHERE namespace = $${values.length + 1} AND request_id = $${values.length + 2} AND thread_id = $${values.length + 3} AND source_id = $${values.length + 4} AND state = 'active' AND fence = $${values.length + 5} AND owner_instance = $${values.length + 6} AND lease_expires_at > clock_timestamp() RETURNING request_id`,
          [
            ...values,
            this.#config.namespace,
            lease.requestId,
            lease.threadId,
            lease.sourceId,
            lease.fence,
            this.#config.instanceId,
          ],
        );
        return rows[0] ? { status: "ok" } : { status: "stale" };
      }),
    );
  }

  async terminal(lease: DistributedTurnLease, state: "completed" | "failed"): Promise<LeaseResult> {
    return this.updateLease(
      lease,
      `state = '${state}', terminal_at = clock_timestamp(), lease_expires_at = NULL, updated_at = clock_timestamp()`,
      [],
    );
  }

  lease(request: DistributedTurnRequest, fence: number, expiresAt: number): DistributedTurnLease {
    return {
      namespace: this.#config.namespace,
      requestId: request.requestId,
      threadId: request.threadId,
      sourceId: request.source.id,
      instanceId: this.#config.instanceId,
      fence,
      expiresAt,
    };
  }

  validLease(lease: DistributedTurnLease): boolean {
    return (
      lease.namespace === this.#config.namespace &&
      lease.instanceId === this.#config.instanceId &&
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

  async transaction<T>(callback: (tx: SqlTransaction) => Promise<T>): Promise<T> {
    return this.#sql.begin(async (tx) => {
      // With pg_catalog omitted, PostgreSQL searches it implicitly before the
      // fixed schema. A role- or URL-supplied search_path cannot shadow either
      // built-in functions or coordination relations for this transaction.
      await tx.unsafe("SET LOCAL search_path TO public");
      return callback(tx);
    });
  }

  async safe<T>(fallback: T, callback: () => Promise<T>): Promise<T> {
    try {
      return await callback();
    } catch {
      return fallback;
    }
  }
}
