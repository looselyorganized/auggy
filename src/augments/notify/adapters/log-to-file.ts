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

import { closeSync } from "node:fs";
import { basename, dirname } from "node:path";
import { appendPinnedFile, pinDirectory } from "../../../lib/anchored-files";
import type {
  LogToFileNotifyDestination,
  NotifyAdapter,
  NotifyDeliveryResult,
  NotifyDestination,
  NotifyPayload,
} from "../../../types";

export function createLogToFileAdapter(
  adapterOptions: {
    /** @internal Deterministic boundary hook for regression tests. */
    __testHooks?: { afterParentPinned?: () => void | Promise<void> };
  } = {},
): NotifyAdapter {
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

      let parentFd: number | undefined;
      try {
        options?.signal?.throwIfAborted();
        const parent = pinDirectory(dirname(dest.path), "log-to-file parent", { create: true });
        parentFd = parent.fd;
        await adapterOptions.__testHooks?.afterParentPinned?.();
        options?.signal?.throwIfAborted();
        appendPinnedFile(
          parentFd,
          basename(dest.path),
          `${JSON.stringify(record)}\n`,
          "log-to-file destination",
        );
        return { status: "sent" };
      } catch (err) {
        return {
          status: "failed",
          detail: `log-to-file append failed: ${(err as Error).message}`,
        };
      } finally {
        if (parentFd !== undefined) closeSync(parentFd);
      }
    },
  };
}
