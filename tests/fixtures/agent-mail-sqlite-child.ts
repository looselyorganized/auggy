import { Database } from "bun:sqlite";
import { statSync } from "node:fs";
import { createAgentMailInboundLedger } from "../../src/augments/agentMail/inbound-ledger";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../src/augments/agentMail/provider";

const [mode, dbPath, workerId = "child"] = process.argv.slice(2);
if (!mode || !dbPath) throw new Error("mode and dbPath are required");

function envelope(messageId: string) {
  return agentMailRestEnvelope(
    normalizeAgentMailMessage({
      inbox_id: "support@agentmail.to",
      thread_id: "thread_child",
      message_id: messageId,
      labels: ["received"],
      timestamp: "2026-07-16T12:00:00.000Z",
      from: "sender@example.com",
      to: ["support@agentmail.to"],
      subject: "Child process",
      text: "durability probe",
      size: 16,
    }),
  );
}

async function released(): Promise<void> {
  console.log(JSON.stringify({ event: "READY" }));
  await Bun.stdin.text();
}

if (mode === "claim") {
  await released();
  const ledger = createAgentMailInboundLedger({
    dbPath,
    now: () => 1_000,
    leaseToken: () => `token_${workerId}`,
  });
  const claim = ledger.claimNext({ workerId, leaseMs: 100 });
  console.log(
    JSON.stringify({
      event: "RESULT",
      messageId: claim?.envelope.message.messageId ?? null,
      attemptCount: claim?.attemptCount ?? null,
    }),
  );
  ledger.close();
} else if (mode === "enqueue") {
  await released();
  const ledger = createAgentMailInboundLedger({ dbPath, now: () => 1_000 });
  const result = ledger.enqueue(envelope("race_duplicate"));
  console.log(JSON.stringify({ event: "RESULT", status: result.status }));
  ledger.close();
} else if (mode === "crash-committed") {
  const ledger = createAgentMailInboundLedger({
    dbPath,
    now: () => 1_000,
    leaseToken: () => "killed_token",
  });
  ledger.enqueue(envelope("committed_before_kill"));
  const claim = ledger.claimNext({ workerId: "killed_worker", leaseMs: 100 });
  console.log(JSON.stringify({ event: "COMMITTED", attemptCount: claim?.attemptCount }));
  setInterval(() => {}, 60_000);
} else if (mode === "crash-uncommitted") {
  const ledger = createAgentMailInboundLedger({ dbPath, now: () => 1_000 });
  ledger.enqueue(envelope("rollback_after_kill"));
  const raw = new Database(dbPath, { readwrite: true });
  raw.run("PRAGMA wal_checkpoint(TRUNCATE)");
  const baselineWalSize = statSync(`${dbPath}-wal`).size;
  raw.run("PRAGMA cache_size = 1");
  raw.run("PRAGMA cache_spill = 1");
  raw.run("BEGIN IMMEDIATE");
  const insert = raw.prepare(
    `INSERT INTO agentmail_inbound_messages (
       inbox_id, message_id, thread_id, event_type, provider_event_id,
       first_source, last_source, message_timestamp, message_ts_ms, payload_json,
       state, attempt_count, available_at, first_seen_at, last_seen_at
     ) VALUES (?, ?, ?, 'message.received', NULL, 'rest', 'rest', ?, ?, ?, 'pending', 0, 1000, 1000, 1000)`,
  );
  for (let index = 0; index < 200; index++) {
    const messageId = `uncommitted_${index}`;
    const timestamp = "2026-07-16T12:00:00.000Z";
    insert.run(
      "support@agentmail.to",
      messageId,
      "thread_uncommitted",
      timestamp,
      Date.parse(timestamp),
      JSON.stringify({
        inboxId: "support@agentmail.to",
        messageId,
        threadId: "thread_uncommitted",
        labels: ["received"],
        timestamp,
        from: "sender@example.com",
        to: ["support@agentmail.to"],
        cc: [],
        bcc: [],
        replyTo: [],
        subject: "uncommitted",
        text: "x".repeat(20_000),
        size: 20_000,
        attachments: [],
        references: [],
      }),
    );
  }
  const uncommittedWalSize = statSync(`${dbPath}-wal`).size;
  console.log(JSON.stringify({ event: "UNCOMMITTED", baselineWalSize, uncommittedWalSize }));
  setInterval(() => {}, 60_000);
} else if (mode === "hold-write") {
  const raw = new Database(dbPath, { readwrite: true });
  raw.run("BEGIN IMMEDIATE");
  console.log(JSON.stringify({ event: "LOCKED" }));
  await Bun.stdin.text();
  raw.run("ROLLBACK");
  raw.close();
  console.log(JSON.stringify({ event: "RELEASED" }));
} else if (mode === "try-write") {
  const raw = new Database(dbPath, { readwrite: true });
  raw.run("PRAGMA busy_timeout = 50");
  let result = "acquired";
  try {
    raw.run("BEGIN IMMEDIATE");
    raw.run("ROLLBACK");
  } catch (error) {
    const detail = error as Error & { code?: string };
    if (detail.code !== "SQLITE_BUSY" && !/busy|locked/i.test(detail.message)) throw error;
    result = detail.code ?? "SQLITE_BUSY";
  }
  raw.close();
  console.log(JSON.stringify({ event: "RESULT", result }));
} else {
  throw new Error(`unknown mode: ${mode}`);
}
