import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { agentMail } from "auggy";

const API_KEY = "am_packed_runtime_contract_sentinel";
const INBOX_ID = "packed-runtime@agentmail.to";

function deferred(): { promise: Promise<void>; resolve(): void } {
  let resolve!: () => void;
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 2_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

function assertPackedResolution(): void {
  const expectedConsumerRoot = process.env.AUGGY_PACKED_CONSUMER_ROOT;
  const sourceRoot = process.env.AUGGY_SOURCE_ROOT;
  if (!expectedConsumerRoot || !sourceRoot) {
    throw new Error("packed AgentMail runtime contract requires its isolated-path boundaries");
  }
  const resolved = realpathSync(Bun.resolveSync("auggy", import.meta.dir));
  const consumerNodeModules = `${realpathSync(expectedConsumerRoot)}${sep}node_modules${sep}auggy${sep}`;
  if (!resolved.startsWith(consumerNodeModules)) {
    throw new Error("packed AgentMail runtime resolved outside the isolated consumer");
  }
  if (resolved.startsWith(`${realpathSync(sourceRoot)}${sep}`)) {
    throw new Error("packed AgentMail runtime leaked to the source checkout");
  }
}

function startLoopbackProvider(state: {
  healthChecks: number;
  catchUps: number;
  subscriptions: number;
  closed: ReturnType<typeof deferred>;
}) {
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: attempt === 0 ? 0 : fallbackStart + attempt - 1,
        fetch(request, server) {
          if (request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
            return new Response("unauthorized", { status: 401 });
          }
          const url = new URL(request.url);
          if (url.pathname === "/v0" && server.upgrade(request, { data: undefined })) return;
          if (
            request.method === "GET" &&
            url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}`
          ) {
            state.healthChecks++;
            return Response.json({
              inbox_id: INBOX_ID,
              email: INBOX_ID,
              display_name: "Packed runtime contract",
            });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}/messages`
          ) {
            state.catchUps++;
            return Response.json({ count: 0, messages: [] });
          }
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
            if (
              message.type !== "subscribe" ||
              message.inbox_ids?.length !== 1 ||
              message.inbox_ids[0] !== INBOX_ID ||
              message.event_types?.length !== 1 ||
              message.event_types[0] !== "message.received"
            ) {
              socket.close(1008, "unexpected subscription");
              return;
            }
            state.subscriptions++;
            socket.send(
              JSON.stringify({
                type: "subscribed",
                inbox_ids: message.inbox_ids,
                event_types: message.event_types,
              }),
            );
          },
          close(_socket, code) {
            if (code === 1000) state.closed.resolve();
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

assertPackedResolution();
const state = {
  healthChecks: 0,
  catchUps: 0,
  subscriptions: 0,
  closed: deferred(),
};
const unhandled: unknown[] = [];
process.on("unhandledRejection", (error) => unhandled.push(error));
const provider = startLoopbackProvider(state);
const stateDir = mkdtempSync(join(tmpdir(), "auggy-packed-agentmail-"));

const baseUrl = `http://127.0.0.1:${provider.port}`;
const augment = agentMail({
  apiKey: API_KEY,
  inboxId: INBOX_ID,
  emailAddress: INBOX_ID,
  apiBaseUrl: `${baseUrl}/v0`,
  allowInsecureHttpWithCredentials: true,
  stateDir,
  inbound: {
    mode: "websocket",
    allowAnySender: true,
    rateLimit: {
      globalMaxPerHour: 10,
      perSenderMaxPerHour: 2,
    },
    websocketBaseUrl: baseUrl.replace("http:", "ws:"),
  },
});

try {
  await withTimeout(augment.onBoot?.() ?? Promise.resolve(), "packed AgentMail boot");
  if (!augment.transport) throw new Error("packed AgentMail omitted its inbound transport");
  await augment.transport.register(
    {
      quarantineThread() {},
    } as never,
    augment.name,
  );
  await withTimeout(augment.transport.ready?.() ?? Promise.resolve(), "packed AgentMail ready");
  if (state.healthChecks !== 1 || state.catchUps !== 1 || state.subscriptions !== 1) {
    throw new Error("packed AgentMail runtime did not complete its provider readiness sequence");
  }
  await withTimeout(augment.onShutdown?.() ?? Promise.resolve(), "packed AgentMail shutdown");
  await withTimeout(state.closed.promise, "packed AgentMail WebSocket close");
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (unhandled.length > 0) {
    throw new Error("packed AgentMail runtime produced an unhandled rejection");
  }
  console.log("packed AgentMail runtime WebSocket contract passed");
} finally {
  try {
    await withTimeout(
      augment.onShutdown?.() ?? Promise.resolve(),
      "packed AgentMail cleanup shutdown",
    ).catch(() => {});
  } finally {
    provider.stop(true);
    rmSync(stateDir, { recursive: true, force: true });
  }
}
