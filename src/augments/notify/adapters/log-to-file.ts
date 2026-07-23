/**
 * log-to-file notify adapter.
 *
 * Appends one JSON object per notification to a file (JSONL). Default
 * destination shipped by the scaffold so `auggy create` + `auggy dev`
 * has a working notify path with zero env-var setup — operators can
 * `tail -f notifications.jsonl` to see what the agent escalates.
 *
 * Errors are caught and surfaced as `status: "failed"` per the
 * NotifyAdapter contract; no throws.
 */

import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  LogToFileNotifyDestination,
  NotifyAdapter,
  NotifyDeliveryResult,
  NotifyDestination,
  NotifyPayload,
} from "../../../types";

export function createLogToFileAdapter(): NotifyAdapter {
  return {
    async deliver(
      destination: NotifyDestination,
      payload: NotifyPayload,
      options?: { signal?: AbortSignal },
    ): Promise<NotifyDeliveryResult> {
      if (destination.transport !== "log-to-file") {
        return {
          status: "failed",
          detail: `logToFileAdapter received non-log-to-file destination: ${destination.transport}`,
        };
      }
      const dest = destination as LogToFileNotifyDestination;

      const record = {
        timestamp: new Date().toISOString(),
        destination: dest.name,
        summary: payload.summary,
        ...(payload.reason !== undefined ? { reason: payload.reason } : {}),
        ...(payload.visitor !== undefined ? { visitor: payload.visitor } : {}),
      };

      try {
        options?.signal?.throwIfAborted();
        // Ensure the directory exists. Relative paths resolve against CWD
        // — `auggy dev` sets CWD to the agent dir before booting, so the
        // default `./notifications.jsonl` lands in the agent dir.
        mkdirSync(dirname(dest.path), { recursive: true });
        appendFileSync(dest.path, `${JSON.stringify(record)}\n`, { mode: 0o600 });
        return { status: "sent" };
      } catch (err) {
        return {
          status: "failed",
          detail: `log-to-file append failed: ${(err as Error).message}`,
        };
      }
    },
  };
}
