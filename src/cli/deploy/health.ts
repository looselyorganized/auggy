import {
  DEPLOYMENT_READINESS_DEFAULTS,
  type HealthCheckOptions,
  type HealthCheckResult,
} from "./contracts";
import { validateHealthPath } from "./profile";

export type { HealthCheckOptions, HealthCheckResult } from "./contracts";
export const HEALTH_TIMEOUT_ERROR = "Health readiness deadline exceeded.";

function duration(value: number): number {
  if (!Number.isFinite(value) || value <= 0 || value > 2_147_483_647) {
    throw new Error(
      "Health durations must be finite positive milliseconds within the supported timer range.",
    );
  }
  return value;
}

export function validateHealthCheckOptions(options: HealthCheckOptions): void {
  duration(options.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthTimeoutMs);
  duration(options.requestTimeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthRequestTimeoutMs);
  duration(options.intervalMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthIntervalMs);
  if (options.healthPath !== undefined) validateHealthPath(options.healthPath);
  if (options.now) {
    let current: number;
    try {
      current = options.now();
    } catch {
      throw new Error("Health clock must produce finite monotonic timestamps.");
    }
    if (
      !Number.isFinite(current) ||
      current < 0 ||
      !Number.isSafeInteger(
        Math.ceil(current + (options.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthTimeoutMs)),
      )
    )
      throw new Error(
        "Health clock must produce finite monotonic timestamps with safe deadline arithmetic.",
      );
  }
}

type Settled<T> = { kind: "value"; value: T } | { kind: "error" } | { kind: "timeout" };

/** A wall-clock timer also bounds defective injected operations that ignore abort. */
async function within<T>(
  operation: Promise<T>,
  milliseconds: number,
  timeout: () => void,
): Promise<Settled<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation.then(
        (value): Settled<T> => ({ kind: "value", value }),
        (): Settled<T> => ({ kind: "error" }),
      ),
      new Promise<Settled<T>>((resolve) => {
        timer = setTimeout(
          () => {
            timeout();
            resolve({ kind: "timeout" });
          },
          Math.max(0, milliseconds),
        );
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

export async function waitForHealth(
  baseUrl: string,
  options: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  validateHealthCheckOptions(options);
  let origin: URL;
  try {
    origin = new URL(baseUrl);
  } catch {
    throw new Error("Health checks require a valid HTTP(S) deployment origin.");
  }
  if (
    !["http:", "https:"].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== "/"
  )
    throw new Error("Health checks require a credential-free HTTP(S) deployment origin.");
  const path = options.healthPath ?? "/health";
  validateHealthPath(path);
  const url = new URL(path, origin).toString();
  const timeoutMs = duration(options.timeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthTimeoutMs);
  const requestTimeoutMs = duration(
    options.requestTimeoutMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthRequestTimeoutMs,
  );
  const intervalMs = duration(options.intervalMs ?? DEPLOYMENT_READINESS_DEFAULTS.healthIntervalMs);
  const clock = options.now ?? (() => performance.now());
  let lastClock = clock();
  if (
    !Number.isFinite(lastClock) ||
    lastClock < 0 ||
    !Number.isSafeInteger(Math.ceil(lastClock + timeoutMs))
  )
    throw new Error(
      "Health clock must produce finite monotonic timestamps with safe deadline arithmetic.",
    );
  const deadline = lastClock + timeoutMs;
  const wallDeadline = performance.now() + timeoutMs;
  const remaining = (): number => {
    const current = clock();
    if (!Number.isFinite(current) || current < lastClock)
      throw new Error("Health clock must remain finite and monotonic.");
    lastClock = current;
    return Math.max(0, Math.min(deadline - current, wallDeadline - performance.now()));
  };
  const fetchImpl = options.fetch ?? fetch;
  let attempts = 0;
  let status: number | undefined;
  const timedOut = (): HealthCheckResult => ({
    ok: false,
    url,
    attempts,
    ...(status === undefined ? {} : { status }),
    error: HEALTH_TIMEOUT_ERROR,
  });
  while (remaining() > 0) {
    attempts++;
    const controller = new AbortController();
    let received: Response | undefined;
    let cleanupStarted = false;
    try {
      const requestDeadline = performance.now() + Math.min(requestTimeoutMs, remaining());
      // Late responses still have their bodies cancelled; cancellation failure is
      // observed without retaining an unhandled rejection or blocking the waiter.
      const request = Promise.resolve()
        .then(() => fetchImpl(url, { signal: controller.signal, redirect: "manual" }))
        .then((response) => {
          if (controller.signal.aborted)
            void Promise.resolve()
              .then(() => response.body?.cancel())
              .catch(() => {});
          return response;
        });
      const response = await within(request, Math.max(0, requestDeadline - performance.now()), () =>
        controller.abort(),
      );
      if (response.kind === "value") {
        received = response.value;
        status = response.value.status;
        const cleanupBudget = Math.min(
          remaining(),
          Math.max(0, requestDeadline - performance.now()),
        );
        cleanupStarted = true;
        const cleanup = await within(
          Promise.resolve().then(() => response.value.body?.cancel()),
          cleanupBudget,
          () => controller.abort(),
        );
        controller.abort();
        if (cleanup.kind === "timeout") return timedOut();
        if (cleanup.kind === "error")
          return { ok: false, url, attempts, status, error: "Health response cleanup failed." };
        const observed = response.value.url;
        let sameOrigin = observed === "";
        try {
          sameOrigin ||= new URL(observed).origin === origin.origin;
        } catch {
          /* Invalid response URL cannot prove readiness. */
        }
        if (remaining() <= 0) return timedOut();
        if (response.value.ok && !response.value.redirected && sameOrigin)
          return { ok: true, url, attempts, status };
      } else {
        status = undefined;
        controller.abort();
      }
    } finally {
      controller.abort();
      if (received && !cleanupStarted)
        void Promise.resolve()
          .then(() => received?.body?.cancel())
          .catch(() => {});
    }
    const rest = remaining();
    if (rest <= 0) break;
    const interval = Math.min(intervalMs, rest);
    if (options.sleep) {
      const slept = await within(
        Promise.resolve().then(() => options.sleep!(interval)),
        rest,
        () => {},
      );
      if (slept.kind === "timeout") return timedOut();
      if (slept.kind === "error") throw new Error("Health polling sleep failed.");
    } else await new Promise<void>((resolve) => setTimeout(resolve, interval));
  }
  return timedOut();
}
