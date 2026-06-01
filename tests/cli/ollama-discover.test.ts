import { describe, it, expect } from "bun:test";
import { EventEmitter } from "node:events";
import {
  parseOllamaList,
  partitionByRecommended,
  listInstalledOllamaModels,
  RECOMMENDED_OLLAMA_FAMILIES,
  RECOMMENDED_FIRST_PULL,
  type SpawnFactory,
} from "../../src/cli/ollama-discover";

// ---------------------------------------------------------------------------
// parseOllamaList
// ---------------------------------------------------------------------------

describe("parseOllamaList", () => {
  it("parses the canonical multi-row output", () => {
    const raw = [
      "NAME              ID            SIZE      MODIFIED",
      "qwen3:8b          abc123        4.7 GB    2 days ago",
      "gemma4:latest     def456        7.5 GB    3 weeks ago",
      "llama3.2:3b       789xyz        2.0 GB    1 month ago",
      "",
    ].join("\n");
    expect(parseOllamaList(raw)).toEqual(["qwen3:8b", "gemma4:latest", "llama3.2:3b"]);
  });

  it("returns [] for empty input", () => {
    expect(parseOllamaList("")).toEqual([]);
    expect(parseOllamaList("   \n\n  ")).toEqual([]);
  });

  it("skips the header row regardless of case", () => {
    expect(parseOllamaList("NAME ID SIZE\nqwen3:8b abc 4.7GB")).toEqual(["qwen3:8b"]);
    expect(parseOllamaList("name id size\nqwen3:8b abc 4.7GB")).toEqual(["qwen3:8b"]);
  });

  it("deduplicates repeated model IDs", () => {
    const raw = "NAME ID SIZE\nqwen3:8b a 1G\nqwen3:8b b 1G\ngemma4 c 7G";
    expect(parseOllamaList(raw)).toEqual(["qwen3:8b", "gemma4"]);
  });

  it("rejects model names with unsafe characters", () => {
    // Terminal control chars, shell metacharacters — drop silently.
    const raw = "NAME ID SIZE\nqwen3:8b ok 4G\nevil;rm -rf bad 1G\nbad\x1b[31m bad 1G\n";
    expect(parseOllamaList(raw)).toEqual(["qwen3:8b"]);
  });

  it("accepts the full allowed character set", () => {
    const raw = "NAME ID SIZE\nqwen3.5:9b-instruct abc 5G\nmy-model_v2:latest def 3G";
    expect(parseOllamaList(raw)).toEqual(["qwen3.5:9b-instruct", "my-model_v2:latest"]);
  });

  it("handles output with no header row", () => {
    // Some ollama versions / configurations skip the header.
    const raw = "qwen3:8b abc 4.7 GB 2 days ago\n";
    expect(parseOllamaList(raw)).toEqual(["qwen3:8b"]);
  });
});

// ---------------------------------------------------------------------------
// partitionByRecommended
// ---------------------------------------------------------------------------

describe("partitionByRecommended", () => {
  it("splits installed models into recommended-for-tool-calling and other", () => {
    const installed = [
      "qwen3.6:27b",
      "qwen3.5:9b",
      "qwen3:8b",
      "gemma4:31b",
      "glm-5.1",
      "deepseek-v3.2",
      "llama3.2:3b",
      "mistral:7b",
    ];
    const { recommended, other } = partitionByRecommended(installed);
    expect(recommended).toEqual([
      "qwen3.6:27b",
      "qwen3.5:9b",
      "qwen3:8b",
      "gemma4:31b",
      "glm-5.1",
      "deepseek-v3.2",
    ]);
    expect(other).toEqual(["llama3.2:3b", "mistral:7b"]);
  });

  it("returns empty arrays for empty input", () => {
    expect(partitionByRecommended([])).toEqual({ recommended: [], other: [] });
  });

  it("treats unsized model IDs (no colon) the same as tagged ones", () => {
    const { recommended, other } = partitionByRecommended([
      "qwen3.6",
      "qwen3",
      "gemma4",
      "llama3.2",
    ]);
    expect(recommended).toEqual(["qwen3.6", "qwen3", "gemma4"]);
    expect(other).toEqual(["llama3.2"]);
  });

  it("matches family by prefix, not by exact match", () => {
    // A future "qwen3:8b-instruct-fp16" tag should still partition as
    // recommended — family is "qwen3", which is in the shortlist.
    const { recommended } = partitionByRecommended(["qwen3:8b-instruct-fp16", "qwen3.5:9b"]);
    expect(recommended).toEqual(["qwen3:8b-instruct-fp16", "qwen3.5:9b"]);
  });
});

