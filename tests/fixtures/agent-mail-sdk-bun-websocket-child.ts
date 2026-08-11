import { createAgentMailSdkAdapters } from "../../src/augments/agentMail/sdk-provider";

const INBOX_ID = "support@agentmail.to";
const API_KEY = "am_loopback_contract_sentinel";

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 1_500);
    }),
  ]).finally(() => clearTimeout(timer));
}

function startLoopbackServer(): ReturnType<typeof Bun.serve> {
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        // Bun 1.3.14 can report EADDRINUSE for port 0, so bounded distinct
        // fallback ports keep the regression contract deterministic.
        port: attempt === 0 ? 0 : fallbackStart + attempt - 1,
        fetch(request, bunServer) {
          const url = new URL(request.url);
          if (url.pathname === "/v0" && bunServer.upgrade(request, { data: undefined })) return;
          return new Response("not found", { status: 404 });
        },
        websocket: {
          message(socket, rawMessage) {
            const message = JSON.parse(
              typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
            ) as {
              type?: string;
              inbox_ids?: string[];
              event_types?: string[];
            };
            if (message.type !== "subscribe") {
              socket.close(1008, "unexpected message");
              return;
            }
            socket.send(
              JSON.stringify({
                type: "subscribed",
                inbox_ids: message.inbox_ids,
                event_types: message.event_types,
              }),
            );
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

const server = startLoopbackServer();

console.log(JSON.stringify({ event: "LOOPBACK_READY" }));

try {
  const baseUrl = `http://127.0.0.1:${server.port}`;
  const adapters = createAgentMailSdkAdapters({
    apiKey: API_KEY,
    apiBaseUrl: baseUrl,
    websocketBaseUrl: baseUrl.replace("http:", "ws:"),
    allowInsecureHttpWithCredentials: true,
    handshakeTimeoutMs: 1_000,
    connectionTimeoutMs: 1_000,
  });
  const subscription = await withTimeout(
    adapters.live.subscribe({
      inboxId: INBOX_ID,
      eventTypes: ["message.received"],
      async onEvent() {},
      onError() {},
    }),
    "AgentMail subscription",
  );
  await withTimeout(subscription.close(), "AgentMail subscription close");
  console.log(JSON.stringify({ event: "SUBSCRIBED" }));
} finally {
  server.stop(true);
}
