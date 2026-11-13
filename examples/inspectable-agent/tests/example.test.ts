import { afterEach, expect, spyOn, test } from "bun:test";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  defineAgent,
  webTransport,
  type ModelClient,
  type ToolExecuteContext,
  type TurnTrigger,
} from "auggy";
import { orderLookupSchema, orderSchema } from "../src/augments/example/schemas";
import { getOrder } from "../src/augments/example/service";

const projectDir = fileURLToPath(new URL("../", import.meta.url));
const temporary: string[] = [];
afterEach(() => {
  for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function isolatedExample() {
  const root = mkdtempSync(join(tmpdir(), "inspectable-example-test-"));
  temporary.push(root);
  cpSync(join(projectDir, "src"), join(root, "src"), { recursive: true });
  symlinkSync(join(projectDir, "node_modules"), join(root, "node_modules"));
  const load = (path: string) => import(pathToFileURL(join(root, "src", path)).href);
  const example = (await load(
    "augments/example/index.ts",
  )) as typeof import("../src/augments/example/index");
  const observability = (await load("observability.ts")) as typeof import("../src/observability");
  const turn = (await load("turn.ts")) as typeof import("../src/turn");
  const records = (channel: string): Record<string, unknown>[] => {
    const file = join(root, "data/observability", `${channel}.jsonl`);
    return existsSync(file)
      ? readFileSync(file, "utf8")
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line))
      : [];
  };
  return {
    root,
    augment: example.default(),
    observability,
    turnProgram: turn.turnProgram,
    records,
  };
}

function context(trustLevel: "creator" | "agent" | "public"): ToolExecuteContext {
  return {
    turnId: crypto.randomUUID(),
    threadId: "private-customer-thread",
    peer: { id: "private-peer", kind: "human", trustLevel, sourceAugment: "test" },
  };
}
function trigger(): TurnTrigger {
  const ctx = context("creator");
  return {
    type: "message",
    turnId: ctx.turnId,
    threadId: ctx.threadId,
    timestamp: Date.now(),
    source: "test",
    peer: ctx.peer,
    payload: {
      parts: [{ kind: "text", text: "private prompt" }],
      sourceAugment: "test",
      peer: ctx.peer,
      timestamp: Date.now(),
    },
  };
}

test("shared schemas reject malformed and extra fields; demo service is deterministic and read-only", () => {
  expect(orderLookupSchema.safeParse({ orderId: "DEMO-1001" }).success).toBe(true);
  for (const input of [
    { orderId: 17 },
    { orderId: "other" },
    { orderId: "DEMO-1001", creator: true },
    {},
  ])
    expect(orderLookupSchema.safeParse(input).success).toBe(false);
  expect(getOrder({ orderId: "DEMO-1001" })).toEqual({
    orderId: "DEMO-1001",
    status: "ready-for-pickup",
    itemCount: 2,
  });
  expect(Object.isFrozen(getOrder({ orderId: "DEMO-1001" }))).toBe(true);
  expect(orderSchema.safeParse(getOrder({ orderId: "DEMO-1001" })).success).toBe(true);
  expect(getOrder({ orderId: "DEMO-9999" })).toBeNull();
  expect(() => getOrder({ orderId: 17 })).toThrow();
});

test("tool rejects missing, agent and public identities before returning order data", async () => {
  const fixture = await isolatedExample();
  const tool = fixture.augment.tools![0]!;
  for (const ctx of [
    undefined,
    { ...context("creator"), peer: null },
    context("agent"),
    context("public"),
  ]) {
    expect(await tool.execute({ orderId: "DEMO-1001" }, ctx)).toEqual({
      content: "Creator authorization is required.",
      isError: true,
    });
  }
  expect(await tool.execute({ orderId: "DEMO-9999" }, context("creator"))).toEqual({
    content: "Demo order not found.",
    isError: true,
  });
  const output = await tool.execute({ orderId: "DEMO-1001" }, context("creator"));
  expect(output).toBe(JSON.stringify(getOrder({ orderId: "DEMO-1001" })));
  expect(fixture.records("tools").map((record) => record.outcome)).toEqual([
    "denied",
    "denied",
    "denied",
    "denied",
    "not-found",
    "found",
  ]);
  const logs = JSON.stringify(fixture.records("tools"));
  for (const secret of ["private-customer-thread", "private-peer", "DEMO-1001", "ready-for-pickup"])
    expect(logs).not.toContain(secret);
  expect(fixture.records("tools").at(-1)?.outputSHA256).toBe(
    fixture.observability.observationHash(output as string),
  );
});

test("actual HTTP route enforces creator bearer auth and shared parameter validation", async () => {
  const fixture = await isolatedExample();
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const model: ModelClient = {
    maxContextTokens: 4096,
    countTokens: (text) => text.length,
    complete: async () => {
      throw new Error("HTTP lookup must not invoke inference");
    },
  };
  const web = webTransport({
    port,
    auth: { type: "bearer", token: "example-test-only" },
    allowAnonymous: false,
    adminRoute: false,
  });
  const agent = defineAgent(
    { name: "example-test", model: "test", augments: [fixture.augment, web] },
    model,
  );
  await agent.start();
  try {
    for (const token of [null, "wrong"]) {
      const response = await fetch(`http://127.0.0.1:${port}/example/orders/DEMO-1001`, {
        headers: token ? { authorization: `Bearer ${token}` } : {},
      });
      expect(response.status).toBe(401);
      await response.text();
    }
    for (const [orderId, status] of [
      ["DEMO-1001", 200],
      ["DEMO-9999", 404],
      ["invalid", 400],
    ] as const) {
      const response = await fetch(`http://127.0.0.1:${port}/example/orders/${orderId}`, {
        headers: { authorization: "Bearer example-test-only" },
      });
      expect(response.status).toBe(status);
      const body = await response.json();
      if (status === 200) expect(body).toEqual(getOrder({ orderId }));
    }
    expect(fixture.records("tools")).toHaveLength(0);
  } finally {
    await agent.stop();
  }
});

