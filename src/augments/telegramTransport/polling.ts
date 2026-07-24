import type { TelegramBotClient, TelegramUpdate } from "../../telegram-client";

export interface PollLoopOptions {
  client: TelegramBotClient;
  timeoutSec?: number;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  errorBackoffMs?: number;
  log?: { warn: (msg: string) => void };
}

export interface PollLoopHandle {
  stop(): void;
  done: Promise<void>;
}

export function runPollLoop(opts: PollLoopOptions): PollLoopHandle {
  const timeoutSec = opts.timeoutSec ?? 30;
  const errorBackoffMs = opts.errorBackoffMs ?? 5000;
  const log = opts.log ?? console;

  let stopped = false;
  let nextOffset: number | undefined;
  let activePoll: AbortController | null = null;
  let wakeBackoff: (() => void) | null = null;

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

  const done = (async () => {
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
        log.warn(
          `[telegram-transport.polling] getUpdates error: ${(err as Error).message} — retrying in ${errorBackoffMs}ms`,
        );
        await sleep(errorBackoffMs);
        continue;
      } finally {
        activePoll = null;
      }
      if (stopped) break;
      for (const update of updates) {
        if (stopped) break;
        try {
          await opts.onUpdate(update);
          nextOffset = update.update_id + 1;
        } catch {
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
  })();

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      activePoll?.abort();
      wakeBackoff?.();
    },
    done,
  };
}
