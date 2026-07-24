import { timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "../../telegram-client";
import {
  InvalidRequestBodyError,
  readRequestBodyJson,
  RequestBodyTooLargeError,
} from "../../transports/request-body";
import { InvalidTelegramUpdateError, TelegramReplayConflictError } from "./replay-store";

export interface WebhookServerOptions {
  port: number;
  secretToken: string;
  maxBodyBytes?: number;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  log?: { warn: (msg: string) => void };
}

export interface WebhookServerHandle {
  stop(): void;
}

export async function startWebhookServer(opts: WebhookServerOptions): Promise<WebhookServerHandle> {
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(opts.secretToken)) {
    throw new TypeError(
      "[telegram-transport.webhook] secretToken must contain 1 to 256 letters, numbers, underscores, or hyphens",
    );
  }
  const log = opts.log ?? console;
  const expected = Buffer.from(opts.secretToken, "utf8");

  function safeCompare(provided: string | null): boolean {
    if (provided == null) return false;
    const providedBuf = Buffer.from(provided, "utf8");
    if (providedBuf.length !== expected.length) return false;
    return timingSafeEqual(providedBuf, expected);
  }

  const server = Bun.serve({
    port: opts.port,
    async fetch(req: Request): Promise<Response> {
      if (req.method !== "POST") {
        return new Response(null, { status: 405 });
      }
      const provided = req.headers.get("x-telegram-bot-api-secret-token");
      if (!safeCompare(provided)) {
        return new Response(null, { status: 401 });
      }
      let body: unknown;
      try {
        body = await readRequestBodyJson(req, opts.maxBodyBytes ?? 256 * 1024);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError) {
          return new Response(null, { status: 413 });
        }
        if (!(error instanceof InvalidRequestBodyError)) {
          log.warn("[telegram-transport.webhook] request body read failed");
        }
        return new Response(null, { status: 400 });
      }
      try {
        await opts.onUpdate(body as TelegramUpdate);
      } catch (error) {
        if (error instanceof InvalidTelegramUpdateError) {
          return new Response(null, { status: 400 });
        }
        if (error instanceof TelegramReplayConflictError) {
          return new Response(null, { status: 409 });
        }
        log.warn("[telegram-transport.webhook] update processing failed");
        return new Response(null, { status: 503, headers: { "retry-after": "1" } });
      }
      return new Response(null, { status: 200 });
    },
  });

  return {
    stop() {
      server.stop(true);
    },
  };
}
