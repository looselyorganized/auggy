import { describe, it, expect, spyOn } from "bun:test";
import { withTimeout, TimeoutError } from "@/kernel/timeout";

describe("withTimeout", () => {
  it("does not invoke work when the caller is already aborted", async () => {
    const controller = new AbortController();
    controller.abort(new DOMException("caller left", "AbortError"));
    let invoked = false;

    await expect(
      withTimeout(
        async () => {
          invoked = true;
          return "late";
        },
        100,
        controller.signal,
      ),
    ).rejects.toHaveProperty("name", "AbortError");
    expect(invoked).toBe(false);
  });

  it("returns the result when the call completes before timeout", async () => {
    const result = await withTimeout(async () => "hello", 1000);
    expect(result).toBe("hello");
  });

  it("throws TimeoutError when the call exceeds the timeout", async () => {
    await expect(
      withTimeout(() => new Promise((resolve) => setTimeout(resolve, 500)), 50),
    ).rejects.toThrow(TimeoutError);
  });

  it("clears the timer when the call completes (no leaked timers)", async () => {
    const clearSpy = spyOn(globalThis, "clearTimeout");

    await withTimeout(async () => "fast", 5000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("clears the timer when the call throws (no leaked timers)", async () => {
    const clearSpy = spyOn(globalThis, "clearTimeout");

    await expect(
      withTimeout(async () => {
        throw new Error("boom");
      }, 5000),
    ).rejects.toThrow("boom");

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("propagates the original error, not TimeoutError, when call fails fast", async () => {
    await expect(
      withTimeout(async () => {
        throw new Error("custom error");
      }, 5000),
    ).rejects.toThrow("custom error");
  });

  it("combines caller cancellation with the deadline signal", async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });

    const pending = withTimeout(
      async (signal) => {
        observedSignal = signal;
        markStarted();
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
      5_000,
      caller.signal,
    );

    await started;
    caller.abort(new Error("caller canceled"));

    await expect(pending).rejects.toThrow("caller canceled");
    expect(observedSignal?.aborted).toBe(true);
  });

  it("aborts cooperative work with an outcome-unknown TimeoutError", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      withTimeout(async (signal) => {
        observedSignal = signal;
        return await new Promise<string>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }, 5),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      outcomeUnknown: true,
    });
    expect(observedSignal?.aborted).toBe(true);
  });

  it("reports non-cooperative work that remains detached after caller cancellation", async () => {
    const caller = new AbortController();
    let release!: () => void;
    let started!: () => void;
    const didStart = new Promise<void>((resolve) => {
      started = resolve;
    });
    const underlying = new Promise<string>((resolve) => {
      release = () => resolve("late");
    });
    const detached: Promise<unknown>[] = [];
    const pending = withTimeout(
      async () => {
        started();
        return underlying;
      },
      5_000,
      caller.signal,
      (operation) => detached.push(operation),
    );

    await didStart;
    caller.abort(new DOMException("caller left", "AbortError"));
    await expect(pending).rejects.toHaveProperty("name", "AbortError");
    expect(detached).toHaveLength(1);
    let detachedSettled = false;
    void detached[0]!.then(() => {
      detachedSettled = true;
    });
    await Promise.resolve();
    expect(detachedSettled).toBe(false);
    release();
    await detached[0];
    expect(detachedSettled).toBe(true);
  });

  it("does not report work that cooperatively acknowledges caller cancellation", async () => {
    const caller = new AbortController();
    let startedResolve!: () => void;
    const started = new Promise<void>((resolve) => {
      startedResolve = resolve;
    });
    const detached: Promise<unknown>[] = [];
    const pending = withTimeout(
      async (signal) => {
        startedResolve();
        await new Promise<void>((resolve) => {
          signal.addEventListener("abort", () => resolve(), { once: true });
        });
        signal.throwIfAborted();
      },
      1_000,
      caller.signal,
      (operation) => detached.push(operation),
    );

    await started;
    caller.abort(new DOMException("caller left", "AbortError"));
    await expect(pending).rejects.toThrow("caller left");
    expect(detached).toHaveLength(0);
  });
});
