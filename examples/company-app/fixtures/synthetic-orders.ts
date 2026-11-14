/** Test-only authoritative synthetic records and effect journal. No real refund API. */
import { Database } from "bun:sqlite";
import { createHash, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type {
  CompanyAuthorization,
  CompanySubject,
  OrderPrincipal,
  OrderRecord,
  RefundSimulation,
} from "../agent-integration/orders/contracts";
import { OrdersServiceError } from "../agent-integration/orders/service-client";

export const SYNTHETIC_POLICY_VERSION = "synthetic-company-policy-v1";
export const SYNTHETIC_CHECKPOINT_LIMITS = Object.freeze({ effects: 100, bytes: 64 * 1024 });
const checkpointEffect = z
  .object({
    operationHash: z.string().regex(/^[a-f0-9]{64}$/),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/),
    subject: z.literal("support-agent"),
    receipt: z
      .object({
        simulationId: z.string().regex(/^simulation-[a-f0-9]{24}$/),
        orderId: z.literal("order-a"),
        amountCents: z.number().int().min(1).max(5000),
        simulated: z.literal(true),
      })
      .strict(),
  })
  .strict();
const checkpointSchema = z
  .object({
    version: z.literal(1),
    policyVersion: z.literal(SYNTHETIC_POLICY_VERSION),
    effects: z.array(checkpointEffect).max(SYNTHETIC_CHECKPOINT_LIMITS.effects),
  })
  .strict();
export type SyntheticOrdersCheckpoint = z.infer<typeof checkpointSchema>;

/** A synthetic downstream checkpoint, never an Auggy managed-state backup. */
export function serializeSyntheticOrdersCheckpoint(value: unknown) {
  const checkpoint = checkpointSchema.parse(value);
  const seen = new Set<string>();
  for (const effect of checkpoint.effects) {
    if (
      seen.has(effect.operationHash) ||
      effect.receipt.simulationId !== `simulation-${effect.operationHash.slice(0, 24)}`
    )
      throw new Error("Invalid synthetic checkpoint effect tuple");
    seen.add(effect.operationHash);
  }
  const bytes = JSON.stringify(checkpoint);
  if (Buffer.byteLength(bytes) > SYNTHETIC_CHECKPOINT_LIMITS.bytes)
    throw new Error("Synthetic checkpoint exceeded byte bound");
  return { checkpoint, bytes, sha256: createHash("sha256").update(bytes).digest("hex") };
}
const provider = "fixture-app";
const orgId = "synthetic-company";
const maximumRefund = 5000;
const accountSchema = z
  .object({
    provider: z.string().min(1).max(128),
    userId: z.string().min(1).max(128),
    orgId: z.string().min(1).max(128).optional(),
    roles: z.array(z.string().max(128)).max(32),
  })
  .strict();
const principalSchema = z
  .object({
    provider: z.string().min(1).max(128),
    subject: z.string().min(1).max(128),
    orgId: z.string().min(1).max(128).optional(),
    authzVersion: z.string().max(128),
    grants: z
      .array(
        z
          .object({
            action: z.string().max(128),
            resource: z.string().max(128).optional(),
            constraints: z.object({ maxAmountCents: z.number().int() }).strict().optional(),
          })
          .strict(),
      )
      .max(64),
  })
  .strict();
const readSchema = z.object({ principal: principalSchema, orderId: z.string().max(128) }).strict();
const refundSchema = readSchema
  .extend({
    amountCents: z.number().int().min(1).max(5000),
    reason: z.string().trim().min(1).max(256),
    operationId: z.string().min(1).max(256),
  })
  .strict();

