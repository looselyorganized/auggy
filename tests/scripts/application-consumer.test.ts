import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  APPLICATION_ROWS,
  applicationEnvironment,
  applicationHash,
  assertApplicationDenial,
  assertApplicationReplay,
  assertApplicationTurn,
  assertInstalledApplicationArtifact,
  assertOnlyApplicationEdits,
  classifyApplicationUpgrade,
  inspectApplicationArtifact,
  parseApplicationStream,
  prepareApplicationConsumer,
  snapshotApplicationFiles,
  startApplicationChild,
  withApplicationEdit,
  type ApplicationRecipe,
  type PackedArtifactInput,
} from "../../scripts/release-smoke/application-consumer";
import type { TurnFinalizationObservation } from "../../src/index";
import type { ProviderFixtureEvidence } from "../../scripts/release-smoke/provider-fixture";

let root: string;
let sequence = 0;
const processFixture = fileURLToPath(
  new URL("../fixtures/m3-main-codeql/process-child.ts", import.meta.url),
);
function write(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}

// These tiny tarballs exercise packaging rejection/materialization only. They
// are never executed and cannot count as actual Auggy acceptance artifacts.
function artifact(name = "auggy", variant = "A", capable = true): PackedArtifactInput {
  const staging = join(root, `pack-${sequence++}`);
  const manifest = {
    name,
    version: "0.5.0",
    type: "module",
    bin: { auggy: "src/index.ts" },
    exports: { ".": "./src/index.ts", "./application": "./src/index.ts" },
    ...(capable && name === "auggy"
      ? { auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] } }
      : {}),
  };
  write(join(staging, "package/package.json"), JSON.stringify(manifest));
  write(
    join(staging, "package/src/index.ts"),
    `throw new Error("unit packaging fixture ${variant} must not run");\n`,
  );
  const path = join(root, `artifact-${sequence}.tgz`);
  const result = spawnSync("tar", ["-czf", path, "-C", staging, "package"], { timeout: 10_000 });
  expect(result.status).toBe(0);
  return {
    path,
    sha256: applicationHash(readFileSync(path)),
    packageName: name,
    sourceFiles: ["src/index.ts"],
  };
}

const recipe: ApplicationRecipe = {
  entrypoint: "src/index.ts",
  sourceFiles: ["package.json", "agent.yaml", "src/index.ts", "src/http.ts", "src/turn.ts"],
  edits: {
    startup: { path: "src/index.ts", before: "startup-v1", after: "startup-v2" },
    http: { path: "src/http.ts", before: "header-v1", after: "header-v2" },
    turn: { path: "src/turn.ts", before: "maxInferences: 2", after: "maxInferences: 1" },
  },
  tool: { name: "unit_fixture_tool", input: { id: "fixture" }, invalidInput: { id: 17 } },
  userMessage: "Run the explicitly configured fixture tool.",
  evidenceFiles: {
    startup: "proof/startup.jsonl",
    trace: "proof/trace.jsonl",
    finalization: "proof/finalization.jsonl",
    toolJournal: "proof/tool.jsonl",
  },
};

