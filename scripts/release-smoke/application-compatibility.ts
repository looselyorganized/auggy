/** Installed launcher compatibility. Inputs are actual independently installed packages. */
import { randomBytes, randomUUID } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parse, stringify } from "yaml";
import { ACCEPTED_MAIN } from "./accepted-main-artifacts";
import {
  APPLICATION_BOUNDS,
  applicationEnvironment,
  applicationHash,
  assertInstalledApplicationArtifact,
  parseApplicationStream,
  snapshotApplicationFiles,
  startApplicationChild,
  type ApplicationRecipe,
  type PackedArtifactEvidence,
} from "./application-consumer";
import {
  applicationHttp,
  readApplicationJsonLines,
  waitForApplicationReady,
} from "./application-http";
import {
  createProviderFixture,
  PROVIDER_FIXTURE_API_KEY,
  PROVIDER_FIXTURE_FINAL_TEXT,
  type ProviderFixtureEvidence,
} from "./provider-fixture";
import { redactEvidence } from "./export-evidence";
import { readBoundedRegularFile } from "./bounded-file";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function homeFiles(root: string): Record<string, string> {
  const found: Record<string, string> = {};
  // Bun's own transpiler cache can legitimately appear before CLI preflight.
  const operatorRoot = join(root, ".auggy");
  if (!existsSync(operatorRoot)) return found;
  const walk = (directory: string, prefix: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const name = `${prefix}${entry.name}`;
      check(Object.keys(found).length < 1_024, "Compatibility HOME evidence exceeded its bound");
      if (entry.isDirectory()) walk(path, `${name}/`);
      else {
        check(entry.isFile(), "Compatibility HOME contains an unexpected link");
        found[name] = applicationHash(readFileSync(path));
      }
    }
  };
  walk(operatorRoot, "");
  return found;
}

export interface ApplicationCompatibilityOptions {
  repoRoot: string;
  consumer: string;
  home: string;
  temporaryDirectory: string;
  evidenceDirectory: string;
  recipe: ApplicationRecipe;
  core: PackedArtifactEvidence;
  provider: PackedArtifactEvidence;
  global: { consumer: string; core: PackedArtifactEvidence };
  /** An unpublished differing-version launcher artifact; source graph remains the candidate. */
  differentVersion: { consumer: string; core: PackedArtifactEvidence };
  /** Plain installed package project, with no agent files; built from accepted main 209185d. */
  acceptedLegacy: {
    consumer: string;
    core: PackedArtifactEvidence;
    provider: PackedArtifactEvidence;
    buildEvidencePath?: string;
  };
  expectedToolOutput: string;
}

export function verifyLegacyBuildEvidence(
  core: PackedArtifactEvidence,
  provider: PackedArtifactEvidence,
  evidence: unknown,
): void {
  check(
    object(evidence) &&
      evidence.status === "passed" &&
      evidence.cleanupUnknown === false &&
      evidence.retainedWorkspace === null &&
      object(evidence.source),
    "Accepted legacy rebuild evidence is incomplete",
  );
  check(
    evidence.source.commit === ACCEPTED_MAIN.commit &&
      evidence.source.tree === ACCEPTED_MAIN.tree &&
      evidence.source.lockSHA256 === ACCEPTED_MAIN.lockSHA256,
    "Legacy rebuild is not accepted main209",
  );
  for (const [kind, artifact, required] of [
    [
      "core",
      core,
      [
        "src/cli/index.ts",
        "src/kernel/turn-loop.ts",
        "src/agent.ts",
        "src/transports/web-transport.ts",
      ],
    ],
    ["provider", provider, ["src/index.ts"]],
  ] as const) {
    const built = evidence[kind];
    check(
      object(built) &&
        built.sha256 === artifact.sha256 &&
        built.packageName === artifact.packageName &&
        built.version === artifact.version &&
        object(built.sourceFiles),
      "Accepted rebuild artifact identity mismatch",
    );
    for (const file of required)
      check(
        Object.hasOwn(artifact.fileHashes, file),
        "Legacy installed evidence lacks critical source files",
      );
    for (const [file, hash] of Object.entries(artifact.fileHashes))
      check(
        built.sourceFiles[file] === hash,
        "Legacy installed bytes differ from the accepted rebuild",
      );
  }
}

