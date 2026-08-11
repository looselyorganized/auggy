import { createAgentMailSdkAdapters } from "../../src/augments/agentMail/sdk-provider";

const INBOX_ID = "support@agentmail.to";
const API_KEY = "am_loopback_contract_sentinel";
const EVENT_TYPES = ["message.received"] as const;

function withTimeout<T>(promise: Promise<T>, label: string, timeoutMs = 12_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), timeoutMs);
    }),
  ]).finally(() => clearTimeout(timer));
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function receivedEvent(generation: number): Record<string, unknown> {
  const messageId = `message_${generation}`;
  const threadId = `thread_${generation}`;
  const timestamp = `2026-08-11T10:00:0${generation}.000Z`;
  return {
    type: "event",
    event_type: "message.received",
    event_id: `event_${generation}`,
    message: {
      inbox_id: INBOX_ID,
      thread_id: threadId,
      message_id: messageId,
      labels: ["received"],
      timestamp,
      from: "customer@example.com",
      reply_to: [],
      to: [INBOX_ID],
      cc: [],
      bcc: [],
      subject: `Loopback event ${generation}`,
      text: "AgentMail pinned-SDK contract event",
      attachments: [],
      references: [],
      size: 128,
      updated_at: timestamp,
      created_at: timestamp,
    },
    thread: {
      inbox_id: INBOX_ID,
      thread_id: threadId,
      labels: ["received"],
      timestamp,
      senders: ["customer@example.com"],
      recipients: [INBOX_ID],
      attachments: [],
      last_message_id: messageId,
      message_count: 1,
      size: 128,
      updated_at: timestamp,
      created_at: timestamp,
    },
  };
}

function startLoopbackServer() {
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  const generations = new WeakMap<object, number>();
  let connections = 0;

  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        // Bun 1.3.14 can report EADDRINUSE for port 0, so bounded distinct
        // fallback ports keep the regression contract deterministic.
        port: attempt === 0 ? 0 : fallbackStart + attempt - 1,
        fetch(request, bunServer) {
          const url = new URL(request.url);
          const expectedAuthorization = `Bearer ${API_KEY}`;
          if (
            url.pathname === "/v0" &&
            request.headers.get("authorization") === expectedAuthorization &&
            bunServer.upgrade(request, { data: undefined })
          ) {
            return;
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          open(socket) {
            generations.set(socket, ++connections);
          },
          message(socket, rawMessage) {
            const generation = generations.get(socket);
            if (!generation) {
              socket.close(1011, "missing connection generation");
              return;
            }
            const message = JSON.parse(
              typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
            ) as {
              type?: string;
              inbox_ids?: string[];
              event_types?: string[];
            };
            if (
              message.type !== "subscribe" ||
              message.inbox_ids?.length !== 1 ||
              message.inbox_ids[0] !== INBOX_ID ||
              message.event_types?.length !== 1 ||
              message.event_types[0] !== EVENT_TYPES[0]
            ) {
              socket.close(1008, "unexpected subscription");
              return;
            }

            console.log(JSON.stringify({ event: "SERVER_SUBSCRIBE", generation }));
            socket.send(
              JSON.stringify({
                type: "subscribed",
                inbox_ids: message.inbox_ids,
                event_types: message.event_types,
              }),
            );
            socket.send(JSON.stringify(receivedEvent(generation)));

            if (generation === 1) {
              // Exercise the SDK's reconnecting wrapper, not just its first connection.
              setTimeout(() => socket.close(1012, "contract reconnect"), 25);
            }
          },
        },
      });
    } catch (error) {
      lastError = error;
      if ((error as { code?: string }).code !== "EADDRINUSE") throw error;
    }
  }
  throw lastError;
}

const unhandled: unknown[] = [];
process.on("unhandledRejection", (error) => {
  unhandled.push(error);
});

const server = startLoopbackServer();
console.log(JSON.stringify({ event: "LOOPBACK_READY" }));

try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const adapters = createAgentMailSdkAdapters({
    apiKey: API_KEY,
    apiBaseUrl: baseUrl,
    websocketBaseUrl: baseUrl.replace("http:", "ws:"),
    allowInsecureHttpWithCredentials: true,
    handshakeTimeoutMs: 6_500,
    connectionTimeoutMs: 1_000,
  });
  const reconnected = deferred<void>();
  const secondEvent = deferred<void>();
  const deliveries: string[] = [];
  const subscription = await withTimeout(
    adapters.live.subscribe({
      inboxId: INBOX_ID,
      eventTypes: [...EVENT_TYPES],
      async onEvent(envelope) {
        deliveries.push(envelope.message.messageId);
        console.log(
          JSON.stringify({
            event: "EVENT_RECEIVED",
            messageId: envelope.message.messageId,
            source: envelope.source,
          }),
        );
        if (deliveries.length === 2) secondEvent.resolve();
      },
      async onSubscribed(value) {
        console.log(JSON.stringify({ event: "SUBSCRIBED", reconnected: value.reconnected }));
        if (value.reconnected) reconnected.resolve();
      },
      onError() {
        // The deliberate 1012 close between generations is expected and retryable.
      },
    }),
    "initial AgentMail subscription",
  );

  await withTimeout(
    Promise.all([reconnected.promise, secondEvent.promise]),
    "AgentMail reconnect and second event",
  );
  await withTimeout(subscription.close(), "AgentMail subscription close");
  await withTimeout(subscription.closed, "AgentMail closed signal");
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (unhandled.length > 0)
    throw new Error("AgentMail subscription produced an unhandled rejection");
  if (deliveries.join(",") !== "message_1,message_2") {
    throw new Error("AgentMail subscription did not preserve event delivery across reconnect");
  }
  console.log(JSON.stringify({ event: "CLOSED" }));
} finally {
  server.stop(true);
}