function materialization() {
  return {
    repoRoot: join(root, "repo"),
    referenceDir: join(root, "repo/reference"),
    destination: join(root, "consumer"),
    recipe,
    core: artifact(),
    provider: artifact("@auggy/anthropic"),
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "auggy-application-harness-"));
  mkdirSync(join(root, "home"));
  mkdirSync(join(root, "temp"));
  write(
    join(root, "repo/reference/package.json"),
    JSON.stringify({
      name: "fixture",
      private: true,
      type: "module",
      dependencies: { auggy: "file:../..", "@auggy/anthropic": "workspace:*" },
    }),
  );
  write(
    join(root, "repo/reference/agent.yaml"),
    "application:\n  entrypoint: ./src/index.ts\n  contractVersion: 1\n",
  );
  write(join(root, "repo/reference/src/index.ts"), "// startup-v1\n");
  write(join(root, "repo/reference/src/http.ts"), "// header-v1\n");
  write(join(root, "repo/reference/src/turn.ts"), "// maxInferences: 2\n");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("application fixture materialization (not runtime acceptance)", () => {
  test("copies only owned source, binds exact artifacts, and leaves every execution row pending", () => {
    const options = materialization();
    write(join(options.referenceDir, ".env"), "SECRET=must-not-copy");
    write(join(options.referenceDir, "data/state.db"), "private");
    write(join(options.referenceDir, "bun.lock"), "development lock");
    const prepared = prepareApplicationConsumer(options);
    expect(prepared.phase).toBe("prepared-not-executed");
    expect(prepared.pendingRows).toEqual([...APPLICATION_ROWS]);
    expect(existsSync(join(options.destination, "node_modules"))).toBe(false);
    expect(existsSync(join(options.destination, ".env"))).toBe(false);
    expect(existsSync(join(options.destination, "bun.lock"))).toBe(false);
    expect(existsSync(join(options.destination, "data"))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(options.destination, "package.json"), "utf8"));
    expect(manifest.dependencies.auggy).toContain(options.core.sha256);
    expect(manifest.dependencies["@auggy/anthropic"]).toContain(options.provider.sha256);
    expect(manifest.dependencies.auggy).not.toContain(options.repoRoot);
    expect(readFileSync(join(options.destination, "src/index.ts"), "utf8")).toBe("// startup-v1\n");
    expect(prepared.originalSourceHashes["src/index.ts"]).toBe(
      prepared.sourceHashes["src/index.ts"],
    );
  });

  test("rejects source checkout destinations, secret allowlists and symlinked files before writing", () => {
    const options = materialization();
    expect(() =>
      prepareApplicationConsumer({ ...options, destination: join(options.repoRoot, "consumer") }),
    ).toThrow("outside the source");
    expect(() =>
      prepareApplicationConsumer({
        ...options,
        recipe: { ...recipe, sourceFiles: [...recipe.sourceFiles, ".env"] },
      }),
    ).toThrow("secret files");
    rmSync(join(options.referenceDir, "src/http.ts"));
    symlinkSync(
      join(options.referenceDir, "src/index.ts"),
      join(options.referenceDir, "src/http.ts"),
    );
    expect(() => prepareApplicationConsumer(options)).toThrow("symlinks");
    expect(existsSync(options.destination)).toBe(false);
  });

  test("rejects a source parent alias and preserves an already-owned destination", () => {
    const options = materialization();
    symlinkSync(options.repoRoot, join(root, "alias"));
    expect(() =>
      prepareApplicationConsumer({ ...options, destination: join(root, "alias/new") }),
    ).toThrow("outside the source");
    mkdirSync(options.destination);
    write(join(options.destination, "owned"), "keep");
    expect(() => prepareApplicationConsumer(options)).toThrow("already exists");
    expect(readFileSync(join(options.destination, "owned"), "utf8")).toBe("keep");
  });

  test("rejects hash mismatch, pre-M3 core, escaped dependency and ambiguous source edits", () => {
    const options = materialization();
    expect(() =>
      prepareApplicationConsumer({ ...options, core: { ...options.core, sha256: "0".repeat(64) } }),
    ).toThrow("SHA256 mismatch");
    expect(() =>
      prepareApplicationConsumer({ ...options, core: artifact("auggy", "old", false) }),
    ).toThrow("contract-1");
    write(join(options.referenceDir, "src/index.ts"), "startup-v1 startup-v1");
    expect(() => prepareApplicationConsumer(options)).toThrow("edit contract");
    write(join(options.referenceDir, "src/index.ts"), "startup-v1");
    write(
      join(options.referenceDir, "package.json"),
      JSON.stringify({ dependencies: { another: "file:../../other" } }),
    );
    expect(() => prepareApplicationConsumer(options)).toThrow("escape the packed consumer");
    expect(existsSync(options.destination)).toBe(false);
  });

  test("removes only the known checkout provider overrides and preserves security pins", () => {
    const options = materialization();
    const path = join(options.referenceDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    const security = {
      "@hono/node-server": "2.1.6",
      "body-parser": "2.4.0",
      "fast-uri": "3.1.9",
      hono: "4.13.16",
      "ip-address": "10.7.4",
      "proxy-addr": "2.0.8",
      qs: "6.16.1",
    };
    manifest.overrides = {
      ...security,
      ...Object.fromEntries(
        ["anthropic", "ollama", "openai", "openrouter"].map((name) => [
          `@auggy/${name}`,
          `file:../../packages/${name}`,
        ]),
      ),
    };
    write(path, JSON.stringify(manifest));
    prepareApplicationConsumer(options);
    const consumer = JSON.parse(readFileSync(join(options.destination, "package.json"), "utf8"));
    expect(consumer.overrides).toEqual(security);
    expect(consumer.dependencies.auggy).toStartWith("file:./.application-artifacts/");
    expect(consumer.dependencies["@auggy/anthropic"]).toStartWith("file:./.application-artifacts/");
    expect(JSON.parse(readFileSync(path, "utf8")).overrides).toEqual(manifest.overrides);
  });

  test("rejects unknown or changed checkout overrides before creating a consumer", () => {
    const options = materialization();
    const path = join(options.referenceDir, "package.json");
    const manifest = JSON.parse(readFileSync(path, "utf8"));
    for (const overrides of [
      { "@auggy/openai": "file:../../other" },
      { unknown: "link:../outside" },
      { unknown: "workspace:*" },
      { unknown: { ".": "file:../outside" } },
      { auggy: "0.5.0" },
    ]) {
      write(path, JSON.stringify({ ...manifest, overrides }));
      expect(() => prepareApplicationConsumer(options)).toThrow(/override/);
      expect(existsSync(options.destination)).toBe(false);
    }
  });

  test("retains an edited file when process cleanup is unconfirmed and preserves the primary error", async () => {
    const reference = join(root, "repo/reference");
    const originalError = new Error("primary scenario failure");
    let thrown: unknown;
    try {
      await withApplicationEdit(
        reference,
        recipe.edits.turn,
        async () => {
          throw originalError;
        },
        () => false,
      );
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(AggregateError);
    expect((thrown as AggregateError).errors[0]).toBe(originalError);
    expect(readFileSync(join(reference, "src/turn.ts"), "utf8")).toContain("maxInferences: 1");
  });

  test("equal versions cannot substitute a different artifact's installed source", () => {
    const a = inspectApplicationArtifact(artifact("auggy", "A"));
    const b = inspectApplicationArtifact(artifact("auggy", "B"));
    expect(classifyApplicationUpgrade(a, b)).toBe("same-version-artifact-experiment");
    const consumer = join(root, "installed");
    write(join(consumer, "package.json"), "{}");
    write(join(consumer, "node_modules/auggy/package.json"), JSON.stringify(a.manifest));
    write(
      join(consumer, "node_modules/auggy/src/index.ts"),
      'throw new Error("unit packaging fixture A must not run");\n',
    );
    expect(
      assertInstalledApplicationArtifact(consumer, join(root, "repo"), a, "auggy/application")
        .artifactSHA256,
    ).toBe(a.sha256);
    expect(() =>
      assertInstalledApplicationArtifact(consumer, join(root, "repo"), b, "auggy/application"),
    ).toThrow("differ from");
    expect(() =>
      classifyApplicationUpgrade(inspectApplicationArtifact(artifact("auggy", "old", false)), b),
    ).toThrow("contract-1");
  });

  test("installed checks reject workspace links instead of presenting them as packed evidence", () => {
    const artifactEvidence = inspectApplicationArtifact(artifact());
    const consumer = join(root, "installed");
    write(join(consumer, "package.json"), "{}");
    mkdirSync(join(consumer, "node_modules"));
    symlinkSync(join(root, "repo/reference"), join(consumer, "node_modules/auggy"));
    expect(() =>
      assertInstalledApplicationArtifact(
        consumer,
        join(root, "repo"),
        artifactEvidence,
        "auggy/application",
      ),
    ).toThrow("escaped");
  });

  test("source edits are exact and restored even when a real acceptance callback fails", async () => {
    const reference = join(root, "repo/reference");
    const before = snapshotApplicationFiles(reference, recipe.sourceFiles);
    await expect(
      withApplicationEdit(reference, recipe.edits.turn, async () => {
        const after = snapshotApplicationFiles(reference, recipe.sourceFiles);
        assertOnlyApplicationEdits(before, after, ["src/turn.ts"]);
        expect(() => assertOnlyApplicationEdits(before, after, ["src/index.ts"])).toThrow(
          "unexpected",
        );
        throw new Error("deliberate acceptance failure");
      }),
    ).rejects.toThrow("deliberate acceptance failure");
    expect(snapshotApplicationFiles(reference, recipe.sourceFiles)).toEqual(before);
    await expect(
      withApplicationEdit(reference, { ...recipe.edits.turn, before: "missing" }, async () => {}),
    ).rejects.toThrow("exactly once");
  });
});

describe("bounded harness child ownership", () => {
  function child(
    codeOrCommand: string | readonly string[],
    extra: Partial<Parameters<typeof startApplicationChild>[0]> = {},
  ) {
    return startApplicationChild({
      command:
        typeof codeOrCommand === "string" ? [process.execPath, "-e", codeOrCommand] : codeOrCommand,
      cwd: root,
      env: applicationEnvironment(join(root, "home"), join(root, "temp")),
      secrets: ["dummy-secret-never-export"],
      ...extra,
    });
  }

  test("does not inherit ambient secrets and preserves nonzero exit with sanitized evidence", async () => {
    const result = await child(
      'console.log("dummy-secret-never-export"); process.exit(7)',
    ).finish();
    expect(result.exitCode).toBe(7);
    expect(result.stdout).toContain("[REDACTED]");
    expect(result.stdout).not.toContain("dummy-secret");
    expect(result.stdoutSHA256).toBe(applicationHash(result.stdout));
    expect(result.orphanedGroup).toBe(false);
    expect(result.cleanupConfirmed).toBe(true);
    expect(() =>
      applicationEnvironment(join(root, "home"), join(root, "temp"), {
        NODE_OPTIONS: "--require anything",
      }),
    ).toThrow("allowlisted");
  });

  test("kills timed-out and output-flooding children without keeping unbounded logs", async () => {
    const timeout = await child("setInterval(() => {}, 1000)", { timeoutMs: 100 }).finish();
    expect(timeout.timedOut).toBe(true);
    expect(timeout.signal).toBe("SIGKILL");
    const overflow = await child('console.log("x".repeat(10000)); setInterval(() => {}, 1000)', {
      maxOutputBytes: 128,
    }).finish();
    expect(overflow.exceededOutput).toBe(true);
    expect(Buffer.byteLength(overflow.stdout)).toBeLessThanOrEqual(128);
  });

  test("graceful signal is observed separately from forced harness termination", async () => {
    const ready = join(root, "ready");
    const running = child([process.execPath, processFixture, "graceful", ready]);
    for (let i = 0; i < 100 && !existsSync(ready); i++) await Bun.sleep(10);
    expect(existsSync(ready)).toBe(true);
    const result = await running.stop();
    expect(result).toMatchObject({
      wasRunning: true,
      forced: false,
      exitCode: 0,
      orphanedGroup: false,
    });
  });

  test.skipIf(process.platform === "win32")(
    "bounds inherited pipes outside the owned group without claiming cleanup",
    async () => {
      const pidFile = join(root, "escaped-pid");
      const started = Date.now();
      try {
        const result = await child(
          [process.execPath, processFixture, "escaped-descendant", pidFile, "0"],
          { timeoutMs: 100 },
        ).finish();
        expect(result.cleanupConfirmed).toBe(false);
        expect(Date.now() - started).toBeLessThan(6500);
        expect(result.pid).toBeGreaterThan(0);
      } finally {
        // This exact child was deliberately created by the fixture above and
        // remains alive on its own timer; clean it without relying on parent PGID.
        if (existsSync(pidFile)) {
          const pid = Number(readFileSync(pidFile, "utf8"));
          if (Number.isSafeInteger(pid) && pid > 0) {
            try {
              process.kill(pid, "SIGKILL");
            } catch {}
          }
        }
      }
    },
    10_000,
  );

  test.skipIf(process.platform === "win32")(
    "detects and kills a delegated descendant left behind by an exited parent",
    async () => {
      const result = await child(
        'import { spawn } from "node:child_process"; spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" }); process.exit(0);',
      ).finish();
      expect(result.exitCode).toBe(0);
      expect(result.orphanedGroup).toBe(true);
    },
  );
});

describe("application evidence assertions are sensitive to false success", () => {
  const body = [
    { type: "RUN_STARTED", runId: "public", threadId: "thread" },
    { type: "RUN_FINISHED", runId: "public", threadId: "thread", result: { status: "completed" } },
  ]
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("");
  const provider: ProviderFixtureEvidence = {
    scenario: "success",
    generation: 1,
    calls: 2,
    toolRequests: 1,
    validatedToolResults: 1,
    finalResponses: 1,
    rejectedRequests: 0,
    summaries: [],
  };
  const finalization: TurnFinalizationObservation = {
    turnId: "turn",
    threadId: "thread",
    triggerType: "message",
    source: "transport",
    boundary: "before-post-turn",
    executionStarted: true,
    sessionStarted: true,
    outcome: "completed",
    status: "completed",
    disposition: "returned",
    outcomeUnknown: false,
    primaryFailureCode: null,
    priorFailureCodes: [],
    history: "deferred-to-transport",
    accounting: { state: "committed", pricing: "priced" },
    trace: {
      started: true,
      inferenceAttempts: 2,
      recordedInferenceSteps: 2,
      toolAttempts: 1,
      successfulToolCalls: 1,
      capabilityChecks: 1,
      snapshot: "recorded",
    },
    pendingEffects: false,
  };
  const options = {
    httpStatus: 200,
    body,
    threadId: "thread",
    expectedCalls: 2 as const,
    toolName: "fixture",
    provider,
    trace: {
      turnId: "turn",
      threadId: "thread",
      success: true,
      status: "completed",
      inferenceSteps: 2,
      toolNames: ["fixture"],
      sentinelMatched: true,
    },
    finalization,
    toolExecutions: 1,
    history: "deferred-to-transport" as const,
  };

  test("requires actual provider counts, tool evidence and managed settlement together", () => {
    expect(assertApplicationTurn(options).turnId).toBe("turn");
    expect(() =>
      assertApplicationTurn({ ...options, provider: { ...provider, calls: 1 } }),
    ).toThrow("Provider counts");
    expect(() => assertApplicationTurn({ ...options, toolExecutions: 0 })).toThrow("independently");
    expect(() =>
      assertApplicationTurn({
        ...options,
        finalization: { ...finalization, accounting: { state: "failed", pricing: "priced" } },
      }),
    ).toThrow("settlement");
    expect(() => assertApplicationTurn({ ...options, history: "committed" })).toThrow("settlement");
    expect(() =>
      assertApplicationTurn({ ...options, body: `${body}data: {"type":"late"}\n\n` }),
    ).toThrow("final public");
  });

  test("auth denial and replay cannot pass when any execution counter advances", () => {
    assertApplicationDenial(401, [0, 0, 0, 0], [0, 0, 0, 0]);
    expect(() => assertApplicationDenial(200, [0, 0, 0, 0], [0, 0, 0, 0])).toThrow("denied");
    expect(() => assertApplicationDenial(401, [0, 0, 0, 0], [0, 0, 1, 0])).toThrow("counters");
    assertApplicationReplay(body, body, [2, 1, 1, 1], [2, 1, 1, 1]);
    expect(() => assertApplicationReplay(body, body, [2, 1, 1, 1], [2, 1, 2, 1])).toThrow(
      "new model",
    );
    expect(() => assertApplicationReplay(body, `${body}\n`, [2, 1, 1, 1], [2, 1, 1, 1])).toThrow(
      "changed",
    );
    expect(() => parseApplicationStream("data: null\n\n")).toThrow("Invalid SSE");
  });
});