/** Restore exact bytes even when a subprocess or assertion rejects. */
export async function withCompatibilityFile<T>(
  path: string,
  bytes: string | Buffer,
  action: () => Promise<T>,
  beforeRestore: () => Promise<void> = async () => {},
): Promise<T> {
  let previous: ReturnType<typeof readBoundedRegularFile> | null = null;
  try {
    previous = readBoundedRegularFile(path, APPLICATION_BOUNDS.sourceBytes);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  // Bun may hardlink installed files to a shared cache or sibling consumer.
  // Replace the directory entry atomically; never truncate the installed inode.
  const replace = (value: string | Buffer) => {
    const temporary = `${path}.compatibility-${randomUUID()}`;
    try {
      writeFileSync(temporary, value, {
        flag: "wx",
        mode: previous ? previous.mode & 0o777 : 0o600,
      });
      renameSync(temporary, path);
    } finally {
      rmSync(temporary, { force: true });
    }
  };
  replace(bytes);
  try {
    return await action();
  } finally {
    await beforeRestore();
    if (previous) replace(previous.bytes);
    else rmSync(path, { force: true });
  }
}

/** Static executable fixture; all per-run values stay in sibling data files. */
export function writeLegacyCompatibilityObserver(directory: string): void {
  const source = String.raw`import { appendFileSync, readFileSync } from "node:fs";
import { defineAugment } from "auggy";

const sentinel = readFileSync(new URL("./acceptance.txt", import.meta.url), "utf8");
const trace = new URL("./trace.jsonl", import.meta.url);

export default function () {
  return defineAugment({
    name: "compatibilityObserver",
    onTurnEnd: async (turn) => {
      appendFileSync(trace, JSON.stringify({
        success: turn.success,
        status: turn.status,
        tools: turn.toolCalls.map((tool) => ({
          name: tool.name,
          sentinel: tool.output.includes(sentinel),
        })),
        runtime: import.meta.resolve("auggy"),
        processEntry: process.argv[1],
        delegation: JSON.parse(process.env.AUGGY_CLI_DELEGATION ?? "null"),
      }) + "\n", { mode: 0o600 });
    },
  });
}
`;
  writeFileSync(join(directory, "observer.ts"), source, { flag: "wx", mode: 0o600 });
}

export function assertRejectedCompatibilityProcess(
  result: Awaited<ReturnType<ReturnType<typeof startApplicationChild>["finish"]>>,
  expectedDiagnostic: string,
): void {
  check(
    result.cleanupConfirmed &&
      !result.spawnFailed &&
      !result.timedOut &&
      !result.exceededOutput &&
      !result.orphanedGroup &&
      result.signal === null &&
      result.exitCode !== null &&
      result.exitCode !== 0,
    "Compatibility rejection was not a normal nonzero CLI exit",
  );
  check(
    `${result.stdout}\n${result.stderr}`.includes(expectedDiagnostic),
    "Compatibility rejection lost its actionable diagnostic",
  );
}

export function assertCompatibilityCompletion(options: {
  httpStatus: number;
  body: string;
  threadId: string;
  toolName: string;
  provider: ProviderFixtureEvidence;
}): string {
  const events = parseApplicationStream(options.body);
  const starts = events.filter((event) => event.type === "RUN_STARTED");
  const finishes = events.filter((event) => event.type === "RUN_FINISHED");
  const tools = events.filter((event) => event.type === "TOOL_CALL_START");
  check(
    options.httpStatus === 200 &&
      starts.length === 1 &&
      finishes.length === 1 &&
      events.at(-1) === finishes[0],
    "Compatibility turn lacks one terminal public result",
  );
  const start = starts[0]!,
    finish = finishes[0]!;
  check(
    typeof start.runId === "string" &&
      start.runId.length > 0 &&
      start.runId === finish.runId &&
      start.threadId === options.threadId &&
      finish.threadId === options.threadId,
    "Compatibility stream identity mismatch",
  );
  check(
    object(finish.result) &&
      finish.result.status === "completed" &&
      !events.some((event) => event.type === "RUN_ERROR"),
    "Compatibility turn did not complete successfully",
  );
  check(
    tools.length === 1 && tools[0]!.toolCallName === options.toolName,
    "Compatibility turn did not execute exactly the requested tool",
  );
  check(
    events
      .filter((event) => event.type === "TEXT_MESSAGE_CONTENT")
      .map((event) => event.delta)
      .join("")
      .includes(PROVIDER_FIXTURE_FINAL_TEXT),
    "Compatibility final response text mismatch",
  );
  const observed = options.provider;
  check(
    observed.calls === 2 &&
      observed.toolRequests === 1 &&
      observed.validatedToolResults === 1 &&
      observed.finalResponses === 1 &&
      observed.rejectedRequests === 0,
    "Compatibility provider counters do not prove one tool turn",
  );
  return start.runId;
}

export async function runApplicationCompatibility(
  options: ApplicationCompatibilityOptions,
): Promise<void> {
  const helperSHA256 = applicationHash(readFileSync(import.meta.path));
  const consumer = realpathSync(options.consumer);
  const repo = realpathSync(options.repoRoot);
  const evidence = resolve(options.evidenceDirectory);
  mkdirSync(evidence, { recursive: true, mode: 0o700 });
  writeFileSync(
    join(evidence, "compatibility.json"),
    `${JSON.stringify({ status: "running", helperSHA256 })}\n`,
    { mode: 0o600 },
  );
  const local = assertInstalledApplicationArtifact(consumer, repo, options.core, "auggy/cli");
  assertInstalledApplicationArtifact(consumer, repo, options.provider, "@auggy/anthropic");
  const global = assertInstalledApplicationArtifact(
    options.global.consumer,
    repo,
    options.global.core,
    "auggy/cli",
  );
  const different = assertInstalledApplicationArtifact(
    options.differentVersion.consumer,
    repo,
    options.differentVersion.core,
    "auggy/cli",
  );
  check(
    options.differentVersion.core.version !== options.core.version &&
      options.differentVersion.core.sha256 !== options.core.sha256,
    "Differing-version coverage requires a distinct real packed artifact",
  );
  if (options.acceptedLegacy.buildEvidencePath) {
    verifyLegacyBuildEvidence(
      options.acceptedLegacy.core,
      options.acceptedLegacy.provider,
      JSON.parse(
        readBoundedRegularFile(
          options.acceptedLegacy.buildEvidencePath,
          APPLICATION_BOUNDS.sourceBytes,
        ).bytes.toString("utf8"),
      ),
    );
  } else
    check(
      options.acceptedLegacy.core.sha256 === ACCEPTED_MAIN.coreSHA256 &&
        options.acceptedLegacy.provider.sha256 === ACCEPTED_MAIN.providerSHA256,
      "Legacy acceptance requires certified accepted209 artifacts or verified rebuild evidence",
    );
  const legacy = realpathSync(options.acceptedLegacy.consumer);
  const legacyCore = assertInstalledApplicationArtifact(
    legacy,
    repo,
    options.acceptedLegacy.core,
    "auggy/cli",
  );
  assertInstalledApplicationArtifact(
    legacy,
    repo,
    options.acceptedLegacy.provider,
    "@auggy/anthropic",
  );
  check(
    options.acceptedLegacy.core.manifest.auggyRuntime === undefined,
    "Legacy baseline unexpectedly has application capabilities",
  );
  const original = snapshotApplicationFiles(consumer, options.recipe.sourceFiles);
  const lockSHA256 = applicationHash(readFileSync(join(consumer, "bun.lock")));
  const configPath = join(consumer, "agent.yaml");
  const entryPath = join(consumer, options.recipe.entrypoint);
  const manifestPath = join(local.packageRoot, "package.json");
  const marker = join(consumer, ".compatibility-import.jsonl");
  check(!existsSync(marker), "Compatibility marker already exists");
  const config: unknown = parse(readFileSync(configPath, "utf8"));
  check(object(config) && Array.isArray(config.augments), "Expected reference agent configuration");
  const configValue = config as Record<string, unknown> & { augments: Record<string, unknown>[] };
  const web = configValue.augments.find((item) => object(item) && item.type === "webTransport");
  check(web && object(web.options), "Reference web transport missing");
  configValue.id = `aug1_${randomUUID()}`;
  const reservation = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
  const port = reservation.port!;
  await reservation.stop(true);
  const baseURL = `http://127.0.0.1:${port}`;
  const bearer = randomBytes(32).toString("hex");
  const secrets = [bearer, PROVIDER_FIXTURE_API_KEY];
  const provider = createProviderFixture({
    tool: options.recipe.tool,
    toolResultSentinel: options.expectedToolOutput,
  });
  const providers = [provider];
  const env = applicationEnvironment(options.home, options.temporaryDirectory, {
    ANTHROPIC_API_KEY: PROVIDER_FIXTURE_API_KEY,
    AUGGY_WEB_TOKEN: bearer,
    AUGGY_PUBLIC_URL: baseURL,
  });
  const http = applicationHttp(baseURL, bearer);
  const scenarios: Record<string, unknown> = {};
  const lifecycle: Record<string, unknown>[] = [];
  const cleanupErrors: string[] = [];
  let child: ReturnType<typeof startApplicationChild> | undefined;
  let failure: unknown;
  let activeLabel = "";
  let childObservations = 0;
  let unsafeCleanup = false;
  const cancel = new AbortController();
  const write = (file: string, value: unknown) =>
    writeFileSync(
      join(evidence, file),
      `${redactEvidence(JSON.stringify(value, null, 2), secrets)}\n`,
      { mode: 0o600 },
    );
  const onSignal = () => {
    cancel.abort(new Error("Compatibility interrupted"));
    child?.signal("SIGTERM");
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  const checkpoint = () => cancel.signal.throwIfAborted();
  const finish = async (stop: boolean) => {
    if (!child) return;
    const current = child;
    const result = stop ? await current.stop() : await current.finish();
    unsafeCleanup ||= !result.cleanupConfirmed || result.orphanedGroup;
    if (result.cleanupConfirmed) child = undefined;
    const suffix = childObservations++ === 0 ? "" : `-cleanup-${childObservations}`;
    write(`${activeLabel}${suffix}.json`, result);
    if (stop) {
      check(
        result.cleanupConfirmed &&
          !("forced" in result && result.forced) &&
          !result.orphanedGroup &&
          !result.timedOut &&
          result.exitCode === 0,
        "Compatibility runtime did not shut down cleanly",
      );
      lifecycle.push({ label: activeLabel, exitCode: result.exitCode, signal: result.signal });
    }
    return result;
  };
  const launch = (
    label: string,
    command: string[],
    cwd = consumer,
    extraEnv: Record<string, string> = {},
  ) => {
    checkpoint();
    check(!child, "Compatibility child overlap");
    activeLabel = label;
    childObservations = 0;
    child = startApplicationChild({ command, cwd, env: { ...env, ...extraEnv }, secrets });
  };
  const restoreBoundary = async () => {
    await finish(true);
    check(!unsafeCleanup, "Retaining mutated fixture because process cleanup is unproven");
  };
  const edit = <T>(path: string, bytes: string | Buffer, action: () => Promise<T>) =>
    withCompatibilityFile(path, bytes, action, restoreBoundary);
  const prefix = (label: string) =>
    `import { appendFileSync as compatibilityWrite } from "node:fs"; compatibilityWrite(${JSON.stringify(marker)}, JSON.stringify({kind:${JSON.stringify(label)}})+"\\n");\n`;
  const reject = async (
    label: string,
    diagnostic: string,
    command = [process.execPath, global.entry, "run", "--no-open"],
    cwd = consumer,
    extraEnv: Record<string, string> = {},
    allowedImports = 0,
  ) => {
    const beforeHome = allowedImports === 0 ? homeFiles(options.home) : null;
    const imports = existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      : 0;
    const calls = provider.evidence().calls;
    launch(label, command, cwd, extraEnv);
    const result = (await finish(false))!;
    assertRejectedCompatibilityProcess(result, diagnostic);
    const after = existsSync(marker)
      ? readFileSync(marker, "utf8").split("\n").filter(Boolean).length
      : 0;
    check(
      after - imports === allowedImports && provider.evidence().calls === calls,
      "Rejected startup executed unexpected project/provider code",
    );
    if (beforeHome)
      check(
        JSON.stringify(homeFiles(options.home)) === JSON.stringify(beforeHome),
        "Pre-import rejection wrote operator state or resource claims",
      );
    let listenerObserved = false;
    try {
      await fetch(`${baseURL}/health`, { signal: AbortSignal.timeout(300) });
      listenerObserved = true;
    } catch (error) {
      listenerObserved = error instanceof Error && error.name === "TimeoutError";
    }
    check(!listenerObserved, "Rejected startup left an HTTP listener");
    scenarios[label] = {
      status: "passed",
      exitCode: result.exitCode,
      diagnostic,
      projectImports: after - imports,
      providerCalls: 0,
      operatorStateUnchanged: beforeHome !== null,
      listenerObserved,
    };
  };
  const mutateManifest = async (
    label: string,
    mutate: (value: Record<string, unknown>) => void,
    diagnostic: string,
  ) => {
    const value = JSON.parse(readFileSync(manifestPath, "utf8"));
    mutate(value);
    await edit(manifestPath, JSON.stringify(value), () => reject(label, diagnostic));
  };
  const startupRecords = () =>
    readApplicationJsonLines(consumer, options.recipe.evidenceFiles.startup);
  const runReference = async (label: string, command: string[], cwd = consumer) => {
    provider.reset();
    const starts = startupRecords().length;
    launch(label, command, cwd);
    await waitForApplicationReady(child!, http, cancel.signal);
    const startupDeadline = Date.now() + 5_000;
    while (startupRecords().length === starts && Date.now() < startupDeadline) {
      checkpoint();
      await Bun.sleep(25);
    }
    const ready = startupRecords().at(-1);
    check(
      startupRecords().length === starts + 1 &&
        ready?.event === "application.ready" &&
        ready.mode === "foreground",
      "Reference main was not invoked once with foreground mode",
    );
    check(
      typeof ready.processEntry === "string" &&
        realpathSync(ready.processEntry) ===
          realpathSync(join(consumer, "node_modules/auggy/src/cli/index.ts")),
      "Global launch did not execute the selected local CLI",
    );
    const threadId = `compatibility-${randomUUID()}`;
    const response = await http.request("/agent/run", {
      method: "POST",
      json: {
        threadId,
        messages: [{ role: "user", content: options.recipe.userMessage }],
      },
      signal: cancel.signal,
    });
    const observed = provider.evidence();
    const publicRunId = assertCompatibilityCompletion({
      httpStatus: response.status,
      body: response.body,
      threadId,
      toolName: options.recipe.tool.name,
      provider: observed,
    });
    scenarios[label] = {
      status: "passed",
      provider: observed,
      startup: ready,
      threadId,
      publicRunId,
      responseSHA256: applicationHash(response.body),
    };
    await finish(true);
  };
  const moveToLink = async (path: string, action: () => Promise<void>) => {
    const moved = `${path}.compatibility-source`;
    check(!existsSync(moved), "Workspace fixture destination exists");
    renameSync(path, moved);
    symlinkSync(moved, path);
    try {
      await action();
    } finally {
      await restoreBoundary();
      rmSync(path);
      renameSync(moved, path);
    }
  };
  try {
    write("compatibility-provenance.json", {
      helperSHA256,
      bun: Bun.version,
      local,
      global,
      differentVersion: {
        selection: different,
        version: options.differentVersion.core.version,
        sha256: options.differentVersion.core.sha256,
      },
      currentArtifacts: { core: options.core, provider: options.provider },
      legacy: {
        selection: legacyCore,
        core: options.acceptedLegacy.core,
        provider: options.acceptedLegacy.provider,
        buildEvidencePath: options.acceptedLegacy.buildEvidencePath ?? null,
      },
      projectSources: original,
      lockSHA256,
    });
    configValue.engine = {
      provider: "anthropic",
      model: "claude-compatibility-fixture",
      baseURL: provider.baseURL,
      maxContextTokens: 32_000,
      maxTokens: 256,
      requestTimeoutMs: 5_000,
      costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
    };
    web.options.port = port;
    web.options.auth = { type: "bearer", token: "${AUGGY_WEB_TOKEN}" };
    web.options.allowAnonymous = false;
    await edit(configPath, stringify(configValue), async () => {
      const factoryPath = join(consumer, "src/augments/example/index.ts");
      await edit(
        factoryPath,
        prefix("augment-module") + readFileSync(factoryPath, "utf8"),
        async () => {
          await edit(
            entryPath,
            prefix("application-module") + readFileSync(entryPath, "utf8"),
            async () => {
              const configured = readFileSync(configPath);
              await mutateManifest(
                "L05-malformed-capability",
                (value) => {
                  value.auggyRuntime = { schemaVersion: "1" };
                },
                "unsupported or malformed",
              );
              await mutateManifest(
                "L05-unsupported-launcher",
                (value) => {
                  value.auggyRuntime = {
                    schemaVersion: 1,
                    launcherProtocol: 2,
                    applicationContracts: [1],
                  };
                },
                "unsupported or malformed",
              );
              await mutateManifest(
                "L05-unsupported-contract",
                (value) => {
                  value.auggyRuntime = {
                    schemaVersion: 1,
                    launcherProtocol: 1,
                    applicationContracts: [2],
                  };
                },
                "does not support application contract",
              );
              await mutateManifest(
                "L05-incompatible-engine",
                (value) => {
                  value.engines = { bun: ">=99.0.0" };
                },
                "Bun requirement is not satisfied",
              );
              await edit(
                configPath,
                stringify({
                  ...configValue,
                  application: { entrypoint: "./src/index.ts", contractVersion: 2 },
                }),
                () => reject("L05-invalid-app-contract", "supports integer contract 1"),
              );
              await edit(
                configPath,
                stringify({
                  ...configValue,
                  application: { entrypoint: "../outside.ts", contractVersion: 1 },
                }),
                () => reject("L05-escaping-entrypoint", "regular file inside the project"),
              );
              await edit(configPath, "application: [\n", () =>
                reject("L05-invalid-yaml", "readable, valid YAML"),
              );
              const hidden = `${local.packageRoot}.compatibility-hidden`;
              check(!existsSync(hidden), "Missing-package fixture destination exists");
              renameSync(local.packageRoot, hidden);
              try {
                await reject("L05-missing-local", "install Auggy explicitly");
              } finally {
                await restoreBoundary();
                renameSync(hidden, local.packageRoot);
              }
              const nested = join(consumer, ".compatibility-nested");
              mkdirSync(nested);
              try {
                for (const file of options.recipe.sourceFiles) {
                  mkdirSync(dirname(join(nested, file)), { recursive: true });
                  copyFileSync(join(consumer, file), join(nested, file));
                }
                await reject(
                  "L05-ancestor-only-local",
                  "install Auggy explicitly",
                  [process.execPath, global.entry, "run", "--no-open"],
                  nested,
                );
                mkdirSync(join(nested, "node_modules"));
                symlinkSync(local.packageRoot, join(nested, "node_modules/auggy"));
                await reject(
                  "L06-ancestor-only-provider",
                  "install",
                  [process.execPath, global.entry, "run", "--no-open"],
                  nested,
                  {},
                  1,
                );
              } finally {
                await restoreBoundary();
                rmSync(nested, { recursive: true, force: true });
              }
              const probe = join(consumer, ".compatibility-version.ts");
              await edit(
                probe,
                `import {inspectProjectRuntime} from ${JSON.stringify(join(local.packageRoot, "src/cli/project-runtime.ts"))}; inspectProjectRuntime(${JSON.stringify(consumer)},{applicationContract:1,bunVersion:"1.3.13"});`,
                () =>
                  reject("L05-older-version-preflight-only", "requires Bun 1.3.14", [
                    process.execPath,
                    probe,
                  ]),
              );
              await edit(
                entryPath,
                `${prefix("missing-main-module")}export const notMain = true;`,
                () => reject("L05-missing-main-post-import", "main", undefined, consumer, {}, 1),
              );
              const envelope = {
                protocol: 1,
                configPath: realpathSync(configPath),
                packageRoot: local.packageRoot,
                cliPath: local.entry,
                manifestSHA256: applicationHash(readFileSync(manifestPath)),
              };
              await reject(
                "L08-corrupt-envelope",
                "invalid local CLI delegation envelope",
                undefined,
                consumer,
                { AUGGY_CLI_DELEGATION: "{" },
              );
              await reject("L08-forged-envelope", "refusing a second hop", undefined, consumer, {
                AUGGY_CLI_DELEGATION: JSON.stringify({ ...envelope, protocol: 2 }),
              });
              await reject("L08-inherited-envelope", "refusing a second hop", undefined, consumer, {
                AUGGY_CLI_DELEGATION: JSON.stringify(envelope),
              });
              const originalCli = readFileSync(local.entry, "utf8");
              const replacement = `import {readFileSync as readCompat,writeFileSync as writeCompat} from "node:fs"; const compatManifest=${JSON.stringify(manifestPath)};const compatValue=JSON.parse(readCompat(compatManifest,"utf8"));compatValue.description="changed between parent and child";writeCompat(compatManifest,JSON.stringify(compatValue));\n`;
              await edit(manifestPath, readFileSync(manifestPath), () =>
                edit(
                  local.entry,
                  originalCli.replace(/^(#![^\n]*\n)?/, (prefix) => `${prefix}${replacement}`),
                  () => reject("L08-selected-package-replaced", "refusing a second hop"),
                ),
              );
              await reject("L15-invalid-option", "unknown option", [
                process.execPath,
                global.entry,
                "run",
                "--unknown-compatibility-option",
              ]);
              await reject("L15-wrong-name", "command requested", [
                process.execPath,
                global.entry,
                "run",
                "not-the-agent",
                "--no-open",
              ]);
              check(
                applicationHash(readFileSync(configPath)) === applicationHash(configured),
                "Negative fixture changed configured YAML",
              );
            },
          );
        },
      );
      await moveToLink(join(consumer, "node_modules/auggy"), () =>
        moveToLink(join(consumer, "node_modules/@auggy/anthropic"), () =>
          runReference("L06-explicit-workspace-links", [
            process.execPath,
            global.entry,
            "run",
            "--no-open",
          ]),
        ),
      );
      await runReference("L07-different-version-local-selection", [
        process.execPath,
        different.entry,
        "run",
        "--no-open",
      ]);
      await edit(
        join(consumer, ".env"),
        "ANTHROPIC_API_KEY=dotenv-dummy-not-used\nAUGGY_WEB_TOKEN=dotenv-dummy-not-used\n",
        () =>
          runReference(
            "L15-explicit-config-leading-terminator-shell-env",
            [
              process.execPath,
              global.entry,
              "--",
              "run",
              "ignored-name",
              "--no-open",
              "--config",
              configPath,
            ],
            options.temporaryDirectory,
          ),
      );
      await runReference("L15-optional-name", [
        process.execPath,
        global.entry,
        "run",
        String(configValue.name),
        "--no-open",
      ]);
    });
    // Legacy fixture is application-free and owns ordinary inline augment configuration.
    check(
      !existsSync(join(legacy, "agent.yaml")),
      "Legacy install must not already contain an agent",
    );
    const legacyOwned = join(legacy, ".compatibility-legacy");
    check(!existsSync(legacyOwned), "Legacy owned fixture already exists");
    mkdirSync(legacyOwned);
    const legacySentinel = `accepted209-${randomUUID()}`;
    writeFileSync(join(legacyOwned, "acceptance.txt"), legacySentinel);
    const legacyProvider = createProviderFixture({ toolResultSentinel: legacySentinel });
    providers.push(legacyProvider);
    writeLegacyCompatibilityObserver(legacyOwned);
    const legacyConfig = {
      id: `aug1_${randomUUID()}`,
      name: "accepted-legacy",
      purpose: "Read the isolated acceptance file.",
      engine: {
        provider: "anthropic",
        model: "claude-compatibility-fixture",
        baseURL: legacyProvider.baseURL,
        maxTokens: 256,
        maxContextTokens: 32_000,
        requestTimeoutMs: 5_000,
        costOverride: { inputUsdPerMtok: 0, outputUsdPerMtok: 0 },
      },
      augments: [
        {
          name: "filesystem",
          type: "filesystem",
          options: {
            mounts: [{ name: "workspace", path: legacyOwned, writable: false, deletable: false }],
            workspaceAwareness: { enabled: false },
          },
        },
        {
          name: "web",
          type: "webTransport",
          options: {
            port,
            auth: { type: "bearer", token: "${AUGGY_WEB_TOKEN}" },
            allowAnonymous: false,
            console: { enabled: false },
          },
        },
        {
          name: "compatibilityObserver",
          type: "custom",
          source: "./.compatibility-legacy/observer.ts",
        },
      ],
    };
    try {
      await edit(join(legacy, "agent.yaml"), stringify(legacyConfig), async () => {
        launch(
          "L09-accepted-legacy-request",
          [process.execPath, global.entry, "dev", "--config", join(legacy, "agent.yaml")],
          legacy,
        );
        await waitForApplicationReady(child!, http, cancel.signal);
        const threadId = `legacy-${randomUUID()}`;
        const response = await http.request("/agent/run", {
          method: "POST",
          json: {
            threadId,
            messages: [{ role: "user", content: "Read workspace/acceptance.txt using fs_read." }],
          },
          signal: cancel.signal,
        });
        const result = legacyProvider.evidence();
        const publicRunId = assertCompatibilityCompletion({
          httpStatus: response.status,
          body: response.body,
          threadId,
          toolName: "fs_read",
          provider: result,
        });
        const traces = readApplicationJsonLines(legacy, ".compatibility-legacy/trace.jsonl");
        const trace = traces.at(-1);
        check(
          traces.length === 1 && trace?.success === true && trace.status === "completed",
          "Accepted legacy runtime did not complete its real tool turn",
        );
        check(
          typeof trace.processEntry === "string" &&
            realpathSync(trace.processEntry) === legacyCore.entry &&
            object(trace.delegation) &&
            trace.delegation.packageRoot === legacyCore.packageRoot &&
            trace.delegation.protocol === 1 &&
            Array.isArray(trace.tools) &&
            trace.tools.length === 1 &&
            trace.tools.some(
              (tool) => object(tool) && tool.name === "fs_read" && tool.sentinel === true,
            ),
          "Legacy execution lost local ownership, handoff or real tool proof",
        );
        scenarios["L09-accepted-legacy-request"] = {
          status: "passed",
          acceptedSource: ACCEPTED_MAIN.commit,
          coreSHA256: options.acceptedLegacy.core.sha256,
          provider: result,
          trace,
          threadId,
          publicRunId,
          responseSHA256: applicationHash(response.body),
        };
        await finish(true);
        const legacyEntry = join(legacyOwned, "entry.ts");
        writeFileSync(
          legacyEntry,
          `${prefix("unsupported-legacy-app")}export async function main() {};`,
        );
        await edit(
          join(legacy, "agent.yaml"),
          stringify({
            ...legacyConfig,
            application: { entrypoint: "./.compatibility-legacy/entry.ts", contractVersion: 1 },
          }),
          () =>
            reject(
              "L09-legacy-app-rejected",
              "does not support application contract",
              [
                process.execPath,
                global.entry,
                "run",
                "--no-open",
                "--config",
                join(legacy, "agent.yaml"),
              ],
              legacy,
            ),
        );
      });
    } finally {
      await finish(true);
      if (!unsafeCleanup) rmSync(legacyOwned, { recursive: true, force: true });
    }
  } catch (error) {
    failure = error;
  } finally {
    try {
      try {
        await finish(true);
      } catch {
        cleanupErrors.push("child-cleanup-failed");
        unsafeCleanup = true;
      }
      for (const fixture of providers) {
        try {
          await fixture.stop();
        } catch {
          cleanupErrors.push("provider-cleanup-failed");
        }
      }
      if (!unsafeCleanup) {
        try {
          rmSync(marker, { force: true });
        } catch {
          cleanupErrors.push("marker-cleanup-failed");
        }
      }
      try {
        check(
          JSON.stringify(snapshotApplicationFiles(consumer, options.recipe.sourceFiles)) ===
            JSON.stringify(original),
          "Compatibility fixture changed project source",
        );
        check(
          applicationHash(readFileSync(join(consumer, "bun.lock"))) === lockSHA256,
          "Compatibility fixture changed the lock",
        );
        assertInstalledApplicationArtifact(consumer, repo, options.core, "auggy/cli");
        assertInstalledApplicationArtifact(consumer, repo, options.provider, "@auggy/anthropic");
        check(
          applicationHash(readFileSync(import.meta.path)) === helperSHA256,
          "Compatibility helper changed during execution",
        );
      } catch {
        cleanupErrors.push("fixture-restoration-failed");
      }
      write("compatibility.json", {
        status: failure || cleanupErrors.length ? "failed" : "passed",
        scenarios,
        lifecycle,
        cleanupErrors,
        unsafeCleanup,
        failure:
          failure instanceof Error ? failure.message : failure ? "compatibility-failed" : null,
        obligations: {
          L05: "Older Bun is an installed metadata preflight with injected 1.3.13, not execution under an unsupported binary.",
          L06: "Core/provider explicit symlinks and ancestor rejection executed here; Link shares import-from-agent selector and retains the separately required packed Link gate.",
          L07: "This helper covers differing versions only; the main runner owns same-version distinct-artifact selection.",
          L15: "Explicit config, leading --, optional/wrong names, invalid options, foreground mode and shell-over-dotenv covered; browser/launchd/generated service modes retain their separate gates.",
        },
      });
    } finally {
      process.off("SIGINT", onSignal);
      process.off("SIGTERM", onSignal);
    }
  }
  check(
    !failure && cleanupErrors.length === 0,
    `Application compatibility failed; see ${join(evidence, "compatibility.json")}`,
  );
}
