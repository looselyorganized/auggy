import { afterEach, describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { createJsonLineBarrier, spawnJsonLineWorker } from "./multiprocess";

const CHILD = resolve("tests/fixtures/json-line-barrier-child.ts");
const workers: ReturnType<typeof spawnJsonLineWorker>[] = [];

afterEach(async () => {
  await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
});

describe("JSON-line multi-process barrier", () => {
  test("releases every worker only after each has explicitly reached READY", async () => {
    const first = spawnJsonLineWorker({ script: CHILD, args: ["first"] });
    const second = spawnJsonLineWorker({ script: CHILD, args: ["second"] });
    workers.push(first, second);
    const barrier = createJsonLineBarrier([first, second]);

    await barrier.waitUntilReady();
    barrier.release();
    barrier.close();

    expect(await first.next()).toEqual({ event: "RELEASED", worker: "first" });
    expect(await second.next()).toEqual({ event: "RELEASED", worker: "second" });
    expect(await first.process.exited).toBe(0);
    expect(await second.process.exited).toBe(0);
  });

  test("drains noisy child stderr without retaining its contents", async () => {
    const worker = spawnJsonLineWorker({ script: CHILD, args: ["noisy", "noisy"] });
    workers.push(worker);
    const barrier = createJsonLineBarrier([worker]);

    await barrier.waitUntilReady();
    barrier.release();
    barrier.close();

    expect(await worker.next()).toEqual({ event: "RELEASED", worker: "noisy" });
    expect(await worker.process.exited).toBe(0);
    const stderr = await worker.stderr();
    expect(stderr).toContain("worker stderr suppressed");
    expect(stderr).not.toContain("x".repeat(64));
  });

  test("redacts malformed child stdout from diagnostics", async () => {
    const worker = spawnJsonLineWorker({ script: CHILD, args: ["malformed", "malformed"] });
    workers.push(worker);

    let failure: unknown;
    try {
      await worker.next();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("worker emitted invalid JSON");
    expect(String(failure)).not.toContain("credential-sentinel");
  });

  test("redacts unexpected barrier messages from diagnostics", async () => {
    const worker = spawnJsonLineWorker({ script: CHILD, args: ["unexpected", "unexpected"] });
    workers.push(worker);

    let failure: unknown;
    try {
      await createJsonLineBarrier([worker]).waitUntilReady();
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toContain("expected READY from worker");
    expect(String(failure)).not.toContain("credential-sentinel");
  });
});
