import { resolve } from "node:path";

const MAX_JSON_LINE_BYTES = 64 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;

export interface JsonLineWorkerOptions {
  script: string;
  args?: readonly string[];
  cwd?: string;
  /**
   * Explicit test-only environment. Callers must not pass secrets as command
   * arguments because worker argument failures are surfaced in diagnostics.
   */
  env?: Record<string, string | undefined>;
}

export interface JsonLineWorker {
  readonly process: ReturnType<typeof Bun.spawn>;
  next(): Promise<Record<string, unknown>>;
  send(value: Record<string, unknown>): void;
  closeInput(): void;
  stderr(): Promise<string>;
  kill(): Promise<void>;
  terminate(): Promise<void>;
}

export interface JsonLineBarrier {
  waitUntilReady(): Promise<void>;
  release(value?: Record<string, unknown>): void;
  close(): void;
}

function boundedText(stream: ReadableStream<Uint8Array> | null): Promise<string> {
  if (!stream) return Promise.resolve("");
  const reader = stream.getReader();
  let bytes = 0;
  return (async () => {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        return bytes === 0
          ? ""
          : `worker stderr suppressed (${Math.min(bytes, MAX_STDERR_BYTES)}+ bytes)`;
      }
      // Keep consuming after the retained diagnostic budget so a noisy worker
      // cannot deadlock on a full stderr pipe. Do not surface arbitrary child
      // diagnostics: future worker output can contain sensitive context.
      bytes = Math.min(MAX_STDERR_BYTES + 1, bytes + chunk.value.byteLength);
    }
  })();
}

/**
 * Starts a Bun child which communicates only with newline-delimited JSON.
 *
 * Tests use explicit READY/GO messages instead of elapsed-time races. Timeouts
 * belong to each test as a deadlock safety net, not as synchronization.
 */
export function spawnJsonLineWorker(options: JsonLineWorkerOptions): JsonLineWorker {
  const child = Bun.spawn([process.execPath, resolve(options.script), ...(options.args ?? [])], {
    cwd: options.cwd ?? process.cwd(),
    env: options.env,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = child.stdout.getReader();
  const stderr = boundedText(child.stderr);
  const decoder = new TextDecoder();
  let buffered = "";
  let closed = false;

  async function next(): Promise<Record<string, unknown>> {
    while (true) {
      const newline = buffered.indexOf("\n");
      if (newline >= 0) {
        const line = buffered.slice(0, newline);
        buffered = buffered.slice(newline + 1);
        if (line.length === 0) continue;
        if (line.length > MAX_JSON_LINE_BYTES) {
          throw new Error("worker emitted an oversized JSON line");
        }
        let value: unknown;
        try {
          value = JSON.parse(line);
        } catch {
          // Child stdout can accidentally contain deployment diagnostics.
          // Treat it as untrusted and never reflect it into test output.
          throw new Error("worker emitted invalid JSON");
        }
        if (typeof value !== "object" || value === null || Array.isArray(value)) {
          throw new Error("worker JSON line must be an object");
        }
        return value as Record<string, unknown>;
      }
      const chunk = await stdout.read();
      if (chunk.done) {
        const detail = await stderr;
        throw new Error(`worker exited before emitting a JSON line${detail ? ` (${detail})` : ""}`);
      }
      buffered += decoder.decode(chunk.value, { stream: true });
      if (buffered.length > MAX_JSON_LINE_BYTES) {
        throw new Error("worker buffered output exceeded the JSON line limit");
      }
    }
  }

  function send(value: Record<string, unknown>): void {
    if (closed) throw new Error("worker stdin is closed");
    const stdin = child.stdin;
    if (!stdin || typeof stdin === "number") throw new Error("worker stdin is not writable");
    const line = JSON.stringify(value);
    if (line.length > MAX_JSON_LINE_BYTES) throw new Error("worker input exceeds JSON line limit");
    stdin.write(`${line}\n`);
  }

  function closeInput(): void {
    if (closed) return;
    closed = true;
    const stdin = child.stdin;
    if (!stdin || typeof stdin === "number") return;
    stdin.end();
  }

  async function kill(): Promise<void> {
    try {
      child.kill("SIGKILL");
    } catch {
      // The process can have exited between cleanup steps.
    }
    await child.exited;
  }

  async function terminate(): Promise<void> {
    closeInput();
    await kill();
  }

  return { process: child, next, send, closeInput, stderr: () => stderr, kill, terminate };
}

/** Creates an explicit two-phase barrier for a fixed group of JSON-line workers. */
export function createJsonLineBarrier(workers: readonly JsonLineWorker[]): JsonLineBarrier {
  let released = false;
  return {
    async waitUntilReady(): Promise<void> {
      const messages = await Promise.all(workers.map((worker) => worker.next()));
      for (const message of messages) {
        if (message.event !== "READY") {
          throw new Error("expected READY from worker");
        }
      }
    },
    release(value: Record<string, unknown> = { event: "GO" }): void {
      if (released) throw new Error("barrier was already released");
      released = true;
      for (const worker of workers) worker.send(value);
    },
    close(): void {
      for (const worker of workers) worker.closeInput();
    },
  };
}
