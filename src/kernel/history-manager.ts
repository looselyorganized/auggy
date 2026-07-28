import type {
  Message,
  CompactionStrategy,
  Transcript,
  PeerIdentity,
  Part,
  ToolCallRecord,
  ThreadHistorySnapshot,
} from "../types";

/**
 * Per-turn snapshot recorded by the kernel at turn completion. Used by
 * SchedulerContext.getCompletedTranscript() (ADR-027). Kept distinct from
 * the running Message[] history because the snapshot's identity boundary
 * is the turn, not the message — and downstream consumers (post-turn
 * extraction) want a self-contained record they can hand to a focused
 * extraction model without traversing the message log.
 */
export interface TurnSnapshot {
  turnId: string;
  threadId: string;
  peer: PeerIdentity | null;
  parts: Part[];
  toolCalls: ToolCallRecord[];
  startedAt: number;
  endedAt: number;
}

export interface HistoryManager {
  append(message: Message): void;
  getHistory(tokenBudget: number): Message[];
  compact(tokenBudget: number, strategy: CompactionStrategy): void;
  /** Return an isolated, versioned snapshot suitable for durable storage. */
  snapshot(): ThreadHistorySnapshot;
  /**
   * Validate and atomically replace model-visible history. Invalid snapshots
   * throw without modifying the current history.
   */
  replace(snapshot: unknown): void;
  totalTokens(): number;
  /**
   * Record a per-turn snapshot at turn completion. Called by the turn-loop
   * before the SchedulerContext closure binds (ADR-027). Multiple snapshots
   * for the same turnId overwrite (idempotent on retry).
   */
  recordTurn(snapshot: TurnSnapshot): void;
  /**
   * Retrieve a previously-recorded turn snapshot. Returns null if the
   * snapshot was never recorded (e.g. turn errored before recording) or
   * has been evicted by retention. Kernel-internal: SchedulerContext
   * exposes only the just-completed turn via a closure-bound wrapper.
   */
  getTranscript(turnId: string): Transcript | null;
}

/**
 * Cap on retained per-turn snapshots. ADR-027 only requires retaining the
 * just-completed turn; we keep the last N to absorb scheduleAfterTurn
 * hooks that may take a brief moment to read after the next turn admits.
 * Bounded to prevent unbounded growth on long threads.
 */
const MAX_TURN_SNAPSHOTS = 32;

const MESSAGE_ROLES = new Set(["user", "assistant", "tool_use", "tool_result"]);

function parseSnapshot(snapshot: unknown): Message[] {
  // Accept the legacy bare-array shape written by HistoryManager.save() in
  // older releases, but validate it with the same strict rules. New writes
  // always use the versioned envelope.
  const candidate = Array.isArray(snapshot)
    ? snapshot
    : typeof snapshot === "object" &&
        snapshot !== null &&
        (snapshot as { version?: unknown }).version === 1
      ? (snapshot as { messages?: unknown }).messages
      : undefined;

  if (!Array.isArray(candidate)) {
    throw new Error("Invalid thread history snapshot: expected version 1 messages");
  }

  const seenIds = new Set<string>();
  const validated: Message[] = candidate.map((value, index) => {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      throw new Error(`Invalid thread history message at index ${index}`);
    }
    const message = value as Record<string, unknown>;
    if (
      typeof message.id !== "string" ||
      message.id.length === 0 ||
      typeof message.role !== "string" ||
      !MESSAGE_ROLES.has(message.role) ||
      typeof message.content !== "string" ||
      typeof message.timestamp !== "number" ||
      !Number.isSafeInteger(message.timestamp) ||
      message.timestamp < 0 ||
      typeof message.tokenCount !== "number" ||
      !Number.isSafeInteger(message.tokenCount) ||
      message.tokenCount < 0 ||
      (message.peerId !== undefined &&
        (typeof message.peerId !== "string" || message.peerId.length === 0)) ||
      (message.toolCallId !== undefined &&
        (typeof message.toolCallId !== "string" || message.toolCallId.length === 0))
    ) {
      throw new Error(`Invalid thread history message at index ${index}`);
    }
    if (seenIds.has(message.id)) {
      throw new Error(`Invalid thread history snapshot: duplicate message id "${message.id}"`);
    }
    seenIds.add(message.id);
    return {
      id: message.id,
      role: message.role as Message["role"],
      ...(message.peerId === undefined ? {} : { peerId: message.peerId as string }),
      ...(message.toolCallId === undefined ? {} : { toolCallId: message.toolCallId as string }),
      content: message.content,
      timestamp: message.timestamp,
      tokenCount: message.tokenCount,
    };
  });

  for (let index = 0; index < validated.length; index++) {
    const message = validated[index]!;
    if (message.role === "tool_use") {
      const result = validated[index + 1];
      if (
        !message.toolCallId ||
        result?.role !== "tool_result" ||
        result.toolCallId !== message.toolCallId
      ) {
        throw new Error(
          `Invalid thread history snapshot: tool_use at index ${index} has no matching result`,
        );
      }
      index++;
      continue;
    }
    if (message.role === "tool_result") {
      throw new Error(`Invalid thread history snapshot: orphaned tool_result at index ${index}`);
    }
    if (message.toolCallId !== undefined) {
      throw new Error(`Invalid thread history snapshot: ${message.role} message has a toolCallId`);
    }
  }

  return validated;
}

