import { createHash, randomBytes, randomUUID } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";
import { parse, stringify } from "yaml";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
  type ProviderFixtureEvidence,
} from "./provider-fixture";

const READY_MS = 60_000;
const SCENARIO_MS = 120_000;
const SHUTDOWN_MS = 15_000;
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024;
const SCENARIOS = [
  "success",
  "missing-auth",
  "invalid-auth",
  "invalid-tool-arguments",
  "provider-failure",
  "durable-replay",
  "restart-replay",
] as const;

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function inside(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

function packageRoot(entry: string, name: string): string {
  let directory = dirname(entry);
  while (true) {
    const file = join(directory, "package.json");
    if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).name === name) return directory;
    const parent = dirname(directory);
    check(parent !== directory, `Cannot locate installed ${name} package`);
    directory = parent;
  }
}

async function bounded<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} exceeded ${ms}ms`)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function collect(stream: ReadableStream<Uint8Array>, secrets: string[]): Promise<string> {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  let truncated = false;
  while (true) {
    const next = await reader.read();
    if (next.done) break;
    const remaining = MAX_OUTPUT_BYTES - bytes;
    if (remaining > 0) {
      chunks.push(next.value.slice(0, remaining));
      bytes += Math.min(next.value.byteLength, remaining);
    }
    if (next.value.byteLength > remaining) truncated = true;
  }
  let output = Buffer.concat(chunks).toString("utf8");
  for (const secret of secrets) output = output.replaceAll(secret, "[redacted]");
  return output + (truncated ? "\n[output truncated]\n" : "");
}

interface Trace {
  turnId: string;
  threadId: string;
  success: boolean;
  status: string;
  trustLevel?: string;
  inferenceSteps: { outcome: string; tools: { name: string; approved: boolean }[] }[];
  tools: { name: string; sentinelMatched: boolean; validationError: boolean }[];
}

interface StreamEvidence {
  status: number;
  body: string;
  events: Record<string, unknown>[];
}

export async function runPackedTurn(options: {
  cli: string;
  agentDir: string;
  home: string;
  evidenceDir: string;
  repoRoot: string;
}): Promise<void> {
  const agentDir = realpathSync(options.agentDir);
  const repoRoot = realpathSync(options.repoRoot);
  const cli = realpathSync(options.cli);
  const home = realpathSync(options.home);
  const evidenceDir = resolve(options.evidenceDir);
  check(!inside(agentDir, repoRoot), "Packed consumer must live outside the source checkout");
  check(!inside(cli, repoRoot), "CLI must resolve outside the source checkout");
  check(!inside(home, repoRoot), "Consumer HOME must be isolated from the source checkout");
  const globalCore = packageRoot(cli, "auggy");
  const globalKernel = realpathSync(join(globalCore, "src/kernel/turn-loop.ts"));
  check(inside(globalKernel, globalCore), "CLI kernel escapes its installed package");
  const ownedDir = join(agentDir, ".packed-acceptance");
  check(!existsSync(ownedDir), "Packed acceptance directory already exists");
  await mkdir(evidenceDir, { recursive: true, mode: 0o700 });
  await mkdir(join(ownedDir, "workspace"), { recursive: true, mode: 0o700 });
  await mkdir(join(ownedDir, "tmp"), { mode: 0o700 });
  const tracePath = join(ownedDir, "traces.jsonl");
  const sentinel = `auggy-packed-sentinel-${randomUUID()}`;
  const bearer = randomBytes(32).toString("hex");
  const redact = (text: string) =>
    text.replaceAll(bearer, "[redacted]").replaceAll(PROVIDER_FIXTURE_API_KEY, "[redacted]");
  const json = async (name: string, data: unknown) => {
    await writeFile(join(evidenceDir, name), `${redact(JSON.stringify(data, null, 2))}\n`, {
      mode: 0o600,
    });
  };
  const env: Record<string, string> = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: home,
    TMPDIR: join(ownedDir, "tmp"),
    LANG: "C.UTF-8",
    TZ: "UTC",
    TERM: "dumb",
    CI: "1",
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: bearer,
  };
  const saved = new Map<string, Buffer>();
  const rewrite = async (file: string, value: string) => {
    if (!saved.has(file)) saved.set(file, await readFile(file));
    await writeFile(file, value, { mode: 0o600 });
  };
  const outcomes: Record<string, unknown> = Object.fromEntries(
    SCENARIOS.map((name) => [name, { status: "pending" }]),
  );
  const lifecycle: Record<string, unknown>[] = [];
  const startTime = Date.now();
  let child: ReturnType<typeof Bun.spawn> | undefined;
  let outputs: Promise<string>[] = [];
  let generation = 0;
  let observerCreated = false;
  let provider: ReturnType<typeof createProviderFixture> | undefined;
  let failure: unknown;
  let interrupted = false;
  const cancellation = new AbortController();
  let scenarioCancellation: AbortController | undefined;
  const checkpoint = () => {
    cancellation.signal.throwIfAborted();
    scenarioCancellation?.signal.throwIfAborted();
  };
  const requestSignal = (timeoutMs: number) =>
    AbortSignal.any([
      cancellation.signal,
      ...(scenarioCancellation ? [scenarioCancellation.signal] : []),
      AbortSignal.timeout(timeoutMs),
    ]);
  const onSignal = () => {
    interrupted = true;
    cancellation.abort(new Error("Packed acceptance interrupted"));
    child?.kill("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const snapshot = () =>
    json("scenarios.json", { elapsedMs: Date.now() - startTime, scenarios: outcomes, lifecycle });
  const stop = async () => {
    if (!child) return;
    const processToStop = child;
    child = undefined;
    const started = Date.now();
    let forced = false;
    const runningBeforeStop = processToStop.exitCode === null;
    if (processToStop.exitCode === null) processToStop.kill("SIGTERM");
    try {
      await bounded(processToStop.exited, SHUTDOWN_MS, "graceful shutdown");
    } catch {
      forced = true;
      processToStop.kill("SIGKILL");
      await bounded(processToStop.exited, 5_000, "forced shutdown");
    } finally {
      const logs = await bounded(Promise.all(outputs), 5_000, "process log capture");
      await writeFile(join(evidenceDir, `cli-${generation}.log`), logs.join("\n[stderr]\n"), {
        mode: 0o600,
      });
      lifecycle.push({
        event: "stopped",
        generation,
        exitCode: processToStop.exitCode,
        signalCode: processToStop.signalCode,
        forced,
        durationMs: Date.now() - started,
      });
      await snapshot();
    }
    check(!forced, "CLI required forced termination");
    check(runningBeforeStop, "CLI exited before the requested shutdown");
    check(
      processToStop.exitCode === 0 && processToStop.signalCode === null,
      "CLI did not exit cleanly after SIGTERM",
    );
  };
  const traces = async (): Promise<Trace[]> => {
    if (!existsSync(tracePath)) return [];
    return (await readFile(tracePath, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  };
  const scenario = async (name: (typeof SCENARIOS)[number], action: () => Promise<unknown>) => {
    check(!interrupted, "Packed acceptance interrupted");
    const started = Date.now();
    outcomes[name] = { status: "running" };
    await snapshot();
    scenarioCancellation = new AbortController();
    const actionResult = action();
    try {
      const details = await bounded(actionResult, SCENARIO_MS, name);
      outcomes[name] = { status: "passed", durationMs: Date.now() - started, details };
    } catch (error) {
      scenarioCancellation.abort(error);
      outcomes[name] = {
        status: "failed",
        durationMs: Date.now() - started,
        message: redact(String(error)),
      };
      // Every network wait observes this abort; settle the action before shared
      // provider/process/config cleanup begins. Shutdown itself keeps its budget.
      try {
        await bounded(
          actionResult.catch(() => undefined),
          SHUTDOWN_MS + 5_000,
          `${name} cancellation`,
        );
      } catch (settlementError) {
        cancellation.abort(settlementError);
        throw new AggregateError([error, settlementError], `${name} failed to settle`);
      }
      throw error;
    } finally {
      scenarioCancellation = undefined;
      await json("traces.json", await traces());
      if (provider) await json(`provider-${name}.json`, provider.evidence());
      await snapshot();
    }
  };
  try {
    await snapshot();
    await writeFile(join(ownedDir, "workspace/acceptance.txt"), sentinel, { mode: 0o600 });
    provider = createProviderFixture({ toolResultSentinel: sentinel });
    await json("provider-ready.json", provider.ready);
    const probe = join(ownedDir, "provenance.ts");
    await writeFile(
      probe,
      `import { defineAgent } from "auggy";\nimport { createAnthropicEngine } from "@auggy/anthropic";\nconsole.log(JSON.stringify({core: import.meta.resolve("auggy"), provider: import.meta.resolve("@auggy/anthropic"), exportsValid: typeof defineAgent === "function" && typeof createAnthropicEngine === "function"}));\n`,
    );
    const probeChild = Bun.spawn([process.execPath, probe], {
      cwd: agentDir,
      env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const probeOutput = Promise.all([
      collect(probeChild.stdout, [bearer, PROVIDER_FIXTURE_API_KEY]),
      collect(probeChild.stderr, [bearer, PROVIDER_FIXTURE_API_KEY]),
    ]);
    let probeExit: number;
    try {
      probeExit = await bounded(probeChild.exited, READY_MS, "packed provenance probe");
    } catch (error) {
      probeChild.kill("SIGKILL");
      await bounded(probeChild.exited, 5_000, "provenance probe shutdown");
      throw error;
    }
    const [probeStdout, probeStderr] = await bounded(probeOutput, 5_000, "provenance probe output");
    check(probeExit === 0, `Packed provenance probe failed: ${probeStderr}`);
    const provenance = JSON.parse(probeStdout.trim());
    check(provenance.exportsValid, "Packed package exports failed to load");
    for (const key of ["core", "provider"]) {
      const installed = realpathSync(new URL(provenance[key]));
      check(
        inside(installed, join(agentDir, "node_modules")),
        `${key} did not resolve in consumer node_modules`,
      );
      check(!inside(installed, repoRoot), `${key} resolved into source checkout`);
      provenance[key] = installed;
    }
    await json("provenance.json", {
      ...provenance,
      cli,
      globalCore,
      globalKernel,
      agentDir,
      home,
      runtimeOwnership:
        "The installed global CLI owns this run's kernel; the agent-local adapter and custom augment resolve from the generated project. Local CLI delegation is a later milestone.",
      agentListener:
        "Existing webTransport bind behavior; acceptance requests use 127.0.0.1. Provider fixture binds only 127.0.0.1.",
    });
    const observerDir = join(agentDir, "augments", "packedAcceptanceObserver");
    check(!existsSync(observerDir), "Packed observer directory already exists");
    await mkdir(observerDir, { mode: 0o700 });
    observerCreated = true;
    await writeFile(
      join(observerDir, "augment.yaml"),
      stringify({ type: "custom", source: "./index.ts" }),
    );
    await writeFile(
      join(observerDir, "index.ts"),
      `import { appendFile } from "node:fs/promises";
