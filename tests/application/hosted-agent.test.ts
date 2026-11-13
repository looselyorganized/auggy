import { expect, test } from "bun:test";
import { createHostedAgent } from "../../src/agent";
import type { Augment, TurnTrigger } from "../../src/types";
import { createMockModel } from "../fixtures/mock-model";
import { createMockTransport } from "../fixtures/mock-augment";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function trigger(): TurnTrigger {
  return {
    type: "message",
    turnId: crypto.randomUUID(),
    timestamp: Date.now(),
    source: "test",
    peer: { id: "caller", kind: "human", trustLevel: "creator", sourceAugment: "test" },
    payload: {
      parts: [{ kind: "text", text: "hello" }],
      sourceAugment: "test",
      peer: null,
      timestamp: Date.now(),
    },
  };
}

test("host admission holds transport and direct turns after agent readiness, then admits both", async () => {
  const model = createMockModel();
  const transport = createMockTransport();
  const hosted = createHostedAgent(
    { name: "held", model: "mock", augments: [transport.augment] },
    model,
    {},
  );
  expect(() => hosted.openAdmission()).toThrow(/cannot open/);
  await hosted.agent.start();
  const direct = hosted.agent.inject(trigger());
  const inbound = transport.sendMessage("hello");
  await Bun.sleep(5);
  expect(hosted.snapshot().pendingTurns).toBe(2);
  expect(model.calls).toHaveLength(0);
  expect(hosted.agent.operationalSnapshot().readiness.accepting).toBe(false);
  hosted.openAdmission();
  expect((await direct).success).toBe(true);
  expect((await inbound).success).toBe(true);
  expect(model.calls).toHaveLength(2);
  await hosted.agent.stop();
  expect(await hosted.waitForQuiescence()).toMatchObject({
    admission: "closed",
    pendingTurns: 0,
    resourceState: "closed",
  });
  expect(() => hosted.openAdmission()).toThrow(/cannot open/);
  await expect(hosted.agent.start()).rejects.toThrow(/interrupted/);
});

test("close wins a pending host gate without inference or execution-start callback", async () => {
  const model = createMockModel();
  const observed: string[] = [];
  const hosted = createHostedAgent({ name: "closed", model: "mock", augments: [] }, model, {
    onTurnFinalized: (event) => {
      observed.push(event.outcome);
    },
  });
  await hosted.agent.start();
  let began = false;
  const pending = hosted.agent.inject(trigger(), {
    onExecutionStart: () => {
      began = true;
    },
  });
  await Bun.sleep(1);
  hosted.closeAdmission();
  expect(await pending).toMatchObject({
    status: "rejected",
    rejection: { reason: "runtime-stopping" },
  });
  expect(began).toBe(false);
  expect(model.calls).toHaveLength(0);
  expect(observed).toHaveLength(1);
  await hosted.agent.stop();
  expect((await hosted.waitForQuiescence()).resourceState).toBe("closed");
});

test("abort while waiting for host admission settles the caller and never begins execution", async () => {
  const model = createMockModel();
  const hosted = createHostedAgent({ name: "abort", model: "mock", augments: [] }, model, {});
  await hosted.agent.start();
  const controller = new AbortController();
  const pending = hosted.agent.inject(trigger(), { signal: controller.signal });
  controller.abort();
  expect((await pending).status).toBe("canceled");
  hosted.openAdmission();
  expect(model.calls).toHaveLength(0);
  await hosted.agent.stop();
  await hosted.waitForQuiescence();
});

test("shutdown during boot never boots the next augment and closes every factory allocation exactly once", async () => {
  const entered = deferred();
  const held = deferred();
  const events: string[] = [];
  const augment = (name: string): Augment => ({
    name,
    onBoot: async () => {
      events.push(`boot:${name}`);
    },
    onShutdown: async () => {
      events.push(`close:${name}`);
    },
  });
  const first = augment("first");
  first.onBoot = async () => {
    events.push("boot:first");
    entered.resolve();
    await held.promise;
  };
  const hosted = createHostedAgent(
    { name: "boot", model: "mock", augments: [first, augment("never-booted")] },
    createMockModel(),
    {},
  );
  const starting = hosted.agent.start();
  const failure = starting.catch((error) => error);
  await entered.promise;
  const stopping = hosted.agent.stop();
  expect(hosted.snapshot().admission).toBe("closed");
  held.resolve();
  expect(await failure).toBeInstanceOf(Error);
  await stopping;
  await hosted.agent.stop();
  expect(events).toEqual(["boot:first", "close:first", "close:never-booted"]);
  expect((await hosted.waitForQuiescence()).resourceState).toBe("closed");
});

test("never-started hosted agents dispose the shared effective augment graph once", async () => {
  let closed = 0;
  const hosted = createHostedAgent(
    {
      name: "unbooted",
      model: "mock",
      augments: [
        {
          name: "factory",
          onShutdown: async () => {
            closed++;
          },
        },
      ],
    },
    createMockModel(),
    {},
  );
  await hosted.agent.stop();
  await hosted.agent.stop();
  expect(closed).toBe(1);
  expect((await hosted.waitForQuiescence()).resourceState).toBe("closed");
});

test("host quiescence includes an active model operation and its post-turn hooks", async () => {
  const entered = deferred(),
    held = deferred();
  const model = createMockModel();
  const complete = model.complete.bind(model);
  model.complete = async (prompt) => {
    entered.resolve();
    await held.promise;
    return complete(prompt);
  };
  const hookEntered = deferred(),
    hookHeld = deferred();
  const hosted = createHostedAgent(
    {
      name: "drain",
      model: "mock",
      augments: [
        {
          name: "post",
          onTurnEnd: async () => {
            hookEntered.resolve();
            await hookHeld.promise;
          },
        },
      ],
    },
    model,
    {},
  );
  await hosted.agent.start();
  hosted.openAdmission();
  const turn = hosted.agent.inject(trigger());
  await entered.promise;
  let stopped = false;
  const stopping = hosted.agent.stop().then(() => {
    stopped = true;
  });
  const settlement = hosted.waitForQuiescence();
  expect(hosted.snapshot().pendingTurns).toBe(1);
  held.resolve();
  await hookEntered.promise;
  expect(stopped).toBe(false);
  hookHeld.resolve();
  await turn;
  await stopping;
  expect(await settlement).toMatchObject({ pendingTurns: 0, resourceState: "closed" });
});