export function createHistoryManager(): HistoryManager {
  let messages: Message[] = [];
  let runningTokens = 0;
  // Insertion-ordered snapshot store. JS Map preserves insertion order;
  // we evict oldest when capacity is exceeded.
  const turnSnapshots = new Map<string, TurnSnapshot>();

  return {
    append(message: Message) {
      messages.push(message);
      runningTokens += message.tokenCount;
    },

    recordTurn(snapshot: TurnSnapshot) {
      // Re-recording the same turnId moves it to most-recent without
      // increasing capacity pressure.
      if (turnSnapshots.has(snapshot.turnId)) {
        turnSnapshots.delete(snapshot.turnId);
      } else if (turnSnapshots.size >= MAX_TURN_SNAPSHOTS) {
        // Evict oldest insertion-order entry.
        const oldestKey = turnSnapshots.keys().next().value;
        if (oldestKey !== undefined) turnSnapshots.delete(oldestKey);
      }
      turnSnapshots.set(snapshot.turnId, snapshot);
    },

    getTranscript(turnId: string): Transcript | null {
      const snap = turnSnapshots.get(turnId);
      if (!snap) return null;
      return {
        turnId: snap.turnId,
        threadId: snap.threadId,
        peer: snap.peer,
        parts: snap.parts,
        toolCalls: snap.toolCalls,
        startedAt: snap.startedAt,
        endedAt: snap.endedAt,
      };
    },

    getHistory(tokenBudget: number): Message[] {
      if (tokenBudget <= 0 || messages.length === 0) return [];

      // Walk backwards from newest, accumulating tokens
      let budget = tokenBudget;
      let startIndex = messages.length;

      for (let i = messages.length - 1; i >= 0; i--) {
        const msg = messages[i]!;

        // Check if this is a tool_result — must include its tool_use pair
        if (msg.role === "tool_result" && i > 0 && messages[i - 1]!.role === "tool_use") {
          const pairCost = msg.tokenCount + messages[i - 1]!.tokenCount;
          if (budget - pairCost < 0 && startIndex < messages.length) break;
          budget -= pairCost;
          startIndex = i - 1;
          i--; // skip the tool_use we just included — paired tool_use can never reach the else branch
        } else {
          if (budget - msg.tokenCount < 0 && startIndex < messages.length) break;
          budget -= msg.tokenCount;
          startIndex = i;
        }
      }

      return messages.slice(startIndex);
    },

    compact(tokenBudget: number, strategy: CompactionStrategy) {
      const threshold = Math.floor(tokenBudget * 0.8);
      if (runningTokens <= threshold) return;

      if (strategy === "truncate" || strategy === "summarize") {
        // summarize is treated as truncate in v1
        // Drop oldest messages until under threshold, respecting atomic tool pairs
        while (messages.length > 0 && runningTokens > threshold) {
          const first = messages[0]!;
          if (
            first.role === "tool_use" &&
            messages.length > 1 &&
            messages[1]!.role === "tool_result"
          ) {
            // Drop the pair together
            runningTokens -= first.tokenCount + messages[1]!.tokenCount;
            messages.splice(0, 2);
          } else if (first.role === "tool_result") {
            // Orphaned tool_result — drop it
            runningTokens -= first.tokenCount;
            messages.splice(0, 1);
          } else {
            runningTokens -= first.tokenCount;
            messages.splice(0, 1);
          }
        }
      } else if (strategy === "sliding-window") {
        // Keep newest messages that fit within threshold
        let kept = 0;
        let keepFrom = messages.length;
        for (let i = messages.length - 1; i >= 0; i--) {
          const msg = messages[i]!;
          if (kept + msg.tokenCount > threshold) break;
          // Ensure tool pairs stay together
          if (msg.role === "tool_result" && i > 0 && messages[i - 1]!.role === "tool_use") {
            const pairCost = msg.tokenCount + messages[i - 1]!.tokenCount;
            if (kept + pairCost > threshold) break;
            kept += pairCost;
            keepFrom = i - 1;
            i--; // skip tool_use
          } else {
            kept += msg.tokenCount;
            keepFrom = i;
          }
        }
        const removed = messages.splice(0, keepFrom);
        runningTokens -= removed.reduce((s, m) => s + m.tokenCount, 0);
      }
    },

    snapshot() {
      return {
        version: 1,
        messages: messages.map((message) => ({ ...message })),
      };
    },

    replace(snapshot: unknown) {
      const validated = parseSnapshot(snapshot);
      messages = validated;
      runningTokens = validated.reduce((sum, message) => sum + message.tokenCount, 0);
    },

    totalTokens() {
      return runningTokens;
    },
  };
}
