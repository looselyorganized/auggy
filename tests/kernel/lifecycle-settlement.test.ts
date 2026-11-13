import { expect, test } from "bun:test";
import { createLifecycleManager } from "../../src/kernel/lifecycle-manager";
import { registerCleanupProof } from "../../src/application/cleanup-proof";
import type { Augment } from "../../src/types";

test("shutdown joins already-running idle callbacks before closing resources", async () => {
  let release!: () => void, entered!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const began = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let closed = false;
  const lifecycle = createLifecycleManager({
    name: "test",
    augments: [
      {
        name: "owned",
        onShutdown: async () => {
          closed = true;
        },
      },
    ],
  });
  await lifecycle.boot();
  lifecycle.startIdleTimer(async () => {
    entered();
    await held;
  }, 1);
  await began;
  const stopping = lifecycle.shutdown();
  expect(lifecycle.settlement().pendingIdleCallbacks).toBeGreaterThan(0);
  expect(closed).toBe(false);
  release();
  await stopping;
  expect((await lifecycle.waitForSettlement()).resourceState).toBe("closed");
  expect(closed).toBe(true);
});

test("a shutdown deadline retains actual pending cleanup until late settlement", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const lifecycle = createLifecycleManager({
    name: "test",
    augments: [{ name: "held", onShutdown: async () => held }],
  });
  await lifecycle.boot();
  try {
    expect((await lifecycle.shutdown()).hookFailures).toBe(1);
    expect(lifecycle.settlement()).toMatchObject({
      pendingShutdownHooks: 1,
      resourceState: "unknown",
    });
    let settled = false;
    const settlement = lifecycle.waitForSettlement().then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    release();
    expect(await settlement).toMatchObject({
      pendingShutdownHooks: 0,
      resourceState: "closed",
      failures: ["augment-shutdown-failed"],
    });
  } finally {
    release();
  }
}, 10_000);

test("settled rejection alone is unknown; package-owned closure proof permits failed cleanup release", async () => {
  const unknown: Augment = {
    name: "unknown",
    onShutdown: async () => {
      throw new Error("private");
    },
  };
  const a = createLifecycleManager({ name: "test", augments: [unknown] });
  await a.boot();
  await a.shutdown();
  expect((await a.waitForSettlement()).resourceState).toBe("unknown");
  let closed = false;
  const proven: Augment = {
    name: "known",
    onShutdown: async () => {
      closed = true;
      throw new Error("private");
    },
  };
  registerCleanupProof(proven, () => closed);
  const b = createLifecycleManager({ name: "test", augments: [{ ...proven }] });
  await b.boot();
  await b.shutdown();
  expect(await b.waitForSettlement()).toMatchObject({
    resourceState: "closed",
    failures: ["augment-shutdown-failed"],
  });
});
