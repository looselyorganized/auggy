/** M5 mechanics. A completed helper is not an installed integration acceptance result. */
import { lstatSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { isAbsolute, join, relative, sep } from "node:path";
import {
  applicationHash,
  APPLICATION_BOUNDS,
  assertInstalledApplicationArtifact,
  startApplicationChild,
} from "./application-consumer";
import {
  assertAuthoringArtifactManifest,
  createAuthoringConsumer,
  runAuthoringBuild,
  selectAuthoringArtifacts,
  snapshotGeneratedAuthoringSources,
} from "./authoring-consumer";
import { AUTHORING_BOUNDS, type CreateAuthoringConsumerOptions } from "./authoring-contract";
import { readBoundedRegularFile } from "./bounded-file";
import { runDependencyAudit } from "../audit-dependencies";
import { redactEvidence } from "./export-evidence";
import {
  INTEGRATION_LIMITS,
  type HashedIntegrationFile,
  type IntegrationScenarioEvidence,
} from "./integration-contracts";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

function finiteBound(value: number, maximum: number): void {
  check(Number.isSafeInteger(value) && value > 0 && value <= maximum, "Invalid integration bound");
}

export interface IntegrationBudget {
  readonly signal: AbortSignal;
  remainingMs(): number;
  run<T>(maximumMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T>;
  dispose(): void;
}

/** Monotonic and independently racing: a fetch/body ignoring abort cannot extend a deadline. */
export function createIntegrationBudget(
  timeoutMs: number = INTEGRATION_LIMITS.scenarioMs,
  parent?: AbortSignal,
): IntegrationBudget {
  finiteBound(timeoutMs, INTEGRATION_LIMITS.phaseBuildMs);
  const controller = new AbortController();
  const end = performance.now() + timeoutMs;
  const abort = () => controller.abort(new Error("Integration phase aborted"));
  const timer = setTimeout(abort, timeoutMs);
  parent?.addEventListener("abort", abort, { once: true });
  if (parent?.aborted) abort();
  let disposed = false;
  const remainingMs = () => Math.max(0, Math.ceil(end - performance.now()));
  return {
    signal: controller.signal,
    remainingMs,
    async run<T>(maximumMs: number, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
      finiteBound(maximumMs, INTEGRATION_LIMITS.phaseBuildMs);
      check(
        !disposed && !controller.signal.aborted && remainingMs() > 0,
        "Integration phase ended",
      );
      const scope = new AbortController();
      const limit = Math.min(maximumMs, remainingMs());
      let rejectAbort!: (reason: Error) => void;
      const aborted = new Promise<never>((_resolve, reject) => {
        rejectAbort = reject;
      });
      const onAbort = () => {
        scope.abort(new Error("Integration operation aborted"));
        rejectAbort(new Error("Integration operation deadline or interruption"));
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      const scopedTimer = setTimeout(onAbort, limit);
      try {
        return await Promise.race([
          Promise.resolve().then(() => {
            scope.signal.throwIfAborted();
            return operation(scope.signal);
          }),
          aborted,
        ]);
      } finally {
        clearTimeout(scopedTimer);
        controller.signal.removeEventListener("abort", onAbort);
        scope.abort(new Error("Integration operation ended"));
      }
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      clearTimeout(timer);
      parent?.removeEventListener("abort", abort);
      abort();
    },
  };
}

export function integrationRelativePath(path: string): string {
  check(
    typeof path === "string" &&
      path.length > 0 &&
      Buffer.byteLength(path) <= 1024 &&
      !isAbsolute(path) &&
      !path.includes("\\") &&
      [...path].every(
        (character) => character.charCodeAt(0) > 31 && character.charCodeAt(0) !== 127,
      ),
    "Integration path must be bounded and relative",
  );
  const parts = path.split("/");
  check(
    parts.length <= 64 && parts.every((part) => part !== "" && part !== "." && part !== ".."),
    "Integration path is not canonical",
  );
  return path;
}

export function readIntegrationFile(root: string, path: string, maximumBytes: number): Buffer {
  integrationRelativePath(path);
  finiteBound(maximumBytes, 256 * 1024 * 1024);
  const owner = realpathSync(root);
  let parent = owner;
  for (const part of path.split("/").slice(0, -1)) {
    parent = join(parent, part);
    const stat = lstatSync(parent);
    check(stat.isDirectory() && !stat.isSymbolicLink(), "Integration file parent is not ordinary");
  }
  const rel = relative(owner, realpathSync(parent));
  check(
    rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)),
    "Integration file escaped its owner",
  );
  return readBoundedRegularFile(join(owner, path), maximumBytes).bytes;
}

/** Extra protections cover short supplied secrets, assertions and Telegram URL credentials. */
export function redactIntegrationDiagnostic(value: string, secrets: readonly string[]): string {
  let text = value;
  check(
    secrets.length <= 256 && secrets.every((secret) => secret.length <= 16_384),
    "Integration secret inventory exceeded bound",
  );
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length))
    text = text.split(secret).join("[REDACTED]");
  return redactEvidence(text, [])
    .replace(/(x-auggy-auth-assertion\s*[:=]\s*)[^\r\n]+/gi, "$1[REDACTED]")
    .replace(/https?:\/\/api\.telegram\.org\/bot[^\s"'<>]+/gi, "[REDACTED_TELEGRAM_URL]")
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)?\b/g, "[REDACTED_ASSERTION]")
    .replace(
      /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/g,
      "[REDACTED_PRIVATE_KEY]",
    );
}

