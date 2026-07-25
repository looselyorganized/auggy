import { randomUUID } from "node:crypto";
import type { TelegramBotClient, TelegramUpdate } from "../../telegram-client";
import { TelegramBotApiError } from "../../telegram-client";
import { TelegramReplayConflictError } from "./replay-store";

export type PollLoopConflictKind =
  | "replay-payload"
  | "polling-ownership"
  | "invalid-update-sequence";

export interface PollLoopConflict {
  id: string;
  kind: PollLoopConflictKind;
  detectedAt: number;
  updateId?: number;
}

export interface PollLoopSnapshot {
  state: "running" | "conflict-quarantined" | "stopped";
  conflict: PollLoopConflict | null;
  nextOffset?: number;
}

export interface PollLoopOptions {
  client: TelegramBotClient;
  timeoutSec?: number;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  initialConflict?: PollLoopConflict;
  waitForReplayRecovery?: (conflict: PollLoopConflict, signal: AbortSignal) => Promise<void>;
  errorBackoffMs?: number;
  log?: { warn: (msg: string) => void };
  now?: () => number;
  randomUUID?: () => string;
  onStateChange?: (snapshot: PollLoopSnapshot) => void;
}

export interface PollLoopHandle {
  stop(): void;
  recoverConflict(conflictId: string): boolean;
  snapshot(): PollLoopSnapshot;
  done: Promise<void>;
}

