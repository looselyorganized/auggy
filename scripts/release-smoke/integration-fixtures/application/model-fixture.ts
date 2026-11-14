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
  maximum = INTEGRATION_LIMITS.fixtureRequestBytes,
): Promise<string> {
  const reader = request.body?.getReader();
  check(reader, "Fixture request body missing");
  const chunks: Uint8Array[] = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    void reader.cancel().catch(() => {});
  }, INTEGRATION_LIMITS.fixtureRequestMs);
  try {
    for (;;) {
      const part = await reader.read();
      check(!timedOut, "Fixture body deadline exceeded");
      if (part.done) break;
      size += part.value.byteLength;
      check(size <= maximum, "Fixture body limit exceeded");
      chunks.push(part.value);
    }
    return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks));
  } finally {
    clearTimeout(timeout);
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

export function createApplicationModelFixture() {
  let provider: ProviderFixture | undefined;
  let scenario: ApplicationModelScenario | undefined;
  let active = 0;
  let totalRequests = 0;
  let stopped = false;
  const requests: {
    generation: number;
    containsA: boolean;
    containsB: boolean;
    authorizationDenied: boolean;
    offeredTools: string[];
    creatorPreamble: boolean;
  }[] = [];
  let generation = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 10,
    maxRequestBodySize: INTEGRATION_LIMITS.fixtureRequestBytes,
    async fetch(request) {
      if (
        stopped ||
        !provider ||
        !scenario ||
        request.method !== "POST" ||
        new URL(request.url).pathname !== "/v1/messages"
      )
        return Response.json({ error: "fixture_unavailable" }, { status: 503 });
      active++;
      try {
        check(++totalRequests <= 100 && requests.length < 100, "Model request bound exceeded");
        const raw = await boundedFixtureBody(request);
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
          signal: AbortSignal.timeout(INTEGRATION_LIMITS.fixtureRequestMs),
        });
        const output = await boundedFixtureBody(response);
        const delay = scenario.terminalDelayMs ?? 750;
        if (
          response.ok &&
          output.includes('"type":"text_delta"') &&
          output.includes("event: message_delta")
        ) {
          const boundary = output.indexOf("event: message_delta");
          const encoder = new TextEncoder();
          let timer: ReturnType<typeof setTimeout> | undefined;
          let finished = false;
          const finish = () => {
            if (!finished) {
              finished = true;
              active--;
            }
          };
          return new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(encoder.encode(output.slice(0, boundary)));
                timer = setTimeout(() => {
                  try {
                    controller.enqueue(encoder.encode(output.slice(boundary)));
                    controller.close();
                  } finally {
                    finish();
                  }
                }, delay);
              },
              cancel() {
                if (timer) clearTimeout(timer);
                finish();
              },
            }),
            { status: response.status, headers: response.headers },
          );
        }
        active--;
        return new Response(output, { status: response.status, headers: response.headers });
      } catch {
        active--;
        return Response.json({ error: "fixture_request_rejected" }, { status: 400 });
      }
    },
  });
  return {
    origin: `http://127.0.0.1:${server.port}`,
    async configure(next: ApplicationModelScenario) {
      check(!stopped && active === 0, "Model fixture is active or stopped");
      check(
        next.terminalDelayMs === undefined ||
          (Number.isSafeInteger(next.terminalDelayMs) &&
            next.terminalDelayMs >= 1 &&
            next.terminalDelayMs <= 5000),
        "Invalid model frame delay",
      );
      await provider?.stop();
      provider = createProviderFixture({
        tool: next.tool,
        toolResultSentinel: next.sentinel,
        maxCalls: 4,
        maxRequestBytes: INTEGRATION_LIMITS.fixtureRequestBytes,
      });
      scenario = structuredClone(next);
      generation++;
    },
    snapshot() {
      return {
        generation,
        active,
        totalRequests,
        provider: provider?.evidence() ?? null,
        requests: structuredClone(requests),
      };
    },
    async stop() {
      stopped = true;
      await server.stop(true);
      await provider?.stop();
    },
  };
}
