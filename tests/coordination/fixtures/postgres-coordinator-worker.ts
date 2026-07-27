import { PostgresDistributedTurnCoordinator } from "../../../src/coordination";

const [namespace, instanceId, mode = "claim"] = process.argv.slice(2);
const url = process.env.AUGGY_TEST_POSTGRES_URL;

if (!namespace || !instanceId || !url) process.exit(2);

const coordinator = new PostgresDistributedTurnCoordinator({
  url,
  namespace,
  instanceId,
  maxConcurrent: 2,
  maxQueued: 4,
  maxQueuedPerThread: 2,
  leaseMs: 500,
  buildFingerprint: "c".repeat(64),
  sources: [{ id: "web", maxConcurrent: 2, maxQueued: 4 }],
  retention: {
    terminalRequestRetentionMs: 604_800_000,
    maxTerminalRequests: 10_000,
    eventRetentionMs: 2_592_000_000,
    maxEvents: 50_000,
  },
  result: { maxReplayBytes: 65_536 },
  compatibility: {
    protocolVersion: 3,
    protocolFingerprint: "a".repeat(64),
    configurationFingerprint: "b".repeat(64),
  },
});

function emit(value: Record<string, unknown>): void {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

try {
  if ((await coordinator.register()).status !== "registered") {
    throw new Error("failed to register child coordinator");
  }
  emit({ event: "READY" });

  const reader = Bun.stdin.stream().getReader();
  const decoder = new TextDecoder();
  let buffered = "";
  while (true) {
    const newline = buffered.indexOf("\n");
    if (newline >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.length === 0) continue;
      const message = JSON.parse(line) as { event?: unknown };
      if (message.event !== "GO") continue;
      const request = {
        requestId: "multiprocess-request",
        threadId: "multiprocess-thread",
        source: { id: "web", maxConcurrent: 2, maxQueued: 4 },
        bindingHash: "S7l_qm3W92Yd4JbKzV1LQYdKebJ4Q-4C3m3VnuDhxQY",
      };
      const admitted = await coordinator.admit(request);
      const claimed = await coordinator.claim(request);
      if (mode === "effect" && claimed.status === "acquired") {
        const started = await coordinator.markExecutionStarted(claimed.lease);
        if (started.status !== "ok") throw new Error("failed to mark child execution started");
        // This phase is the deterministic boundary immediately after a
        // non-idempotent effect would be dispatched. The parent kills this
        // process before it can emit a terminal coordinator update.
        emit({
          event: "EFFECT_BEGUN",
          admitted: admitted.status,
          claimed: claimed.status,
          fence: claimed.lease.fence,
        });
        continue;
      }
      emit({
        event: "CLAIM",
        admitted: admitted.status,
        claimed: claimed.status,
        fence: claimed.status === "acquired" ? claimed.lease.fence : null,
      });
      await coordinator.close();
      process.exit(0);
    }
    const chunk = await reader.read();
    if (chunk.done) break;
    buffered += decoder.decode(chunk.value, { stream: true });
  }
  await coordinator.close();
  process.exit(0);
} catch {
  // Parent tests deliberately suppress worker stderr. Do not serialize an
  // operational error because it can contain driver or deployment details.
  try {
    await coordinator.close();
  } catch {
    // Best effort during a failed connection.
  }
  process.exit(1);
}
