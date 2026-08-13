import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import {
  agentMail,
  type Augment,
  type OutboundMessage,
  type PeerIdentity,
  type Tool,
  type ToolExecuteContext,
  type ToolResult,
  type TransportKernel,
  type TurnResult,
  type TurnState,
  type TurnTrigger,
} from "auggy";

const API_KEY = "am_packed_runtime_contract_sentinel";
const INBOX_ID = "packed-runtime@agentmail.to";
const MESSAGE_ID = "message_offline_1";
const THREAD_ID = "thread_offline_1";
const DRAFT_ID = "draft_reply_1";
const CREATED_AT = "2026-08-13T12:00:00.000Z";
const creator: PeerIdentity = {
  id: "creator_packed_runtime",
  kind: "human",
  trustLevel: "creator",
  sourceAugment: "webTransport",
};

function withTimeout<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`timed out waiting for ${label}`)), 5_000);
    }),
  ]).finally(() => clearTimeout(timer));
}

async function waitFor(check: () => boolean, label: string): Promise<void> {
  await withTimeout(
    (async () => {
      while (!check()) await Bun.sleep(10);
    })(),
    label,
  );
}

function assertPackedResolution(): void {
  const expectedConsumerRoot = process.env.AUGGY_PACKED_CONSUMER_ROOT;
  const sourceRoot = process.env.AUGGY_SOURCE_ROOT;
  if (!expectedConsumerRoot || !sourceRoot) {
    throw new Error("packed AgentMail E2E requires its isolated-path boundaries");
  }
  const resolved = realpathSync(Bun.resolveSync("auggy", import.meta.dir));
  const consumerNodeModules = `${realpathSync(expectedConsumerRoot)}${sep}node_modules${sep}auggy${sep}`;
  if (!resolved.startsWith(consumerNodeModules)) {
    throw new Error("packed AgentMail E2E resolved outside the isolated consumer");
  }
  if (resolved.startsWith(`${realpathSync(sourceRoot)}${sep}`)) {
    throw new Error("packed AgentMail E2E leaked to the source checkout");
  }
}

function messageResponse() {
  return {
    inbox_id: INBOX_ID,
    thread_id: THREAD_ID,
    message_id: MESSAGE_ID,
    labels: ["received"],
    timestamp: CREATED_AT,
    from: "Customer <customer@example.com>",
    to: [INBOX_ID],
    cc: [],
    subject: "Need help with order 42",
    preview: "Please help with order 42.",
    text: "Please help with order 42.",
    reply_to: [],
    references: [],
    attachments: [],
    size: 128,
    updated_at: CREATED_AT,
    created_at: CREATED_AT,
  };
}

