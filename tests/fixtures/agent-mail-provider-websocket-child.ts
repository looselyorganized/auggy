import { createAgentMailProvider } from "../../src/augments/agentMail/provider";
import { createServer } from "node:net";

const inboxId = "support@agentmail.to";
let resolveSubscribe!: () => void;
const subscribed = new Promise<void>((resolve) => {
  resolveSubscribe = resolve;
});
const port = await new Promise<number>((resolve, reject) => {
  const probe = createServer();
  probe.once("error", reject);
  probe.listen(0, "127.0.0.1", () => {
    const address = probe.address();
    if (typeof address !== "object" || address === null) {
      probe.close();
      reject(new Error("Could not allocate a WebSocket contract-test port"));
      return;
    }
    probe.close((error) => (error ? reject(error) : resolve(address.port)));
  });
}).catch((error: NodeJS.ErrnoException) => {
  if (error.code === "EPERM") {
    process.stdout.write("skipped-local-network\n");
    process.exit(0);
  }
  throw error;
});
const server = Bun.serve({
  port,
  fetch(request, server) {
    return server.upgrade(request) ? undefined : new Response("upgrade required", { status: 426 });
  },
  websocket: {
    message(_socket, data) {
      const parsed = JSON.parse(String(data)) as {
        type?: string;
        inboxIds?: string[];
        inbox_ids?: string[];
      };
      const subscribedInbox = parsed.inboxIds?.[0] ?? parsed.inbox_ids?.[0];
      if (parsed.type === "subscribe" && subscribedInbox === inboxId) resolveSubscribe();
    },
  },
});
const controller = new AbortController();

try {
  const provider = createAgentMailProvider({
    apiKey: "am_bun_contract",
    inboxId,
    websocketBaseUrl: `ws://127.0.0.1:${server.port}`,
  });
  const connection = await provider.connect({ onEvent() {} }, controller.signal);
  await Promise.race([
    subscribed,
    new Promise<never>((_, reject) =>
      setTimeout(() => reject(new Error("AgentMail subscribe was not observed")), 2_000),
    ),
  ]);
  connection.close();
  process.stdout.write("subscribed\n");
} finally {
  controller.abort();
  server.stop(true);
}
