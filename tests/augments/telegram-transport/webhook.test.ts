import { describe, it, expect } from "bun:test";
import { createServer } from "node:net";
import {
  startWebhookServer,
  type WebhookServerHandle,
  type WebhookServerOptions,
} from "../../../src/augments/telegramTransport/webhook";
import type { TelegramUpdate } from "../../../src/telegram-client";

function isAddressInUse(error: unknown): boolean {
  return (
    (typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EADDRINUSE") ||
    (error instanceof Error && /address already in use|port .* in use/i.test(error.message))
  );
}

async function reserveEphemeralPort(): Promise<number> {
  const reservation = createServer();
  await new Promise<void>((resolve, reject) => {
    reservation.once("error", reject);
    reservation.listen(0, "127.0.0.1", resolve);
  });
  const address = reservation.address();
  const port = typeof address === "object" && address ? address.port : undefined;
  await new Promise<void>((resolve, reject) => {
    reservation.close((error) => (error ? reject(error) : resolve()));
  });
  if (port === undefined) throw new Error("Telegram webhook test port reservation did not bind");
  return port;
}

async function withWebhookServer<T>(
  options: Omit<WebhookServerOptions, "port">,
  run: (port: number) => Promise<T>,
): Promise<T> {
  let collision: unknown;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const port = await reserveEphemeralPort();
    let server: WebhookServerHandle | undefined;
    try {
      server = await startWebhookServer({ ...options, port });
      return await run(port);
    } catch (error) {
      if (server === undefined && isAddressInUse(error)) {
        collision = error;
        continue;
      }
      throw error;
    } finally {
      server?.stop();
    }
  }
  throw collision ?? new Error("Could not allocate a Telegram webhook test port");
}

describe("startWebhookServer", () => {
  it("rejects an empty authentication secret before binding", async () => {
    await expect(
      startWebhookServer({ port: 0, secretToken: "", onUpdate: () => {} }),
    ).rejects.toThrow("must contain 1 to 256");
  });

  it("accepts POST with valid secret-token header and dispatches onUpdate", async () => {
    const received: TelegramUpdate[] = [];
    await withWebhookServer(
      {
        secretToken: "VALID",
        onUpdate: (u) => {
          received.push(u);
        },
      },
      async (port) => {
        const update = {
          update_id: 1,
          message: { message_id: 1, chat: { id: 99, type: "private" }, date: 0, text: "hi" },
        };
        const res = await fetch(`http://localhost:${port}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "VALID",
          },
          body: JSON.stringify(update),
        });
        expect(res.status).toBe(200);
        await new Promise((resolve) => setTimeout(resolve, 20));
        expect(received).toHaveLength(1);
        expect(received[0]?.update_id).toBe(1);
      },
    );
  });

  it("rejects POST with missing secret-token → 401, no onUpdate", async () => {
    const received: TelegramUpdate[] = [];
    await withWebhookServer(
      {
        secretToken: "VALID",
        onUpdate: (u) => {
          received.push(u);
        },
      },
      async (port) => {
        const res = await fetch(`http://localhost:${port}/`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ update_id: 1 }),
        });
        expect(res.status).toBe(401);
        expect(received).toHaveLength(0);
      },
    );
  });

  it("rejects POST with wrong secret-token → 401, no onUpdate", async () => {
    const received: TelegramUpdate[] = [];
    await withWebhookServer(
      {
        secretToken: "VALID",
        onUpdate: (u) => {
          received.push(u);
        },
      },
      async (port) => {
        const res = await fetch(`http://localhost:${port}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "WRONG",
          },
          body: JSON.stringify({ update_id: 1 }),
        });
        expect(res.status).toBe(401);
        expect(received).toHaveLength(0);
      },
    );
  });

  it("rejects non-POST methods", async () => {
    await withWebhookServer({ secretToken: "X", onUpdate: () => {} }, async (port) => {
      const res = await fetch(`http://localhost:${port}/`, { method: "GET" });
      expect(res.status).toBe(405);
    });
  });

  it("rejects malformed JSON", async () => {
    await withWebhookServer({ secretToken: "X", onUpdate: () => {} }, async (port) => {
      const res = await fetch(`http://localhost:${port}/`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-telegram-bot-api-secret-token": "X",
        },
        body: "not json",
      });
      expect(res.status).toBe(400);
    });
  });

  it("rejects an oversized body before dispatch", async () => {
    let calls = 0;
    await withWebhookServer(
      {
        secretToken: "X",
        maxBodyBytes: 16,
        onUpdate: () => {
          calls++;
        },
      },
      async (port) => {
        const res = await fetch(`http://localhost:${port}/`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-telegram-bot-api-secret-token": "X",
          },
          body: JSON.stringify({ update_id: 1, padding: "x".repeat(100) }),
        });
        expect(res.status).toBe(413);
        expect(calls).toBe(0);
      },
    );
  });
});