function startLoopbackProvider(state: {
  authChecks: number;
  healthChecks: number;
  catchUps: number;
  subscriptions: number;
  draftCreates: number;
  draftReads: number;
  draftUpdates: number;
  draftSends: number;
  sentIdempotencyKeys: string[];
  draft: {
    text: string;
    updatedAt: string;
    present: boolean;
    clientId?: string;
    subject?: string;
  };
}) {
  let lastError: unknown;
  const fallbackStart = 20_000 + Math.floor(Math.random() * 20_000);
  for (let attempt = 0; attempt < 20; attempt++) {
    try {
      return Bun.serve({
        hostname: "127.0.0.1",
        port: attempt === 0 ? 0 : fallbackStart + attempt - 1,
        async fetch(request, server) {
          if (request.headers.get("authorization") !== `Bearer ${API_KEY}`) {
            return new Response("unauthorized", { status: 401 });
          }
          const url = new URL(request.url);
          if (url.pathname === "/v0" && server.upgrade(request, { data: undefined })) return;
          if (request.method === "GET" && url.pathname === "/v0/auth/me") {
            state.authChecks++;
            return Response.json({
              scope_type: "inbox",
              scope_id: INBOX_ID,
              organization_id: "org_packed_runtime",
              inbox_id: INBOX_ID,
            });
          }
          if (
            request.method === "GET" &&
            url.pathname === `/v0/inboxes/${encodeURIComponent(INBOX_ID)}`
          ) {
            state.healthChecks++;
            return Response.json({
              inbox_id: INBOX_ID,
              email: INBOX_ID,
              display_name: "Packed runtime E2E",
            });
          }
          const inboxRoot = `/v0/inboxes/${encodeURIComponent(INBOX_ID)}`;
          if (request.method === "GET" && url.pathname === `${inboxRoot}/messages`) {
            state.catchUps++;
            return Response.json({ count: 1, messages: [messageResponse()] });
          }
          if (request.method === "GET" && url.pathname === `${inboxRoot}/messages/${MESSAGE_ID}`) {
            return Response.json(messageResponse());
          }
          if (request.method === "GET" && url.pathname === `${inboxRoot}/drafts`) {
            return Response.json({
              count: state.draft.present ? 1 : 0,
              drafts: state.draft.present ? [draftResponse(state.draft)] : [],
            });
          }
          if (request.method === "POST" && url.pathname === `${inboxRoot}/drafts`) {
            const input = (await request.json()) as Record<string, unknown>;
            if (input.in_reply_to !== MESSAGE_ID || input.reply_all !== undefined) {
              return Response.json({ code: "invalid_draft" }, { status: 400 });
            }
            state.draftCreates++;
            state.draft.present = true;
            state.draft.clientId = String(input.client_id ?? "");
            state.draft.subject = String(input.subject ?? "");
            state.draft.text = String(input.text ?? "");
            state.draft.updatedAt = "2026-08-13T12:00:01.000Z";
            return Response.json(draftResponse(state.draft));
          }
          if (request.method === "GET" && url.pathname === `${inboxRoot}/drafts/${DRAFT_ID}`) {
            state.draftReads++;
            return state.draft.present
              ? Response.json(draftResponse(state.draft))
              : Response.json({ code: "not_found" }, { status: 404 });
          }
          if (request.method === "PATCH" && url.pathname === `${inboxRoot}/drafts/${DRAFT_ID}`) {
            if (!state.draft.present) return Response.json({ code: "not_found" }, { status: 404 });
            const input = (await request.json()) as Record<string, unknown>;
            if (typeof input.text !== "string" || input.text.length === 0) {
              return Response.json({ code: "invalid_draft" }, { status: 400 });
            }
            state.draftUpdates++;
            state.draft.text = input.text;
            state.draft.updatedAt = "2026-08-13T12:00:02.000Z";
            return Response.json(draftResponse(state.draft));
          }
          if (
            request.method === "POST" &&
            url.pathname === `${inboxRoot}/drafts/${DRAFT_ID}/send`
          ) {
            if (!state.draft.present) return Response.json({ code: "not_found" }, { status: 404 });
            const key = request.headers.get("idempotency-key");
            if (!key) return Response.json({ code: "idempotency_required" }, { status: 400 });
            state.draftSends++;
            state.sentIdempotencyKeys.push(key);
            state.draft.present = false;
            return Response.json({ message_id: "message_sent_1", thread_id: THREAD_ID });
          }
          return new Response("not found", { status: 404 });
        },
        websocket: {
          message(socket, rawMessage) {
            const message = JSON.parse(
              typeof rawMessage === "string" ? rawMessage : new TextDecoder().decode(rawMessage),
            ) as { type?: string; inbox_ids?: string[] };
            if (
              message.type !== "subscribe" ||
              message.inbox_ids?.length !== 1 ||
              message.inbox_ids[0] !== INBOX_ID
            ) {
              socket.close(1008, "unexpected subscription");
              return;
            }
            state.subscriptions++;
            socket.send(JSON.stringify({ type: "subscribed", inbox_ids: message.inbox_ids }));
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

function draftResponse(draft: {
  text: string;
  updatedAt: string;
  clientId?: string;
  subject?: string;
}) {
  return {
    inbox_id: INBOX_ID,
    draft_id: DRAFT_ID,
    client_id: draft.clientId,
    labels: [],
    reply_to: [],
    to: ["customer@example.com"],
    cc: [],
    bcc: [],
    subject: draft.subject,
    text: draft.text,
    in_reply_to: MESSAGE_ID,
    references: [],
    attachments: [],
    updated_at: draft.updatedAt,
    created_at: "2026-08-13T12:00:01.000Z",
  };
}

function runtime(baseUrl: string, dbPath: string) {
  return agentMail({
    apiKey: API_KEY,
    inboxId: INBOX_ID,
    emailAddress: INBOX_ID,
    apiBaseUrl: baseUrl,
    websocketBaseUrl: baseUrl.replace("http:", "ws:"),
    allowInsecureHttpWithCredentials: true,
    dbPath,
    inbound: {
      mode: "websocket",
      allowAnySender: true,
      rateLimit: { globalMaxPerHour: 100, perSenderMaxPerHour: 5 },
    },
    replies: { mode: "review", allowReplyAll: false },
    outbound: {
      allowedTrustLevels: ["creator"],
      allowDirectDelivery: true,
      subjectPrefix: "[Packed E2E] ",
      maxRecipients: 10,
      bodyMaxBytes: 102_400,
      rateLimit: {
        globalMaxPerHour: 10,
        perRecipientCooldownMs: 0,
        dedupWindowMs: 0,
      },
    },
  });
}

function kernel(reply: string): TransportKernel {
  let outbound: ((peer: PeerIdentity, message: OutboundMessage) => Promise<void>) | undefined;
  return {
    async handleInbound(trigger: TurnTrigger) {
      const response: OutboundMessage = {
        parts: [{ kind: "text", text: reply }],
        contextId: trigger.contextId,
      };
      if (!trigger.peer || !outbound) throw new Error("packed E2E inbound identity was missing");
      await outbound(trigger.peer, response);
      return {
        turnId: trigger.turnId,
        success: true,
        status: "completed",
        response,
      } as TurnResult;
    },
    onOutbound(callback) {
      outbound = callback;
    },
    getAgentCard: () => ({}) as never,
    quarantineThread: () => true,
    recoverThread: () => true,
    getAugmentRoutes: () => [],
    getAugments: () => [],
  };
}

function requireTool(augment: Augment, name: string): Tool {
  const tool = augment.tools?.find((candidate) => candidate.name === name);
  if (!tool) throw new Error(`packed AgentMail E2E omitted ${name}`);
  return tool;
}

function toolResult(value: string | ToolResult): Record<string, unknown> {
  return JSON.parse(typeof value === "string" ? value : value.content) as Record<string, unknown>;
}

function creatorTurn(turnId: string, text: string): TurnState {
  return {
    turnId,
    threadId: "console_packed_e2e",
    peer: creator,
    toolCallsSoFar: 0,
    turnStartedAt: Date.now(),
    metadata: {},
    trigger: {
      type: "message",
      turnId,
      threadId: "console_packed_e2e",
      timestamp: Date.now(),
      source: "webTransport",
      peer: creator,
      payload: {
        parts: [{ kind: "text", text }],
        sourceAugment: "webTransport",
        peer: creator,
        timestamp: Date.now(),
      },
    },
  };
}

function context(turnId: string, operationId: string): ToolExecuteContext {
  return {
    turnId,
    threadId: "console_packed_e2e",
    peer: creator,
    operationId,
  };
}

async function boot(augment: ReturnType<typeof runtime>, reply: string) {
  await withTimeout(augment.onBoot?.() ?? Promise.resolve(), "packed AgentMail boot");
  if (!augment.transport) throw new Error("packed AgentMail omitted its inbound transport");
  await augment.transport.register(kernel(reply), "agentMail");
  await withTimeout(augment.transport.ready?.() ?? Promise.resolve(), "packed AgentMail ready");
}

assertPackedResolution();
const state = {
  authChecks: 0,
  healthChecks: 0,
  catchUps: 0,
  subscriptions: 0,
  draftCreates: 0,
  draftReads: 0,
  draftUpdates: 0,
  draftSends: 0,
  sentIdempotencyKeys: [] as string[],
  draft: {
    text: "",
    updatedAt: CREATED_AT,
    present: false,
    clientId: undefined as string | undefined,
    subject: undefined as string | undefined,
  },
};
const unhandled: unknown[] = [];
process.on("unhandledRejection", (error) => unhandled.push(error));
const provider = startLoopbackProvider(state);
const stateDir = mkdtempSync(join(tmpdir(), "auggy-packed-agentmail-"));
const dbPath = join(stateDir, "orchestration.db");
const baseUrl = `http://127.0.0.1:${provider.port}`;
let first: ReturnType<typeof runtime> | undefined;
let second: ReturnType<typeof runtime> | undefined;
let third: ReturnType<typeof runtime> | undefined;

try {
  // Offline catch-up wakes a normal turn and creates exactly one provider draft.
  first = runtime(baseUrl, dbPath);
  await boot(first, "We can help with order 42.");
  await waitFor(() => state.draftCreates === 1, "offline mail draft creation");
  if (!state.draft.present || state.draft.text !== "We can help with order 42.") {
    throw new Error("packed AgentMail E2E did not create the expected provider draft");
  }
  await first.onShutdown?.();
  first = undefined;

  // Restart must recover the managed draft without creating a duplicate.
  second = runtime(baseUrl, dbPath);
  await boot(second, "[NO_REPLY]");
  await Bun.sleep(25);
  if (state.draftCreates !== 1) throw new Error("packed AgentMail restart duplicated the draft");

  const list = toolResult(
    await requireTool(second, "list_mail_drafts").execute(
      { limit: 20 },
      context("list", "list-op"),
    ),
  );
  if (list.status !== "ok") throw new Error("packed AgentMail could not list the recovered draft");

  const showTurn = creatorTurn("show", `show draft ${DRAFT_ID}`);
  await second.onTurnStart?.(showTurn);
  const shown = toolResult(
    await requireTool(second, "show_mail_draft").execute(
      { draftId: DRAFT_ID },
      context("show", "show-op"),
    ),
  );
  await second.onTurnEnd?.({ turnId: "show" } as TurnResult);
  if (shown.status !== "review" || typeof shown.providerRevision !== "string") {
    throw new Error("packed AgentMail could not review the recovered draft");
  }

  const reviseTurn = creatorTurn("revise", `revise draft ${DRAFT_ID}`);
  await second.onTurnStart?.(reviseTurn);
  const revised = toolResult(
    await requireTool(second, "revise_mail_draft").execute(
      {
        draftId: DRAFT_ID,
        expectedRevision: shown.providerRevision,
        text: "We can help tomorrow.",
      },
      context("revise", "revise-op"),
    ),
  );
  await second.onTurnEnd?.({ turnId: "revise" } as TurnResult);
  if (revised.status !== "revised" || typeof revised.providerRevision !== "string") {
    throw new Error("packed AgentMail could not revise the provider draft");
  }

  const sendTurn = creatorTurn("send", `send draft ${DRAFT_ID}`);
  await second.onTurnStart?.(sendTurn);
  const sendTool = requireTool(second, "send_mail_draft");
  const sent = toolResult(
    await sendTool.execute(
      { draftId: DRAFT_ID, expectedRevision: revised.providerRevision },
      context("send", "packed-send-op"),
    ),
  );
  const replayed = toolResult(
    await sendTool.execute(
      { draftId: DRAFT_ID, expectedRevision: revised.providerRevision },
      context("send", "packed-send-op"),
    ),
  );
  await second.onTurnEnd?.({ turnId: "send" } as TurnResult);
  if (sent.status !== "sent" || replayed.status !== "sent" || replayed.replayed !== true) {
    throw new Error("packed AgentMail send did not replay its durable settlement");
  }
  if (
    state.draftSends !== 1 ||
    state.sentIdempotencyKeys.length !== 1 ||
    !state.sentIdempotencyKeys[0]?.startsWith("agentmail.delivery.v2.")
  ) {
    throw new Error("packed AgentMail send did not use exactly one stable idempotency key");
  }
  await second.onShutdown?.();
  second = undefined;

  // A second restart must replay the sent result without touching AgentMail.
  third = runtime(baseUrl, dbPath);
  await boot(third, "[NO_REPLY]");
  const replayTurn = creatorTurn("restart-replay", `send draft ${DRAFT_ID}`);
  await third.onTurnStart?.(replayTurn);
  const restartedReplay = toolResult(
    await requireTool(third, "send_mail_draft").execute(
      { draftId: DRAFT_ID, expectedRevision: revised.providerRevision },
      context("restart-replay", "packed-send-op"),
    ),
  );
  await third.onTurnEnd?.({ turnId: "restart-replay" } as TurnResult);
  if (restartedReplay.status !== "sent" || restartedReplay.replayed !== true) {
    throw new Error("packed AgentMail restart did not recover sent delivery settlement");
  }
  if (state.draftSends !== 1) throw new Error("packed AgentMail restart resent the draft");

  await third.onShutdown?.();
  third = undefined;
  await Bun.sleep(25);
  if (unhandled.length > 0) throw new Error("packed AgentMail E2E produced an unhandled rejection");
  if (state.authChecks !== 6 || state.healthChecks !== 6 || state.subscriptions !== 3) {
    throw new Error(
      `packed AgentMail E2E missed its readiness contract: ${JSON.stringify({
        authChecks: state.authChecks,
        healthChecks: state.healthChecks,
        subscriptions: state.subscriptions,
      })}`,
    );
  }
  console.log(
    "packed AgentMail E2E passed: offline catch-up -> turn -> provider draft -> creator revision/send -> restart replay",
  );
} finally {
  await first?.onShutdown?.().catch(() => undefined);
  await second?.onShutdown?.().catch(() => undefined);
  await third?.onShutdown?.().catch(() => undefined);
  provider.stop(true);
  rmSync(stateDir, { recursive: true, force: true });
}
