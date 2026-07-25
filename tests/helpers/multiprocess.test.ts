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
});