export function createSyntheticOrdersStore(dbPath: string) {
  const db = new Database(dbPath, { create: true, strict: true });
  db.run("PRAGMA journal_mode=WAL");
  db.run("PRAGMA synchronous=FULL");
  db.run("PRAGMA busy_timeout=5000");
  db.run(
    "CREATE TABLE IF NOT EXISTS accounts (subject TEXT PRIMARY KEY, readable TEXT NOT NULL, refundable TEXT NOT NULL)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS orders (id TEXT PRIMARY KEY, owner TEXT NOT NULL, record TEXT NOT NULL)",
  );
  db.run(
    "CREATE TABLE IF NOT EXISTS effects (operation_hash TEXT PRIMARY KEY, binding_hash TEXT NOT NULL, receipt TEXT NOT NULL, subject TEXT NOT NULL)",
  );
  const seed = db.transaction(() => {
    const insertAccount = db.query("INSERT OR IGNORE INTO accounts VALUES (?, ?, ?)");
    insertAccount.run("customer-a", '["order-a"]', "[]");
    insertAccount.run("customer-b", '["order-b"]', "[]");
    insertAccount.run("support-agent", '["order-a"]', '["order-a"]');
    insertAccount.run("app-admin", '["order-a"]', "[]");
    const insertOrder = db.query("INSERT OR IGNORE INTO orders VALUES (?, ?, ?)");
    for (const [id, owner, item, status, note] of [
      ["order-a", "customer-a", "Trail jacket", "shipped", "customer-a-private-marker"],
      ["order-b", "customer-b", "Field backpack", "processing", "customer-b-private-marker"],
    ] as const)
      insertOrder.run(
        id,
        owner,
        JSON.stringify({ id, status, item, totalCents: 12_500, privateNote: note }),
      );
  });
  seed.immediate();
  let touched = false;
  let imported = false;

  function authorizationFor(subject: CompanySubject): CompanyAuthorization {
    touched = true;
    const account =
      subject.provider === provider && subject.orgId === orgId
        ? db
            .query<{ readable: string; refundable: string }, [string]>(
              "SELECT readable, refundable FROM accounts WHERE subject = ?",
            )
            .get(subject.userId)
        : null;
    const readable: string[] = account ? JSON.parse(account.readable) : [];
    const refundable: string[] = account ? JSON.parse(account.refundable) : [];
    // Account records own permission. A supplied "admin" or "support" role adds nothing.
    return {
      scopes: readable.length ? ["orders.read"] : [],
      authzVersion: SYNTHETIC_POLICY_VERSION,
      grants: [
        ...readable.map((resource) => ({ action: "orders.read", resource })),
        ...refundable.map((resource) => ({
          action: "orders.refund.simulate",
          resource,
          constraints: { maxAmountCents: maximumRefund },
        })),
      ],
    };
  }

  function admit(
    principal: OrderPrincipal,
    action: string,
    orderId: string,
    amount?: number,
  ): void {
    const current = authorizationFor({
      provider: principal.provider,
      userId: principal.subject,
      orgId: principal.orgId,
      roles: [],
    });
    const issued = principal.grants.find(
      (grant) => grant.action === action && grant.resource === orderId,
    );
    const authoritative = current.grants.find(
      (grant) => grant.action === action && grant.resource === orderId,
    );
    if (principal.authzVersion !== current.authzVersion || !issued || !authoritative)
      throw new OrdersServiceError(403);
    if (amount !== undefined) {
      const limit = issued.constraints?.maxAmountCents;
      if (
        typeof limit !== "number" ||
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        limit > maximumRefund ||
        !Number.isSafeInteger(amount) ||
        amount < 1 ||
        amount > limit
      )
        throw new OrdersServiceError(403);
    }
  }

  function read(principal: OrderPrincipal, orderId: string): OrderRecord {
    admit(principal, "orders.read", orderId);
    const row = db
      .query<{ record: string }, [string]>("SELECT record FROM orders WHERE id = ?")
      .get(orderId);
    if (!row) throw new OrdersServiceError(403);
    return JSON.parse(row.record);
  }

  const simulate = db.transaction(
    (
      principal: OrderPrincipal,
      input: { orderId: string; amountCents: number; reason: string; operationId: string },
    ): RefundSimulation => {
      if (!input.operationId || input.operationId.length > 256) throw new OrdersServiceError(403);
      admit(principal, "orders.refund.simulate", input.orderId, input.amountCents);
      const operation = createHash("sha256")
        .update(
          JSON.stringify([
            principal.provider,
            principal.subject,
            principal.orgId ?? null,
            input.operationId,
          ]),
        )
        .digest("hex");
      const binding = createHash("sha256")
        .update(
          JSON.stringify([
            input.orderId,
            input.amountCents,
            input.reason,
            principal.grants,
            principal.authzVersion,
          ]),
        )
        .digest("hex");
      const existing = db
        .query<{ binding_hash: string; receipt: string }, [string]>(
          "SELECT binding_hash, receipt FROM effects WHERE operation_hash = ?",
        )
        .get(operation);
      if (existing) {
        if (existing.binding_hash !== binding) throw new OrdersServiceError(409);
        return JSON.parse(existing.receipt);
      }
      const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM effects").get();
      if (!count || count.count >= SYNTHETIC_CHECKPOINT_LIMITS.effects)
        throw new OrdersServiceError(503);
      const receipt: RefundSimulation = {
        simulationId: `simulation-${operation.slice(0, 24)}`,
        orderId: input.orderId,
        amountCents: input.amountCents,
        simulated: true,
      };
      db.query("INSERT INTO effects VALUES (?, ?, ?, ?)").run(
        operation,
        binding,
        JSON.stringify(receipt),
        principal.subject,
      );
      return receipt;
    },
  );
  function checkpoint() {
    const rows = db
      .query<
        {
          operation_hash: string;
          binding_hash: string;
          receipt: string;
          subject: string;
        },
        []
      >(
        "SELECT operation_hash, binding_hash, receipt, subject FROM effects ORDER BY rowid LIMIT 101",
      )
      .all();
    return serializeSyntheticOrdersCheckpoint({
      version: 1,
      policyVersion: SYNTHETIC_POLICY_VERSION,
      effects: rows.map((row) => ({
        operationHash: row.operation_hash,
        bindingHash: row.binding_hash,
        subject: row.subject,
        receipt: JSON.parse(row.receipt),
      })),
    });
  }
  function restoreCheckpoint(value: unknown, expectedSHA256: string) {
    if (!/^[a-f0-9]{64}$/.test(expectedSHA256)) throw new Error("Missing checkpoint identity");
    const prepared = serializeSyntheticOrdersCheckpoint(value);
    if (prepared.sha256 !== expectedSHA256)
      throw new Error("Synthetic checkpoint identity mismatch");
    const restore = db.transaction(() => {
      const count = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM effects").get();
      if (touched || imported || !count || count.count !== 0)
        throw new Error("Synthetic checkpoint requires a fresh unused store");
      const insert = db.query("INSERT INTO effects VALUES (?, ?, ?, ?)");
      for (const effect of prepared.checkpoint.effects)
        insert.run(
          effect.operationHash,
          effect.bindingHash,
          JSON.stringify(effect.receipt),
          effect.subject,
        );
    });
    restore.immediate();
    imported = true;
    return prepared.sha256;
  }
  return {
    authorizationFor,
    read,
    simulateRefund: (
      principal: OrderPrincipal,
      input: { orderId: string; amountCents: number; reason: string; operationId: string },
    ) => simulate.immediate(principal, input),
    journal: () =>
      checkpoint().checkpoint.effects.map((effect) => ({
        subject: effect.subject,
        receipt: effect.receipt,
      })),
    checkpoint,
    restoreCheckpoint,
    close: () => db.close(),
  };
}

