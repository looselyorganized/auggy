import { describe, it, expect, vi } from "vitest";
import { withTimeout, TimeoutError } from "@/kernel/timeout";

describe("withTimeout", () => {
  it("returns the result when the call completes before timeout", async () => {
    const result = await withTimeout(async () => "hello", 1000);
    expect(result).toBe("hello");
  });

  it("throws TimeoutError when the call exceeds the timeout", async () => {
    await expect(
      withTimeout(
        () => new Promise((resolve) => setTimeout(resolve, 500)),
        50,
      ),
    ).rejects.toThrow(TimeoutError);
  });

  it("clears the timer when the call completes (no leaked timers)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

    await withTimeout(async () => "fast", 5000);

    expect(clearSpy).toHaveBeenCalled();
    clearSpy.mockRestore();
  });

  it("clears the timer when the call throws (no leaked timers)", async () => {
    const clearSpy = vi.spyOn(globalThis, "clearTimeout");

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
});
