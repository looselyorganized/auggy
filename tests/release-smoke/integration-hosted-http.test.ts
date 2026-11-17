import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createHostedHttpFixture,
  HOSTED_HTTP_LIMITS,
} from "../../scripts/release-smoke/integration-fixtures/http-container/startup";
import {
  assertHostedHttpFixtures,
  assertHostedHttpSourceMarker,
  assertSealedHostedHttpSnapshot,
  editHostedHttpSource,
  observeHostedHttpGeneration,
  parseHostedHttpSnapshot,
  persistHostedHttpGeneration,
  prepareHostedHttpFixtures,
} from "../../scripts/release-smoke/integration-hosted-http";
import { createSyntheticOrdersStore } from "../../examples/company-app/fixtures/synthetic-orders";
import { createOrdersServiceClient } from "../../examples/company-app/agent-integration/orders/service-client";
import { runHostedHttpControl } from "../../scripts/release-smoke/integration-fixtures/http-container/control";
import {
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
} from "../../scripts/release-smoke/provider-fixture";

const controlToken = "1".repeat(64);
const serviceToken = "2".repeat(64);
const options = {
  controlToken,
  serviceToken,
  expectedCheckpointSHA256: null,
  ports: { model: 0, domain: 0, control: 0 },
};
type Fixture = Awaited<ReturnType<typeof createHostedHttpFixture>>;
const call = (fixture: Fixture, operation: unknown, token = controlToken) =>
  fetch(`${fixture.controlOrigin}/control`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-fixture-control": token },
    body: JSON.stringify(operation),
    signal: AbortSignal.timeout(12000),
  });
async function control(fixture: Fixture, operation: unknown) {
  const response = await call(fixture, operation);
  expect(response.status).toBe(200);
  return response.text();
}
function principal() {
  const policy = createSyntheticOrdersStore(":memory:");
  try {
    const authorization = policy.authorizationFor({
      provider: "fixture-app",
      userId: "support-agent",
      orgId: "synthetic-company",
      roles: [],
    });
    return {
      provider: "fixture-app",
      subject: "support-agent",
      orgId: "synthetic-company",
      grants: authorization.grants,
      authzVersion: authorization.authzVersion,
    };
  } finally {
    policy.close();
  }
}
const refund = {
  orderId: "order-a",
  amountCents: 1250,
  reason: "checkpoint-proof",
  operationId: "stable-fixture-operation",
};

test("ordinary quota and invalid authentication cannot consume the reserved immutable final export", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    for (let index = 0; index < 132; index++) {
      const rejected = await call(fixture, { operation: "seal" }, "wrong-authority");
      expect(rejected.status).toBe(403);
      await rejected.body?.cancel();
    }
    await control(fixture, { operation: "initialize", checkpoint: null });
    for (let index = 1; index < HOSTED_HTTP_LIMITS.ordinaryControls; index++)
      await control(fixture, { operation: "snapshot" });
    const exhausted = await call(fixture, { operation: "snapshot" });
    expect(exhausted.status).toBe(400);
    await exhausted.body?.cancel();
    const sealed = await control(fixture, { operation: "seal" });
    expect(assertSealedHostedHttpSnapshot(sealed).checkpoint.effects).toEqual([]);
    for (let index = 1; index < HOSTED_HTTP_LIMITS.terminalControls; index++)
      expect(await control(fixture, { operation: "snapshot" })).toBe(sealed);
    const terminalExhausted = await call(fixture, { operation: "snapshot" });
    expect(terminalExhausted.status).toBe(400);
    await terminalExhausted.body?.cancel();
  } finally {
    await fixture.stop();
  }
}, 10000);