// ---------------------------------------------------------------------------
// listInstalledOllamaModels (spawn-injected)
// ---------------------------------------------------------------------------

/**
 * Build a fake child process that resolves with a given stdout + exit code.
 */
function fakeChild(opts: { stdout?: string; stderr?: string; exitCode: number }) {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const child = new EventEmitter() as EventEmitter & {
    stdout: typeof stdout;
    stderr: typeof stderr;
    kill?: (sig?: string) => void;
  };
  child.stdout = stdout;
  child.stderr = stderr;
  child.kill = () => {};

  // Emit data + close on the next tick so the listeners are attached first.
  queueMicrotask(() => {
    if (opts.stdout) stdout.emit("data", Buffer.from(opts.stdout, "utf8"));
    if (opts.stderr) stderr.emit("data", Buffer.from(opts.stderr, "utf8"));
    child.emit("close", opts.exitCode);
  });

  return child;
}

describe("listInstalledOllamaModels", () => {
  it("returns parsed model IDs on success", async () => {
    const spawnFactory: SpawnFactory = () =>
      fakeChild({
        stdout: "NAME ID SIZE\nqwen3:8b abc 4G\ngemma4 def 7G\n",
        exitCode: 0,
      }) as never;
    const result = await listInstalledOllamaModels({ spawnFactory });
    expect(result).toEqual(["qwen3:8b", "gemma4"]);
  });

  it("returns [] when the command exits non-zero", async () => {
    const spawnFactory: SpawnFactory = () =>
      fakeChild({ stderr: "ollama: daemon not running", exitCode: 1 }) as never;
    const result = await listInstalledOllamaModels({ spawnFactory });
    expect(result).toEqual([]);
  });

  it("returns [] when spawn itself throws (binary not on PATH)", async () => {
    const spawnFactory: SpawnFactory = () => {
      throw new Error("ENOENT: ollama not found");
    };
    const result = await listInstalledOllamaModels({ spawnFactory });
    expect(result).toEqual([]);
  });

  it("returns [] on the 'error' event (spawn error after creation)", async () => {
    const spawnFactory: SpawnFactory = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill?: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {};
      queueMicrotask(() => child.emit("error", new Error("spawn failed")));
      return child as never;
    };
    const result = await listInstalledOllamaModels({ spawnFactory });
    expect(result).toEqual([]);
  });

  it("returns [] when the child runs past the timeout", async () => {
    let killed = false;
    const spawnFactory: SpawnFactory = () => {
      const child = new EventEmitter() as EventEmitter & {
        stdout: EventEmitter;
        stderr: EventEmitter;
        kill?: (sig?: string) => void;
      };
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.kill = () => {
        killed = true;
      };
      // Never emit close — simulate a hung daemon.
      return child as never;
    };
    const result = await listInstalledOllamaModels({ spawnFactory, timeoutMs: 20 });
    expect(result).toEqual([]);
    expect(killed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Recommended-list invariants
// ---------------------------------------------------------------------------

describe("recommended shortlist", () => {
  it("never includes llama3.2 (BFCL rank 98 + format-incompatible)", () => {
    expect(RECOMMENDED_OLLAMA_FAMILIES).not.toContain("llama3.2");
  });

  it("first-pull recommendation is on the shortlist (family match)", () => {
    const family = RECOMMENDED_FIRST_PULL.split(":")[0] ?? RECOMMENDED_FIRST_PULL;
    expect(RECOMMENDED_OLLAMA_FAMILIES).toContain(family);
  });
});
