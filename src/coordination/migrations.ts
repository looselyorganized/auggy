/**
 * These statements are deliberately not run by the runtime. Operators invoke
 * migratePostgresCoordinator during provisioning or a controlled deployment.
 */
const INITIAL_COORDINATION_MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS auggy_coordination_migrations (
  id TEXT PRIMARY KEY,
  checksum TEXT NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS auggy_coordination_namespaces (
  namespace TEXT PRIMARY KEY,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
  max_queued INTEGER NOT NULL CHECK (max_queued >= 0),
  max_queued_per_thread INTEGER NOT NULL CHECK (max_queued_per_thread >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE IF NOT EXISTS auggy_coordination_instances (
  namespace TEXT NOT NULL,
  instance_id TEXT NOT NULL,
  draining BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, instance_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_threads (
  namespace TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  next_fence BIGINT NOT NULL DEFAULT 0,
  quarantined BOOLEAN NOT NULL DEFAULT FALSE,
  quarantine_fence BIGINT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, thread_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_sources (
  namespace TEXT NOT NULL,
  source_id TEXT NOT NULL,
  max_concurrent INTEGER NOT NULL CHECK (max_concurrent > 0),
  max_queued INTEGER NOT NULL CHECK (max_queued >= 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, source_id)
);

CREATE TABLE IF NOT EXISTS auggy_coordination_requests (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  binding_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown')),
  fence BIGINT,
  owner_instance TEXT,
  lease_expires_at TIMESTAMPTZ,
  execution_started_at TIMESTAMPTZ,
  queued_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  terminal_at TIMESTAMPTZ,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, request_id)
);

CREATE INDEX IF NOT EXISTS auggy_coordination_request_queue_idx
  ON auggy_coordination_requests (namespace, state, queued_at, request_id);
CREATE INDEX IF NOT EXISTS auggy_coordination_request_thread_idx
  ON auggy_coordination_requests (namespace, thread_id, state);
CREATE INDEX IF NOT EXISTS auggy_coordination_request_source_idx
  ON auggy_coordination_requests (namespace, source_id, state);

CREATE TABLE IF NOT EXISTS auggy_coordination_events (
  event_id BIGSERIAL PRIMARY KEY,
  namespace TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  request_id TEXT,
  fence BIGINT,
  event_type TEXT NOT NULL,
  reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
);
`;

const COORDINATION_COMPATIBILITY_MIGRATION_SQL = `
ALTER TABLE auggy_coordination_namespaces
  ADD COLUMN protocol_version INTEGER NOT NULL
    CONSTRAINT auggy_coord_ns_protocol_version_check CHECK (protocol_version > 0),
  ADD COLUMN protocol_fingerprint TEXT NOT NULL
    CONSTRAINT auggy_coord_ns_protocol_fingerprint_check CHECK (protocol_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN configuration_fingerprint TEXT NOT NULL
    CONSTRAINT auggy_coord_ns_config_fingerprint_check CHECK (configuration_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN terminal_request_retention_ms BIGINT NOT NULL
    CONSTRAINT auggy_coord_ns_terminal_retention_check CHECK (terminal_request_retention_ms >= 60000 AND terminal_request_retention_ms <= 31536000000),
  ADD COLUMN max_terminal_requests INTEGER NOT NULL
    CONSTRAINT auggy_coord_ns_max_terminal_check CHECK (max_terminal_requests >= 1 AND max_terminal_requests <= 1000000),
  ADD COLUMN event_retention_ms BIGINT NOT NULL
    CONSTRAINT auggy_coord_ns_event_retention_check CHECK (event_retention_ms >= 60000 AND event_retention_ms <= 31536000000),
  ADD COLUMN max_events INTEGER NOT NULL
    CONSTRAINT auggy_coord_ns_max_events_check CHECK (max_events >= 1 AND max_events <= 1000000),
  ADD COLUMN max_replay_bytes INTEGER NOT NULL
    CONSTRAINT auggy_coord_ns_replay_bytes_check CHECK (max_replay_bytes >= 1024 AND max_replay_bytes <= 1048576);
`;

const COORDINATION_LIFECYCLE_MIGRATION_SQL = `
UPDATE auggy_coordination_threads AS thread
   SET quarantined = TRUE,
       quarantine_fence = request.fence,
       updated_at = clock_timestamp()
  FROM auggy_coordination_requests AS request
 WHERE request.namespace = thread.namespace
   AND request.thread_id = thread.thread_id
   AND request.state = 'active'
   AND request.execution_started_at IS NOT NULL;

UPDATE auggy_coordination_requests
   SET state = CASE
         WHEN state = 'active' AND execution_started_at IS NOT NULL THEN 'outcome_unknown'
         WHEN state IN ('queued', 'active') THEN 'canceled'
         ELSE state
       END,
       owner_instance = NULL,
       lease_expires_at = NULL,
       terminal_at = CASE
         WHEN state IN ('queued', 'active', 'completed', 'failed', 'canceled', 'outcome_unknown')
           THEN COALESCE(terminal_at, clock_timestamp())
         ELSE terminal_at
       END,
       updated_at = clock_timestamp();

DELETE FROM auggy_coordination_instances;

ALTER TABLE auggy_coordination_instances
  ADD COLUMN session_id TEXT NOT NULL
    CONSTRAINT auggy_coord_instance_session_check CHECK (session_id ~ '^[0-9a-f]{64}$'),
  ADD COLUMN build_fingerprint TEXT NOT NULL
    CONSTRAINT auggy_coord_instance_build_check CHECK (build_fingerprint ~ '^[0-9a-f]{64}$'),
  ADD COLUMN accepting BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN lease_expires_at TIMESTAMPTZ NOT NULL,
  ADD COLUMN registered_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  ADD CONSTRAINT auggy_coord_instance_lifecycle_check
    CHECK ((accepting AND NOT draining) OR (NOT accepting AND draining));

ALTER TABLE auggy_coordination_requests
  ADD COLUMN owner_session TEXT,
  ADD COLUMN queue_owner_instance TEXT,
  ADD COLUMN queue_owner_session TEXT,
  ADD COLUMN queue_generation BIGINT NOT NULL DEFAULT 0
    CONSTRAINT auggy_coord_request_queue_generation_check CHECK (queue_generation >= 0),
  ADD COLUMN queue_expires_at TIMESTAMPTZ,
  ADD CONSTRAINT auggy_coord_request_lifecycle_check CHECK (
    (state = 'queued'
      AND queue_owner_instance IS NOT NULL
      AND queue_owner_session IS NOT NULL
      AND queue_generation > 0
      AND queue_expires_at IS NOT NULL
      AND fence IS NULL
      AND owner_instance IS NULL
      AND owner_session IS NULL
      AND lease_expires_at IS NULL
      AND terminal_at IS NULL)
    OR
    (state = 'active'
      AND fence IS NOT NULL
      AND owner_instance IS NOT NULL
      AND owner_session IS NOT NULL
      AND lease_expires_at IS NOT NULL
      AND queue_owner_instance IS NULL
      AND queue_owner_session IS NULL
      AND queue_expires_at IS NULL
      AND terminal_at IS NULL)
    OR
    (state IN ('completed', 'failed', 'canceled', 'outcome_unknown')
      AND terminal_at IS NOT NULL
      AND owner_instance IS NULL
      AND owner_session IS NULL
      AND lease_expires_at IS NULL
      AND queue_owner_instance IS NULL
      AND queue_owner_session IS NULL
      AND queue_expires_at IS NULL)
  );

CREATE INDEX auggy_coordination_instance_lease_idx
  ON auggy_coordination_instances (namespace, lease_expires_at, instance_id);
CREATE INDEX auggy_coordination_request_queue_lease_idx
  ON auggy_coordination_requests (namespace, state, queue_expires_at, request_id);
CREATE INDEX auggy_coordination_request_terminal_idx
  ON auggy_coordination_requests (namespace, state, terminal_at, request_id);
`;

const COORDINATION_RESULT_MIGRATION_SQL = `
UPDATE auggy_coordination_events
   SET reason = 'legacy-redacted'
 WHERE reason IS NOT NULL
   AND reason !~ '^[a-z0-9][a-z0-9._:-]{0,63}$';

ALTER TABLE auggy_coordination_events
  ADD CONSTRAINT auggy_coord_event_type_check
    CHECK (event_type ~ '^[a-z0-9][a-z0-9._:-]{0,63}$'),
  ADD CONSTRAINT auggy_coord_event_reason_check
    CHECK (reason IS NULL OR reason ~ '^[a-z0-9][a-z0-9._:-]{0,63}$');

ALTER TABLE auggy_coordination_namespaces
  ADD COLUMN lease_ms BIGINT,
  ADD COLUMN next_fence BIGINT NOT NULL DEFAULT 0;

UPDATE auggy_coordination_namespaces AS namespace_row
   SET next_fence = COALESCE((
     SELECT max(thread.next_fence)
       FROM auggy_coordination_threads AS thread
      WHERE thread.namespace = namespace_row.namespace
   ), 0);

ALTER TABLE auggy_coordination_namespaces
  ADD CONSTRAINT auggy_coord_ns_lease_ms_check
    CHECK (lease_ms IS NULL OR (lease_ms >= 1 AND lease_ms <= 3600000)),
  ADD CONSTRAINT auggy_coord_ns_next_fence_check CHECK (next_fence >= 0);

ALTER TABLE auggy_coordination_requests
  ADD COLUMN result_body BYTEA,
  ADD COLUMN result_content_type TEXT,
  ADD COLUMN result_version SMALLINT,
  ADD CONSTRAINT auggy_coord_request_result_version_check
    CHECK (result_version IS NULL OR result_version = 1),
  ADD CONSTRAINT auggy_coord_request_result_check CHECK (
    (result_body IS NULL AND result_content_type IS NULL AND result_version IS NULL)
    OR
    (state = 'completed'
      AND result_body IS NOT NULL
      AND result_content_type = 'application/json'
      AND result_version = 1
      AND octet_length(result_body) <= 1048576)
  );
`;

const COORDINATION_TURN_STATE_MIGRATION_SQL = `
ALTER TABLE auggy_coordination_namespaces
  ADD COLUMN max_history_snapshot_bytes INTEGER
    CONSTRAINT auggy_coord_ns_history_bytes_check
      CHECK (max_history_snapshot_bytes IS NULL OR (max_history_snapshot_bytes >= 1024 AND max_history_snapshot_bytes <= 1048576)),
  ADD COLUMN max_history_messages INTEGER
    CONSTRAINT auggy_coord_ns_history_messages_check
      CHECK (max_history_messages IS NULL OR (max_history_messages >= 1 AND max_history_messages <= 10000)),
  ADD COLUMN max_history_threads INTEGER
    CONSTRAINT auggy_coord_ns_history_threads_check
      CHECK (max_history_threads IS NULL OR (max_history_threads >= 1 AND max_history_threads <= 1000000)),
  ADD COLUMN max_cost_markers_per_turn INTEGER
    CONSTRAINT auggy_coord_ns_cost_markers_check
      CHECK (max_cost_markers_per_turn IS NULL OR (max_cost_markers_per_turn >= 1 AND max_cost_markers_per_turn <= 1000)),
  ADD COLUMN max_outbox_intents_per_turn INTEGER
    CONSTRAINT auggy_coord_ns_outbox_intents_check
      CHECK (max_outbox_intents_per_turn IS NULL OR (max_outbox_intents_per_turn >= 0 AND max_outbox_intents_per_turn <= 1000)),
  ADD COLUMN max_outbox_intent_bytes INTEGER
    CONSTRAINT auggy_coord_ns_outbox_bytes_check
      CHECK (max_outbox_intent_bytes IS NULL OR (max_outbox_intent_bytes >= 1024 AND max_outbox_intent_bytes <= 1048576)),
  ADD COLUMN max_pending_outbox_intents INTEGER
    CONSTRAINT auggy_coord_ns_pending_outbox_check
      CHECK (max_pending_outbox_intents IS NULL OR (max_pending_outbox_intents >= 0 AND max_pending_outbox_intents <= 1000000));

ALTER TABLE auggy_coordination_requests
  ADD COLUMN history_binding_hash TEXT,
  ADD COLUMN history_revision BIGINT,
  ADD CONSTRAINT auggy_coord_request_history_claim_check CHECK (
    (history_binding_hash IS NULL AND history_revision IS NULL)
    OR
    (history_binding_hash ~ '^[0-9a-f]{64}$' AND history_revision >= 0)
  );

CREATE TABLE auggy_coordination_history (
  namespace TEXT NOT NULL,
  thread_id TEXT NOT NULL,
  peer_binding_hash TEXT NOT NULL
    CONSTRAINT auggy_coord_history_binding_check CHECK (peer_binding_hash ~ '^[0-9a-f]{64}$'),
  peer_id_hash TEXT
    CONSTRAINT auggy_coord_history_peer_check CHECK (peer_id_hash IS NULL OR peer_id_hash ~ '^[0-9a-f]{64}$'),
  promotion_scope_hash TEXT NOT NULL
    CONSTRAINT auggy_coord_history_scope_check CHECK (promotion_scope_hash ~ '^[0-9a-f]{64}$'),
  trust_level TEXT NOT NULL
    CONSTRAINT auggy_coord_history_trust_check CHECK (trust_level IN ('creator', 'agent', 'public')),
  public_substate TEXT
    CONSTRAINT auggy_coord_history_public_check CHECK (
      (trust_level = 'public' AND public_substate IN ('anonymous', 'recognized') AND peer_id_hash IS NOT NULL)
      OR
      (trust_level <> 'public' AND public_substate IS NULL)
    ),
  revision BIGINT NOT NULL DEFAULT 0
    CONSTRAINT auggy_coord_history_revision_check CHECK (revision >= 0),
  snapshot_version SMALLINT NOT NULL
    CONSTRAINT auggy_coord_history_version_check CHECK (snapshot_version = 1),
  snapshot_body BYTEA NOT NULL
    CONSTRAINT auggy_coord_history_body_check CHECK (octet_length(snapshot_body) <= 1048576),
  message_count INTEGER NOT NULL
    CONSTRAINT auggy_coord_history_messages_check CHECK (message_count >= 0 AND message_count <= 10000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, thread_id)
);

CREATE TABLE auggy_coordination_cost_markers (
  namespace TEXT NOT NULL,
  operation_id TEXT NOT NULL
    CONSTRAINT auggy_coord_cost_operation_check CHECK (operation_id ~ '^auggy-op-v1-[0-9a-f]{64}$'),
  request_id TEXT NOT NULL,
  fence BIGINT NOT NULL
    CONSTRAINT auggy_coord_cost_fence_check CHECK (fence > 0),
  marker_version SMALLINT NOT NULL
    CONSTRAINT auggy_coord_cost_version_check CHECK (marker_version = 1),
  priced BOOLEAN NOT NULL,
  cost_usd NUMERIC,
  unpriced_reason TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT auggy_coord_cost_value_check CHECK (
    (priced AND cost_usd IS NOT NULL AND cost_usd >= 0 AND unpriced_reason IS NULL)
    OR
    (NOT priced AND cost_usd IS NULL AND unpriced_reason IN ('missing-usage', 'missing-pricing'))
  ),
  PRIMARY KEY (namespace, operation_id)
);

CREATE INDEX auggy_coordination_cost_marker_request_idx
  ON auggy_coordination_cost_markers (namespace, request_id);

CREATE TABLE auggy_coordination_outbox (
  namespace TEXT NOT NULL,
  request_id TEXT NOT NULL,
  intent_ordinal INTEGER NOT NULL
    CONSTRAINT auggy_coord_outbox_ordinal_check CHECK (intent_ordinal >= 0),
  operation_id TEXT NOT NULL
    CONSTRAINT auggy_coord_outbox_operation_check CHECK (operation_id ~ '^auggy-op-v1-[0-9a-f]{64}$'),
  fence BIGINT NOT NULL
    CONSTRAINT auggy_coord_outbox_fence_check CHECK (fence > 0),
  intent_version SMALLINT NOT NULL
    CONSTRAINT auggy_coord_outbox_version_check CHECK (intent_version = 1),
  intent_body BYTEA NOT NULL
    CONSTRAINT auggy_coord_outbox_body_check CHECK (octet_length(intent_body) <= 1048576),
  intent_content_type TEXT NOT NULL
    CONSTRAINT auggy_coord_outbox_content_type_check CHECK (intent_content_type = 'application/json'),
  state TEXT NOT NULL DEFAULT 'pending'
    CONSTRAINT auggy_coord_outbox_state_check CHECK (state = 'pending'),
  created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, request_id, intent_ordinal)
);

CREATE UNIQUE INDEX auggy_coordination_outbox_operation_idx
  ON auggy_coordination_outbox (namespace, operation_id);
CREATE INDEX auggy_coordination_outbox_pending_idx
  ON auggy_coordination_outbox (namespace, state, created_at, request_id, intent_ordinal);
`;

const COORDINATION_ADMISSION_MIGRATION_SQL = `
ALTER TABLE auggy_coordination_namespaces
  ADD COLUMN max_rate_limit_events INTEGER,
  ADD COLUMN rate_policy_fingerprint TEXT,
  ADD CONSTRAINT auggy_coord_ns_admission_policy_check CHECK (
    (max_rate_limit_events IS NULL AND rate_policy_fingerprint IS NULL)
    OR
    (max_rate_limit_events >= 0
      AND max_rate_limit_events <= 1000000
      AND rate_policy_fingerprint ~ '^[0-9a-f]{64}$')
  );

ALTER TABLE auggy_coordination_requests
  ADD COLUMN admission_hash TEXT NOT NULL
    DEFAULT 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
    CONSTRAINT auggy_coord_request_admission_hash_check
      CHECK (admission_hash ~ '^[0-9a-f]{64}$'),
  ADD COLUMN capacity_class TEXT,
  ADD COLUMN capacity_partition_hash TEXT,
  ADD CONSTRAINT auggy_coord_request_capacity_check CHECK (
    (capacity_class IS NULL AND capacity_partition_hash IS NULL)
    OR
    (capacity_class ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'
      AND capacity_partition_hash ~ '^[0-9a-f]{64}$')
  );

CREATE INDEX auggy_coordination_request_capacity_class_idx
  ON auggy_coordination_requests (namespace, capacity_class, request_id);
CREATE INDEX auggy_coordination_request_capacity_partition_idx
  ON auggy_coordination_requests
    (namespace, capacity_class, capacity_partition_hash, request_id);

CREATE TABLE auggy_coordination_request_class_counters (
  namespace TEXT NOT NULL,
  capacity_class TEXT NOT NULL
    CONSTRAINT auggy_coord_request_class_counter_id_check
      CHECK (capacity_class ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  max_retained_requests INTEGER NOT NULL
    CONSTRAINT auggy_coord_request_class_counter_max_check
      CHECK (max_retained_requests >= 1 AND max_retained_requests <= 1000000),
  max_retained_per_partition INTEGER NOT NULL
    CONSTRAINT auggy_coord_request_class_counter_partition_max_check
      CHECK (max_retained_per_partition >= 1 AND max_retained_per_partition <= max_retained_requests),
  retained_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT auggy_coord_request_class_counter_count_check
      CHECK (retained_count >= 0 AND retained_count <= max_retained_requests),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, capacity_class)
);

CREATE TABLE auggy_coordination_request_partition_counters (
  namespace TEXT NOT NULL,
  capacity_class TEXT NOT NULL
    CONSTRAINT auggy_coord_request_partition_counter_id_check
      CHECK (capacity_class ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  partition_hash TEXT NOT NULL
    CONSTRAINT auggy_coord_request_partition_counter_hash_check
      CHECK (partition_hash ~ '^[0-9a-f]{64}$'),
  retained_count INTEGER NOT NULL
    CONSTRAINT auggy_coord_request_partition_counter_count_check
      CHECK (retained_count >= 0 AND retained_count <= 1000000),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, capacity_class, partition_hash)
);

CREATE TABLE auggy_coordination_rate_counters (
  namespace TEXT NOT NULL,
  policy_id TEXT NOT NULL
    CONSTRAINT auggy_coord_rate_counter_policy_check
      CHECK (policy_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  max_events INTEGER NOT NULL
    CONSTRAINT auggy_coord_rate_counter_max_check
      CHECK (max_events >= 1 AND max_events <= 1000000),
  event_count INTEGER NOT NULL DEFAULT 0
    CONSTRAINT auggy_coord_rate_counter_count_check
      CHECK (event_count >= 0 AND event_count <= max_events),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (namespace, policy_id)
);

CREATE TABLE auggy_coordination_rate_events (
  namespace TEXT NOT NULL,
  policy_id TEXT NOT NULL
    CONSTRAINT auggy_coord_rate_policy_check
      CHECK (policy_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  subject_hash TEXT NOT NULL
    CONSTRAINT auggy_coord_rate_subject_check CHECK (subject_hash ~ '^[0-9a-f]{64}$'),
  request_id TEXT NOT NULL
    CONSTRAINT auggy_coord_rate_request_check
      CHECK (request_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,159}$'),
  occurred_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT auggy_coord_rate_expiry_check CHECK (expires_at > occurred_at),
  PRIMARY KEY (namespace, policy_id, subject_hash, request_id)
);

CREATE INDEX auggy_coordination_rate_event_bucket_idx
  ON auggy_coordination_rate_events
    (namespace, policy_id, subject_hash, occurred_at, request_id);
CREATE INDEX auggy_coordination_rate_event_expiry_idx
  ON auggy_coordination_rate_events (namespace, expires_at, request_id);
CREATE INDEX auggy_coordination_rate_event_policy_expiry_idx
  ON auggy_coordination_rate_events
    (namespace, policy_id, expires_at, subject_hash, request_id);
CREATE INDEX auggy_coordination_rate_event_request_idx
  ON auggy_coordination_rate_events
    (namespace, request_id, policy_id, subject_hash, expires_at);
`;

/** Recomputed from immutable migration SQL; migration rejects any mismatch. */
export const postgresCoordinationMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(INITIAL_COORDINATION_MIGRATION_SQL)
  .digest("hex");

export const postgresCoordinationCompatibilityMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(COORDINATION_COMPATIBILITY_MIGRATION_SQL)
  .digest("hex");

export const postgresCoordinationLifecycleMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(COORDINATION_LIFECYCLE_MIGRATION_SQL)
  .digest("hex");

export const postgresCoordinationResultMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(COORDINATION_RESULT_MIGRATION_SQL)
  .digest("hex");

export const postgresCoordinationTurnStateMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(COORDINATION_TURN_STATE_MIGRATION_SQL)
  .digest("hex");

export const postgresCoordinationAdmissionMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(COORDINATION_ADMISSION_MIGRATION_SQL)
  .digest("hex");

export const POSTGRES_COORDINATION_MIGRATIONS = [
  {
    id: "20260724_01_distributed_turn_coordination",
    checksum: postgresCoordinationMigrationChecksum,
    sql: INITIAL_COORDINATION_MIGRATION_SQL,
  },
  {
    id: "20260726_02_coordination_compatibility_contract",
    checksum: postgresCoordinationCompatibilityMigrationChecksum,
    sql: COORDINATION_COMPATIBILITY_MIGRATION_SQL,
  },
  {
    id: "20260726_03_coordination_instance_lifecycle",
    checksum: postgresCoordinationLifecycleMigrationChecksum,
    sql: COORDINATION_LIFECYCLE_MIGRATION_SQL,
  },
  {
    id: "20260726_04_coordination_bounded_results",
    checksum: postgresCoordinationResultMigrationChecksum,
    sql: COORDINATION_RESULT_MIGRATION_SQL,
  },
  {
    id: "20260726_05_coordination_atomic_turn_state",
    checksum: postgresCoordinationTurnStateMigrationChecksum,
    sql: COORDINATION_TURN_STATE_MIGRATION_SQL,
  },
  {
    id: "20260726_06_coordination_atomic_admission",
    checksum: postgresCoordinationAdmissionMigrationChecksum,
    sql: COORDINATION_ADMISSION_MIGRATION_SQL,
  },
] as const;

export interface PostgresMigrationExecutor {
  begin<T>(callback: (transaction: PostgresMigrationExecutor) => Promise<T>): Promise<T>;
  unsafe<T extends object = Record<string, unknown>>(
    query: string,
    values?: unknown[],
  ): Promise<T[]>;
}

interface CoordinationCatalogColumn {
  table_name: string;
  column_name: string;
  data_type: string;
  not_null: boolean;
  default_expression: string | null;
  identity: string;
  generated: string;
  collation: string | null;
}

interface CoordinationCatalogIndex {
  table_name: string;
  index_name: string;
  is_unique: boolean;
  is_primary: boolean;
  columns: string;
  method: string;
  is_valid: boolean;
  is_ready: boolean;
  is_live: boolean;
  is_immediate: boolean;
  has_predicate: boolean;
  has_expressions: boolean;
  has_included_columns: boolean;
  opclasses: string;
  collations: string;
  options: string;
}

interface CoordinationCatalogCheck {
  table_name: string;
  constraint_name: string;
  definition: string;
  is_validated: boolean;
  is_enforced: boolean;
}

interface CoordinationCatalogConstraint {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  is_validated: boolean;
  is_enforced: boolean;
  is_deferrable: boolean;
  is_initially_deferred: boolean;
}

interface CoordinationCatalogNotNull {
  is_validated: boolean;
  is_enforced: boolean;
}

interface CoordinationCatalogTable {
  table_name: string;
  persistence: string;
  row_security: boolean;
  force_row_security: boolean;
  has_rules: boolean;
  has_triggers: boolean;
  has_inheritance: boolean;
}

interface CoordinationCatalogSequence {
  schema_name: string;
  sequence_name: string;
  data_type: string;
  start_value: string;
  minimum_value: string;
  maximum_value: string;
  increment_by: string;
  cache_size: string;
  cycles: boolean;
  same_owner: boolean;
  default_uses_sequence: boolean;
}

export interface PostgresMigrationOptions {
  /** Dedicated schema owned by Auggy coordination. Defaults to `public`. */
  schema?: string;
}

const EVENT_ID_SEQUENCE_DEFAULT = "event-id-owned-sequence";

const EXPECTED_COORDINATION_COLUMNS: readonly CoordinationCatalogColumn[] = [
  ["auggy_coordination_cost_markers", "cost_usd", "numeric", false, null],
  [
    "auggy_coordination_cost_markers",
    "created_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_cost_markers", "fence", "bigint", true, null],
  ["auggy_coordination_cost_markers", "marker_version", "smallint", true, null],
  ["auggy_coordination_cost_markers", "namespace", "text", true, null],
  ["auggy_coordination_cost_markers", "operation_id", "text", true, null],
  ["auggy_coordination_cost_markers", "priced", "boolean", true, null],
  ["auggy_coordination_cost_markers", "request_id", "text", true, null],
  ["auggy_coordination_cost_markers", "unpriced_reason", "text", false, null],
  [
    "auggy_coordination_events",
    "created_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_events", "event_id", "bigint", true, EVENT_ID_SEQUENCE_DEFAULT],
  ["auggy_coordination_events", "event_type", "text", true, null],
  ["auggy_coordination_events", "fence", "bigint", false, null],
  ["auggy_coordination_events", "namespace", "text", true, null],
  ["auggy_coordination_events", "reason", "text", false, null],
  ["auggy_coordination_events", "request_id", "text", false, null],
  ["auggy_coordination_events", "thread_id", "text", true, null],
  ["auggy_coordination_history", "message_count", "integer", true, null],
  ["auggy_coordination_history", "namespace", "text", true, null],
  ["auggy_coordination_history", "peer_binding_hash", "text", true, null],
  ["auggy_coordination_history", "peer_id_hash", "text", false, null],
  ["auggy_coordination_history", "promotion_scope_hash", "text", true, null],
  ["auggy_coordination_history", "public_substate", "text", false, null],
  ["auggy_coordination_history", "revision", "bigint", true, "0"],
  ["auggy_coordination_history", "snapshot_body", "bytea", true, null],
  ["auggy_coordination_history", "snapshot_version", "smallint", true, null],
  ["auggy_coordination_history", "thread_id", "text", true, null],
  ["auggy_coordination_history", "trust_level", "text", true, null],
  [
    "auggy_coordination_history",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_instances", "accepting", "boolean", true, "true"],
  ["auggy_coordination_instances", "build_fingerprint", "text", true, null],
  ["auggy_coordination_instances", "draining", "boolean", true, "false"],
  ["auggy_coordination_instances", "instance_id", "text", true, null],
  ["auggy_coordination_instances", "lease_expires_at", "timestamp with time zone", true, null],
  ["auggy_coordination_instances", "namespace", "text", true, null],
  [
    "auggy_coordination_instances",
    "registered_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_instances", "session_id", "text", true, null],
  [
    "auggy_coordination_instances",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  [
    "auggy_coordination_migrations",
    "applied_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_migrations", "checksum", "text", true, null],
  ["auggy_coordination_migrations", "id", "text", true, null],
  ["auggy_coordination_namespaces", "configuration_fingerprint", "text", true, null],
  ["auggy_coordination_namespaces", "event_retention_ms", "bigint", true, null],
  ["auggy_coordination_namespaces", "lease_ms", "bigint", false, null],
  ["auggy_coordination_namespaces", "max_concurrent", "integer", true, null],
  ["auggy_coordination_namespaces", "max_cost_markers_per_turn", "integer", false, null],
  ["auggy_coordination_namespaces", "max_events", "integer", true, null],
  ["auggy_coordination_namespaces", "max_history_messages", "integer", false, null],
  ["auggy_coordination_namespaces", "max_history_snapshot_bytes", "integer", false, null],
  ["auggy_coordination_namespaces", "max_history_threads", "integer", false, null],
  ["auggy_coordination_namespaces", "max_outbox_intent_bytes", "integer", false, null],
  ["auggy_coordination_namespaces", "max_outbox_intents_per_turn", "integer", false, null],
  ["auggy_coordination_namespaces", "max_pending_outbox_intents", "integer", false, null],
  ["auggy_coordination_namespaces", "max_queued", "integer", true, null],
  ["auggy_coordination_namespaces", "max_queued_per_thread", "integer", true, null],
  ["auggy_coordination_namespaces", "max_rate_limit_events", "integer", false, null],
  ["auggy_coordination_namespaces", "max_replay_bytes", "integer", true, null],
  ["auggy_coordination_namespaces", "max_terminal_requests", "integer", true, null],
  ["auggy_coordination_namespaces", "namespace", "text", true, null],
  ["auggy_coordination_namespaces", "next_fence", "bigint", true, "0"],
  ["auggy_coordination_namespaces", "protocol_fingerprint", "text", true, null],
  ["auggy_coordination_namespaces", "protocol_version", "integer", true, null],
  ["auggy_coordination_namespaces", "rate_policy_fingerprint", "text", false, null],
  ["auggy_coordination_namespaces", "terminal_request_retention_ms", "bigint", true, null],
  [
    "auggy_coordination_namespaces",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  [
    "auggy_coordination_outbox",
    "created_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_outbox", "fence", "bigint", true, null],
  ["auggy_coordination_outbox", "intent_body", "bytea", true, null],
  ["auggy_coordination_outbox", "intent_content_type", "text", true, null],
  ["auggy_coordination_outbox", "intent_ordinal", "integer", true, null],
  ["auggy_coordination_outbox", "intent_version", "smallint", true, null],
  ["auggy_coordination_outbox", "namespace", "text", true, null],
  ["auggy_coordination_outbox", "operation_id", "text", true, null],
  ["auggy_coordination_outbox", "request_id", "text", true, null],
  ["auggy_coordination_outbox", "state", "text", true, "'pending'::text"],
  [
    "auggy_coordination_outbox",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_rate_counters", "event_count", "integer", true, "0"],
  ["auggy_coordination_rate_counters", "max_events", "integer", true, null],
  ["auggy_coordination_rate_counters", "namespace", "text", true, null],
  ["auggy_coordination_rate_counters", "policy_id", "text", true, null],
  [
    "auggy_coordination_rate_counters",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_rate_events", "expires_at", "timestamp with time zone", true, null],
  ["auggy_coordination_rate_events", "namespace", "text", true, null],
  [
    "auggy_coordination_rate_events",
    "occurred_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_rate_events", "policy_id", "text", true, null],
  ["auggy_coordination_rate_events", "request_id", "text", true, null],
  ["auggy_coordination_rate_events", "subject_hash", "text", true, null],
  ["auggy_coordination_request_class_counters", "capacity_class", "text", true, null],
  [
    "auggy_coordination_request_class_counters",
    "max_retained_per_partition",
    "integer",
    true,
    null,
  ],
  ["auggy_coordination_request_class_counters", "max_retained_requests", "integer", true, null],
  ["auggy_coordination_request_class_counters", "namespace", "text", true, null],
  ["auggy_coordination_request_class_counters", "retained_count", "integer", true, "0"],
  [
    "auggy_coordination_request_class_counters",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_request_partition_counters", "capacity_class", "text", true, null],
  ["auggy_coordination_request_partition_counters", "namespace", "text", true, null],
  ["auggy_coordination_request_partition_counters", "partition_hash", "text", true, null],
  ["auggy_coordination_request_partition_counters", "retained_count", "integer", true, null],
  [
    "auggy_coordination_request_partition_counters",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  [
    "auggy_coordination_requests",
    "admission_hash",
    "text",
    true,
    "'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'::text",
  ],
  ["auggy_coordination_requests", "binding_hash", "text", true, null],
  ["auggy_coordination_requests", "capacity_class", "text", false, null],
  ["auggy_coordination_requests", "capacity_partition_hash", "text", false, null],
  ["auggy_coordination_requests", "execution_started_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "fence", "bigint", false, null],
  ["auggy_coordination_requests", "history_binding_hash", "text", false, null],
  ["auggy_coordination_requests", "history_revision", "bigint", false, null],
  ["auggy_coordination_requests", "lease_expires_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "namespace", "text", true, null],
  ["auggy_coordination_requests", "owner_instance", "text", false, null],
  ["auggy_coordination_requests", "owner_session", "text", false, null],
  ["auggy_coordination_requests", "queue_expires_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "queue_generation", "bigint", true, "0"],
  ["auggy_coordination_requests", "queue_owner_instance", "text", false, null],
  ["auggy_coordination_requests", "queue_owner_session", "text", false, null],
  [
    "auggy_coordination_requests",
    "queued_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_requests", "request_id", "text", true, null],
  ["auggy_coordination_requests", "result_body", "bytea", false, null],
  ["auggy_coordination_requests", "result_content_type", "text", false, null],
  ["auggy_coordination_requests", "result_version", "smallint", false, null],
  ["auggy_coordination_requests", "source_id", "text", true, null],
  ["auggy_coordination_requests", "state", "text", true, null],
  ["auggy_coordination_requests", "terminal_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "thread_id", "text", true, null],
  [
    "auggy_coordination_requests",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_sources", "max_concurrent", "integer", true, null],
  ["auggy_coordination_sources", "max_queued", "integer", true, null],
  ["auggy_coordination_sources", "namespace", "text", true, null],
  ["auggy_coordination_sources", "source_id", "text", true, null],
  [
    "auggy_coordination_sources",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_threads", "namespace", "text", true, null],
  ["auggy_coordination_threads", "next_fence", "bigint", true, "0"],
  ["auggy_coordination_threads", "quarantine_fence", "bigint", false, null],
  ["auggy_coordination_threads", "quarantined", "boolean", true, "false"],
  ["auggy_coordination_threads", "thread_id", "text", true, null],
  [
    "auggy_coordination_threads",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
].map(([table_name, column_name, data_type, not_null, default_expression]) => ({
  table_name: table_name as string,
  column_name: column_name as string,
  data_type: data_type as string,
  not_null: not_null as boolean,
  default_expression: default_expression as string | null,
  identity: "",
  generated: "",
  collation: data_type === "text" ? "pg_catalog.default" : null,
}));

const EXPECTED_COORDINATION_INDEXES: readonly CoordinationCatalogIndex[] = [
  [
    "auggy_coordination_cost_markers",
    "auggy_coordination_cost_marker_request_idx",
    false,
    false,
    "namespace,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_cost_markers",
    "auggy_coordination_cost_markers_pkey",
    true,
    true,
    "namespace,operation_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_events",
    "auggy_coordination_events_pkey",
    true,
    true,
    "event_id",
    "pg_catalog.int8_ops",
    "-",
  ],
  [
    "auggy_coordination_history",
    "auggy_coordination_history_pkey",
    true,
    true,
    "namespace,thread_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_instances",
    "auggy_coordination_instance_lease_idx",
    false,
    false,
    "namespace,lease_expires_at,instance_id",
    "pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_instances",
    "auggy_coordination_instances_pkey",
    true,
    true,
    "namespace,instance_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_migrations",
    "auggy_coordination_migrations_pkey",
    true,
    true,
    "id",
    "pg_catalog.text_ops",
    "pg_catalog.default",
  ],
  [
    "auggy_coordination_namespaces",
    "auggy_coordination_namespaces_pkey",
    true,
    true,
    "namespace",
    "pg_catalog.text_ops",
    "pg_catalog.default",
  ],
  [
    "auggy_coordination_outbox",
    "auggy_coordination_outbox_operation_idx",
    true,
    false,
    "namespace,operation_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_outbox",
    "auggy_coordination_outbox_pending_idx",
    false,
    false,
    "namespace,state,created_at,request_id,intent_ordinal",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops,pg_catalog.int4_ops",
    "pg_catalog.default,pg_catalog.default,-,pg_catalog.default,-",
  ],
  [
    "auggy_coordination_outbox",
    "auggy_coordination_outbox_pkey",
    true,
    true,
    "namespace,request_id,intent_ordinal",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.int4_ops",
    "pg_catalog.default,pg_catalog.default,-",
  ],
  [
    "auggy_coordination_rate_counters",
    "auggy_coordination_rate_counters_pkey",
    true,
    true,
    "namespace,policy_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_rate_events",
    "auggy_coordination_rate_event_bucket_idx",
    false,
    false,
    "namespace,policy_id,subject_hash,occurred_at,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_rate_events",
    "auggy_coordination_rate_event_expiry_idx",
    false,
    false,
    "namespace,expires_at,request_id",
    "pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_rate_events",
    "auggy_coordination_rate_event_policy_expiry_idx",
    false,
    false,
    "namespace,policy_id,expires_at,subject_hash,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,-,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_rate_events",
    "auggy_coordination_rate_event_request_idx",
    false,
    false,
    "namespace,request_id,policy_id,subject_hash,expires_at",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default,pg_catalog.default,-",
  ],
  [
    "auggy_coordination_rate_events",
    "auggy_coordination_rate_events_pkey",
    true,
    true,
    "namespace,policy_id,subject_hash,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_request_class_counters",
    "auggy_coordination_request_class_counters_pkey",
    true,
    true,
    "namespace,capacity_class",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_request_partition_counters",
    "auggy_coordination_request_partition_counters_pkey",
    true,
    true,
    "namespace,capacity_class,partition_hash",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_capacity_class_idx",
    false,
    false,
    "namespace,capacity_class,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_capacity_partition_idx",
    false,
    false,
    "namespace,capacity_class,capacity_partition_hash,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_queue_idx",
    false,
    false,
    "namespace,state,queued_at,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_queue_lease_idx",
    false,
    false,
    "namespace,state,queue_expires_at,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_source_idx",
    false,
    false,
    "namespace,source_id,state",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_terminal_idx",
    false,
    false,
    "namespace,state,terminal_at,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.timestamptz_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,-,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_request_thread_idx",
    false,
    false,
    "namespace,thread_id,state",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_requests",
    "auggy_coordination_requests_pkey",
    true,
    true,
    "namespace,request_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_sources",
    "auggy_coordination_sources_pkey",
    true,
    true,
    "namespace,source_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
  [
    "auggy_coordination_threads",
    "auggy_coordination_threads_pkey",
    true,
    true,
    "namespace,thread_id",
    "pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default",
  ],
].map(([table_name, index_name, is_unique, is_primary, columns, opclasses, collations]) => ({
  table_name: table_name as string,
  index_name: index_name as string,
  is_unique: is_unique as boolean,
  is_primary: is_primary as boolean,
  columns: columns as string,
  method: "btree",
  is_valid: true,
  is_ready: true,
  is_live: true,
  is_immediate: true,
  has_predicate: false,
  has_expressions: false,
  has_included_columns: false,
  opclasses: opclasses as string,
  collations: collations as string,
  options: (columns as string)
    .split(",")
    .map(() => "0")
    .join(","),
}));

const EXPECTED_COORDINATION_CHECKS = new Map<string, { table: string; definition: string }>([
  [
    "auggy_coord_cost_fence_check",
    { table: "auggy_coordination_cost_markers", definition: "checkfence>0" },
  ],
  [
    "auggy_coord_cost_operation_check",
    {
      table: "auggy_coordination_cost_markers",
      definition: "checkoperation_id~'^auggy-op-v1-[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_cost_value_check",
    {
      table: "auggy_coordination_cost_markers",
      definition:
        "checkpricedandcost_usdisnotnullandcost_usd>=0::numericandunpriced_reasonisnullornotpricedandcost_usdisnullandunpriced_reason=anyarray['missing-usage','missing-pricing']",
    },
  ],
  [
    "auggy_coord_cost_version_check",
    { table: "auggy_coordination_cost_markers", definition: "checkmarker_version=1" },
  ],
  [
    "auggy_coord_event_reason_check",
    {
      table: "auggy_coordination_events",
      definition: "checkreasonisnullorreason~'^[a-z0-9][a-z0-9._:-]{0,63}$'",
    },
  ],
  [
    "auggy_coord_event_type_check",
    {
      table: "auggy_coordination_events",
      definition: "checkevent_type~'^[a-z0-9][a-z0-9._:-]{0,63}$'",
    },
  ],
  [
    "auggy_coord_instance_build_check",
    {
      table: "auggy_coordination_instances",
      definition: "checkbuild_fingerprint~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_instance_lifecycle_check",
    {
      table: "auggy_coordination_instances",
      definition: "checkacceptingandnotdrainingornotacceptinganddraining",
    },
  ],
  [
    "auggy_coord_instance_session_check",
    {
      table: "auggy_coordination_instances",
      definition: "checksession_id~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_history_binding_check",
    {
      table: "auggy_coordination_history",
      definition: "checkpeer_binding_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_history_body_check",
    {
      table: "auggy_coordination_history",
      definition: "checkoctet_lengthsnapshot_body<=1048576",
    },
  ],
  [
    "auggy_coord_history_messages_check",
    {
      table: "auggy_coordination_history",
      definition: "checkmessage_count>=0andmessage_count<=10000",
    },
  ],
  [
    "auggy_coord_history_peer_check",
    {
      table: "auggy_coordination_history",
      definition: "checkpeer_id_hashisnullorpeer_id_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_history_public_check",
    {
      table: "auggy_coordination_history",
      definition:
        "checktrust_level='public'andpublic_substate=anyarray['anonymous','recognized']andpeer_id_hashisnotnullortrust_level<>'public'andpublic_substateisnull",
    },
  ],
  [
    "auggy_coord_history_revision_check",
    { table: "auggy_coordination_history", definition: "checkrevision>=0" },
  ],
  [
    "auggy_coord_history_scope_check",
    {
      table: "auggy_coordination_history",
      definition: "checkpromotion_scope_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_history_trust_check",
    {
      table: "auggy_coordination_history",
      definition: "checktrust_level=anyarray['creator','agent','public']",
    },
  ],
  [
    "auggy_coord_history_version_check",
    { table: "auggy_coordination_history", definition: "checksnapshot_version=1" },
  ],
  [
    "auggy_coord_ns_admission_policy_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_rate_limit_eventsisnullandrate_policy_fingerprintisnullormax_rate_limit_events>=0andmax_rate_limit_events<=1000000andrate_policy_fingerprint~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_ns_config_fingerprint_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkconfiguration_fingerprint~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_ns_event_retention_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkevent_retention_ms>=60000andevent_retention_ms<=31536000000",
    },
  ],
  [
    "auggy_coord_ns_cost_markers_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_cost_markers_per_turnisnullormax_cost_markers_per_turn>=1andmax_cost_markers_per_turn<=1000",
    },
  ],
  [
    "auggy_coord_ns_history_bytes_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_history_snapshot_bytesisnullormax_history_snapshot_bytes>=1024andmax_history_snapshot_bytes<=1048576",
    },
  ],
  [
    "auggy_coord_ns_history_messages_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_history_messagesisnullormax_history_messages>=1andmax_history_messages<=10000",
    },
  ],
  [
    "auggy_coord_ns_history_threads_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_history_threadsisnullormax_history_threads>=1andmax_history_threads<=1000000",
    },
  ],
  [
    "auggy_coord_ns_lease_ms_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checklease_msisnullorlease_ms>=1andlease_ms<=3600000",
    },
  ],
  [
    "auggy_coord_ns_max_events_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkmax_events>=1andmax_events<=1000000",
    },
  ],
  [
    "auggy_coord_ns_max_terminal_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkmax_terminal_requests>=1andmax_terminal_requests<=1000000",
    },
  ],
  [
    "auggy_coord_ns_next_fence_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checknext_fence>=0",
    },
  ],
  [
    "auggy_coord_ns_outbox_bytes_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_outbox_intent_bytesisnullormax_outbox_intent_bytes>=1024andmax_outbox_intent_bytes<=1048576",
    },
  ],
  [
    "auggy_coord_ns_outbox_intents_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_outbox_intents_per_turnisnullormax_outbox_intents_per_turn>=0andmax_outbox_intents_per_turn<=1000",
    },
  ],
  [
    "auggy_coord_ns_pending_outbox_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkmax_pending_outbox_intentsisnullormax_pending_outbox_intents>=0andmax_pending_outbox_intents<=1000000",
    },
  ],
  [
    "auggy_coord_ns_protocol_fingerprint_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkprotocol_fingerprint~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_ns_protocol_version_check",
    { table: "auggy_coordination_namespaces", definition: "checkprotocol_version>0" },
  ],
  [
    "auggy_coord_ns_replay_bytes_check",
    {
      table: "auggy_coordination_namespaces",
      definition: "checkmax_replay_bytes>=1024andmax_replay_bytes<=1048576",
    },
  ],
  [
    "auggy_coord_ns_terminal_retention_check",
    {
      table: "auggy_coordination_namespaces",
      definition:
        "checkterminal_request_retention_ms>=60000andterminal_request_retention_ms<=31536000000",
    },
  ],
  [
    "auggy_coordination_namespaces_max_concurrent_check",
    { table: "auggy_coordination_namespaces", definition: "checkmax_concurrent>0" },
  ],
  [
    "auggy_coordination_namespaces_max_queued_check",
    { table: "auggy_coordination_namespaces", definition: "checkmax_queued>=0" },
  ],
  [
    "auggy_coordination_namespaces_max_queued_per_thread_check",
    { table: "auggy_coordination_namespaces", definition: "checkmax_queued_per_thread>=0" },
  ],
  [
    "auggy_coord_rate_counter_count_check",
    {
      table: "auggy_coordination_rate_counters",
      definition: "checkevent_count>=0andevent_count<=max_events",
    },
  ],
  [
    "auggy_coord_rate_counter_max_check",
    {
      table: "auggy_coordination_rate_counters",
      definition: "checkmax_events>=1andmax_events<=1000000",
    },
  ],
  [
    "auggy_coord_rate_counter_policy_check",
    {
      table: "auggy_coordination_rate_counters",
      definition: "checkpolicy_id~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'",
    },
  ],
  [
    "auggy_coord_rate_expiry_check",
    {
      table: "auggy_coordination_rate_events",
      definition: "checkexpires_at>occurred_at",
    },
  ],
  [
    "auggy_coord_rate_policy_check",
    {
      table: "auggy_coordination_rate_events",
      definition: "checkpolicy_id~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'",
    },
  ],
  [
    "auggy_coord_rate_request_check",
    {
      table: "auggy_coordination_rate_events",
      definition: "checkrequest_id~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'",
    },
  ],
  [
    "auggy_coord_rate_subject_check",
    {
      table: "auggy_coordination_rate_events",
      definition: "checksubject_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_request_class_counter_count_check",
    {
      table: "auggy_coordination_request_class_counters",
      definition: "checkretained_count>=0andretained_count<=max_retained_requests",
    },
  ],
  [
    "auggy_coord_request_class_counter_id_check",
    {
      table: "auggy_coordination_request_class_counters",
      definition: "checkcapacity_class~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'",
    },
  ],
  [
    "auggy_coord_request_class_counter_max_check",
    {
      table: "auggy_coordination_request_class_counters",
      definition: "checkmax_retained_requests>=1andmax_retained_requests<=1000000",
    },
  ],
  [
    "auggy_coord_request_class_counter_partition_max_check",
    {
      table: "auggy_coordination_request_class_counters",
      definition:
        "checkmax_retained_per_partition>=1andmax_retained_per_partition<=max_retained_requests",
    },
  ],
  [
    "auggy_coord_request_partition_counter_count_check",
    {
      table: "auggy_coordination_request_partition_counters",
      definition: "checkretained_count>=0andretained_count<=1000000",
    },
  ],
  [
    "auggy_coord_request_partition_counter_hash_check",
    {
      table: "auggy_coordination_request_partition_counters",
      definition: "checkpartition_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_request_partition_counter_id_check",
    {
      table: "auggy_coordination_request_partition_counters",
      definition: "checkcapacity_class~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'",
    },
  ],
  [
    "auggy_coord_request_admission_hash_check",
    {
      table: "auggy_coordination_requests",
      definition: "checkadmission_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_request_capacity_check",
    {
      table: "auggy_coordination_requests",
      definition:
        "checkcapacity_classisnullandcapacity_partition_hashisnullorcapacity_class~'^[a-za-z0-9][a-za-z0-9._:-]{0,159}$'andcapacity_partition_hash~'^[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_request_lifecycle_check",
    {
      table: "auggy_coordination_requests",
      definition:
        "checkstate='queued'andqueue_owner_instanceisnotnullandqueue_owner_sessionisnotnullandqueue_generation>0andqueue_expires_atisnotnullandfenceisnullandowner_instanceisnullandowner_sessionisnullandlease_expires_atisnullandterminal_atisnullorstate='active'andfenceisnotnullandowner_instanceisnotnullandowner_sessionisnotnullandlease_expires_atisnotnullandqueue_owner_instanceisnullandqueue_owner_sessionisnullandqueue_expires_atisnullandterminal_atisnullorstate=anyarray['completed','failed','canceled','outcome_unknown']andterminal_atisnotnullandowner_instanceisnullandowner_sessionisnullandlease_expires_atisnullandqueue_owner_instanceisnullandqueue_owner_sessionisnullandqueue_expires_atisnull",
    },
  ],
  [
    "auggy_coord_request_history_claim_check",
    {
      table: "auggy_coordination_requests",
      definition:
        "checkhistory_binding_hashisnullandhistory_revisionisnullorhistory_binding_hash~'^[0-9a-f]{64}$'andhistory_revision>=0",
    },
  ],
  [
    "auggy_coord_request_queue_generation_check",
    {
      table: "auggy_coordination_requests",
      definition: "checkqueue_generation>=0",
    },
  ],
  [
    "auggy_coord_request_result_check",
    {
      table: "auggy_coordination_requests",
      definition:
        "checkresult_bodyisnullandresult_content_typeisnullandresult_versionisnullorstate='completed'andresult_bodyisnotnullandresult_content_type='application/json'andresult_version=1andoctet_lengthresult_body<=1048576",
    },
  ],
  [
    "auggy_coord_request_result_version_check",
    {
      table: "auggy_coordination_requests",
      definition: "checkresult_versionisnullorresult_version=1",
    },
  ],
  [
    "auggy_coordination_requests_state_check",
    {
      table: "auggy_coordination_requests",
      definition:
        "checkstate=anyarray['queued','active','completed','failed','canceled','outcome_unknown']",
    },
  ],
  [
    "auggy_coord_outbox_body_check",
    {
      table: "auggy_coordination_outbox",
      definition: "checkoctet_lengthintent_body<=1048576",
    },
  ],
  [
    "auggy_coord_outbox_content_type_check",
    {
      table: "auggy_coordination_outbox",
      definition: "checkintent_content_type='application/json'",
    },
  ],
  [
    "auggy_coord_outbox_fence_check",
    { table: "auggy_coordination_outbox", definition: "checkfence>0" },
  ],
  [
    "auggy_coord_outbox_operation_check",
    {
      table: "auggy_coordination_outbox",
      definition: "checkoperation_id~'^auggy-op-v1-[0-9a-f]{64}$'",
    },
  ],
  [
    "auggy_coord_outbox_ordinal_check",
    { table: "auggy_coordination_outbox", definition: "checkintent_ordinal>=0" },
  ],
  [
    "auggy_coord_outbox_state_check",
    { table: "auggy_coordination_outbox", definition: "checkstate='pending'" },
  ],
  [
    "auggy_coord_outbox_version_check",
    { table: "auggy_coordination_outbox", definition: "checkintent_version=1" },
  ],
  [
    "auggy_coordination_sources_max_concurrent_check",
    { table: "auggy_coordination_sources", definition: "checkmax_concurrent>0" },
  ],
  [
    "auggy_coordination_sources_max_queued_check",
    { table: "auggy_coordination_sources", definition: "checkmax_queued>=0" },
  ],
]);

const EXPECTED_COORDINATION_CONSTRAINTS: readonly CoordinationCatalogConstraint[] = [
  ["auggy_coordination_cost_markers", "auggy_coordination_cost_markers_pkey"],
  ["auggy_coordination_events", "auggy_coordination_events_pkey"],
  ["auggy_coordination_history", "auggy_coordination_history_pkey"],
  ["auggy_coordination_instances", "auggy_coordination_instances_pkey"],
  ["auggy_coordination_migrations", "auggy_coordination_migrations_pkey"],
  ["auggy_coordination_namespaces", "auggy_coordination_namespaces_pkey"],
  ["auggy_coordination_outbox", "auggy_coordination_outbox_pkey"],
  ["auggy_coordination_rate_counters", "auggy_coordination_rate_counters_pkey"],
  ["auggy_coordination_rate_events", "auggy_coordination_rate_events_pkey"],
  ["auggy_coordination_request_class_counters", "auggy_coordination_request_class_counters_pkey"],
  [
    "auggy_coordination_request_partition_counters",
    "auggy_coordination_request_partition_counters_pkey",
  ],
  ["auggy_coordination_requests", "auggy_coordination_requests_pkey"],
  ["auggy_coordination_sources", "auggy_coordination_sources_pkey"],
  ["auggy_coordination_threads", "auggy_coordination_threads_pkey"],
].map(([table_name, constraint_name]) => ({
  table_name: table_name as string,
  constraint_name: constraint_name as string,
  constraint_type: "p",
  is_validated: true,
  is_enforced: true,
  is_deferrable: false,
  is_initially_deferred: false,
}));

const EXPECTED_COORDINATION_TABLES: readonly CoordinationCatalogTable[] = [
  "auggy_coordination_cost_markers",
  "auggy_coordination_events",
  "auggy_coordination_history",
  "auggy_coordination_instances",
  "auggy_coordination_migrations",
  "auggy_coordination_namespaces",
  "auggy_coordination_outbox",
  "auggy_coordination_rate_counters",
  "auggy_coordination_rate_events",
  "auggy_coordination_request_class_counters",
  "auggy_coordination_request_partition_counters",
  "auggy_coordination_requests",
  "auggy_coordination_sources",
  "auggy_coordination_threads",
].map((table_name) => ({
  table_name,
  persistence: "p",
  row_security: false,
  force_row_security: false,
  has_rules: false,
  has_triggers: false,
  has_inheritance: false,
}));

function incompatibleSchema(): Error {
  return new Error("coordination schema is incompatible with this Auggy version");
}

function catalogMatches<T>(actual: readonly T[], expected: readonly T[]): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

function normalizedCheck(value: string): string {
  return value.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ").trim();
}

function compactCheck(value: string): string {
  return normalizedCheck(value)
    .replaceAll("::text", "")
    .replace(/'([0-9]+)'::bigint/g, "$1")
    .replace(/[()\s]/g, "");
}

function normalizedDefault(row: CoordinationCatalogColumn): string | null {
  if (row.default_expression === null) return null;
  const value = row.default_expression.toLowerCase().replaceAll('"', "").trim();
  if (row.table_name === "auggy_coordination_events" && row.column_name === "event_id") {
    if (
      /^nextval\('[a-z0-9_]*(?:\.)?auggy_coordination_events_event_id_seq'::regclass\)$/.test(value)
    ) {
      return EVENT_ID_SEQUENCE_DEFAULT;
    }
  }
  return value;
}

function validCoordinationColumns(rows: readonly CoordinationCatalogColumn[]): boolean {
  return catalogMatches(
    rows.map((row) => ({ ...row, default_expression: normalizedDefault(row) })),
    EXPECTED_COORDINATION_COLUMNS,
  );
}

function validCoordinationChecks(rows: readonly CoordinationCatalogCheck[]): boolean {
  if (rows.length !== EXPECTED_COORDINATION_CHECKS.size) return false;
  return rows.every((row) => {
    const expected = EXPECTED_COORDINATION_CHECKS.get(row.constraint_name);
    return (
      row.is_validated &&
      row.is_enforced &&
      expected?.table === row.table_name &&
      expected.definition === compactCheck(row.definition)
    );
  });
}

async function assertPostgresCoordinationSchema(
  sql: PostgresMigrationExecutor,
  expectedSchema: string,
): Promise<void> {
  const tables =
    "'auggy_coordination_cost_markers', 'auggy_coordination_events', " +
    "'auggy_coordination_history', 'auggy_coordination_instances', " +
    "'auggy_coordination_migrations', 'auggy_coordination_namespaces', " +
    "'auggy_coordination_outbox', 'auggy_coordination_rate_counters', " +
    "'auggy_coordination_rate_events', " +
    "'auggy_coordination_request_class_counters', " +
    "'auggy_coordination_request_partition_counters', " +
    "'auggy_coordination_requests', " +
    "'auggy_coordination_sources', " +
    "'auggy_coordination_threads'";
  const columns = await sql.unsafe<CoordinationCatalogColumn>(`
    SELECT cls.relname AS table_name,
           attr.attname AS column_name,
           format_type(attr.atttypid, attr.atttypmod) AS data_type,
           attr.attnotnull AS not_null,
           pg_get_expr(defaults.adbin, defaults.adrelid) AS default_expression,
           attr.attidentity AS identity,
           attr.attgenerated AS generated,
           CASE WHEN attr.attcollation = 0 THEN NULL
                ELSE collation_namespace.nspname || '.' || collation_catalog.collname
            END AS collation
      FROM pg_class cls
      JOIN pg_namespace namespace ON namespace.oid = cls.relnamespace
      JOIN pg_attribute attr ON attr.attrelid = cls.oid
      LEFT JOIN pg_attrdef defaults
        ON defaults.adrelid = cls.oid AND defaults.adnum = attr.attnum
      LEFT JOIN pg_collation collation_catalog ON collation_catalog.oid = attr.attcollation
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = collation_catalog.collnamespace
     WHERE namespace.nspname = current_schema()
       AND cls.relkind = 'r'
       AND cls.relname IN (${tables})
       AND attr.attnum > 0
       AND NOT attr.attisdropped
     ORDER BY cls.relname, attr.attname
  `);
  if (!validCoordinationColumns(columns)) throw incompatibleSchema();

  // relhastriggers may remain true after the final trigger is dropped, so
  // validate the authoritative trigger catalog instead of the cached hint.
  const tableCatalog = await sql.unsafe<CoordinationCatalogTable>(`
    SELECT cls.relname AS table_name,
           cls.relpersistence AS persistence,
           cls.relrowsecurity AS row_security,
           cls.relforcerowsecurity AS force_row_security,
           cls.relhasrules AS has_rules,
           EXISTS (
             SELECT 1
               FROM pg_trigger trigger_catalog
              WHERE trigger_catalog.tgrelid = cls.oid
           ) AS has_triggers,
           EXISTS (
             SELECT 1
               FROM pg_inherits inheritance_catalog
              WHERE inheritance_catalog.inhparent = cls.oid
                 OR inheritance_catalog.inhrelid = cls.oid
           ) AS has_inheritance
      FROM pg_class cls
      JOIN pg_namespace namespace ON namespace.oid = cls.relnamespace
     WHERE namespace.nspname = current_schema()
       AND cls.relkind = 'r'
       AND cls.relname IN (${tables})
     ORDER BY cls.relname
  `);
  if (!catalogMatches(tableCatalog, EXPECTED_COORDINATION_TABLES)) throw incompatibleSchema();

  const indexes = await sql.unsafe<CoordinationCatalogIndex>(`
    SELECT table_class.relname AS table_name,
           index_class.relname AS index_name,
           idx.indisunique AS is_unique,
           idx.indisprimary AS is_primary,
           string_agg(attribute.attname, ',' ORDER BY key.ordinality) AS columns,
           access_method.amname AS method,
           idx.indisvalid AS is_valid,
           idx.indisready AS is_ready,
           idx.indislive AS is_live,
           idx.indimmediate AS is_immediate,
           idx.indpred IS NOT NULL AS has_predicate,
           idx.indexprs IS NOT NULL AS has_expressions,
           idx.indnkeyatts <> idx.indnatts AS has_included_columns,
           string_agg(opclass_namespace.nspname || '.' || opclass.opcname, ',' ORDER BY key.ordinality) AS opclasses,
           string_agg(CASE WHEN key.collation_oid = 0 THEN '-'
                           ELSE collation_namespace.nspname || '.' || collation_catalog.collname
                       END, ',' ORDER BY key.ordinality) AS collations,
           string_agg(key.option_bits::text, ',' ORDER BY key.ordinality) AS options
      FROM pg_index idx
      JOIN pg_class table_class ON table_class.oid = idx.indrelid
      JOIN pg_class index_class ON index_class.oid = idx.indexrelid
      JOIN pg_am access_method ON access_method.oid = index_class.relam
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
      LEFT JOIN LATERAL
        unnest(idx.indkey, idx.indcollation, idx.indclass, idx.indoption)
          WITH ORDINALITY AS key(attnum, collation_oid, opclass_oid, option_bits, ordinality)
        ON TRUE
      LEFT JOIN pg_attribute attribute
        ON attribute.attrelid = table_class.oid AND attribute.attnum = key.attnum
      LEFT JOIN pg_opclass opclass ON opclass.oid = key.opclass_oid
      LEFT JOIN pg_namespace opclass_namespace ON opclass_namespace.oid = opclass.opcnamespace
      LEFT JOIN pg_collation collation_catalog ON collation_catalog.oid = key.collation_oid
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = collation_catalog.collnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
     GROUP BY table_class.relname,
              index_class.relname,
              idx.indisunique,
              idx.indisprimary,
              access_method.amname,
              idx.indisvalid,
              idx.indisready,
              idx.indislive,
              idx.indimmediate,
              idx.indpred,
              idx.indexprs,
              idx.indnkeyatts,
              idx.indnatts
     ORDER BY table_class.relname, index_class.relname
  `);
  if (!catalogMatches(indexes, EXPECTED_COORDINATION_INDEXES)) throw incompatibleSchema();

  const checks = await sql.unsafe<CoordinationCatalogCheck>(`
    SELECT table_class.relname AS table_name,
           con.conname AS constraint_name,
           pg_get_constraintdef(con.oid, true) AS definition,
           con.convalidated AS is_validated,
           COALESCE((to_jsonb(con)->>'conenforced')::boolean, true) AS is_enforced
      FROM pg_constraint con
      JOIN pg_class table_class ON table_class.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
       AND con.contype = 'c'
     ORDER BY table_class.relname, con.conname
  `);
  if (!validCoordinationChecks(checks)) throw incompatibleSchema();

  // PostgreSQL 18 exposes NOT NULL constraints here as type `n`. The
  // pg_attribute flag above can also describe an invalid NOT NULL constraint,
  // so separately require every catalog constraint to be active.
  const notNulls = await sql.unsafe<CoordinationCatalogNotNull>(`
    SELECT con.convalidated AS is_validated,
           COALESCE((to_jsonb(con)->>'conenforced')::boolean, true) AS is_enforced
      FROM pg_constraint con
      JOIN pg_class table_class ON table_class.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
       AND con.contype = 'n'
  `);
  if (notNulls.some((constraint) => !constraint.is_validated || !constraint.is_enforced)) {
    throw incompatibleSchema();
  }

  const constraints = await sql.unsafe<CoordinationCatalogConstraint>(`
    SELECT table_class.relname AS table_name,
           con.conname AS constraint_name,
           con.contype AS constraint_type,
           con.convalidated AS is_validated,
           COALESCE((to_jsonb(con)->>'conenforced')::boolean, true) AS is_enforced,
           con.condeferrable AS is_deferrable,
           con.condeferred AS is_initially_deferred
      FROM pg_constraint con
      JOIN pg_class table_class ON table_class.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
       AND con.contype NOT IN ('c', 'n')
     ORDER BY table_class.relname, con.conname
  `);
  if (!catalogMatches(constraints, EXPECTED_COORDINATION_CONSTRAINTS)) {
    throw incompatibleSchema();
  }

  const sequence = await sql.unsafe<CoordinationCatalogSequence>(`
    SELECT sequence_namespace.nspname AS schema_name,
           sequence.relname AS sequence_name,
           sequence_type.typname AS data_type,
           parameters.seqstart::text AS start_value,
           parameters.seqmin::text AS minimum_value,
           parameters.seqmax::text AS maximum_value,
           parameters.seqincrement::text AS increment_by,
           parameters.seqcache::text AS cache_size,
           parameters.seqcycle AS cycles,
           sequence.relowner = table_class.relowner AS same_owner,
           EXISTS (
             SELECT 1
               FROM pg_depend default_dependency
              WHERE default_dependency.classid = 'pg_attrdef'::regclass
                AND default_dependency.objid = defaults.oid
                AND default_dependency.refclassid = 'pg_class'::regclass
                AND default_dependency.refobjid = sequence.oid
           ) AS default_uses_sequence
      FROM pg_class table_class
      JOIN pg_namespace table_namespace ON table_namespace.oid = table_class.relnamespace
      JOIN pg_attribute attribute
        ON attribute.attrelid = table_class.oid AND attribute.attname = 'event_id'
      JOIN pg_attrdef defaults
        ON defaults.adrelid = table_class.oid AND defaults.adnum = attribute.attnum
      JOIN pg_depend ownership
        ON ownership.classid = 'pg_class'::regclass
       AND ownership.refclassid = 'pg_class'::regclass
       AND ownership.refobjid = table_class.oid
       AND ownership.refobjsubid = attribute.attnum
       AND ownership.deptype IN ('a', 'i')
      JOIN pg_class sequence ON sequence.oid = ownership.objid AND sequence.relkind = 'S'
      JOIN pg_namespace sequence_namespace ON sequence_namespace.oid = sequence.relnamespace
      JOIN pg_sequence parameters ON parameters.seqrelid = sequence.oid
      JOIN pg_type sequence_type ON sequence_type.oid = parameters.seqtypid
     WHERE table_namespace.nspname = current_schema()
       AND table_class.relname = 'auggy_coordination_events'
  `);
  if (
    !catalogMatches(sequence, [
      {
        schema_name: expectedSchema,
        sequence_name: "auggy_coordination_events_event_id_seq",
        data_type: "int8",
        start_value: "1",
        minimum_value: "1",
        maximum_value: "9223372036854775807",
        increment_by: "1",
        cache_size: "1",
        cycles: false,
        same_owner: true,
        default_uses_sequence: true,
      },
    ])
  ) {
    throw incompatibleSchema();
  }
}

/** Apply checked, idempotent migrations. It intentionally performs no DDL until called. */
export async function migratePostgresCoordinator(
  sql: PostgresMigrationExecutor,
  options: PostgresMigrationOptions = {},
): Promise<void> {
  const schema = options.schema ?? "public";
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(schema)) {
    throw new Error("coordination schema must be a lowercase PostgreSQL identifier");
  }
  await sql.begin(async (tx) => {
    // Omitting pg_catalog keeps its implicit precedence over the owned schema.
    // Explicitly placing pg_temp last prevents a session-local relation from
    // receiving its usual implicit precedence over the real system catalogs.
    await tx.unsafe(`SET LOCAL search_path TO "${schema}", pg_temp`);
    await tx.unsafe(
      "SELECT pg_advisory_xact_lock(hashtextextended('auggy_coordination_migrations', 0))",
    );
    await tx.unsafe(
      "CREATE TABLE IF NOT EXISTS auggy_coordination_migrations (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp())",
    );
    for (const migration of POSTGRES_COORDINATION_MIGRATIONS) {
      const applied = await tx.unsafe<{ id: string; checksum: string }>(
        "SELECT id, checksum FROM auggy_coordination_migrations WHERE id = $1 FOR UPDATE",
        [migration.id],
      );
      if (applied.length > 0) {
        if (typeof applied[0]?.checksum !== "string" || applied[0]?.checksum !== migration.checksum)
          throw new Error(`coordination migration checksum mismatch: ${migration.id}`);
        continue;
      }
      await tx.unsafe(migration.sql);
      await tx.unsafe("INSERT INTO auggy_coordination_migrations (id, checksum) VALUES ($1, $2)", [
        migration.id,
        migration.checksum,
      ]);
    }
    await assertPostgresCoordinationSchema(tx, schema);
  });
}
