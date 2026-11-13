import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  applicationEnvironment,
  startApplicationChild,
} from "../../scripts/release-smoke/application-consumer";
import {
  assertRejectedCompatibilityProcess,
  assertCompatibilityCompletion,
  verifyLegacyBuildEvidence,
  withCompatibilityFile,
  writeLegacyCompatibilityObserver,
} from "../../scripts/release-smoke/application-compatibility";
import { ACCEPTED_MAIN } from "../../scripts/release-smoke/accepted-main-artifacts";
import type { PackedArtifactEvidence } from "../../scripts/release-smoke/application-consumer";
import {
  PROVIDER_FIXTURE_FINAL_TEXT,
  type ProviderFixtureEvidence,
} from "../../scripts/release-smoke/provider-fixture";

const directories: string[] = [];
const processFixture = fileURLToPath(
  new URL("../fixtures/m3-main-codeql/process-child.ts", import.meta.url),
);
afterEach(() => {
  for (const directory of directories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});
function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "auggy-compatibility-test-"));
  directories.push(directory);
  mkdirSync(join(directory, "home"));
  mkdirSync(join(directory, "tmp"));
  return directory;
}

describe("installed compatibility evidence and cleanup", () => {
  test("rejects linked and oversized originals before replacing compatibility fixtures", async () => {
    const root = fixture();
    const target = join(root, "original.txt");
    const linked = join(root, "linked.txt");
    writeFileSync(target, "original");
    symlinkSync(target, linked);
    let ran = false;
    const action = async () => {
      ran = true;
    };
    await expect(withCompatibilityFile(linked, "fixture", action)).rejects.toThrow();
    expect(readFileSync(target, "utf8")).toBe("original");
    writeFileSync(target, Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(withCompatibilityFile(target, "fixture", action)).rejects.toThrow();
    expect(ran).toBe(false);
    expect(statSync(target).size).toBe(2 * 1024 * 1024 + 1);
  });

  test("restores captured file mode as well as bytes", async () => {
    const file = join(fixture(), "entry.ts");
    writeFileSync(file, "original");
    chmodSync(file, 0o640);
    await withCompatibilityFile(file, "fixture", async () => {
      expect(statSync(file).mode & 0o777).toBe(0o640);
    });
    expect(readFileSync(file, "utf8")).toBe("original");
    expect(statSync(file).mode & 0o777).toBe(0o640);
  });

  test("legacy observer executes fixed code while hostile paths and sentinels stay data", async () => {
    const root = fixture();
    mkdirSync(join(root, "node_modules"));
    symlinkSync(
      fileURLToPath(new URL("../../", import.meta.url)),
      join(root, "node_modules/auggy"),
    );
    const sentinel = '"}); globalThis.__legacyFixtureInjection = true; //\n';
    const owned = join(root, 'observer-"${data}');
    mkdirSync(owned);
    writeFileSync(join(owned, "acceptance.txt"), sentinel);
    writeLegacyCompatibilityObserver(owned);
    const source = readFileSync(join(owned, "observer.ts"), "utf8");
    expect(source).not.toContain(sentinel);
    expect(source).not.toContain(owned);
    const observer = await import(pathToFileURL(join(owned, "observer.ts")).href);
    await observer.default().onTurnEnd({
      success: true,
      status: "completed",
      toolCalls: [{ name: "fs_read", output: sentinel }],
    });
    expect(Reflect.get(globalThis, "__legacyFixtureInjection")).toBeUndefined();
    const trace = JSON.parse(readFileSync(join(owned, "trace.jsonl"), "utf8"));
    expect(trace.success).toBe(true);
    expect(trace.status).toBe("completed");
    expect(trace.tools).toEqual([{ name: "fs_read", sentinel: true }]);
    expect(typeof trace.runtime).toBe("string");
  });

  test("requires one correlated completed stream and exact tool/provider evidence", () => {
    const events: Record<string, unknown>[] = [
      { type: "RUN_STARTED", threadId: "thread", runId: "run" },
      { type: "TOOL_CALL_START", toolCallName: "fs_read" },
      { type: "TEXT_MESSAGE_CONTENT", delta: PROVIDER_FIXTURE_FINAL_TEXT },
      { type: "RUN_FINISHED", threadId: "thread", runId: "run", result: { status: "completed" } },
    ];
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
    const assert = (value: Record<string, unknown>[], overrides = {}) =>
      assertCompatibilityCompletion({
        httpStatus: 200,
        threadId: "thread",
        toolName: "fs_read",
        provider,
        body: value.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""),
        ...overrides,
      });
    expect(assert(events)).toBe("run");
    expect(() =>
      assert([...events.slice(0, -1), { ...events.at(-1), result: { status: "failed" } }]),
    ).toThrow("complete successfully");
    expect(() =>
      assert([...events.slice(0, -1), { ...events.at(-1), runId: "other-run" }]),
    ).toThrow("identity mismatch");
    expect(() =>
      assert([...events.slice(0, -1), { ...events.at(-1), threadId: "other-thread" }]),
    ).toThrow("identity mismatch");
    expect(() => assert([...events, events.at(-1)!])).toThrow("one terminal");
    expect(() => assert([events[0]!, ...events])).toThrow("one terminal");
    expect(() => assert([events[0]!, { type: "RUN_ERROR" }, ...events.slice(1)])).toThrow(
      "complete successfully",
    );
    expect(() => assert([events[0]!, events[1]!, ...events.slice(1)])).toThrow(
      "exactly the requested tool",
    );
    expect(() => assert(events, { provider: { ...provider, finalResponses: 0 } })).toThrow(
      "provider counters",
    );
    expect(() => assert(events, { httpStatus: 503 })).toThrow("one terminal");
  });
  test("never mutates another consumer or cache through a shared installed hardlink", async () => {
    const root = fixture();
    const file = join(root, "package.json");
    const cache = join(root, "shared-cache.json");
    writeFileSync(cache, "original installed bytes");
    linkSync(cache, file);
    await withCompatibilityFile(file, "negative fixture", async () => {
      expect(readFileSync(cache, "utf8")).toBe("original installed bytes");
      expect(readFileSync(file, "utf8")).toBe("negative fixture");
    });
    expect(readFileSync(cache, "utf8")).toBe("original installed bytes");
    expect(readFileSync(file, "utf8")).toBe("original installed bytes");
  });
  test("accepts source-verified cross-platform rebuilds only when source and critical installed bytes match", () => {
    const core: PackedArtifactEvidence = {
      packageName: "auggy",
      version: "0.5.0",
      sha256: "c".repeat(64),
      manifest: { name: "auggy", version: "0.5.0" },
      fileHashes: Object.fromEntries(
        [
          "package.json",
          "src/cli/index.ts",
          "src/kernel/turn-loop.ts",
          "src/agent.ts",
          "src/transports/web-transport.ts",
        ].map((file) => [file, "a".repeat(64)]),
      ),
    };
    const provider: PackedArtifactEvidence = {
      packageName: "@auggy/anthropic",
      version: "0.5.0",
      sha256: "d".repeat(64),
      manifest: { name: "@auggy/anthropic", version: "0.5.0" },
      fileHashes: { "src/index.ts": "b".repeat(64) },
    };
    const record = {
      status: "passed",
      cleanupUnknown: false,
      retainedWorkspace: null,
      source: {
        commit: ACCEPTED_MAIN.commit,
        tree: ACCEPTED_MAIN.tree,
        lockSHA256: ACCEPTED_MAIN.lockSHA256,
      },
      core: { ...core, sourceFiles: core.fileHashes },
      provider: { ...provider, sourceFiles: provider.fileHashes },
    };
    expect(() => verifyLegacyBuildEvidence(core, provider, record)).not.toThrow();
    expect(() =>
      verifyLegacyBuildEvidence(core, provider, {
        ...record,
        source: { ...record.source, commit: "29147" },
      }),
    ).toThrow("accepted main209");
    expect(() =>
      verifyLegacyBuildEvidence(core, provider, { ...record, status: "failed" }),
    ).toThrow("incomplete");
    expect(() =>
      verifyLegacyBuildEvidence(core, provider, {
        ...record,
        core: { ...record.core, sha256: "e".repeat(64) },
      }),
    ).toThrow("identity mismatch");
    expect(() =>
      verifyLegacyBuildEvidence(
        { ...core, fileHashes: { ...core.fileHashes, "src/agent.ts": "f".repeat(64) } },
        provider,
        record,
      ),
    ).toThrow("bytes differ");
    expect(() =>
      verifyLegacyBuildEvidence(
        { ...core, fileHashes: { "package.json": "a".repeat(64) } },
        provider,
        record,
      ),
    ).toThrow("critical source");
  });
  test("restores original bytes after a failed assertion only after the owned child cleanup", async () => {
    const file = join(fixture(), "entry.ts");
    writeFileSync(file, "original");
    const events: string[] = [];
    await expect(
      withCompatibilityFile(
        file,
        "fixture",
        async () => {
          events.push("action");
          throw new Error("rejected launch assertion");
        },
        async () => {
          expect(readFileSync(file, "utf8")).toBe("fixture");
          events.push("child joined");
        },
      ),
    ).rejects.toThrow("rejected launch assertion");
    expect(events).toEqual(["action", "child joined"]);
    expect(readFileSync(file, "utf8")).toBe("original");
  });

  test("retains the current fixture when process cleanup cannot be proved", async () => {
    const file = join(fixture(), "entry.ts");
    writeFileSync(file, "original");
    await expect(
      withCompatibilityFile(
        file,
        "active fixture",
        async () => 7,
        async () => {
          throw new Error("child still alive");
        },
      ),
    ).rejects.toThrow("child still alive");
    expect(readFileSync(file, "utf8")).toBe("active fixture");
  });

  test("removes newly created fixture files and preserves a zero-byte original", async () => {
    const file = join(fixture(), "probe.ts");
    await withCompatibilityFile(file, "probe", async () =>
      expect(readFileSync(file, "utf8")).toBe("probe"),
    );
    expect(() => readFileSync(file)).toThrow("ENOENT");
    writeFileSync(file, "", { flag: "wx" });
    await withCompatibilityFile(file, "probe", async () => {});
    expect(readFileSync(file).length).toBe(0);
  });

  test("accepts only an ordinary nonzero installed CLI rejection with its diagnostic", async () => {
    const directory = fixture();
    const run = (code: string) =>
      startApplicationChild({
        command: [process.execPath, "-e", code],
        cwd: directory,
        env: applicationEnvironment(join(directory, "home"), join(directory, "tmp")),
        secrets: [],
      }).finish();
    const rejected = await run('console.error("install Auggy explicitly");process.exit(1)');
    expect(() =>
      assertRejectedCompatibilityProcess(rejected, "install Auggy explicitly"),
    ).not.toThrow();
    expect(() => assertRejectedCompatibilityProcess(rejected, "unsupported contract")).toThrow(
      "diagnostic",
    );
    const successful = await run('console.error("install Auggy explicitly")');
    expect(() =>
      assertRejectedCompatibilityProcess(successful, "install Auggy explicitly"),
    ).toThrow("nonzero CLI exit");
    expect(() =>
      assertRejectedCompatibilityProcess(
        { ...rejected, orphanedGroup: true },
        "install Auggy explicitly",
      ),
    ).toThrow("nonzero CLI exit");
    expect(() =>
      assertRejectedCompatibilityProcess(
        { ...rejected, cleanupConfirmed: false },
        "install Auggy explicitly",
      ),
    ).toThrow("nonzero CLI exit");
  });

  test.skipIf(process.platform === "win32")(
    "rejects an exited leader whose escaped descendant retains inherited pipes",
    async () => {
      const root = fixture();
      const pidFile = join(root, "escaped-child.pid");
      try {
        const result = await startApplicationChild({
          command: [process.execPath, processFixture, "escaped-descendant", pidFile, "1"],
          cwd: root,
          env: applicationEnvironment(join(root, "home"), join(root, "tmp")),
          secrets: [],
          timeoutMs: 100,
        }).finish();
        expect(result.exitCode).toBe(1);
        expect(result.orphanedGroup).toBe(false);
        expect(result.cleanupConfirmed).toBe(false);
        expect(() =>
          assertRejectedCompatibilityProcess(result, "install Auggy explicitly"),
        ).toThrow("nonzero CLI exit");
      } finally {
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

  test("does not count a command timeout as a passing fail-closed rejection", async () => {
    const directory = fixture();
    const result = await startApplicationChild({
      command: [
        process.execPath,
        "-e",
        'console.error("install Auggy explicitly");setInterval(()=>{},1000)',
      ],
      cwd: directory,
      env: applicationEnvironment(join(directory, "home"), join(directory, "tmp")),
      secrets: [],
      timeoutMs: 100,
    }).finish();
    expect(result.timedOut).toBe(true);
    expect(() => assertRejectedCompatibilityProcess(result, "install Auggy explicitly")).toThrow(
      "nonzero CLI exit",
    );
  });
});