export function runPollLoop(opts: PollLoopOptions): PollLoopHandle {
  const timeoutSec = opts.timeoutSec ?? 30;
  const errorBackoffMs = opts.errorBackoffMs ?? 5000;
  const log = opts.log ?? console;
  const now = opts.now ?? Date.now;
  const mintConflictId = opts.randomUUID ?? randomUUID;

  let stopped = false;
  let nextOffset: number | undefined;
  let activePoll: AbortController | null = null;
  let wakeBackoff: (() => void) | null = null;
  let conflict: PollLoopConflict | null = null;
  let wakeConflict: (() => void) | null = null;
  let activeConflictWait: AbortController | null = null;

  function snapshot(): PollLoopSnapshot {
    const activeConflict = conflict ? Object.freeze({ ...conflict }) : null;
    return Object.freeze({
      state: stopped ? "stopped" : conflict ? "conflict-quarantined" : "running",
      conflict: activeConflict,
      ...(nextOffset !== undefined ? { nextOffset } : {}),
    });
  }

  function publishState(): void {
    opts.onStateChange?.(snapshot());
  }

  function sleep(ms: number): Promise<void> {
    if (stopped) return Promise.resolve();
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        wakeBackoff = null;
        resolve();
      }, ms);
      wakeBackoff = () => {
        clearTimeout(timer);
        wakeBackoff = null;
        resolve();
      };
    });
  }

  function isExpectedStopError(err: unknown): boolean {
    if (!stopped) return false;
    if (!(err instanceof Error)) return true;
    return (
      err.name === "AbortError" ||
      err.name === "TimeoutError" ||
      /abort|cancel|terminated/i.test(err.message)
    );
  }

  function pollingOwnershipConflict(error: unknown): boolean {
    return (
      error instanceof TelegramBotApiError &&
      error.method === "getUpdates" &&
      (error.httpStatus === 409 || error.apiErrorCode === 409)
    );
  }

  function conflictId(): string {
    const id = mintConflictId();
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) {
      throw new Error("Telegram polling generated an invalid conflict id.");
    }
    return id;
  }

  async function quarantine(next: PollLoopConflict): Promise<void> {
    if (stopped) return;
    const localRecovery = new Promise<"local">((resolve) => {
      wakeConflict = () => resolve("local");
    });
    conflict = Object.freeze({ ...next });
    publishState();
    activeConflictWait = new AbortController();
    const remoteRecovery =
      next.kind === "replay-payload" && opts.waitForReplayRecovery
        ? opts
            .waitForReplayRecovery(next, activeConflictWait.signal)
            .then(() => "remote" as const)
            .catch(
              () =>
                new Promise<never>(() => {
                  // Fail closed. Local recovery or shutdown still wakes the latch.
                }),
            )
        : new Promise<never>(() => {});
    const recoveredBy = await Promise.race([localRecovery, remoteRecovery]);
    if (recoveredBy === "remote" && conflict?.id === next.id) {
      conflict = null;
      publishState();
    }
    activeConflictWait.abort();
    activeConflictWait = null;
    wakeConflict = null;
  }

  function invalidBatch(updates: unknown): TelegramUpdate[] | null {
    if (!Array.isArray(updates)) return null;
    let previous = nextOffset === undefined ? -1 : nextOffset - 1;
    for (const update of updates) {
      const updateId = (update as TelegramUpdate | null)?.update_id;
      if (
        !Number.isSafeInteger(updateId) ||
        (updateId as number) < 0 ||
        (updateId as number) >= Number.MAX_SAFE_INTEGER ||
        (updateId as number) <= previous
      ) {
        return null;
      }
      previous = updateId as number;
    }
    return updates as TelegramUpdate[];
  }

  const done = (async () => {
    if (opts.initialConflict) await quarantine(opts.initialConflict);
    while (!stopped) {
      let updates: TelegramUpdate[];
      activePoll = new AbortController();
      try {
        updates = await opts.client.getUpdates({
          offset: nextOffset,
          timeoutSec,
          signal: activePoll.signal,
        });
      } catch (err) {
        if (isExpectedStopError(err)) break;
        if (pollingOwnershipConflict(err)) {
          log.warn(
            "[telegram-transport.polling] Telegram polling ownership conflict — polling quarantined pending operator recovery",
          );
          await quarantine({
            id: conflictId(),
            kind: "polling-ownership",
            detectedAt: now(),
          });
          continue;
        }
        log.warn(
          `[telegram-transport.polling] getUpdates error: ${(err as Error).message} — retrying in ${errorBackoffMs}ms`,
        );
        await sleep(errorBackoffMs);
        continue;
      } finally {
        activePoll = null;
      }
      if (stopped) break;
      const validatedUpdates = invalidBatch(updates);
      if (!validatedUpdates) {
        log.warn(
          "[telegram-transport.polling] invalid Telegram update sequence — polling quarantined pending operator recovery",
        );
        await quarantine({
          id: conflictId(),
          kind: "invalid-update-sequence",
          detectedAt: now(),
        });
        continue;
      }
      for (const update of validatedUpdates) {
        if (stopped) break;
        try {
          await opts.onUpdate(update);
          const candidate = update.update_id + 1;
          nextOffset = Math.max(nextOffset ?? candidate, candidate);
        } catch (error) {
          if (error instanceof TelegramReplayConflictError) {
            log.warn(
              `[telegram-transport.polling] replay conflict at update_id=${error.conflict.updateId} — polling quarantined pending operator recovery`,
            );
            await quarantine({
              id: error.conflict.id,
              kind: "replay-payload",
              detectedAt: error.conflict.detectedAt,
              updateId: error.conflict.updateId,
            });
            break;
          }
          log.warn(
            "[telegram-transport.polling] update processing failed before checkpoint — retrying",
          );
          await sleep(errorBackoffMs);
          break;
        }
      }
      // Yield to the macrotask queue between iterations so that callers (e.g.
      // tests using setTimeout to signal stop) can fire between polls. In
      // production this is a no-op relative to the 30 s long-poll latency.
      if (!stopped) await new Promise<void>((r) => setTimeout(r, 0));
    }
  })().finally(() => {
    stopped = true;
    conflict = null;
    activeConflictWait?.abort();
    activeConflictWait = null;
    wakeConflict?.();
    wakeConflict = null;
    publishState();
  });

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      activePoll?.abort();
      wakeBackoff?.();
      activeConflictWait?.abort();
      wakeConflict?.();
      publishState();
    },
    recoverConflict(conflictIdToRecover) {
      if (stopped || !conflict || conflict.id !== conflictIdToRecover) return false;
      conflict = null;
      activeConflictWait?.abort();
      const resume = wakeConflict;
      wakeConflict = null;
      resume?.();
      publishState();
      return true;
    },
    snapshot,
    done,
  };
}
