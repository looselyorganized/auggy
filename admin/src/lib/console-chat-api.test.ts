import { describe, expect, it } from "bun:test";
import {
  ConsoleChatApiError,
  deleteConsoleChatThread,
  getConsoleChatThread,
  isConsoleChatApiError,
  listConsoleChatThreads,
  renameConsoleChatThread,
  setConsoleChatThreadReadState,
  type ConsoleChatThreadSummary,
} from "./console-chat-api";
import type { AdminFetch } from "./api";

const T0 = "2026-07-20T18:00:00.000Z";
const T1 = "2026-07-20T18:01:00.000Z";

function summary(
  patch: Partial<ConsoleChatThreadSummary> = {},
): ConsoleChatThreadSummary {
  return {
    id: "thread:one",
    title: "Debug visitor auth",
    previewMode: "visitor",
    model: { id: "claude-sonnet", displayName: "Sonnet", provider: "anthropic" },
    createdAt: T0,
    updatedAt: T1,
    lastReadAt: T0,
    unread: true,
    runStatus: "complete",
    ...patch,
  };
}

function json(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function options(fetchImpl: AdminFetch) {
  return { fetchImpl, locationHref: "http://:dev-admin@127.0.0.1:8081/console/chat" };
}

describe("console chat API", () => {
  it("lists validated summaries through a credential-stripped same-origin URL", async () => {
    const requests: Array<{ input: string; init?: RequestInit }> = [];
    const fetchImpl: AdminFetch = async (input, init) => {
      requests.push({ input: String(input), init });
      return json({ threads: [summary()] });
    };

    const threads = await listConsoleChatThreads(options(fetchImpl));

    expect(threads).toEqual([summary()]);
    expect(requests).toHaveLength(1);
    expect(requests[0]?.input).toBe("http://127.0.0.1:8081/console/api/chat/threads");
    expect(requests[0]?.init).toMatchObject({
      method: "GET",
      headers: { accept: "application/json" },
    });
    expect(requests[0]?.init).not.toHaveProperty("credentials");
  });

  it("validates a complete detail response including tool calls", async () => {
    const fetchImpl: AdminFetch = async () =>
      json({
        thread: {
          ...summary(),
          messages: [
            {
              id: "message-1",
              role: "assistant",
              content: "Done",
              toolCalls: [
                {
                  id: "tool-1",
                  name: "lookup",
                  args: '{"id":1}',
                  result: "ok",
                  status: "completed",
                },
              ],
              createdAt: T0,
              updatedAt: T1,
            },
          ],
        },
      });

    const thread = await getConsoleChatThread("thread:one", options(fetchImpl));

    expect(thread.messages[0]?.toolCalls?.[0]).toEqual({
      id: "tool-1",
      name: "lookup",
      args: '{"id":1}',
      result: "ok",
      status: "completed",
    });
  });

  it("rejects detail and mutation responses for a different thread", async () => {
    const mismatchedDetail: AdminFetch = async () =>
      json({ thread: { ...summary({ id: "thread:other" }), messages: [] } });
    await expect(
      getConsoleChatThread("thread:one", options(mismatchedDetail)),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const mismatchedMutation: AdminFetch = async () =>
      json({ thread: summary({ id: "thread:other" }) });
    await expect(
      renameConsoleChatThread("thread:one", "Renamed", "csrf", options(mismatchedMutation)),
    ).rejects.toMatchObject({ code: "invalid-response" });
    await expect(
      setConsoleChatThreadReadState(
        "thread:one",
        false,
        "csrf",
        options(mismatchedMutation),
      ),
    ).rejects.toMatchObject({ code: "invalid-response" });
  });

  it("allows a read marker newer than content without treating it as a new turn", async () => {
    const readAt = "2026-07-20T18:02:00.000Z";
    const fetchImpl: AdminFetch = async () =>
      json({ threads: [summary({ lastReadAt: readAt })] });

    const [thread] = await listConsoleChatThreads(options(fetchImpl));

    expect(thread?.updatedAt).toBe(T1);
    expect(thread?.lastReadAt).toBe(readAt);
  });

  it("posts exact rename, read-state, and delete payloads", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const fetchImpl: AdminFetch = async (input, init) => {
      requests.push({ path: new URL(String(input)).pathname, body: JSON.parse(String(init?.body)) });
      if (String(input).endsWith("/delete")) return json({ ok: true });
      return json({ thread: summary() });
    };
    const requestOptions = options(fetchImpl);

    await renameConsoleChatThread("thread:one", "Renamed", "csrf-token", requestOptions);
    await setConsoleChatThreadReadState("thread:one", false, "csrf-token", requestOptions);
    await deleteConsoleChatThread("thread:one", "csrf-token", requestOptions);

    expect(requests).toEqual([
      {
        path: "/console/api/chat/threads/thread%3Aone/rename",
        body: { csrf: "csrf-token", title: "Renamed" },
      },
      {
        path: "/console/api/chat/threads/thread%3Aone/read-state",
        body: { csrf: "csrf-token", unread: false },
      },
      {
        path: "/console/api/chat/threads/thread%3Aone/delete",
        body: { csrf: "csrf-token" },
      },
    ]);
  });

  it("fails closed for unknown, missing, malformed, and invalid nested fields", async () => {
    const invalidValues = [
      { threads: [{ ...summary(), owner: { peerId: "secret" } }] },
      { threads: [{ ...summary(), updatedAt: "yesterday" }] },
      { threads: [{ ...summary(), runStatus: "queued" }] },
      { threads: [{ ...summary(), model: { id: "x", displayName: "X", extra: true } }] },
      { threads: [{ ...summary(), unread: undefined }] },
      { threads: summary() },
    ];

    for (const value of invalidValues) {
      const fetchImpl: AdminFetch = async () => json(value);
      try {
        await listConsoleChatThreads(options(fetchImpl));
        throw new Error("expected validation to reject");
      } catch (error) {
        expect(error).toBeInstanceOf(ConsoleChatApiError);
        expect((error as ConsoleChatApiError).code).toBe("invalid-response");
      }
    }
  });

  it("rejects duplicate IDs and impossible timestamp relationships", async () => {
    const duplicateList: AdminFetch = async () =>
      json({ threads: [summary(), summary({ title: "Duplicate" })] });
    await expect(listConsoleChatThreads(options(duplicateList))).rejects.toMatchObject({
      code: "invalid-response",
    });

    const duplicateDetail: AdminFetch = async () =>
      json({
        thread: {
          ...summary(),
          messages: [
            {
              id: "message-1",
              role: "assistant",
              content: "",
              toolCalls: [
                { id: "tool-1", name: "one", status: "completed" },
                { id: "tool-1", name: "duplicate", status: "completed" },
              ],
              createdAt: T0,
              updatedAt: T1,
            },
          ],
        },
      });
    await expect(
      getConsoleChatThread("thread:one", options(duplicateDetail)),
    ).rejects.toMatchObject({ code: "invalid-response" });

    const backwardsTime: AdminFetch = async () =>
      json({ threads: [summary({ createdAt: T1, updatedAt: T0 })] });
    await expect(listConsoleChatThreads(options(backwardsTime))).rejects.toMatchObject({
      code: "invalid-response",
    });
  });

  it("allows providers to reuse a tool-call ID in a later message", async () => {
    const fetchImpl: AdminFetch = async () =>
      json({
        thread: {
          ...summary(),
          messages: ["message-1", "message-2"].map((id) => ({
            id,
            role: "assistant",
            content: "",
            toolCalls: [{ id: "provider-call-1", name: "lookup", status: "completed" }],
            createdAt: T0,
            updatedAt: T0,
          })),
        },
      });

    const thread = await getConsoleChatThread("thread:one", options(fetchImpl));
    expect(thread.messages).toHaveLength(2);
  });

  it("reports an exact 419 session-expiry error without trusting extra error fields", async () => {
    const fetchImpl: AdminFetch = async () =>
      json({ error: "Session expired — reload the page." }, 419);

    try {
      await renameConsoleChatThread("thread:one", "Name", "old", options(fetchImpl));
      throw new Error("expected request to reject");
    } catch (error) {
      expect(isConsoleChatApiError(error)).toBe(true);
      expect(error).toMatchObject({
        name: "ConsoleChatApiError",
        status: 419,
        code: "csrf-expired",
        message: "Session expired — reload the page.",
      });
    }
  });

  it("classifies gone and conflict responses and rejects successful non-JSON responses", async () => {
    const goneFetch: AdminFetch = async () => json({ error: "thread was deleted" }, 410);
    await expect(getConsoleChatThread("thread:one", options(goneFetch))).rejects.toMatchObject({
      status: 410,
      code: "gone",
      responseMessage: "thread was deleted",
    });

    const conflictFetch: AdminFetch = async () =>
      json({ error: "Cannot delete a chat while it is streaming." }, 409);
    await expect(
      deleteConsoleChatThread("thread:one", "csrf", options(conflictFetch)),
    ).rejects.toMatchObject({ status: 409, code: "conflict" });

    const htmlFetch: AdminFetch = async () =>
      new Response("<html>unexpected</html>", {
        headers: { "content-type": "text/html" },
      });
    await expect(listConsoleChatThreads(options(htmlFetch))).rejects.toMatchObject({
      status: 200,
      code: "invalid-response",
    });
  });

  it("rejects unsafe thread IDs before fetching", async () => {
    let fetched = false;
    const fetchImpl: AdminFetch = async () => {
      fetched = true;
      return json({ thread: {} });
    };

    await expect(getConsoleChatThread("../credentials", options(fetchImpl))).rejects.toMatchObject({
      status: 0,
      code: "request-failed",
    });
    expect(fetched).toBe(false);
  });

  it("normalizes network failures but preserves request cancellation", async () => {
    const offlineFetch: AdminFetch = async () => {
      throw new TypeError("connection refused");
    };
    await expect(listConsoleChatThreads(options(offlineFetch))).rejects.toMatchObject({
      status: 0,
      code: "request-failed",
      message: "Unable to reach the console chat service.",
    });

    const controller = new AbortController();
    controller.abort();
    const abort = new DOMException("Aborted", "AbortError");
    const abortedFetch: AdminFetch = async () => {
      throw abort;
    };
    await expect(
      listConsoleChatThreads({ ...options(abortedFetch), signal: controller.signal }),
    ).rejects.toBe(abort);
  });
});