/** Reject inherited preload/credential configuration; the caller supplies a reviewed fixture env. */
export function assertIntegrationEnvironment(env: Readonly<Record<string, string>>): void {
  check(Object.keys(env).length <= 128, "Integration environment exceeded bound");
  let bytes = 0;
  for (const [key, value] of Object.entries(env)) {
    check(
      /^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(key) &&
        typeof value === "string" &&
        !value.includes("\0") &&
        value.length <= 16_384,
      "Invalid integration environment entry",
    );
    check(
      !/^(?:NODE_OPTIONS|NODE_PATH|BUN_OPTIONS|LD_.*|DYLD_.*|BASH_ENV|ENV|ZDOTDIR|NPM_TOKEN|NODE_AUTH_TOKEN)$/i.test(
        key,
      ),
      "Integration environment contains inherited code or registry credentials",
    );
    bytes += Buffer.byteLength(key) + Buffer.byteLength(value);
  }
  check(bytes <= 64 * 1024, "Integration environment bytes exceeded bound");
}

/** Runs actual packed create/install through M4, then revalidates every selected installed artifact. */
export async function createIntegrationConsumer(options: CreateAuthoringConsumerOptions) {
  const generated = await createAuthoringConsumer(options);
  const installedFiles: HashedIntegrationFile[] = [];
  for (const artifact of [generated.core, generated.provider, ...generated.prerequisites]) {
    const verified = assertInstalledApplicationArtifact(
      generated.consumer,
      options.repoRoot,
      artifact,
      artifact.packageName === "auggy" ? "auggy/application" : artifact.packageName,
    );
    for (const [path, sha256] of Object.entries(verified.fileHashes))
      installedFiles.push({ path: `node_modules/${artifact.packageName}/${path}`, sha256 });
  }
  const baseline = snapshotGeneratedAuthoringSources({
    ...options,
    consumer: generated.consumer,
    sourceFiles: generated.sourceFiles,
  });
  return {
    generated,
    baselineFiles: Object.entries(baseline).map(([path, sha256]) => ({ path, sha256 })),
    installedFiles,
    lockfile: { path: "bun.lock", sha256: generated.lockSHA256 },
  };
}

/**
 * The create command selects absolute fixture archives. Portable export must carry
 * those same bytes inside the project. Record this explicit harness-only edit,
 * let Bun produce its lock, then prove frozen installation and artifact identity.
 */
