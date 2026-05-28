type HealthFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface HealthCheckOptions {
  fetch?: HealthFetch;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  timeoutMs?: number;
  intervalMs?: number;
}

export interface HealthCheckResult {
  ok: boolean;
  url: string;
  attempts: number;
  status?: number;
  error?: string;
}

const DEFAULT_TIMEOUT_MS = 90_000;
const DEFAULT_INTERVAL_MS = 3_000;

export async function waitForHealth(
  baseUrl: string,
  opts: HealthCheckOptions = {},
): Promise<HealthCheckResult> {
  const healthUrl = new URL("/health", ensureTrailingSlash(baseUrl)).toString();
  const fetchImpl = opts.fetch ?? fetch;
  const sleep =
    opts.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const now = opts.now ?? (() => Date.now());
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const intervalMs = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const deadline = now() + timeoutMs;
  let attempts = 0;
  let lastStatus: number | undefined;
  let lastError: string | undefined;

  while (true) {
    attempts++;
    try {
      const res = await fetchImpl(healthUrl);
      lastStatus = res.status;
      lastError = undefined;
      if (res.ok) {
        return { ok: true, url: healthUrl, attempts, status: res.status };
      }
    } catch (err) {
      lastError = (err as Error).message;
      lastStatus = undefined;
    }

    if (now() >= deadline) {
      return {
        ok: false,
        url: healthUrl,
        attempts,
        status: lastStatus,
        error: lastError,
      };
    }

    await sleep(intervalMs);
  }
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith("/") ? url : `${url}/`;
}
