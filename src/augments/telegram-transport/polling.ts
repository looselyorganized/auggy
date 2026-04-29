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

  const done = (async () => {
    while (true) {
      let updates: TelegramUpdate[];
      try {
        updates = await opts.client.getUpdates({ offset: nextOffset, timeoutSec });
      } catch (err) {
        log.warn(
          `[telegram-transport.polling] getUpdates error: ${(err as Error).message} — retrying in ${errorBackoffMs}ms`,
        );
        await new Promise((r) => setTimeout(r, errorBackoffMs));
        continue;
      }
      if (stopped) break;
      for (const update of updates) {
        if (stopped) break;
        nextOffset = update.update_id + 1;
        await opts.onUpdate(update);
      }
      // Yield to the macrotask queue between iterations so that callers (e.g.
      // tests using setTimeout to signal stop) can fire between polls. In
      // production this is a no-op relative to the 30 s long-poll latency.
      if (!stopped) await new Promise<void>((r) => setTimeout(r, 0));
    }
  })();

  return {
    stop() {
      stopped = true;
    },
    done,
  };
}