export async function materializeIntegrationDependencies(options: {
  create: CreateAuthoringConsumerOptions;
  consumer: string;
}) {
  const root = realpathSync(options.consumer);
  const repo = realpathSync(options.create.repoRoot);
  const containment = relative(repo, root);
  check(
    containment === ".." || containment.startsWith(`..${sep}`) || isAbsolute(containment),
    "Dependency materialization must be outside the checkout",
  );
  check(
    root === realpathSync(join(options.create.workspace, options.create.name)),
    "Dependency materialization requires the generated consumer",
  );
  const selection = selectAuthoringArtifacts(options.create.artifacts, options.create.provider);
  const artifacts = [selection.core, selection.provider, ...selection.prerequisites];
  const beforeManifest = readIntegrationFile(root, "package.json", AUTHORING_BOUNDS.manifestBytes);
  const beforeLock = readIntegrationFile(root, "bun.lock", 16 * 1024 * 1024);
  assertAuthoringArtifactManifest(beforeManifest, selection);
  const manifest = JSON.parse(beforeManifest.toString("utf8")) as {
    dependencies: Record<string, string>;
    overrides?: Record<string, string>;
  };
  const archives = artifacts.map((artifact, index) => {
    const input =
      artifact.packageName === "auggy"
        ? options.create.artifacts.core
        : Object.values(options.create.artifacts.providers).find(
            (candidate) => candidate.packageName === artifact.packageName,
          );
    check(input, "Missing selected integration archive");
    const { bytes } = readBoundedRegularFile(input.path, APPLICATION_BOUNDS.artifactBytes);
    check(applicationHash(bytes) === artifact.sha256, "Selected integration archive changed");
    const path = `.integration-artifacts/${index}-${artifact.sha256}.tgz`;
    return { artifact, bytes, path, specifier: `file:./${path}` };
  });
  const directory = join(root, ".integration-artifacts");
  check(
    !lstatSync(directory, { throwIfNoEntry: false }),
    "Dependency materialization already exists",
  );
  mkdirSync(directory, { mode: 0o700 });
  const changes: IntegrationScenarioEvidence["changes"][number][] = [];
  for (const archive of archives) {
    writeFileSync(join(root, archive.path), archive.bytes, { flag: "wx", mode: 0o600 });
    manifest.dependencies[archive.artifact.packageName] = archive.specifier;
    if (manifest.overrides?.[archive.artifact.packageName] !== undefined)
      manifest.overrides[archive.artifact.packageName] = archive.specifier;
    changes.push({
      path: archive.path,
      kind: "dependency-materialization",
      beforeSHA256: null,
      afterSHA256: archive.artifact.sha256,
    });
  }
  const afterManifest = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`);
  writeFileSync(join(root, "package.json"), afterManifest, { mode: 0o600 });
  const run = (label: string, frozen: boolean) =>
    runAuthoringBuild({
      workspace: options.create.workspace,
      consumer: root,
      evidenceDirectory: options.create.evidenceDirectory,
      label,
      command: [
        process.execPath,
        "install",
        ...(frozen ? ["--frozen-lockfile"] : []),
        "--ignore-scripts",
      ],
    });
  await run("materialize-dependencies", false);
  const afterLock = readIntegrationFile(root, "bun.lock", 16 * 1024 * 1024);
  await run("materialize-frozen-install", true);
  check(
    applicationHash(readIntegrationFile(root, "bun.lock", 16 * 1024 * 1024)) ===
      applicationHash(afterLock),
    "Materialized frozen lock changed",
  );
  check(
    readIntegrationFile(root, "package.json", AUTHORING_BOUNDS.manifestBytes).equals(afterManifest),
    "Dependency installation changed the materialized manifest",
  );
  for (const artifact of artifacts)
    assertInstalledApplicationArtifact(
      root,
      options.create.repoRoot,
      artifact,
      artifact.packageName === "auggy" ? "auggy/application" : artifact.packageName,
    );
  const audit = runDependencyAudit({
    cwd: root,
    evidencePath: join(options.create.evidenceDirectory, "materialized-dependency-audit.json"),
  });
  check(audit.status === "passed", "Materialized dependency audit did not pass");
  for (const [path, before, after] of [
    ["package.json", beforeManifest, afterManifest],
    ["bun.lock", beforeLock, afterLock],
  ] as const)
    changes.push({
      path,
      kind: "dependency-materialization",
      beforeSHA256: applicationHash(before),
      afterSHA256: applicationHash(after),
    });
  return { changes, lockfile: { path: "bun.lock", sha256: applicationHash(afterLock) } };
}

export type IntegrationChildOptions = Parameters<typeof startApplicationChild>[0] & {
  /** Static, non-secret label; argv and env are never copied into result metadata. */
  label: string;
  signal?: AbortSignal;
};

export async function withIntegrationChild<T>(
  options: IntegrationChildOptions,
  observe: (context: {
    budget: IntegrationBudget;
    child: ReturnType<typeof startApplicationChild>;
  }) => Promise<T>,
) {
  check(/^[a-z0-9][a-z0-9-]{0,79}$/.test(options.label), "Invalid integration command label");
  check(
    options.command.length > 0 &&
      options.command.length <= AUTHORING_BOUNDS.commandArguments &&
      options.command.every(
        (part) => part.length <= AUTHORING_BOUNDS.argumentCharacters && !part.includes("\0"),
      ),
    "Integration command exceeded bound",
  );
  assertIntegrationEnvironment(options.env);
  const timeoutMs = options.timeoutMs ?? INTEGRATION_LIMITS.scenarioMs;
  finiteBound(timeoutMs, INTEGRATION_LIMITS.scenarioMs);
  options.signal?.throwIfAborted();
  const budget = createIntegrationBudget(timeoutMs, options.signal);
  const child = startApplicationChild({ ...options, timeoutMs });
  const interrupt = () => child.signal("SIGKILL");
  budget.signal.addEventListener("abort", interrupt, { once: true });
  let value: T | undefined;
  let succeeded = false;
  let stopped: Awaited<ReturnType<typeof child.stop>>;
  try {
    value = await budget.run(timeoutMs, () => observe({ budget, child }));
    succeeded = true;
  } catch {
    // Raw fixture/HTTP/driver exceptions can contain credentials; only a controlled outcome escapes.
  } finally {
    stopped = await child.stop();
    budget.signal.removeEventListener("abort", interrupt);
    budget.dispose();
  }
  const stdout = redactIntegrationDiagnostic(stopped.stdout, options.secrets);
  const stderr = redactIntegrationDiagnostic(stopped.stderr, options.secrets);
  const healthy =
    !stopped.spawnFailed &&
    !stopped.timedOut &&
    !stopped.exceededOutput &&
    !stopped.orphanedGroup &&
    !stopped.forced &&
    stopped.cleanupConfirmed &&
    (stopped.wasRunning || (stopped.exitCode === 0 && stopped.signal === null));
  return {
    label: options.label,
    status: succeeded && healthy ? ("passed" as const) : ("failed" as const),
    ...(succeeded && healthy ? { value } : {}),
    process: {
      ...stopped,
      stdout,
      stderr,
      stdoutSHA256: applicationHash(stdout),
      stderrSHA256: applicationHash(stderr),
    },
  };
}

export function integrationLoopbackUrl(value: string): URL {
  const url = new URL(value);
  check(
    url.protocol === "http:" &&
      ["127.0.0.1", "[::1]"].includes(url.hostname) &&
      !url.username &&
      !url.password &&
      !url.hash,
    "Integration HTTP requires an explicit loopback origin",
  );
  return url;
}

async function boundedBody(response: Response, signal: AbortSignal): Promise<string> {
  check(response.body, "Integration response has no body");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  const abort = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", abort, { once: true });
  try {
    while (true) {
      signal.throwIfAborted();
      const next = await reader.read();
      if (next.done) return Buffer.concat(chunks).toString("utf8");
      bytes += next.value.length;
      check(
        bytes <= INTEGRATION_LIMITS.fixtureRequestBytes && chunks.length < 4096,
        "Integration response exceeded bound",
      );
      chunks.push(next.value);
    }
  } finally {
    signal.removeEventListener("abort", abort);
    void reader.cancel().catch(() => {});
  }
}

/** HTTP readiness only. This never supplies authenticated channel-execution evidence. */
export async function waitForIntegrationHttpReady(options: {
  url: string;
  budget: IntegrationBudget;
  ready: (response: { status: number; body: string }) => boolean;
  exited?: Promise<unknown>;
}): Promise<void> {
  const url = integrationLoopbackUrl(options.url);
  const readiness = createIntegrationBudget(
    Math.min(INTEGRATION_LIMITS.readinessMs, options.budget.remainingMs()),
    options.budget.signal,
  );
  let exited = false;
  void options.exited?.then(
    () => {
      exited = true;
    },
    () => {
      exited = true;
    },
  );
  try {
    while (readiness.remainingMs() > 0) {
      check(!exited, "Integration child exited before readiness");
      try {
        const ready = await readiness.run(INTEGRATION_LIMITS.readinessRequestMs, async (signal) => {
          const response = await fetch(url, { redirect: "manual", signal });
          check(response.status < 300 || response.status >= 400, "Readiness redirects are refused");
          return options.ready({
            status: response.status,
            body: await boundedBody(response, signal),
          });
        });
        if (ready) return;
      } catch {
        readiness.signal.throwIfAborted();
      }
      await readiness.run(1000, async (signal) => {
        await new Promise<void>((resolveWait, reject) => {
          const abort = () => {
            clearTimeout(timer);
            reject(new Error("Readiness aborted"));
          };
          const timer = setTimeout(
            () => {
              signal.removeEventListener("abort", abort);
              resolveWait();
            },
            Math.min(100, readiness.remainingMs()),
          );
          signal.addEventListener("abort", abort, { once: true });
        });
      });
    }
    throw new Error("Integration readiness deadline exceeded");
  } finally {
    readiness.dispose();
  }
}

/** Observe real AG-UI framing without retaining assertion, user content or raw network capture. */
export async function observeIntegrationSse(options: {
  response: Response;
  budget: IntegrationBudget;
  expectedMarker?: string;
}): Promise<{
  events: number;
  bytes: number;
  terminal: "RUN_FINISHED" | "RUN_ERROR" | null;
  contentSHA256: string;
  firstChunkBeforeTerminal: boolean;
  containsExpectedMarker: boolean | null;
}> {
  check(
    options.expectedMarker === undefined ||
      (options.expectedMarker.length > 0 && options.expectedMarker.length <= 4096),
    "AG-UI marker must be explicit and bounded",
  );
  check(
    options.response.status === 200 &&
      /^text\/event-stream(?:;|$)/i.test(options.response.headers.get("content-type") ?? ""),
    "Expected a successful AG-UI SSE response",
  );
  check(options.response.body, "AG-UI SSE body missing");
  const reader = options.response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const text: string[] = [];
  let pending = "",
    bytes = 0,
    reads = 0,
    events = 0;
  let firstContentRead: number | null = null;
  let terminalRead: number | null = null;
  let terminal: "RUN_FINISHED" | "RUN_ERROR" | null = null;
  let errorFinalized = false;
  try {
    await options.budget.run(INTEGRATION_LIMITS.scenarioMs, async (signal) => {
      const abort = () => {
        void reader.cancel().catch(() => {});
      };
      signal.addEventListener("abort", abort, { once: true });
      try {
        while (true) {
          signal.throwIfAborted();
          const next = await reader.read();
          if (next.done) {
            pending += decoder.decode();
            check(pending.trim() === "", "AG-UI ended with incomplete SSE framing");
            check(terminal !== null, "AG-UI ended without a terminal event");
            return;
          }
          reads++;
          bytes += next.value.length;
          check(
            reads <= 4096 && bytes <= INTEGRATION_LIMITS.outputBytes,
            "AG-UI stream exceeded bound",
          );
          pending += decoder.decode(next.value, { stream: true });
          // SSE accepts CRLF and LF; preserve a split CRLF by normalizing only complete frames.
          while (true) {
            const separator = /\r?\n\r?\n/.exec(pending);
            if (!separator) break;
            const frame = pending.slice(0, separator.index);
            pending = pending.slice(separator.index + separator[0].length);
            const data = frame
              .split(/\r?\n/)
              .filter((line) => line.startsWith("data:"))
              .map((line) => line.slice(5).replace(/^ /, ""))
              .join("\n");
            if (!data) continue;
            check(++events <= INTEGRATION_LIMITS.fixtureEvents, "AG-UI event count exceeded bound");
            const event: unknown = JSON.parse(data);
            check(
              event !== null && typeof event === "object" && !Array.isArray(event),
              "AG-UI event is not an object",
            );
            const value = event as Record<string, unknown>;
            check(typeof value.type === "string", "AG-UI event type is missing");
            // Auggy closes a rejected turn with RUN_ERROR followed by RUN_FINISHED.
            // Preserve the failure outcome; only that single closing frame is allowed.
            if (terminal === "RUN_ERROR" && !errorFinalized && value.type === "RUN_FINISHED") {
              errorFinalized = true;
              continue;
            }
            check(terminal === null, "AG-UI emitted data after its terminal event");
            if (value.type === "TEXT_MESSAGE_CONTENT") {
              check(typeof value.delta === "string", "AG-UI text delta is invalid");
              if (value.delta) {
                firstContentRead ??= reads;
                text.push(value.delta);
              }
            }
            if (value.type === "RUN_FINISHED" || value.type === "RUN_ERROR") {
              terminal = value.type;
              terminalRead = reads;
            }
          }
        }
      } finally {
        signal.removeEventListener("abort", abort);
      }
    });
    const content = text.join("");
    return {
      events,
      bytes,
      terminal,
      contentSHA256: applicationHash(content),
      firstChunkBeforeTerminal:
        firstContentRead !== null && terminalRead !== null && firstContentRead < terminalRead,
      containsExpectedMarker:
        options.expectedMarker === undefined ? null : content.includes(options.expectedMarker),
    };
  } finally {
    void reader.cancel().catch(() => {});
  }
}
