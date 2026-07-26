import { describe, expect, test } from "bun:test";
import {
  createProviderSignalFetch,
  DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS,
  MAX_PROVIDER_REQUEST_TIMEOUT_MS,
  ProviderRequestTimeoutError,
  resolveProviderRequestTimeoutMs,
  withProviderRequestDeadline,
} from "../../src/engines/_shared/provider-resilience";

describe("provider resilience primitives", () => {
  test("resolves the finite default and strict upper bound", () => {
    expect(resolveProviderRequestTimeoutMs(undefined)).toBe(DEFAULT_PROVIDER_REQUEST_TIMEOUT_MS);
    expect(resolveProviderRequestTimeoutMs(MAX_PROVIDER_REQUEST_TIMEOUT_MS)).toBe(
      MAX_PROVIDER_REQUEST_TIMEOUT_MS,
    );
    for (const invalid of [0, -1, 1.5, Number.NaN, MAX_PROVIDER_REQUEST_TIMEOUT_MS + 1]) {
      expect(() => resolveProviderRequestTimeoutMs(invalid)).toThrow();
    }
  });

  test("rejects before invoking provider code when the caller is already aborted", async () => {
    const controller = new AbortController();
    const reason = new Error("caller canceled");
    controller.abort(reason);
    let invoked = false;

    await expect(
      withProviderRequestDeadline(controller.signal, 100, async () => {
        invoked = true;
        return "unexpected";
      }),
    ).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });

  test("does not invoke provider code when the caller aborts before dispatch", async () => {
    const controller = new AbortController();
    const reason = new Error("caller canceled before dispatch");
    let invoked = false;
    const pending = withProviderRequestDeadline(controller.signal, 100, async () => {
      invoked = true;
      return "unexpected";
    });

    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(invoked).toBe(false);
  });

  test("bounds the whole operation and exposes a stable timeout reason", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      withProviderRequestDeadline(undefined, 5, async (signal) => {
        observedSignal = signal;
        return new Promise<never>(() => {});
      }),
    ).rejects.toBeInstanceOf(ProviderRequestTimeoutError);
    expect(observedSignal?.aborted).toBe(true);
    expect(observedSignal?.reason).toBeInstanceOf(ProviderRequestTimeoutError);
  });

  test("disposes its deadline after successful completion", async () => {
    let observedSignal: AbortSignal | undefined;
    await expect(
      withProviderRequestDeadline(undefined, 10, async (signal) => {
        observedSignal = signal;
        return "ok";
      }),
    ).resolves.toBe("ok");
    await Bun.sleep(20);
    expect(observedSignal?.aborted).toBe(false);
  });

  test("preserves Request and init cancellation when attaching the provider signal", async () => {
    const provider = new AbortController();
    const request = new AbortController();
    const init = new AbortController();
    const observed: AbortSignal[] = [];
    const base = ((_input: string | URL | Request, options?: RequestInit) => {
      observed.push(options?.signal as AbortSignal);
      return Promise.resolve(new Response("ok"));
    }) as typeof fetch;
    const wrapped = createProviderSignalFetch(base, provider.signal);

    await wrapped(new Request("https://provider.example.test", { signal: request.signal }));
    await wrapped("https://provider.example.test", { signal: init.signal });
    expect(observed.every((signal) => !signal.aborted)).toBe(true);

    request.abort(new Error("request canceled"));
    init.abort(new Error("init canceled"));
    expect(observed[0]?.aborted).toBe(true);
    expect(observed[1]?.aborted).toBe(true);
  });
});
