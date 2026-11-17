/** A controlled network peer for the real installed Anthropic adapter. Never an engine replacement. */
import {
  createProviderFixture,
  type ProviderFixture,
  type ProviderFixtureTool,
} from "../../provider-fixture";
import { INTEGRATION_LIMITS } from "../../integration-contracts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export async function boundedFixtureBody(
  request: Request | Response,
  maximum: number = INTEGRATION_LIMITS.fixtureRequestBytes,
  signal?: AbortSignal,
): Promise<string> {
  const reader = request.body?.getReader();
  check(reader, "Fixture request body missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, INTEGRATION_LIMITS.fixtureRequestMs);
  try {
    for (;;) {
      signal?.throwIfAborted();
      const part = await reader.read();
      signal?.throwIfAborted();
      check(!timedOut, "Fixture body deadline exceeded");
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= maximum, "Fixture body limit exceeded");
      chunks.push(part.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener("abort", cancel);
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface ApplicationModelScenario {
  tool: ProviderFixtureTool;
  sentinel: string;
  /** Delays terminal provider frames after actual text, allowing observation/disconnection. */
  terminalDelayMs?: number;
}

export function createApplicationModelFixture(options: { port?: number } = {}) {
  let provider: ProviderFixture | undefined;
  let scenario: ApplicationModelScenario | undefined;
  let totalRequests = 0;
  let state: "running" | "sealing" | "sealed" | "stopped" | "failed" = "running";
  let lateRequests = 0;
  let rejectedRequests = 0;
  let configuring = false;
  const active = new Set<AbortController>();
  const generations: { generation: number; evidence: ReturnType<ProviderFixture["evidence"]> }[] =
    [];
  const requests: {
    generation: number;
    containsA: boolean;
    containsB: boolean;
    authorizationDenied: boolean;
    offeredTools: string[];
    creatorPreamble: boolean;
  }[] = [];
  let generation = 0;
  let sealing: Promise<ReturnType<typeof snapshot>> | undefined;
  let terminal: ReturnType<typeof snapshot> | undefined;
  function snapshot() {
    return {
      generation,
      state,
      active: active.size,
      totalRequests,
      lateRequests,
      rejectedRequests,
      provider: provider?.evidence() ?? null,
      providers: structuredClone([
        ...generations,
        ...(provider ? [{ generation, evidence: provider.evidence() }] : []),
      ]),
      requests: structuredClone(requests),
    };
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    idleTimeout: 10,
    maxRequestBodySize: INTEGRATION_LIMITS.fixtureRequestBytes,
    async fetch(request) {
      if (state !== "running") {
        lateRequests++;
        return Response.json({ error: "fixture_sealed" }, { status: 503 });
      }
      if (
        !provider ||
        !scenario ||
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/messages" ||
        new URL(request.url).search
      ) {
        rejectedRequests++;
        return Response.json({ error: "fixture_unavailable" }, { status: 503 });
      }
      const owned = new AbortController();
      active.add(owned);
      const forwardAbort = () => owned.abort();
      request.signal.addEventListener("abort", forwardAbort, { once: true });
      if (request.signal.aborted) owned.abort();
      const deadline = setTimeout(() => owned.abort(), INTEGRATION_LIMITS.fixtureRequestMs);
      let finished = false;
      let releaseDelay: (() => void) | undefined;
      const finish = () => {
        if (finished) return;
        finished = true;
        clearTimeout(deadline);
        releaseDelay?.();
        request.signal.removeEventListener("abort", forwardAbort);
        active.delete(owned);
      };
      try {
        check(++totalRequests <= 100 && requests.length < 100, "Model request bound exceeded");
        const raw = await boundedFixtureBody(
          request,
          INTEGRATION_LIMITS.fixtureRequestBytes,
          owned.signal,
        );
        const body = JSON.parse(raw) as { tools?: { name?: unknown }[] };
        requests.push({
          generation,
          containsA: raw.includes("customer-a-private-marker"),
          containsB: raw.includes("customer-b-private-marker"),
          authorizationDenied:
            raw.includes("authorization denied") ||
            raw.includes("Order service request could not be completed"),
          offeredTools: (body.tools ?? []).map((tool) => String(tool.name)).slice(0, 100),
          creatorPreamble: raw.includes("Creator authority"),
        });
        const response = await fetch(`${provider.baseURL}/v1/messages`, {
          method: "POST",
          headers: request.headers,
          body: raw,
          redirect: "manual",
          signal: owned.signal,
        });
        const output = await boundedFixtureBody(
          response,
          INTEGRATION_LIMITS.fixtureRequestBytes,
          owned.signal,
        );
        if (!response.ok) rejectedRequests++;
        const boundary =
          response.ok && output.includes('"type":"text_delta"')
            ? output.indexOf("event: message_delta")
            : -1;
        const parts =
          boundary >= 0 ? [output.slice(0, boundary), output.slice(boundary)] : [output];
        const delay = scenario.terminalDelayMs ?? 750;
        let index = 0;
        let streamController: ReadableStreamDefaultController<Uint8Array>;
        const abortStream = () => {
          releaseDelay?.();
          try {
            streamController.error(new Error("Model response aborted"));
          } catch {}
          finish();
        };
        const stream = new ReadableStream<Uint8Array>(
          {
            start(controller) {
              streamController = controller;
            },
            async pull(controller) {
              try {
                owned.signal.throwIfAborted();
                if (index === parts.length) {
                  controller.close();
                  owned.signal.removeEventListener("abort", abortStream);
                  finish();
                  return;
                }
                if (index === 1)
                  await new Promise<void>((resolve) => {
                    const timer = setTimeout(resolve, delay);
                    releaseDelay = () => {
                      clearTimeout(timer);
                      resolve();
                    };
                  });
                owned.signal.throwIfAborted();
                controller.enqueue(new TextEncoder().encode(parts[index++]!));
              } catch {
                try {
                  controller.error(new Error("Model response aborted"));
                } catch {}
                owned.signal.removeEventListener("abort", abortStream);
                finish();
              }
            },
            cancel() {
              owned.signal.removeEventListener("abort", abortStream);
              owned.abort();
              finish();
            },
          },
          { highWaterMark: 0 },
        );
        owned.signal.addEventListener("abort", abortStream, { once: true });
        if (owned.signal.aborted) abortStream();
        return new Response(stream, { status: response.status, headers: response.headers });
      } catch {
        rejectedRequests++;
        finish();
        return Response.json({ error: "fixture_request_rejected" }, { status: 400 });
      }
    },
  });
  async function stop() {
    if (state !== "sealed" && state !== "failed") state = "stopped";
    for (const controller of active) controller.abort();
    await server.stop(true);
    await provider?.stop();
    const deadline = Date.now() + INTEGRATION_LIMITS.fixtureRequestMs;
    while (active.size && Date.now() < deadline) await Bun.sleep(5);
    check(active.size === 0, "Model fixture cleanup did not quiesce");
  }
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async configure(next: ApplicationModelScenario) {
      check(
        state === "running" && active.size === 0 && !configuring,
        "Model fixture is active or stopped",
      );
      check(generation < 100, "Model generation bound exceeded");
      check(
        next.terminalDelayMs === undefined ||
          (Number.isSafeInteger(next.terminalDelayMs) &&
            next.terminalDelayMs >= 1 &&
            next.terminalDelayMs <= 5000),
        "Invalid model frame delay",
      );
      configuring = true;
      try {
        if (provider) generations.push({ generation, evidence: provider.evidence() });
        await provider?.stop();
        check(state === "running", "Model configuration interrupted by cleanup");
        provider = createProviderFixture({
          tool: next.tool,
          toolResultSentinel: next.sentinel,
          maxCalls: 4,
          maxRequestBytes: INTEGRATION_LIMITS.fixtureRequestBytes,
        });
        scenario = structuredClone(next);
        generation++;
      } finally {
        configuring = false;
      }
    },
    snapshot: () => structuredClone(terminal ?? snapshot()),
    seal() {
      if (sealing) return sealing;
      check(
        state === "running" && !configuring,
        "Model fixture cannot be sealed after cleanup or during configuration",
      );
      state = "sealing";
      sealing = (async () => {
        try {
          const deadline = Date.now() + INTEGRATION_LIMITS.fixtureRequestMs;
          while (active.size && Date.now() < deadline) await Bun.sleep(5);
          check(active.size === 0, "Model fixture seal did not drain");
          await server.stop(true);
          await provider?.stop();
          check(
            state === "sealing" &&
              active.size === 0 &&
              lateRequests === 0 &&
              rejectedRequests === 0,
            "Model fixture seal observed cleanup, rejected or late work",
          );
          state = "sealed";
          terminal = snapshot();
          return structuredClone(terminal);
        } catch (error) {
          state = "failed";
          await stop();
          throw error;
        }
      })();
      return sealing;
    },
    stop,
  };
}
