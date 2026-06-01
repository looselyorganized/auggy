import { timingSafeEqual } from "node:crypto";
import type { TelegramUpdate } from "../../telegram-client";

export interface WebhookServerOptions {
  port: number;
  secretToken: string;
  onUpdate: (update: TelegramUpdate) => void | Promise<void>;
  log?: { warn: (msg: string) => void };
}

export interface WebhookServerHandle {
  stop(): void;
}

export async function startWebhookServer(opts: WebhookServerOptions): Promise<WebhookServerHandle> {
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
        body = await req.json();
      } catch {
        return new Response(null, { status: 400 });
      }
      try {
        await opts.onUpdate(body as TelegramUpdate);
      } catch (err) {
        log.warn(`[telegram-transport.webhook] onUpdate threw: ${(err as Error).message}`);
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
