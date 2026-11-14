/** Deterministic downstream peers for the real installed HTTP agent. Never a production service. */
import { createHash, timingSafeEqual } from "node:crypto";
import { lstatSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import {
  createSyntheticOrdersHandler,
  createSyntheticOrdersStore,
  serializeSyntheticOrdersCheckpoint,
  type SyntheticOrdersCheckpoint,
} from "../../../../examples/company-app/fixtures/synthetic-orders";
import {
  boundedFixtureBody,
  createApplicationModelFixture,
  type ApplicationModelScenario,
} from "../application/model-fixture";

export const HOSTED_HTTP_PORTS = Object.freeze({ model: 43151, domain: 43152, control: 43153 });
export const HOSTED_HTTP_LIMITS = Object.freeze({
  ordinaryControls: 128,
  terminalControls: 8,
  domainCalls: 100,
  controlBytes: 64 * 1024,
  snapshotBytes: 2 * 1024 * 1024,
  drainMs: 10_000,
});
export const HOSTED_HTTP_QUIESCENT = "auggy-hosted-http-fixtures:quiescent";
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
const controlSchema = z.discriminatedUnion("operation", [
  z.object({ operation: z.literal("initialize"), checkpoint: z.unknown() }).strict(),
  z
    .object({ operation: z.literal("configure"), scenario: z.enum(["read-a", "read-b", "refund"]) })
    .strict(),
  z.object({ operation: z.literal("snapshot") }).strict(),
  z.object({ operation: z.literal("seal") }).strict(),
]);
export type HostedHttpControl = z.infer<typeof controlSchema>;
export const parseHostedHttpControl = (value: unknown): HostedHttpControl =>
  controlSchema.parse(value);

const scenarios: Record<"read-a" | "read-b" | "refund", ApplicationModelScenario> = {
  "read-a": {
    tool: { name: "read_order", input: { orderId: "order-a" }, invalidInput: { orderId: 1 } },
    sentinel: "customer-a-private-marker",
  },
  "read-b": {
    tool: { name: "read_order", input: { orderId: "order-b" }, invalidInput: { orderId: 1 } },
    sentinel: "customer-b-private-marker",
  },
  refund: {
    tool: {
      name: "simulate_refund",
      input: { orderId: "order-a", amountCents: 1250, reason: "hosted-integration-proof" },
      invalidInput: { orderId: 1 },
    },
    sentinel: '"simulated":true',
    terminalDelayMs: 750,
  },
};

export async function createHostedHttpFixture(options: {
  controlToken: string;
  serviceToken: string;
  expectedCheckpointSHA256: string | null;
  ports?: { model: number; domain: number; control: number };
}) {
  check(
    /^[a-f0-9]{64}$/.test(options.controlToken) && /^[a-f0-9]{64}$/.test(options.serviceToken),
    "Missing private HTTP fixture authority",
  );
  check(
    options.expectedCheckpointSHA256 === null ||
      /^[a-f0-9]{64}$/.test(options.expectedCheckpointSHA256),
    "Missing expected downstream checkpoint identity",
  );
  const ports = options.ports ?? HOSTED_HTTP_PORTS;
  check(
    Object.values(ports).every((port) => Number.isInteger(port) && port >= 0 && port <= 65535),
    "Invalid fixture ports",
  );
  const directory = mkdtempSync(join(tmpdir(), "auggy-hosted-domain-"));
  const directoryIdentity = lstatSync(directory);
  check((directoryIdentity.mode & 0o777) === 0o700, "Fixture directory must be private");
  const store = createSyntheticOrdersStore(join(directory, "domain.sqlite"));
  let model: ReturnType<typeof createApplicationModelFixture>;
  let domain: ReturnType<typeof Bun.serve> | undefined;
  let control: ReturnType<typeof Bun.serve> | undefined;
  let state: "waiting" | "active" | "sealing" | "sealed" | "failed" | "stopped" = "waiting";
  let initialEffects = 0;
  let initializedFrom: string | null = null;
  let domainCalls = 0;
  let activeDomain = 0;
  let lateDomain = 0;
  let rejectedDomain = 0;
  let ordinaryControls = 0;
  let terminalControls = 0;
  let activeControl = 0;
  let controlMutation = false;
  let terminalBytes: string | undefined;
  let sealPromise: Promise<string> | undefined;
  let storeClosed = false;
  let stopped: Promise<void> | undefined;
  const expectedControl = Buffer.from(options.controlToken);
  const domainHandler = createSyntheticOrdersHandler(store, options.serviceToken);
  function snapshot() {
    const checkpoint = store.checkpoint();
    const value = {
      version: 1 as const,
      state,
      initializedFrom,
      initialEffects,
      domain: {
        calls: domainCalls,
        active: activeDomain,
        late: lateDomain,
        rejected: rejectedDomain,
      },
      model: model.snapshot(),
      checkpoint: checkpoint.checkpoint,
      checkpointSHA256: checkpoint.sha256,
    };
    const bytes = JSON.stringify(value);
    check(
      Buffer.byteLength(bytes) <= HOSTED_HTTP_LIMITS.snapshotBytes,
      "HTTP fixture snapshot exceeded bound",
    );
    return bytes;
  }
  async function stop() {
    if (stopped) return stopped;
    if (state !== "sealed" && state !== "failed") state = "stopped";
    stopped = (async () => {
      const outcomes = await Promise.allSettled([
        control?.stop(true),
        domain?.stop(true),
        model?.stop(),
      ]);
      const deadline = Date.now() + HOSTED_HTTP_LIMITS.drainMs;
      while ((activeDomain || activeControl) && Date.now() < deadline) await Bun.sleep(5);
      check(
        outcomes.every((outcome) => outcome.status === "fulfilled") &&
          activeDomain === 0 &&
          activeControl === 0,
        "HTTP fixture cleanup did not quiesce",
      );
      if (!storeClosed) {
        store.close();
        storeClosed = true;
      }
      const identity = lstatSync(directory);
      check(
        identity.isDirectory() &&
          !identity.isSymbolicLink() &&
          identity.dev === directoryIdentity.dev &&
          identity.ino === directoryIdentity.ino,
        "HTTP fixture directory changed before cleanup",
      );
      rmSync(directory, { recursive: true });
    })();
    return stopped;
  }
  function seal() {
    if (sealPromise) return sealPromise;
    check(
      state === "active" && !controlMutation,
      "HTTP fixture cannot seal before initialization or during configuration",
    );
    state = "sealing";
    sealPromise = (async () => {
      try {
        const sealingModel = model.seal().then(
          () => null,
          (error: unknown) => error,
        );
        const deadline = Date.now() + HOSTED_HTTP_LIMITS.drainMs;
        while (activeDomain && Date.now() < deadline) await Bun.sleep(5);
        check(activeDomain === 0, "HTTP domain seal did not drain");
        await domain!.stop(true);
        const modelFailure = await sealingModel;
        if (modelFailure !== null) throw modelFailure;
        check(
          state === "sealing" && lateDomain === 0 && rejectedDomain === 0 && activeDomain === 0,
          "HTTP fixture seal observed cleanup, late or rejected work",
        );
        state = "sealed";
        terminalBytes = snapshot();
        store.close();
        storeClosed = true;
        return terminalBytes;
      } catch (error) {
        state = "failed";
        await Promise.allSettled([domain?.stop(true), model.stop()]);
        throw error;
      }
    })();
    return sealPromise;
  }
  try {
    model = createApplicationModelFixture({ port: ports.model });
    domain = Bun.serve({
      hostname: "127.0.0.1",
      port: ports.domain,
      idleTimeout: 5,
      maxRequestBodySize: 16 * 1024,
      async fetch(request) {
        if (state !== "active") {
          if (state === "sealing" || state === "sealed") lateDomain++;
          else rejectedDomain++;
          return new Response(null, { status: 503 });
        }
        if (++domainCalls > HOSTED_HTTP_LIMITS.domainCalls || activeDomain >= 8) {
          rejectedDomain++;
          return new Response(null, { status: 503 });
        }
        activeDomain++;
        try {
          const response = await domainHandler(request);
          const bytes = await boundedFixtureBody(response, 16 * 1024);
          if (!response.ok) rejectedDomain++;
          return new Response(bytes, { status: response.status, headers: response.headers });
        } catch {
          rejectedDomain++;
          return new Response(null, { status: 503 });
        } finally {
          activeDomain--;
        }
      },
    });
    control = Bun.serve({
      hostname: "127.0.0.1",
      port: ports.control,
      idleTimeout: 5,
      maxRequestBodySize: HOSTED_HTTP_LIMITS.controlBytes,
      async fetch(request) {
        const candidate = Buffer.from(request.headers.get("x-fixture-control") ?? "");
        if (
          request.method !== "POST" ||
          new URL(request.url).pathname !== "/control" ||
          new URL(request.url).search ||
          candidate.length !== expectedControl.length ||
          !timingSafeEqual(candidate, expectedControl)
        )
          return new Response(null, { status: 403 });
        if (activeControl >= 2 || state === "stopped") return new Response(null, { status: 503 });
        activeControl++;
        try {
          const input = parseHostedHttpControl(
            JSON.parse(await boundedFixtureBody(request, HOSTED_HTTP_LIMITS.controlBytes)),
          );
          const terminal =
            input.operation === "seal" ||
            ((state === "sealing" || state === "sealed" || state === "failed") &&
              input.operation === "snapshot");
          if (terminal)
            check(
              ++terminalControls <= HOSTED_HTTP_LIMITS.terminalControls,
              "Terminal control quota exhausted",
            );
          else
            check(
              ++ordinaryControls <= HOSTED_HTTP_LIMITS.ordinaryControls,
              "Ordinary control quota exhausted",
            );
          if (input.operation === "seal")
            return new Response(await seal(), { headers: { "content-type": "application/json" } });
          if (input.operation === "snapshot") {
            if (state === "sealing") await sealPromise;
            check(state !== "failed", "HTTP fixture seal failed");
            return new Response(terminalBytes ?? snapshot(), {
              headers: { "content-type": "application/json" },
            });
          }
          check(!controlMutation, "HTTP fixture control mutation is active");
          controlMutation = true;
          try {
            if (input.operation === "initialize") {
              check(state === "waiting", "HTTP fixture was already initialized");
              if (options.expectedCheckpointSHA256 === null)
                check(input.checkpoint === null, "Fresh generation requires an empty checkpoint");
              else {
                check(input.checkpoint !== null, "Replacement requires its downstream checkpoint");
                initializedFrom = store.restoreCheckpoint(
                  input.checkpoint,
                  options.expectedCheckpointSHA256,
                );
              }
              initialEffects = store.checkpoint().checkpoint.effects.length;
              state = "active";
            } else {
              check(state === "active", "HTTP fixture is not active");
              await model.configure(scenarios[input.scenario]);
            }
          } finally {
            controlMutation = false;
          }
          return new Response(snapshot(), { headers: { "content-type": "application/json" } });
        } catch {
          return Response.json({ error: "http-fixture-control-rejected" }, { status: 400 });
        } finally {
          activeControl--;
        }
      },
    });
    return {
      modelOrigin: model.origin,
      domainOrigin: `http://127.0.0.1:${domain.port}`,
      controlOrigin: `http://127.0.0.1:${control.port}`,
      stop,
      seal,
    };
  } catch (error) {
    await stop();
    throw error;
  }
}

let fixture: Awaited<ReturnType<typeof createHostedHttpFixture>> | undefined;
export async function startContainerHttpFixture() {
  check(!fixture, "HTTP fixture already started");
  const expected = process.env.AUGGY_FIXTURE_DOWNSTREAM_CHECKPOINT;
  check(
    expected === "empty" || (typeof expected === "string" && /^[a-f0-9]{64}$/.test(expected)),
    "Missing explicit downstream initialization mode",
  );
  fixture = await createHostedHttpFixture({
    controlToken: process.env.AUGGY_FIXTURE_CONTROL_TOKEN ?? "",
    serviceToken: process.env.ORDERS_SERVICE_TOKEN ?? "",
    expectedCheckpointSHA256: expected === "empty" ? null : expected,
  });
  try {
    check(
      fixture.modelOrigin === `http://127.0.0.1:${HOSTED_HTTP_PORTS.model}` &&
        fixture.domainOrigin === process.env.ORDERS_SERVICE_URL,
      "HTTP fixture origins differ from the recorded loopback peers",
    );
  } catch (error) {
    await fixture.stop();
    throw error;
  }
}
export async function stopContainerHttpFixture() {
  await fixture?.stop();
  console.log(HOSTED_HTTP_QUIESCENT);
}

export type HostedHttpCheckpoint = SyntheticOrdersCheckpoint;
export const hostedCheckpoint = serializeSyntheticOrdersCheckpoint;
export const hostedSnapshotHash = hash;