test("real managed loop settles the tool before a one-inference stop and preserves two-inference recovery", async () => {
  for (const [maxInferences, invalidInput] of [
    [2, false],
    [1, false],
    [2, true],
  ] as const) {
    const fixture = await isolatedExample();
    let calls = 0;
    const model: ModelClient = {
      maxContextTokens: 20000,
      countTokens: (text) => Math.ceil(text.length / 4),
      complete: async () =>
        ++calls === 1
          ? {
              content: "",
              toolCalls: [
                {
                  name: "example_get_order",
                  arguments: { orderId: invalidInput ? 17 : "DEMO-1001" },
                },
              ],
              finishReason: "tool_use",
              inputTokens: 10,
              outputTokens: 5,
              costUsd: 0.01,
            }
          : {
              content: "Demo order inspected.",
              finishReason: "end_turn",
              inputTokens: 20,
              outputTokens: 5,
              costUsd: 0.02,
            },
    };
    const agent = defineAgent(
      { name: "recipe-test", model: "fixture", augments: [fixture.augment] },
      model,
      {
        turnProgram: { ...fixture.turnProgram, maxInferences },
        onTurnFinalized: fixture.observability.observeFinalization,
      },
    );
    await agent.start();
    try {
      const result = await agent.inject(trigger());
      expect(result.status).toBe("completed");
      expect(calls).toBe(maxInferences);
      const executed = fixture.records("tools").filter((record) => record.outcome === "found");
      expect(executed).toHaveLength(invalidInput ? 0 : 1);
      const finalization = fixture.records("finalization")[0]!;
      expect(finalization).toMatchObject({
        event: "turn.finalized",
        status: "completed",
        history: "memory-only",
        pendingEffects: false,
      });
      const completed = fixture
        .records("turns")
        .find((record) => record.event === "turn.completed")!;
      expect(completed).toMatchObject({
        inferenceSteps: maxInferences,
        usage: {
          inputTokens: maxInferences === 1 ? 10 : 30,
          outputTokens: maxInferences * 5,
          costUsd: maxInferences === 1 ? 0.01 : 0.03,
          unpricedSteps: 0,
        },
      });
      const logs = JSON.stringify([fixture.records("turns"), fixture.records("finalization")]);
      expect(logs).not.toContain("private-customer-thread");
      expect(logs).not.toContain("private prompt");
    } finally {
      await agent.stop();
    }
  }
});

test("provider exceptions produce authoritative finalization without inventing a completed-turn record", async () => {
  const fixture = await isolatedExample();
  const model: ModelClient = {
    maxContextTokens: 20000,
    countTokens: (text) => text.length,
    complete: async () => {
      throw new Error("private provider message");
    },
  };
  const agent = defineAgent(
    { name: "failure-test", model: "fixture", augments: [fixture.augment] },
    model,
    {
      turnProgram: fixture.turnProgram,
      onTurnFinalized: fixture.observability.observeFinalization,
    },
  );
  await agent.start();
  try {
    await expect(agent.inject(trigger())).rejects.toThrow();
    expect(fixture.records("finalization")[0]).toMatchObject({
      event: "turn.finalized",
      disposition: "threw",
      outcome: "failed",
      primaryFailureCode: "provider-failed",
    });
    expect(fixture.records("turns").some((record) => record.event === "turn.completed")).toBe(
      false,
    );
    expect(JSON.stringify(fixture.records("finalization"))).not.toContain(
      "private provider message",
    );
  } finally {
    await agent.stop();
  }
});

test("diagnostic file caps and unsafe destinations never change the business result", async () => {
  for (const unsafe of [false, true]) {
    const fixture = await isolatedExample();
    const directory = join(fixture.root, "data/observability");
    mkdirSync(directory, { recursive: true });
    const file = join(directory, "tools.jsonl");
    const outside = join(fixture.root, "untouched");
    if (unsafe) {
      writeFileSync(outside, "unchanged");
      symlinkSync(outside, file);
    } else writeFileSync(file, Buffer.alloc(1024 * 1024));
    const warning = spyOn(console, "warn").mockImplementation(() => {});
    try {
      for (let attempt = 0; attempt < 2; attempt++)
        expect(
          await fixture.augment.tools![0]!.execute({ orderId: "DEMO-1001" }, context("creator")),
        ).toBe(JSON.stringify(getOrder({ orderId: "DEMO-1001" })));
      expect(warning).toHaveBeenCalledTimes(1);
      if (unsafe) expect(readFileSync(outside, "utf8")).toBe("unchanged");
      else expect(statSync(file).size).toBe(1024 * 1024);
    } finally {
      warning.mockRestore();
    }
  }
});