test("a sealed controller checkpoint survives a fresh ephemeral fixture and cannot be rolled back", async () => {
  const first = await createHostedHttpFixture(options);
  const evidence = mkdtempSync(join(tmpdir(), "m5-http-generation-"));
  let saved: ReturnType<typeof assertSealedHostedHttpSnapshot>;
  try {
    await control(first, { operation: "initialize", checkpoint: null });
    const service = createOrdersServiceClient({ origin: first.domainOrigin, token: serviceToken });
    await service.simulateRefund(principal(), refund);
    const bytes = await control(first, { operation: "seal" });
    saved = assertSealedHostedHttpSnapshot(bytes);
    const identity = {
      generation: "first",
      imageDigest: `sha256:${"a".repeat(64)}`,
      deploymentId: null,
      volumeId: "owned-volume",
      sourceSHA256: "b".repeat(64),
    };
    const receipt = persistHostedHttpGeneration({
      evidenceDirectory: evidence,
      name: "http-generation-first.json",
      snapshot: bytes,
      identity,
    });
    expect(receipt.checkpointSHA256).toBe(saved.checkpointSHA256);
    expect(
      JSON.parse(readFileSync(join(evidence, receipt.path), "utf8")).snapshot.checkpoint,
    ).toEqual(saved.checkpoint);
    expect(() =>
      persistHostedHttpGeneration({
        evidenceDirectory: evidence,
        name: receipt.path,
        snapshot: bytes,
        identity,
      }),
    ).toThrow("already exists");
    chmodSync(evidence, 0o755);
    expect(() =>
      persistHostedHttpGeneration({
        evidenceDirectory: evidence,
        name: "http-generation-other.json",
        snapshot: bytes,
        identity,
      }),
    ).toThrow("private");
    chmodSync(evidence, 0o700);
  } finally {
    await first.stop();
  }
  const replacement = await createHostedHttpFixture({
    ...options,
    expectedCheckpointSHA256: saved!.checkpointSHA256,
  });
  try {
    const rollback = await call(replacement, {
      operation: "initialize",
      checkpoint: { ...saved!.checkpoint, effects: [] },
    });
    expect(rollback.status).toBe(400);
    await rollback.body?.cancel();
    const initialized = parseHostedHttpSnapshot(
      await control(replacement, { operation: "initialize", checkpoint: saved!.checkpoint }),
    );
    expect(initialized.initialEffects).toBe(1);
    expect(initialized.initializedFrom).toBe(saved!.checkpointSHA256);
    const service = createOrdersServiceClient({
      origin: replacement.domainOrigin,
      token: serviceToken,
    });
    expect(await service.simulateRefund(principal(), refund)).toEqual(
      saved!.checkpoint.effects[0]!.receipt,
    );
    await service.simulateRefund(principal(), { ...refund, operationId: "new-fixture-operation" });
    const sealed = assertSealedHostedHttpSnapshot(
      await control(replacement, { operation: "seal" }),
    );
    expect(sealed.checkpoint.effects).toHaveLength(2);
    expect(sealed.initialEffects).toBe(1);
  } finally {
    await replacement.stop();
    rmSync(evidence, { recursive: true });
  }
});

async function modelExchange(fixture: Fixture, initialize = true) {
  if (initialize) {
    await control(fixture, { operation: "initialize", checkpoint: null });
    await control(fixture, { operation: "configure", scenario: "read-a" });
  }
  const post = (messages: unknown[]) =>
    fetch(`${fixture.modelOrigin}/v1/messages`, {
      method: "POST",
      headers: { "x-api-key": PROVIDER_FIXTURE_API_KEY, "content-type": "application/json" },
      body: JSON.stringify({
        model: "fixture-model",
        stream: true,
        tools: [{ name: "read_order" }],
        messages,
      }),
      signal: AbortSignal.timeout(5000),
    });
  expect(await (await post([{ role: "user", content: "read order" }])).text()).toContain(
    '"type":"tool_use"',
  );
  const response = await post([
    { role: "user", content: "read order" },
    {
      role: "assistant",
      content: [
        { type: "tool_use", id: "owned-call", name: "read_order", input: { orderId: "order-a" } },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: "owned-call", content: "customer-a-private-marker" },
      ],
    },
  ]);
  const reader = response.body!.getReader();
  const first = await reader.read();
  expect(new TextDecoder().decode(first.value)).toContain('"type":"text_delta"');
  return reader;
}

test("sealing drains the actual delayed model stream to its terminal frame before freezing", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    const reader = await modelExchange(fixture);
    const sealed = control(fixture, { operation: "seal" });
    let tail = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      tail += new TextDecoder().decode(chunk.value);
    }
    expect(tail).toContain("event: message_stop");
    const final = assertSealedHostedHttpSnapshot(await sealed);
    expect(final.model.active).toBe(0);
    expect(final.model.provider?.validatedToolResults).toBe(1);
  } finally {
    await fixture.stop();
  }
});

test("late model work during drain invalidates the terminal proof", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    const reader = await modelExchange(fixture);
    const sealed = call(fixture, { operation: "seal" });
    await Bun.sleep(30);
    const late = await fetch(`${fixture.modelOrigin}/v1/messages`, {
      method: "POST",
      body: "{}",
      signal: AbortSignal.timeout(1000),
    });
    expect(late.status).toBe(503);
    await late.body?.cancel();
    while (!(await reader.read()).done) {}
    const rejected = await sealed;
    expect(rejected.status).toBe(400);
    await rejected.body?.cancel();
    expect((await call(fixture, { operation: "snapshot" })).status).toBe(400);
  } finally {
    await fixture.stop();
  }
});