import { defineAugment } from "auggy";
export default function observer() {
  return defineAugment({ name: "packedAcceptanceObserver", onTurnEnd: async (turn) => {
    const record = { turnId: turn.turnId, threadId: turn.trace.threadId, success: turn.success, status: turn.status,
      trustLevel: turn.trace.trigger.trustLevel,
      inferenceSteps: turn.trace.inferenceSteps.map(step => ({ outcome: step.outcome ?? "completed", tools: step.toolCalls.map(tool => ({ name: tool.name, approved: tool.approved })) })),
      tools: turn.toolCalls.map(tool => ({ name: tool.name, sentinelMatched: tool.output.includes(${JSON.stringify(sentinel)}), validationError: tool.output.startsWith("Validation error:") })) };
    await appendFile(${JSON.stringify(tracePath)}, JSON.stringify(record) + "\\n", { mode: 0o600 });
  }});
}
`,
    );
    const configPath = join(agentDir, "agent.yaml");
    const config = parse(await readFile(configPath, "utf8"));
    config.engine = {
      provider: "anthropic",
      model: "claude-packed-acceptance",
      baseURL: provider.baseURL,
      maxContextTokens: 32_000,
      maxTokens: 256,
      requestTimeoutMs: 5_000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    config.augments = ["filesystem", "webTransport", "packedAcceptanceObserver"];
    await rewrite(configPath, stringify(config));
    await rewrite(
      join(agentDir, ".env"),
      `ANTHROPIC_API_KEY=${PROVIDER_FIXTURE_API_KEY}\nAUGGY_WEB_TOKEN=${bearer}\n`,
    );
    await rewrite(
      join(agentDir, "augments/filesystem/augment.yaml"),
      stringify({
        type: "filesystem",
        config: {
          mounts: [
            {
              name: "workspace",
              path: join(ownedDir, "workspace"),
              writable: false,
              deletable: false,
            },
          ],
          workspaceAwareness: { enabled: false },
        },
      }),
    );
    const portReservation = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("reserved"),
    });
    const port = portReservation.port;
    await portReservation.stop(true);
    const baseURL = `http://127.0.0.1:${port}`;
    env.AUGGY_PUBLIC_URL = baseURL;
    await rewrite(
      join(agentDir, "augments/webTransport/augment.yaml"),
      stringify({
        type: "webTransport",
        config: {
          port,
          auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
          allowAnonymous: false,
          adminRoute: false,
          visitorTokens: { enabled: false },
          idempotency: { dbPath: "./data/packed-acceptance-idempotency.db" },
          consoleChat: { dbPath: "./data/packed-acceptance-console.db" },
        },
      }),
    );
    const start = async () => {
      checkpoint();
      generation++;
      const started = Date.now();
      child = Bun.spawn([cli, "run", "--no-open"], {
        cwd: agentDir,
        env,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      outputs = [
        collect(child.stdout as ReadableStream<Uint8Array>, [bearer, PROVIDER_FIXTURE_API_KEY]),
        collect(child.stderr as ReadableStream<Uint8Array>, [bearer, PROVIDER_FIXTURE_API_KEY]),
      ];
      while (Date.now() - started < READY_MS) {
        checkpoint();
        check(!interrupted, "Packed acceptance interrupted");
        check(
          child.exitCode === null,
          "Packed CLI exited before readiness; inspect its evidence log",
        );
        try {
          const response = await fetch(`${baseURL}/health`, { signal: requestSignal(1_000) });
          if (
            response.ok &&
            ((await response.json()) as { status?: string }).status === "healthy"
          ) {
            lifecycle.push({ event: "ready", generation, durationMs: Date.now() - started });
            await snapshot();
            return;
          }
        } catch {
          /* The listener has not become ready yet. */
        }
        await Bun.sleep(100);
      }
      throw new Error(`Packed CLI readiness exceeded ${READY_MS}ms`);
    };
    const request = async (
      threadId: string,
      key: string,
      auth: "valid" | "missing" | "invalid" = "valid",
    ): Promise<StreamEvidence> => {
      checkpoint();
      const response = await fetch(`${baseURL}/agent/run`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": key,
          ...(auth === "missing"
            ? {}
            : { authorization: `Bearer ${auth === "valid" ? bearer : "invalid-dummy-bearer"}` }),
        },
        body: JSON.stringify({
          threadId,
          messages: [
            { role: "user", content: "Read workspace/acceptance.txt and report the result." },
          ],
        }),
        signal: requestSignal(SCENARIO_MS - 1_000),
      });
      check(response.body, "HTTP response had no body");
      const body = await collect(response.body, [bearer, PROVIDER_FIXTURE_API_KEY]);
      check(Buffer.byteLength(body) < MAX_OUTPUT_BYTES, "Response exceeded acceptance size limit");
      const events = body
        .split("\n")
        .filter((line) => line.startsWith("data: "))
        .map((line) => JSON.parse(line.slice(6)) as Record<string, unknown>);
      return { status: response.status, body, events };
    };
    const terminal = (response: StreamEvidence, failed = false) => {
      check(response.status === 200, `Turn returned HTTP ${response.status}`);
      const kinds = response.events.map((event) => event.type);
      check(kinds.includes("RUN_STARTED"), "Stream lacked RUN_STARTED");
      check(
        kinds.includes(failed ? "RUN_ERROR" : "RUN_FINISHED"),
        "Stream lacked expected terminal event",
      );
      const finished = response.events.filter((event) => event.type === "RUN_FINISHED");
      check(finished.length === 1, "Stream must finish exactly once");
      const started = response.events.filter((event) => event.type === "RUN_STARTED");
      check(
        started.length === 1 &&
          started[0]!.runId === finished[0]!.runId &&
          started[0]!.threadId === finished[0]!.threadId,
        "Terminal event did not preserve the admitted public run and thread",
      );
      check(
        (finished[0]!.result as { status?: string } | undefined)?.status ===
          (failed ? "failed" : "completed"),
        "Stream terminal status disagrees with expected outcome",
      );
      check(
        response.events.at(-1)?.type === "RUN_FINISHED",
        "Stream has events after its terminal result",
      );
      if (!failed) {
        check(!kinds.includes("RUN_ERROR"), "Successful turn emitted RUN_ERROR");
        const text = response.events
          .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
          .map((event) => event.delta)
          .join("");
        check(
          text.includes(PROVIDER_FIXTURE_FINAL_TEXT),
          "Stream lacked provider fixture's final response",
        );
      }
      return {
        status: response.status,
        eventTypes: kinds,
        bodySha256: createHash("sha256").update(response.body).digest("hex"),
        publicRunId: response.events.find((event) => event.type === "RUN_STARTED")?.runId,
      };
    };
    const summary = (p: ProviderFixtureEvidence) => {
      check(p.rejectedRequests === 0, "Provider fixture rejected an unexpected adapter request");
      return p;
    };
    await start();
    let successResponse: StreamEvidence | undefined;
    const successThread = `packed-success-${randomUUID()}`;
    const successKey = `packed-key-${randomUUID()}`;
    await scenario("success", async () => {
      successResponse = await request(successThread, successKey);
      const stream = terminal(successResponse);
      const evidence = summary(provider!.evidence());
      check(
        evidence.calls === 2 &&
          evidence.validatedToolResults === 1 &&
          evidence.finalResponses === 1,
        "Expected provider/tool/provider success sequence",
      );
      const trace = (await traces()).find((entry) => entry.threadId === successThread);
      check(
        trace?.success && trace.inferenceSteps.length === 2,
        "Success trace missing two real inference steps",
      );
      check(trace.trustLevel === "creator", "Bearer did not produce creator trust");
      check(
        trace.tools.length === 1 &&
          trace.tools[0]?.name === "fs_read" &&
          trace.tools[0]?.sentinelMatched,
        "Trace did not observe the real filesystem result",
      );
      check(
        successResponse.events.filter(
          (event) => event.type === "TOOL_CALL_START" && event.toolCallName === "fs_read",
        ).length === 1,
        "Expected exactly one real fs_read execution event",
      );
      return { ...stream, turnId: trace.turnId, threadId: successThread, provider: evidence };
    });
    for (const auth of ["missing", "invalid"] as const) {
      await scenario(`${auth}-auth`, async () => {
        const beforeCalls = provider!.evidence().calls;
        const beforeTraces = (await traces()).length;
        const response = await request(
          `packed-denial-${randomUUID()}`,
          `packed-denial-${randomUUID()}`,
          auth,
        );
        check(
          response.status === 401 || response.status === 403,
          `Auth denial returned HTTP ${response.status}`,
        );
        check(
          provider!.evidence().calls === beforeCalls && (await traces()).length === beforeTraces,
          "Auth denial reached inference or a turn hook",
        );
        return { status: response.status, additionalProviderCalls: 0, additionalTraces: 0 };
      });
    }
    await scenario("invalid-tool-arguments", async () => {
      provider!.setScenario("invalid-tool-arguments");
      const threadId = `packed-invalid-${randomUUID()}`;
      const response = await request(threadId, `packed-invalid-${randomUUID()}`);
      const stream = terminal(response);
      const evidence = summary(provider!.evidence());
      check(
        evidence.calls === 2 && evidence.validatedToolResults === 1,
        "Invalid tool arguments did not return the kernel validation error to the provider",
      );
      const trace = (await traces()).find((entry) => entry.threadId === threadId);
      check(trace, "Validation turn trace was not recorded");
      check(
        trace.tools.some((tool) => tool.name === "fs_read" && tool.validationError),
        "Trace lacks the schema validation rejection",
      );
      check(
        !trace.tools.some((tool) => tool.sentinelMatched),
        "Invalid arguments reached the filesystem read",
      );
      check(
        !response.events.some((event) => event.type === "TOOL_CALL_START"),
        "Invalid arguments started tool execution",
      );
      check(
        (await readFile(join(ownedDir, "workspace/acceptance.txt"), "utf8")) === sentinel,
        "Invalid arguments changed the seeded filesystem",
      );
      return { ...stream, turnId: trace.turnId, threadId, provider: evidence, executedTools: 0 };
    });
    await scenario("provider-failure", async () => {
      provider!.setScenario("provider-failure");
      const threadId = `packed-failure-${randomUUID()}`;
      const response = await request(threadId, `packed-failure-${randomUUID()}`);
      const stream = terminal(response, true);
      const evidence = provider!.evidence();
      check(
        evidence.calls === 1 &&
          evidence.rejectedRequests === 1 &&
          evidence.summaries.length === 1 &&
          evidence.summaries[0]?.outcome === "provider-failure" &&
          evidence.summaries[0]?.status === 503,
        "Expected one classified provider 503 without unexpected requests",
      );
      check(
        evidence.calls > 0 && evidence.toolRequests === 0 && evidence.finalResponses === 0,
        "Provider failure unexpectedly used tools or returned final content",
      );
      const trace = (await traces()).find((entry) => entry.threadId === threadId);
      check(
        trace && !trace.success && trace.tools.length === 0,
        "Failed provider turn lacked a failed trace",
      );
      return { ...stream, turnId: trace.turnId, threadId, provider: evidence };
    });
    await scenario("durable-replay", async () => {
      provider!.setScenario("success");
      const beforeTraces = (await traces()).length;
      const replay = await request(successThread, successKey);
      check(
        replay.status === successResponse!.status && replay.body === successResponse!.body,
        "Duplicate request did not replay exact terminal stream",
      );
      check(
        provider!.evidence().calls === 0 && (await traces()).length === beforeTraces,
        "Replay repeated inference or turn execution",
      );
      return { ...terminal(replay), additionalProviderCalls: 0, additionalTraces: 0 };
    });
    await scenario("restart-replay", async () => {
      const beforeTraces = (await traces()).length;
      await stop();
      provider!.reset();
      await start();
      const replay = await request(successThread, successKey);
      check(
        replay.status === successResponse!.status && replay.body === successResponse!.body,
        "Restart lost durable idempotency replay",
      );
      check(
        provider!.evidence().calls === 0 && (await traces()).length === beforeTraces,
        "Restart replay repeated inference or tool execution",
      );
      return { ...terminal(replay), additionalProviderCalls: 0, additionalTraces: 0, generation };
    });
  } catch (error) {
    failure = error;
  } finally {
    const cleanupErrors: string[] = [];
    const cleanup = async (label: string, action: () => Promise<unknown>) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(`${label}: ${redact(String(error))}`);
        failure ??= error;
      }
    };
    try {
      cancellation.abort(new Error("Packed acceptance cleanup"));
      await cleanup("CLI shutdown", stop);
      if (provider)
        await cleanup("provider shutdown", () =>
          bounded(provider!.stop(), 5_000, "provider shutdown"),
        );
      for (const [file, contents] of saved)
        await cleanup(`restore ${relative(agentDir, file)}`, () => writeFile(file, contents));
      if (observerCreated)
        await cleanup("remove observer", () =>
          rm(join(agentDir, "augments/packedAcceptanceObserver"), { recursive: true, force: true }),
        );
      await cleanup("write traces", async () => json("traces.json", await traces()));
      await cleanup("write scenario snapshot", snapshot);
      await cleanup("remove temporary consumer files", () =>
        rm(ownedDir, { recursive: true, force: true }),
      );
      await cleanup("write final result", () =>
        json("result.json", {
          status: failure ? "failed" : "passed",
          durationMs: Date.now() - startTime,
          cleanupErrors,
          ...(failure ? { message: redact(String(failure)) } : {}),
        }),
      );
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  if (failure) throw failure;
}

if (import.meta.main) {
  const { values } = parseArgs({
    options: {
      cli: { type: "string" },
      "agent-dir": { type: "string" },
      home: { type: "string" },
      "evidence-dir": { type: "string" },
      "repo-root": { type: "string" },
    },
    strict: true,
  });
  for (const key of ["cli", "agent-dir", "home", "evidence-dir", "repo-root"] as const)
    check(values[key], `Missing --${key}`);
  await runPackedTurn({
    cli: values.cli!,
    agentDir: values["agent-dir"]!,
    home: values.home!,
    evidenceDir: values["evidence-dir"]!,
    repoRoot: values["repo-root"]!,
  });
  console.log("Packed turn acceptance passed.");
}