async function readSyntheticBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("missing body");
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let expired = false;
  const timer = setTimeout(() => {
    expired = true;
    void reader.cancel().catch(() => {});
  }, 2000);
  try {
    for (;;) {
      const part = await reader.read();
      if (expired || request.signal.aborted) throw new Error("request body timed out or aborted");
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 16 * 1024) throw new Error("request too large");
      chunks.push(part.value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export function createSyntheticOrdersHandler(
  store: ReturnType<typeof createSyntheticOrdersStore>,
  token: string,
) {
  if (!token) throw new Error("Fixture service requires an explicit private token");
  const expected = Buffer.from(`Bearer ${token}`);
  return async (request: Request): Promise<Response> => {
    const candidate = Buffer.from(request.headers.get("authorization") ?? "");
    if (candidate.length !== expected.length || !timingSafeEqual(candidate, expected))
      return Response.json({ error: "unauthorized" }, { status: 401 });
    if (request.method !== "POST")
      return Response.json(
        { error: "method_not_allowed" },
        { status: 405, headers: { allow: "POST" } },
      );
    try {
      const body = await readSyntheticBody(request);
      switch (new URL(request.url).pathname) {
        case "/authorization":
          return Response.json(store.authorizationFor(accountSchema.parse(body)));
        case "/orders/read": {
          const input = readSchema.parse(body);
          return Response.json(store.read(input.principal, input.orderId));
        }
        case "/refunds/simulate": {
          const input = refundSchema.parse(body);
          return Response.json(store.simulateRefund(input.principal, input));
        }
        case "/fixture/journal":
          return Response.json({ effects: store.journal() });
        default:
          return Response.json({ error: "not_found" }, { status: 404 });
      }
    } catch (error) {
      return Response.json(
        { error: "request_rejected" },
        { status: error instanceof OrdersServiceError ? error.status : 400 },
      );
    }
  };
}
