/** Bounded network and diagnostic-file operations for the actual installed app. */
import { createHash } from "node:crypto";
import { lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import { APPLICATION_BOUNDS, type startApplicationChild } from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function readApplicationJsonLines(root: string, file: string): Record<string, unknown>[] {
  check(!isAbsolute(file) && !file.includes("\\"), "Diagnostic file must be project-relative");
  const parts = file.split("/");
  check(
    parts.every((part) => part !== "" && part !== "." && part !== ".."),
    "Invalid diagnostic file path",
  );
  const owner = realpathSync(root);
  let current = owner;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    if (!stat) return [];
    check(!stat.isSymbolicLink(), "Diagnostic file may not traverse symlinks");
  }
  const parent = realpathSync(current);
  const rel = relative(owner, parent);
  check(
    rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel),
    "Diagnostic file escaped the consumer",
  );
  const path = join(parent, parts.at(-1)!);
  let bytes: Buffer | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      bytes = readBoundedRegularFile(path, APPLICATION_BOUNDS.outputBytes).bytes;
      break;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT") return [];
      // Diagnostic writers can append while being polled. Retry only detected
      // changes, with a fixed attempt cap and the same byte bound each time.
      if (code !== "ERR_BOUNDED_FILE_CHANGED" || attempt === 2) throw error;
    }
  }
  check(bytes, "Diagnostic file did not produce a stable bounded read");
  const text = bytes.toString("utf8");
  check(text === "" || text.endsWith("\n"), "Diagnostic writer left a partial JSONL record");
  const lines = text.split("\n").filter(Boolean);
  check(lines.length <= 4096, "Too many application diagnostic records");
  return lines.map((line) => {
    check(Buffer.byteLength(line) <= 16_384, "Diagnostic record exceeds its bound");
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error("Invalid application diagnostic JSON");
    }
    check(
      value !== null && typeof value === "object" && !Array.isArray(value),
      "Diagnostic record must be an object",
    );
    return value as Record<string, unknown>;
  });
}

export function applicationThreadRef(threadId: string): string {
  return createHash("sha256").update(threadId).digest("hex");
}

export async function readApplicationResponse(
  response: Response,
  signal: AbortSignal,
): Promise<string> {
  check(response.body, "Application response has no readable body");
  const reader = response.body.getReader();
  let bytes = 0;
  let chunks = 0;
  const output: Uint8Array[] = [];
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await new Promise<Awaited<ReturnType<typeof reader.read>>>((resolve, reject) => {
        const abort = () => reject(signal.reason ?? new Error("Application request aborted"));
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) {
          signal.removeEventListener("abort", abort);
          abort();
        } else
          reader
            .read()
            .then(resolve, reject)
            .finally(() => signal.removeEventListener("abort", abort));
      });
      if (next.done) return Buffer.concat(output).toString("utf8");
      chunks++;
      bytes += next.value.length;
      check(
        chunks <= 4096 && bytes <= APPLICATION_BOUNDS.outputBytes,
        "Application response exceeded its bound",
      );
      if (next.value.length) output.push(next.value);
    }
  } finally {
    // A malicious/non-cooperative body must not hold the acceptance process open.
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface ApplicationResponse {
  status: number;
  body: string;
  headers: Readonly<Record<string, string>>;
}

export function applicationHttp(baseURL: string, bearer: string) {
  const base = new URL(baseURL);
  check(
    base.protocol === "http:" &&
      base.hostname === "127.0.0.1" &&
      base.pathname === "/" &&
      !base.username &&
      !base.password,
    "Application fixture HTTP must target its loopback listener",
  );
  let calls = 0;
  return {
    async request(
      path: string,
      options: {
        method?: "GET" | "POST";
        json?: unknown;
        auth?: "valid" | "missing" | "invalid";
        idempotencyKey?: string;
        timeoutMs?: number;
        signal?: AbortSignal;
      } = {},
    ): Promise<ApplicationResponse> {
      check(
        path.startsWith("/") && !path.startsWith("//") && !path.includes("\\"),
        "Request path must remain local",
      );
      check(++calls <= 2048, "Application request count exceeded its bound");
      const timeoutMs = options.timeoutMs ?? 30_000;
      check(
        Number.isSafeInteger(timeoutMs) &&
          timeoutMs > 0 &&
          timeoutMs <= APPLICATION_BOUNDS.scenarioMs,
        "Invalid application request timeout",
      );
      const signal = AbortSignal.any([
        AbortSignal.timeout(timeoutMs),
        ...(options.signal ? [options.signal] : []),
      ]);
      const auth = options.auth ?? "valid";
      const body = options.json === undefined ? undefined : JSON.stringify(options.json);
      check(
        body === undefined || Buffer.byteLength(body) <= 32_768,
        "Application request body exceeded its bound",
      );
      const response = await fetch(new URL(path, base), {
        method: options.method ?? "GET",
        redirect: "error",
        signal,
        headers: {
          ...(body ? { "content-type": "application/json" } : {}),
          ...(auth === "missing"
            ? {}
            : {
                authorization: `Bearer ${auth === "valid" ? bearer : "invalid-acceptance-credential"}`,
              }),
          ...(options.idempotencyKey ? { "idempotency-key": options.idempotencyKey } : {}),
        },
        body,
      });
      return {
        status: response.status,
        body: await readApplicationResponse(response, signal),
        headers: Object.fromEntries(response.headers),
      };
    },
  };
}

export async function waitForApplicationReady(
  child: ReturnType<typeof startApplicationChild>,
  http: ReturnType<typeof applicationHttp>,
  signal?: AbortSignal,
): Promise<void> {
  let exited = false;
  void child.exited.then(() => {
    exited = true;
  });
  const deadline = Date.now() + APPLICATION_BOUNDS.readinessMs;
  while (Date.now() < deadline) {
    signal?.throwIfAborted();
    check(!exited, "Installed application exited before readiness; inspect child evidence");
    try {
      const response = await http.request("/health", { timeoutMs: 1000, signal });
      if (response.status === 200 && JSON.parse(response.body)?.status === "healthy") return;
    } catch {
      signal?.throwIfAborted();
      // A not-yet-bound listener is expected only within this bounded readiness loop.
    }
    await Bun.sleep(100);
  }
  throw new Error("Installed application did not become healthy before its readiness deadline");
}
