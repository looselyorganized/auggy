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

/** Recomputed from immutable migration SQL; migration rejects any mismatch. */
export const postgresCoordinationMigrationChecksum = new Bun.CryptoHasher("sha256")
  .update(INITIAL_COORDINATION_MIGRATION_SQL)
  .digest("hex");

export const POSTGRES_COORDINATION_MIGRATIONS = [
  {
    id: "20260724_01_distributed_turn_coordination",
    checksum: postgresCoordinationMigrationChecksum,
    sql: INITIAL_COORDINATION_MIGRATION_SQL,
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
}

interface CoordinationCatalogConstraint {
  table_name: string;
  constraint_name: string;
  constraint_type: string;
  is_validated: boolean;
  is_deferrable: boolean;
  is_initially_deferred: boolean;
}

interface CoordinationCatalogTable {
  table_name: string;
  persistence: string;
  row_security: boolean;
  force_row_security: boolean;
  has_rules: boolean;
  has_triggers: boolean;
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
  ["auggy_coordination_instances", "draining", "boolean", true, "false"],
  ["auggy_coordination_instances", "instance_id", "text", true, null],
  ["auggy_coordination_instances", "namespace", "text", true, null],
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
  ["auggy_coordination_namespaces", "max_concurrent", "integer", true, null],
  ["auggy_coordination_namespaces", "max_queued", "integer", true, null],
  ["auggy_coordination_namespaces", "max_queued_per_thread", "integer", true, null],
  ["auggy_coordination_namespaces", "namespace", "text", true, null],
  [
    "auggy_coordination_namespaces",
    "updated_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_requests", "binding_hash", "text", true, null],
  ["auggy_coordination_requests", "execution_started_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "fence", "bigint", false, null],
  ["auggy_coordination_requests", "lease_expires_at", "timestamp with time zone", false, null],
  ["auggy_coordination_requests", "namespace", "text", true, null],
  ["auggy_coordination_requests", "owner_instance", "text", false, null],
  [
    "auggy_coordination_requests",
    "queued_at",
    "timestamp with time zone",
    true,
    "clock_timestamp()",
  ],
  ["auggy_coordination_requests", "request_id", "text", true, null],
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
    "auggy_coordination_events",
    "auggy_coordination_events_pkey",
    true,
    true,
    "event_id",
    "pg_catalog.int8_ops",
    "-",
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
    "auggy_coordination_request_source_idx",
    false,
    false,
    "namespace,source_id,state",
    "pg_catalog.text_ops,pg_catalog.text_ops,pg_catalog.text_ops",
    "pg_catalog.default,pg_catalog.default,pg_catalog.default",
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

const EXPECTED_CHECK_TABLES = new Map([
  ["auggy_coordination_namespaces_max_concurrent_check", "auggy_coordination_namespaces"],
  ["auggy_coordination_namespaces_max_queued_check", "auggy_coordination_namespaces"],
  ["auggy_coordination_namespaces_max_queued_per_thread_check", "auggy_coordination_namespaces"],
  ["auggy_coordination_requests_state_check", "auggy_coordination_requests"],
  ["auggy_coordination_sources_max_concurrent_check", "auggy_coordination_sources"],
  ["auggy_coordination_sources_max_queued_check", "auggy_coordination_sources"],
]);

const EXPECTED_COORDINATION_CONSTRAINTS: readonly CoordinationCatalogConstraint[] = [
  ["auggy_coordination_events", "auggy_coordination_events_pkey"],
  ["auggy_coordination_instances", "auggy_coordination_instances_pkey"],
  ["auggy_coordination_migrations", "auggy_coordination_migrations_pkey"],
  ["auggy_coordination_namespaces", "auggy_coordination_namespaces_pkey"],
  ["auggy_coordination_requests", "auggy_coordination_requests_pkey"],
  ["auggy_coordination_sources", "auggy_coordination_sources_pkey"],
  ["auggy_coordination_threads", "auggy_coordination_threads_pkey"],
].map(([table_name, constraint_name]) => ({
  table_name: table_name as string,
  constraint_name: constraint_name as string,
  constraint_type: "p",
  is_validated: true,
  is_deferrable: false,
  is_initially_deferred: false,
}));

const EXPECTED_COORDINATION_TABLES: readonly CoordinationCatalogTable[] = [
  "auggy_coordination_events",
  "auggy_coordination_instances",
  "auggy_coordination_migrations",
  "auggy_coordination_namespaces",
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
  if (rows.length !== EXPECTED_CHECK_TABLES.size) return false;
  if (
    rows.some(
      (row) =>
        !row.is_validated || EXPECTED_CHECK_TABLES.get(row.constraint_name) !== row.table_name,
    )
  ) {
    return false;
  }
  const definitions = new Map(
    rows.map((row) => [row.constraint_name, compactCheck(row.definition)]),
  );
  const numeric = [
    ["auggy_coordination_namespaces_max_concurrent_check", "max_concurrent", "> 0"],
    ["auggy_coordination_namespaces_max_queued_check", "max_queued", ">= 0"],
    ["auggy_coordination_namespaces_max_queued_per_thread_check", "max_queued_per_thread", ">= 0"],
    ["auggy_coordination_sources_max_concurrent_check", "max_concurrent", "> 0"],
    ["auggy_coordination_sources_max_queued_check", "max_queued", ">= 0"],
  ] as const;
  for (const [name, field, comparison] of numeric) {
    const definition = definitions.get(name);
    if (definition !== `check${field}${comparison.replaceAll(" ", "")}`) return false;
  }
  const state = definitions.get("auggy_coordination_requests_state_check");
  return (
    state ===
    "checkstate=anyarray['queued','active','completed','failed','canceled','outcome_unknown']"
  );
}

async function assertPostgresCoordinationSchema(
  sql: PostgresMigrationExecutor,
  expectedSchema: string,
): Promise<void> {
  const tables =
    "'auggy_coordination_events', 'auggy_coordination_instances', " +
    "'auggy_coordination_migrations', 'auggy_coordination_namespaces', " +
    "'auggy_coordination_requests', 'auggy_coordination_sources', " +
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
                ELSE collation_namespace.nspname || '.' || collation.collname
            END AS collation
      FROM pg_class cls
      JOIN pg_namespace namespace ON namespace.oid = cls.relnamespace
      JOIN pg_attribute attr ON attr.attrelid = cls.oid
      LEFT JOIN pg_attrdef defaults
        ON defaults.adrelid = cls.oid AND defaults.adnum = attr.attnum
      LEFT JOIN pg_collation collation ON collation.oid = attr.attcollation
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = collation.collnamespace
     WHERE namespace.nspname = current_schema()
       AND cls.relkind = 'r'
       AND cls.relname IN (${tables})
       AND attr.attnum > 0
       AND NOT attr.attisdropped
     ORDER BY cls.relname, attr.attname
  `);
  if (!validCoordinationColumns(columns)) throw incompatibleSchema();

  const tableCatalog = await sql.unsafe<CoordinationCatalogTable>(`
    SELECT cls.relname AS table_name,
           cls.relpersistence AS persistence,
           cls.relrowsecurity AS row_security,
           cls.relforcerowsecurity AS force_row_security,
           cls.relhasrules AS has_rules,
           cls.relhastriggers AS has_triggers
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
                           ELSE collation_namespace.nspname || '.' || collation.collname
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
      LEFT JOIN pg_collation collation ON collation.oid = key.collation_oid
      LEFT JOIN pg_namespace collation_namespace
        ON collation_namespace.oid = collation.collnamespace
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
           con.convalidated AS is_validated
      FROM pg_constraint con
      JOIN pg_class table_class ON table_class.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
       AND con.contype = 'c'
     ORDER BY table_class.relname, con.conname
  `);
  if (!validCoordinationChecks(checks)) throw incompatibleSchema();

  const constraints = await sql.unsafe<CoordinationCatalogConstraint>(`
    SELECT table_class.relname AS table_name,
           con.conname AS constraint_name,
           con.contype AS constraint_type,
           con.convalidated AS is_validated,
           con.condeferrable AS is_deferrable,
           con.condeferred AS is_initially_deferred
      FROM pg_constraint con
      JOIN pg_class table_class ON table_class.oid = con.conrelid
      JOIN pg_namespace namespace ON namespace.oid = table_class.relnamespace
     WHERE namespace.nspname = current_schema()
       AND table_class.relname IN (${tables})
       AND con.contype <> 'c'
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
    // Omitting pg_catalog keeps its implicit precedence over the owned schema,
    // so a same-named function cannot redirect migration DDL or validation.
    await tx.unsafe(`SET LOCAL search_path TO "${schema}"`);
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