test("cancelled model output is reaped before sealing and no pending timer escapes", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    const reader = await modelExchange(fixture);
    await reader.cancel();
    const final = assertSealedHostedHttpSnapshot(await control(fixture, { operation: "seal" }));
    expect(final.model.active).toBe(0);
    await Bun.sleep(800);
    expect(parseHostedHttpSnapshot(await control(fixture, { operation: "snapshot" }))).toEqual(
      final,
    );
  } finally {
    await fixture.stop();
  }
});

test("strict snapshot identity and source-marker controls reject fabricated passing evidence", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    await control(fixture, { operation: "initialize", checkpoint: null });
    const bytes = await control(fixture, { operation: "seal" });
    const baseline = JSON.parse(bytes);
    for (const change of [
      (value: typeof baseline) => {
        value.checkpointSHA256 = "0".repeat(64);
      },
      (value: typeof baseline) => {
        value.model.active = 1;
      },
      (value: typeof baseline) => {
        value.domain.late = 1;
      },
      (value: typeof baseline) => {
        value.state = "stopped";
      },
      (value: typeof baseline) => {
        value.privateCredential = "must-not-be-retained";
      },
    ]) {
      const changed = structuredClone(baseline);
      change(changed);
      expect(() => assertSealedHostedHttpSnapshot(JSON.stringify(changed))).toThrow();
    }
    expect(() => assertHostedHttpSourceMarker("actual-marker", "wrong-marker")).toThrow(
      "not observed",
    );
    expect(() => assertHostedHttpSourceMarker("actual-marker", "actual-marker")).not.toThrow();
  } finally {
    await fixture.stop();
  }
});

test("sealed model journals require complete generations, current provider and conserved request counters", async () => {
  const fixture = await createHostedHttpFixture(options);
  try {
    const reader = await modelExchange(fixture);
    while (!(await reader.read()).done) {}
    // Configured generations with no requests are legitimate history, including the current one.
    await control(fixture, { operation: "configure", scenario: "read-b" });
    await control(fixture, { operation: "configure", scenario: "refund" });
    const baseline = assertSealedHostedHttpSnapshot(await control(fixture, { operation: "seal" }));
    expect(baseline.model.providers.map((provider) => provider.evidence.calls)).toEqual([2, 0, 0]);
    for (const change of [
      (value: typeof baseline) => {
        value.model.providers = [];
        value.model.provider!.rejectedRequests = 1;
      },
      (value: typeof baseline) => {
        value.model.providers.shift();
      },
      (value: typeof baseline) => {
        value.model.provider = null;
      },
      (value: typeof baseline) => {
        value.model.providers[1]!.generation = 1;
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.generation = 2;
      },
      (value: typeof baseline) => {
        value.model.requests[0]!.generation = 0;
      },
      (value: typeof baseline) => {
        value.model.requests[0]!.generation = 2;
      },
      (value: typeof baseline) => {
        value.model.requests[1]!.generation = 4;
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.summaries.pop();
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.summaries[1]!.call = 1;
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.summaries[1]!.status = 503;
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.summaries[0]!.outcome = "verified-tool-result";
        value.model.providers[0]!.evidence.summaries[1]!.outcome = "tool-request";
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.scenario = "answer-only";
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.validatedToolResults = 0;
      },
      (value: typeof baseline) => {
        value.model.providers[0]!.evidence.calls = 1;
      },
      (value: typeof baseline) => {
        value.model.provider!.rejectedRequests = 1;
        value.model.providers.at(-1)!.evidence.rejectedRequests = 1;
      },
    ]) {
      const changed = structuredClone(baseline);
      change(changed);
      expect(() => assertSealedHostedHttpSnapshot(JSON.stringify(changed))).toThrow();
    }
  } finally {
    await fixture.stop();
  }
});

