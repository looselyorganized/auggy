import { describe, it, expect } from "bun:test";
import { startWebhookServer } from "../../../src/augments/telegramTransport/webhook";
import type { TelegramUpdate } from "../../../src/telegram-client";

function freePort(): number {
  // Quick way: pick random in 30000-40000. Tests run sequentially in bun:test so collisions rare.
  return 30000 + Math.floor(Math.random() * 9999);
}

describe("startWebhookServer", () => {
  it("accepts POST with valid secret-token header and dispatches onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => {
        received.push(u);
      },
    });
    const update = {
      update_id: 1,
      message: { message_id: 1, chat: { id: 99, type: "private" }, date: 0, text: "hi" },
    };
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "VALID" },
      body: JSON.stringify(update),
    });
    expect(res.status).toBe(200);
    await new Promise((r) => setTimeout(r, 20));
    expect(received).toHaveLength(1);
    expect(received[0]?.update_id).toBe(1);
    server.stop();
  });

  it("rejects POST with missing secret-token → 401, no onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => {
        received.push(u);
      },
    });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
    server.stop();
  });

  it("rejects POST with wrong secret-token → 401, no onUpdate", async () => {
    const port = freePort();
    const received: TelegramUpdate[] = [];
    const server = await startWebhookServer({
      port,
      secretToken: "VALID",
      onUpdate: (u) => {
        received.push(u);
      },
    });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "WRONG" },
      body: JSON.stringify({ update_id: 1 }),
    });
    expect(res.status).toBe(401);
    expect(received).toHaveLength(0);
    server.stop();
  });

  it("rejects non-POST methods", async () => {
    const port = freePort();
    const server = await startWebhookServer({ port, secretToken: "X", onUpdate: () => {} });
    const res = await fetch(`http://localhost:${port}/`, { method: "GET" });
    expect(res.status).toBe(405);
    server.stop();
  });

  it("rejects malformed JSON", async () => {
    const port = freePort();
    const server = await startWebhookServer({ port, secretToken: "X", onUpdate: () => {} });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "X" },
      body: "not json",
    });
    expect(res.status).toBe(400);
    server.stop();
  });

  it("rejects an oversized body before dispatch", async () => {
    const port = freePort();
    let calls = 0;
    const server = await startWebhookServer({
      port,
      secretToken: "X",
      maxBodyBytes: 16,
      onUpdate: () => {
        calls++;
      },
    });
    const res = await fetch(`http://localhost:${port}/`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-telegram-bot-api-secret-token": "X" },
      body: JSON.stringify({ update_id: 1, padding: "x".repeat(100) }),
    });
    expect(res.status).toBe(413);
    expect(calls).toBe(0);
    server.stop();
  });
});
