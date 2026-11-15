/** Shared owned-process supervision for local and packaged fixture commands. */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { redactEvidence } from "./evidence-redaction";

export const APPLICATION_BOUNDS = Object.freeze({
  readinessMs: 60_000,
  scenarioMs: 120_000,
  deploymentMs: 780_000,
  shutdownMs: 15_000,
  reapMs: 5_000,
  outputBytes: 2 * 1024 * 1024,
  sourceBytes: 2 * 1024 * 1024,
  artifactSourceFiles: 128,
  artifactBytes: 256 * 1024 * 1024,
});

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function hash(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** A process group contains any delegated CLI child; never kill by a discovered PID. */
export function startApplicationChild(options: {
  command: readonly string[];
  cwd: string;
  env: Record<string, string>;
  secrets: readonly string[];
  /** Private structured command input; never included in evidence or argv. */
  input?: Uint8Array;
  timeoutMs?: number;
  /** Explicit hosted deployment supervision; ordinary fixture commands retain the 120s ceiling. */
  lifetimeProfile?: "hosted-deployment";
  maxOutputBytes?: number;
}) {
  check(options.command.length > 0, "Fixture child requires a command");
  const timeoutMs = options.timeoutMs ?? APPLICATION_BOUNDS.scenarioMs;
  const maxOutputBytes = options.maxOutputBytes ?? APPLICATION_BOUNDS.outputBytes;
  check(
    options.lifetimeProfile === undefined || options.lifetimeProfile === "hosted-deployment",
    "Invalid child lifetime profile",
  );
  const ceiling =
    options.lifetimeProfile === "hosted-deployment"
      ? APPLICATION_BOUNDS.deploymentMs
      : APPLICATION_BOUNDS.scenarioMs;
  check(
    Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= ceiling,
    "Invalid child lifetime bound",
  );
  check(
    Number.isSafeInteger(maxOutputBytes) &&
      maxOutputBytes > 0 &&
      maxOutputBytes <= APPLICATION_BOUNDS.outputBytes,
    "Invalid child output bound",
  );
  check(
    options.input === undefined ||
      (options.input instanceof Uint8Array &&
        options.input.byteLength <= APPLICATION_BOUNDS.outputBytes),
    "Invalid child input bound",
  );
  // Own the bytes before asynchronous pipe writes; caller mutation cannot change
  // an already admitted command's input.
  const input = options.input === undefined ? undefined : Buffer.from(options.input);
  const started = Date.now();
  const child = spawn(options.command[0]!, options.command.slice(1), {
    cwd: options.cwd,
    env: options.env,
    detached: process.platform !== "win32",
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  const chunks: { stdout: Buffer[]; stderr: Buffer[] } = { stdout: [], stderr: [] };
  let bytes = 0;
  let exceededOutput = false;
  let timedOut = false;
  let spawnFailed = false;
  let orphanedGroup = false;
  let leaderExited = false;
  let streamsClosed = false;
  let cleanupConfirmed = false;
  let terminalSettled = false;
  let forced = false;
  let inputFailed = false;
  let inputComplete = input === undefined;
  let gracefulStopDeadline: number | undefined;
  let reapDeadline: number | undefined;
  let outcome: { exitCode: number | null; signal: NodeJS.Signals | null } = {
    exitCode: null,
    signal: null,
  };
  const groupState = (): "gone" | "live" | "unknown" => {
    if (process.platform === "win32") return leaderExited ? "gone" : "live";
    if (!child.pid) return spawnFailed ? "gone" : "unknown";
    try {
      process.kill(-child.pid, 0);
      return "live";
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "gone" : "unknown";
    }
  };
  const signal = (value: NodeJS.Signals) => {
    if (cleanupConfirmed || terminalSettled) return;
    if (value === "SIGKILL") {
      gracefulStopDeadline = undefined;
      reapDeadline ??= Date.now() + APPLICATION_BOUNDS.reapMs;
    }
    if (!child.pid) return;
    try {
      if (process.platform === "win32") child.kill(value);
      else if (groupState() !== "gone") process.kill(-child.pid, value);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") orphanedGroup = true;
    }
  };
  let resolveTerminal!: (value: typeof outcome) => void;
  const exited = new Promise<typeof outcome>((resolveExit) => {
    resolveTerminal = resolveExit;
  });
  let finalizeTask: Promise<void> | undefined;
  const finalize = () =>
    (finalizeTask ??= (async () => {
      while (true) {
        const group = groupState();
        if ((leaderExited || spawnFailed) && streamsClosed && group === "gone") {
          cleanupConfirmed = true;
          break;
        }
        const now = Date.now();
        if (gracefulStopDeadline !== undefined) {
          // An intentional group stop may finish its leader before descendants
          // drain. Preserve the original shutdown budget before starting reap.
          if (now >= gracefulStopDeadline) {
            forced = true;
            if (leaderExited && group !== "gone") orphanedGroup = true;
            signal("SIGKILL");
          }
        } else {
          reapDeadline ??= now + APPLICATION_BOUNDS.reapMs;
        }
        if (reapDeadline !== undefined && now >= reapDeadline) break;
        await new Promise((resolveWait) => setTimeout(resolveWait, 10));
      }
      clearTimeout(lifetimeTimer);
      terminalSettled = true;
      // Close our own pipes after a failed reap observation. Do not certify that
      // another process has exited merely because its inherited pipe was closed.
      child.stdout?.destroy();
      child.stderr?.destroy();
      child.stdin?.destroy();
      resolveTerminal(outcome);
    })());
  const lifetimeTimer = setTimeout(() => {
    timedOut = true;
    signal("SIGKILL");
    void finalize();
  }, timeoutMs);
  for (const stream of ["stdout", "stderr"] as const) {
    child[stream]!.on("data", (value: Buffer) => {
      const available = Math.max(0, maxOutputBytes - bytes);
      if (available) chunks[stream].push(value.subarray(0, available));
      bytes += value.length;
      if (bytes > maxOutputBytes && !exceededOutput) {
        exceededOutput = true;
        signal("SIGKILL");
        void finalize();
      }
    });
  }
  child.once("error", () => {
    spawnFailed = true;
    gracefulStopDeadline = undefined;
    void finalize();
  });
  child.once("exit", (exitCode, exitSignal) => {
    leaderExited = true;
    outcome = { exitCode, signal: exitSignal };
    if (groupState() !== "gone" && gracefulStopDeadline === undefined) {
      orphanedGroup = true;
      signal("SIGKILL");
    }
    void finalize();
  });
  child.once("close", (exitCode, exitSignal) => {
    streamsClosed = true;
    if (!leaderExited) outcome = { exitCode, signal: exitSignal };
    void finalize();
  });
  if (input !== undefined) {
    child.stdin!.once("error", () => {
      inputFailed = true;
      signal("SIGKILL");
      void finalize();
    });
    child.stdin!.once("finish", () => {
      inputComplete = true;
    });
    child.stdin!.end(input);
  }
  return {
    pid: child.pid,
    exited,
    signal,
    async finish() {
      const terminal = await exited;
      const stdout = redactEvidence(Buffer.concat(chunks.stdout).toString("utf8"), [
        ...options.secrets,
      ]);
      const stderr = redactEvidence(Buffer.concat(chunks.stderr).toString("utf8"), [
        ...options.secrets,
      ]);
      return {
        ...terminal,
        pid: child.pid ?? null,
        spawnFailed,
        timedOut,
        exceededOutput,
        orphanedGroup,
        cleanupConfirmed,
        ...(input === undefined
          ? {}
          : { inputFailed: inputFailed || !inputComplete, inputComplete }),
        durationMs: Date.now() - started,
        stdout,
        stderr,
        stdoutSHA256: hash(stdout),
        stderrSHA256: hash(stderr),
      };
    },
    async stop(requestedSignal: "SIGINT" | "SIGTERM" = "SIGTERM") {
      const wasRunning = !leaderExited && !terminalSettled;
      if (!terminalSettled) {
        if (wasRunning && gracefulStopDeadline === undefined && reapDeadline === undefined)
          gracefulStopDeadline = Date.now() + APPLICATION_BOUNDS.shutdownMs;
        signal(requestedSignal);
        void finalize();
      }
      const result = await this.finish();
      return { wasRunning, forced, ...result };
    },
  };
}
