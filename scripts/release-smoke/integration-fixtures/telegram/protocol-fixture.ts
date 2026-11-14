import { INTEGRATION_LIMITS } from "../../integration-contracts";

export interface FixtureUpdate {
  update_id: number;
  message: {
    message_id: number;
    date: number;
    from: { id: number; is_bot: boolean; first_name: string };
    chat: { id: number; type: "private" | "group" };
    text: string;
  };
}

export type TelegramJournalEvent =
  | {
      kind: "poll";
      offset: number | null;
      timeout: number;
      updateIds: number[];
      json: true;
      runtimeUserAgent: true;
    }
  | { kind: "reply"; chatId: number; text: string; json: true; runtimeUserAgent: true }
  | { kind: "validate-agent"; userId: number }
  | {
      kind: "attempt" | "effect";
      marker: string;
      trust: string;
      peerId: string;
      peerKind: string;
      publicSubstate: "recognized" | "anonymous" | null;
      threadId: string;
    };

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

async function body(request: Request): Promise<Record<string, unknown>> {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("Fixture request has no body.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, 2_000);
  try {
    while (true) {
      const next = await reader.read();
      if (timedOut) throw new Error("Fixture body timed out.");
      if (next.done) break;
      size += next.value.byteLength;
      if (size > INTEGRATION_LIMITS.fixtureRequestBytes)
        throw new Error("Fixture body exceeded bound.");
      chunks.push(next.value);
    }
    const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!record(parsed)) throw new Error("Fixture body must be an object.");
    return parsed;
  } finally {
    clearTimeout(timer);
    void reader.cancel().catch(() => {});
  }
}

/** Private control plane is the returned object, never an HTTP control endpoint. */
export function createTelegramProtocolFixture() {
  const events: TelegramJournalEvent[] = [];
  const waiting = new Set<() => void>();
  let pending: FixtureUpdate[] = [];
  let stopped = false;
  let activeRequests = 0;
  let rejectedRequests = 0;
  let bytes = 0;
  const append = (event: TelegramJournalEvent) => {
    bytes += Buffer.byteLength(JSON.stringify(event));
    if (
      events.length >= INTEGRATION_LIMITS.fixtureEvents ||
      bytes > INTEGRATION_LIMITS.fixtureJournalBytes
    )
      throw new Error("Fixture journal exceeded bound.");
    events.push(event);
  };
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 5,
    maxRequestBodySize: INTEGRATION_LIMITS.fixtureRequestBytes,
    async fetch(request) {
      if (stopped || activeRequests >= 8) return new Response(null, { status: 503 });
      activeRequests++;
      try {
        const url = new URL(request.url);
        if (
          request.method !== "POST" ||
          url.search ||
          !request.headers.get("content-type")?.startsWith("application/json")
        )
          throw new Error("Invalid fixture request envelope.");
        const input = await body(request);
        if (
          url.pathname.startsWith("/telegram/") &&
          request.headers.get("user-agent") !== "auggy-telegram/0.1"
        )
          throw new Error("Expected the packed Telegram HTTP client.");
        const api = (result: unknown) => Response.json({ ok: true, result });
        if (url.pathname === "/telegram/getUpdates") {
          if (
            (input.offset !== undefined && !Number.isSafeInteger(input.offset)) ||
            !Number.isSafeInteger(input.timeout) ||
            (input.timeout as number) < 0 ||
            (input.timeout as number) > 30 ||
            (input.allowed_updates !== undefined &&
              (!Array.isArray(input.allowed_updates) ||
                input.allowed_updates.join(",") !== "message"))
          )
            throw new Error("Invalid getUpdates serialization.");
          if (!pending.length && !stopped) {
            await new Promise<void>((resolve) => {
              const finish = () => {
                clearTimeout(timer);
                waiting.delete(finish);
                request.signal.removeEventListener("abort", finish);
                resolve();
              };
              const timer = setTimeout(finish, 250);
              waiting.add(finish);
              request.signal.addEventListener("abort", finish, { once: true });
              if (request.signal.aborted) finish();
            });
          }
          const updates = pending;
          pending = [];
          append({
            kind: "poll",
            offset: (input.offset as number | undefined) ?? null,
            timeout: input.timeout as number,
            updateIds: updates.map((update) => update.update_id),
            json: true,
            runtimeUserAgent: true,
          });
          return api(updates);
        }
        if (url.pathname === "/telegram/getChat" && Number.isSafeInteger(input.chat_id)) {
          append({ kind: "validate-agent", userId: input.chat_id as number });
          return api({ id: input.chat_id, type: "private", first_name: "Fixture peer" });
        }
        if (
          url.pathname === "/telegram/sendMessage" &&
          Number.isSafeInteger(input.chat_id) &&
          typeof input.text === "string" &&
          input.text.length <= 4096
        ) {
          append({
            kind: "reply",
            chatId: input.chat_id as number,
            text: input.text,
            json: true,
            runtimeUserAgent: true,
          });
          return api({ message_id: events.length, chat: { id: input.chat_id, type: "private" } });
        }
        if (["/telegram/deleteWebhook", "/telegram/setWebhook"].includes(url.pathname))
          return api(true);
        if (["/attempt", "/effect"].includes(url.pathname)) {
          const keys = ["marker", "trust", "peerId", "peerKind", "threadId"] as const;
          if (
            Object.keys(input).length !== keys.length + 1 ||
            ![null, "recognized", "anonymous"].includes(input.publicSubstate as string | null) ||
            !keys.every(
              (key) => typeof input[key] === "string" && (input[key] as string).length <= 256,
            )
          )
            throw new Error("Invalid domain observation.");
          append({
            kind: url.pathname === "/attempt" ? "attempt" : "effect",
            marker: input.marker as string,
            trust: input.trust as string,
            peerId: input.peerId as string,
            peerKind: input.peerKind as string,
            publicSubstate: input.publicSubstate as "recognized" | "anonymous" | null,
            threadId: input.threadId as string,
          });
          return Response.json({ accepted: true });
        }
        throw new Error("Unknown fixture path.");
      } catch {
        rejectedRequests++;
        return Response.json(
          { ok: false, error_code: 400, description: "Fixture request rejected." },
          { status: 400 },
        );
      } finally {
        activeRequests--;
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    enqueue(update: FixtureUpdate) {
      if (stopped || pending.length >= 16) throw new Error("Fixture update queue unavailable.");
      pending.push(structuredClone(update));
      for (const wake of waiting) wake();
    },
    snapshot() {
      return { events: structuredClone(events), activeRequests, rejectedRequests };
    },
    async stop() {
      stopped = true;
      pending = [];
      for (const wake of waiting) wake();
      await server.stop(true);
      if (activeRequests !== 0) throw new Error("Fixture requests did not quiesce.");
    },
  };
}

export function telegramFixtureUpdate(
  id: number,
  userId: number,
  chatId = userId,
  chatType: "private" | "group" = "private",
): FixtureUpdate {
  return {
    update_id: id,
    message: {
      message_id: id,
      date: 1_700_000_000,
      from: { id: userId, is_bot: false, first_name: "Fixture peer" },
      chat: { id: chatId, type: chatType },
      text: "Run the fixture probe.",
    },
  };
}