for (const drift of [
  "none",
  "admitted-effect",
  "duplicate-domain-call",
  "model-generation",
] as const) {
  test(`observer reconciles the sealed journal against completed observations: ${drift}`, async () => {
    const fixture = await createHostedHttpFixture(options);
    let server: ReturnType<typeof Bun.serve> | undefined;
    let pending: Promise<Response> | undefined;
    try {
      const baseline = await control(fixture, { operation: "initialize", checkpoint: null });
      const configured = await control(fixture, { operation: "configure", scenario: "read-a" });
      const reader = await modelExchange(fixture, false);
      while (!(await reader.read()).done) {}
      const service = createOrdersServiceClient({
        origin: fixture.domainOrigin,
        token: serviceToken,
      });
      await service.simulateRefund(principal(), refund);
      const after = await control(fixture, { operation: "snapshot" });
      // Feed real fixture journals through an isolated HTTP observation boundary.
      server = Bun.serve({
        hostname: "127.0.0.1",
        port: 0,
        fetch(request) {
          if (new URL(request.url).pathname === "/orders/order-b")
            return new Response(null, { status: 403 });
          const token = request.headers.get("x-auggy-auth-assertion");
          if (!token || token.endsWith("-wrong")) return new Response(null, { status: 401 });
          let step = 0;
          return new Response(
            new ReadableStream(
              {
                async pull(controller) {
                  if (step++ === 0)
                    controller.enqueue(
                      new TextEncoder().encode(
                        `data: ${JSON.stringify({ type: "TEXT_MESSAGE_CONTENT", delta: PROVIDER_FIXTURE_FINAL_TEXT })}\n\n`,
                      ),
                    );
                  else {
                    await Bun.sleep(30);
                    controller.enqueue(
                      new TextEncoder().encode('data: {"type":"RUN_FINISHED"}\n\n'),
                    );
                    controller.close();
                  }
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "text/event-stream" } },
          );
        },
      });
      let sealed: string | undefined;
      const observed = observeHostedHttpGeneration({
        agentOrigin: `http://127.0.0.1:${server.port}`,
        signer: (input) => input.audience,
        secret: "test",
        keyId: "key",
        audience: "observer-regression",
        checkpoint: null,
        operationId: "observer-operation-0001",
        threadId: "observer-thread-0001",
        expectedSourceMarker: null,
        control: async (operation) => {
          if (operation.operation === "initialize") return baseline;
          if (operation.operation === "configure") return configured;
          if (operation.operation === "snapshot") return sealed ?? after;
          let writer: ReadableStreamDefaultController<Uint8Array> | undefined;
          if (drift === "admitted-effect") {
            const body = JSON.stringify({
              principal: principal(),
              ...refund,
              operationId: "unobserved-admitted-effect",
            });
            pending = fetch(`${fixture.domainOrigin}/refunds/simulate`, {
              method: "POST",
              headers: { authorization: `Bearer ${serviceToken}` },
              body: new ReadableStream({
                start(controller) {
                  writer = controller;
                  controller.enqueue(new TextEncoder().encode(body.slice(0, -1)));
                },
              }),
              signal: AbortSignal.timeout(3000),
            });
            let active = 0;
            for (let index = 0; index < 30 && !active; index++) {
              active = parseHostedHttpSnapshot(await control(fixture, { operation: "snapshot" }))
                .domain.active;
              if (!active) await Bun.sleep(5);
            }
            expect(active).toBe(1);
          } else if (drift === "duplicate-domain-call") {
            await service.simulateRefund(principal(), refund);
          } else if (drift === "model-generation") {
            await control(fixture, { operation: "configure", scenario: "read-a" });
          }
          const sealing = fixture.seal();
          if (writer) {
            writer.enqueue(new TextEncoder().encode("}"));
            writer.close();
          }
          if (pending) {
            const response = await pending;
            expect(response.status).toBe(200);
            await response.body?.cancel();
          }
          sealed = await sealing;
          return sealed;
        },
      });
      if (drift === "none") {
        const accepted = await observed;
        expect(accepted.effectCount).toBe(1);
        expect(accepted.effectCount).toBe(accepted.checkpoint.effects.length);
        expect(accepted.duplicateEffectCount).toBe(0);
        expect(accepted.unauthorizedEffectCount).toBe(0);
      } else {
        await expect(observed).rejects.toThrow("Unexpected HTTP work changed");
      }
    } finally {
      await pending?.catch(() => {});
      await server?.stop(true);
      await fixture.stop();
    }
  }, 10000);
}

test("prepared HTTP source inventory is explicit and owns its startup, shutdown and source-edit anchors", () => {
  const root = mkdtempSync(join(tmpdir(), "m5-http-source-"));
  try {
    mkdirSync(join(root, "src"));
    for (const file of ["main", "http"])
      writeFileSync(
        join(root, `src/${file}.ts`),
        readFileSync(
          new URL(
            `../../src/scaffold-templates/application/src/${file}.ts.template`,
            import.meta.url,
          ),
        ),
      );
    writeFileSync(
      join(root, "agent.yaml"),
      "id: aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa\nname: fixture\nengine:\n  type: anthropic\n  model: fixture-model\naugments: []\n",
    );
    const prepared = prepareHostedHttpFixtures(root);
    expect(prepared.files).toHaveLength(11);
    expect(new Set(prepared.files.map((file) => file.path)).size).toBe(11);
    expect(() => assertHostedHttpFixtures(root, prepared.files.slice(1))).toThrow();
    expect(() =>
      assertHostedHttpFixtures(
        root,
        prepared.files.map((file, index) =>
          index === 0 ? { ...file, sha256: "0".repeat(64) } : file,
        ),
      ),
    ).toThrow();
    expect(readFileSync(join(root, "src/main.ts"), "utf8")).toContain(
      "await startContainerHttpFixture()",
    );
    expect(readFileSync(join(root, "src/augments/orders/index.ts"), "utf8")).toContain(
      "onShutdown: stopContainerHttpFixture",
    );
    const original = readFileSync(join(root, "src/main.ts"));
    writeFileSync(join(root, "src/main.ts"), `${original.toString("utf8")}\n// changed\n`);
    expect(() => assertHostedHttpFixtures(root, prepared.files)).toThrow();
    writeFileSync(join(root, "src/main.ts"), original);
    const edited = editHostedHttpSource(root, "owned-marker");
    expect(edited.beforeSHA256).not.toBe(edited.afterSHA256);
    expect(readFileSync(join(root, "src/http.ts"), "utf8")).toContain(
      'response.headers.set("x-auggy-hosted-source", "owned-marker")',
    );
    expect(() => editHostedHttpSource(root, "another-marker")).toThrow("anchor");
    expect(() => prepareHostedHttpFixtures(root)).toThrow();
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("static remote control rejects unknown operations and credential fields before network access", async () => {
  await expect(
    runHostedHttpControl({ operation: "shell", command: "echo private" }),
  ).rejects.toThrow();
  await expect(
    runHostedHttpControl({ operation: "snapshot", secret: "private-canary" }),
  ).rejects.toThrow();
});

test("HTTP force cleanup racing a seal never returns an accepted final snapshot", async () => {
  const fixture = await createHostedHttpFixture(options);
  await control(fixture, { operation: "initialize", checkpoint: null });
  const sealing = fixture.seal().then(
    () => false,
    () => true,
  );
  await fixture.stop();
  expect(await sealing).toBe(true);
});

for (const failure of ["late-work", "body-deadline"] as const) {
  test(`HTTP sealing refuses ${failure} while an admitted domain body is draining`, async () => {
    const fixture = await createHostedHttpFixture(options);
    const abort = new AbortController();
    let writer!: ReadableStreamDefaultController<Uint8Array>;
    let pending: Promise<Response | null> | undefined;
    try {
      await control(fixture, { operation: "initialize", checkpoint: null });
      const body = JSON.stringify({ principal: principal(), ...refund });
      pending = fetch(`${fixture.domainOrigin}/refunds/simulate`, {
        method: "POST",
        headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            writer = controller;
            controller.enqueue(new TextEncoder().encode(body.slice(0, -1)));
          },
        }),
        signal: abort.signal,
      }).catch(() => null);
      let active = 0;
      for (let index = 0; index < 20 && !active; index++) {
        active = parseHostedHttpSnapshot(await control(fixture, { operation: "snapshot" })).domain
          .active;
        if (!active) await Bun.sleep(10);
      }
      expect(active).toBe(1);
      const sealing = fixture.seal().then(
        () => false,
        () => true,
      );
      if (failure === "late-work") {
        const late = await fetch(`${fixture.domainOrigin}/refunds/simulate`, {
          method: "POST",
          headers: { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" },
          body: JSON.stringify({
            principal: principal(),
            ...refund,
            operationId: "late-operation",
          }),
          signal: AbortSignal.timeout(1000),
        });
        expect(late.status).toBe(503);
        await late.body?.cancel();
        writer.enqueue(new TextEncoder().encode("}"));
        writer.close();
      }
      const response = await pending;
      expect(response?.status).toBe(failure === "late-work" ? 200 : 400);
      await response?.body?.cancel();
      expect(await sealing).toBe(true);
      const final = await call(fixture, { operation: "snapshot" });
      expect(final.status).toBe(400);
      await final.body?.cancel();
    } finally {
      abort.abort();
      await pending;
      await fixture.stop();
    }
  }, 6000);
}
