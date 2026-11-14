import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { parse } from "yaml";
import { runCreate, runInit, type CreateOptions } from "../../src/cli/commands/create";
import { AuthoringError } from "../../src/cli/authoring/document-io";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { planApplicationScaffold } from "../../src/cli/scaffold-application";
import { AUGGY_RUNTIME_PACKAGE_MARKER } from "../../src/cli/runtime-package-marker";
import { getAuggyVersion } from "../../src/cli/scaffold-package-json";
import { listStaticModels } from "../../src/cli/model-registry";
import { createStubBunInstallSpawn } from "../fixtures/bun-install-stub";

let directory: string;
let logs: string[];
let originalLog: typeof console.log;
const automatic: CreateOptions = {
  yes: true,
  provider: "anthropic",
  model: "claude-sonnet-4-6",
  skipInstall: true,
};
beforeEach(() => {
  directory = realpathSync(mkdtempSync(join(tmpdir(), "create-authoring-")));
  logs = [];
  originalLog = console.log;
  console.log = (...values) => {
    logs.push(values.map(String).join(" "));
  };
});
afterEach(() => {
  console.log = originalLog;
  rmSync(directory, { recursive: true, force: true });
});

function inventory(root: string, prefix = ""): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(join(root, prefix), { withFileTypes: true })) {
    const path = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...inventory(root, path));
    else files.push(path);
  }
  return files.sort();
}

describe("automated creation", () => {
  for (const [provider, model] of [
    ["anthropic", "claude-sonnet-4-6"],
    ["openai", "gpt-5.4-mini"],
    ["openrouter", "anthropic/claude-sonnet-4-6"],
    ["ollama", "llama3.2"],
  ] as const) {
    test(`${provider} uses explicit choices without prompts or live discovery`, async () => {
      await runCreate("demo", {
        ...automatic,
        cwd: directory,
        provider,
        model,
        modelRegistry: async (options) => {
          expect(options?.refresh).not.toBe(true);
          expect(options?.env).toBeUndefined();
          expect(options?.writeCache).not.toBe(true);
          return { models: listStaticModels(provider), warnings: [] };
        },
      });
      const project = join(directory, "demo");
      const config = parse(readFileSync(join(project, "agent.yaml"), "utf8"));
      expect(config.engine).toMatchObject({ provider, model });
      expect(config.application).toEqual({ entrypoint: "./src/index.ts", contractVersion: 1 });
      expect(config.augments.map((entry: { type: string }) => entry.type)).toEqual([
        "fileMemory",
        "filesystem",
        "webTransport",
        "webFetch",
        "turnControl",
      ]);
      const filesystem = config.augments.find(
        (entry: { type: string }) => entry.type === "filesystem",
      );
      expect(
        filesystem.options.mounts.filter((mount: { path: string }) => mount.path === "./skills"),
      ).toHaveLength(1);
      expect(existsSync(join(project, "bun.lock"))).toBe(false);
      expect(existsSync(join(project, "augments"))).toBe(false);
      expect(logs.join("\n")).toContain("dependencies not verified");
      expect(logs.join("\n")).not.toContain("application runtime verified");
      expect(statSync(join(project, ".env")).mode & 0o777).toBe(0o600);
      expect(statSync(join(project, ".auggy/models.lock.json")).mode & 0o777).toBe(0o600);
      for (const file of planApplicationScaffold({ configFileName: "agent.yaml" }).files) {
        expect(readFileSync(join(project, file.relativePath))).toEqual(Buffer.from(file.bytes));
      }
    });
  }

  for (const options of [
    { yes: true },
    { yes: true, provider: "anthropic" },
    { yes: true, model: "model" },
    { yes: true, provider: "constructor", model: "model" },
    { ...automatic, refreshModels: true },
    { ...automatic, model: "model\nspoof" },
  ]) {
    test(`invalid automation rejects before mutation ${JSON.stringify(options)}`, async () => {
      await expect(runCreate("invalid", { ...options, cwd: directory })).rejects.toThrow();
      expect(readdirSync(directory)).toEqual([]);
    });
  }

  test("unpriced automation requires its own acknowledgement and keeps runtime budgets intact", async () => {
    await expect(
      runCreate("unknown", { ...automatic, cwd: directory, model: "unknown-model" }),
    ).rejects.toThrow("--allow-unpriced-model");
    expect(readdirSync(directory)).toEqual([]);
    await runCreate("unknown", {
      ...automatic,
      cwd: directory,
      model: "unknown-model",
      allowUnpricedModel: true,
    });
    const config = parse(readFileSync(join(directory, "unknown/agent.yaml"), "utf8"));
    expect(config.engine.model).toBe("unknown-model");
    expect(config.engine.costOverride).toBeUndefined();
    expect(config.settings.maxInferenceLoops).toBe(10);
    expect(logs.join("\n")).toContain("cannot enforce");
    expect(logs.join("\n")).not.toContain("Confirm at the next prompt");
  });

  test("saved known pricing is accepted without requesting refresh or writing cache", async () => {
    await runCreate("cached", {
      ...automatic,
      cwd: directory,
      model: "cached-model",
      useModelCache: true,
      modelRegistry: async (options) => {
        expect(options).toMatchObject({ provider: "anthropic", useCache: true });
        expect(options?.refresh).toBeUndefined();
        expect(options?.writeCache).toBeUndefined();
        return {
          warnings: [],
          models: [
            {
              provider: "anthropic",
              id: "cached-model",
              source: "provider",
              status: "cached",
              pricing: { inputUsdPerMtok: 1, outputUsdPerMtok: 2 },
            },
          ],
        };
      },
    });
    expect(existsSync(join(directory, "cached/agent.yaml"))).toBe(true);
  });
});

describe("collision-safe initialization", () => {
  test("an occupied package FIFO is rejected before package discovery can open it", () => {
    const fifo = join(directory, "package.json");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const result = Bun.spawnSync(
      [
        process.execPath,
        "--no-env-file",
        "--eval",
        `const { runInit } = await import(process.env.M4_CREATE_MODULE);
       console.log = () => {};
       try {
         await runInit({ cwd: process.env.M4_CREATE_PROJECT, name: "fixture", yes: true,
           provider: "ollama", model: "fixture", skipInstall: true });
         process.stdout.write(JSON.stringify({ status: "created" }));
       } catch (error) {
         process.stdout.write(JSON.stringify({ status: "rejected", message: error.message }));
       }`,
      ],
      {
        cwd: resolve(import.meta.dir, "../.."),
        env: {
          ...process.env,
          M4_CREATE_MODULE: resolve(import.meta.dir, "../../src/cli/commands/create.ts"),
          M4_CREATE_PROJECT: directory,
        },
        stdout: "pipe",
        stderr: "pipe",
        timeout: 3000,
      },
    );
    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout.toString())).toMatchObject({
      status: "rejected",
      message: expect.stringContaining("Generated-file collisions"),
    });
    expect(readdirSync(directory)).toEqual(["package.json"]);
    expect(lstatSync(fifo).isFIFO()).toBe(true);
  });

  test("every generated destination is preflighted and preserves existing bytes", async () => {
    await runCreate("seed", { ...automatic, cwd: directory });
    const paths = inventory(join(directory, "seed")).filter(
      (path) => !path.startsWith(".auggy/operations/") && path !== ".auggy/authoring.lock",
    );
    expect(paths.length).toBeGreaterThan(20);
    for (const [index, path] of paths.entries()) {
      const target = join(directory, `collision-${index}`);
      mkdirSync(dirname(join(target, path)), { recursive: true });
      writeFileSync(join(target, path), "USER-CONTENT-DO-NOT-RENDER");
      const before = inventory(target);
      await expect(runInit({ ...automatic, cwd: target })).rejects.toThrow(
        "Generated-file collisions",
      );
      expect(inventory(target)).toEqual(before);
      expect(readFileSync(join(target, path), "utf8")).toBe("USER-CONTENT-DO-NOT-RENDER");
    }
    expect(logs.join("\n")).not.toContain("USER-CONTENT-DO-NOT-RENDER");
  });

  test("unrelated existing files and directories remain unchanged", async () => {
    writeFileSync(join(directory, "unrelated.txt"), "keep");
    mkdirSync(join(directory, "src"));
    writeFileSync(join(directory, "src/unrelated.ts"), "export const owned = true;\n");
    await runInit({ ...automatic, name: "existing", cwd: directory });
    expect(readFileSync(join(directory, "unrelated.txt"), "utf8")).toBe("keep");
    expect(readFileSync(join(directory, "src/unrelated.ts"), "utf8")).toBe(
      "export const owned = true;\n",
    );
    expect(existsSync(join(directory, "src/turn.ts"))).toBe(true);
  });

  for (const kind of ["symlink-parent", "file-parent", "case-collision", "dangling-symlink"]) {
    test(`rejects ${kind} before project mutation`, async () => {
      if (kind === "symlink-parent") symlinkSync(tmpdir(), join(directory, "src"));
      if (kind === "file-parent") writeFileSync(join(directory, "src"), "owned");
      if (kind === "case-collision") writeFileSync(join(directory, "README.MD"), "owned");
      if (kind === "dangling-symlink")
        symlinkSync(join(directory, "missing"), join(directory, "README.md"));
      const before = readdirSync(directory);
      await expect(runInit({ ...automatic, name: "existing", cwd: directory })).rejects.toThrow(
        "collisions",
      );
      expect(readdirSync(directory)).toEqual(before);
      expect(existsSync(join(directory, "agent.yaml"))).toBe(false);
      if (kind === "symlink-parent")
        expect(lstatSync(join(directory, "src")).isSymbolicLink()).toBe(true);
    });
  }

  test("fresh creation never replaces a concurrently appearing empty target", async () => {
    await expect(
      runCreate("concurrent", {
        ...automatic,
        cwd: directory,
        modelRegistry: async () => {
          mkdirSync(join(directory, "concurrent"));
          return { warnings: [], models: listStaticModels("anthropic") };
        },
      }),
    ).rejects.toThrow("appeared concurrently");
    expect(readdirSync(join(directory, "concurrent"))).toEqual([]);
  });

  test("YAML activates last and publication failure preserves unrelated files", async () => {
    writeFileSync(join(directory, "owned.txt"), "preserve");
    const published: string[] = [];
    await expect(
      runInit({
        ...automatic,
        name: "existing",
        cwd: directory,
        publicationFault: ({ boundary, path }) => {
          if (boundary === "after-file") published.push(path!);
          if (boundary === "before-file" && path === "agent.yaml") {
            expect(existsSync(join(directory, "src/turn.ts"))).toBe(true);
            expect(existsSync(join(directory, "agent.yaml"))).toBe(false);
            throw new Error("injected activation failure");
          }
        },
      }),
    ).rejects.toThrow("not ready");
    expect(published).toContain("src/turn.ts");
    expect(published).not.toContain("agent.yaml");
    expect(existsSync(join(directory, "agent.yaml"))).toBe(false);
    expect(existsSync(join(directory, ".env"))).toBe(false);
    expect(readFileSync(join(directory, "owned.txt"), "utf8")).toBe("preserve");
  });

  test("create shows controlled publication diagnostics without private locations", async () => {
    const failure = await runCreate("diagnostic", {
      ...automatic,
      cwd: directory,
      publicationFault: ({ boundary }) => {
        if (boundary === "before-ignore")
          throw new AuthoringError("publication-stale", "An input changed before publication.", {
            path: "PRIVATE_PATH_CANARY",
            field: "PRIVATE_FIELD_CANARY",
          });
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("Application publication rolled-back; the project is not ready.");
    expect(message).toContain("[publication-stale] An input changed before publication.");
    expect(message).toMatch(/Preserve private operation [a-f0-9-]{36}/);
    expect(message).toContain("Preview recovery: auggy migrate --project-dir");
    expect(message).toContain("Review that plan before adding --apply.");
    expect(message).not.toContain("PRIVATE_PATH_CANARY");
    expect(message).not.toContain("PRIVATE_FIELD_CANARY");
    expect(existsSync(join(directory, "diagnostic", "agent.yaml"))).toBe(false);
  });

  test("init shows a generic diagnostic without exposing the original publication error", async () => {
    const failure = await runInit({
      ...automatic,
      name: "diagnostic",
      cwd: directory,
      publicationFault: ({ boundary }) => {
        if (boundary === "before-ignore")
          throw new Error("PRIVATE_NATIVE_ERROR_CANARY https://user:secret@example.test");
      },
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = (failure as Error).message;
    expect(message).toContain("[publication-failed] Authoring publication failed.");
    expect(message).not.toContain("PRIVATE_NATIVE_ERROR_CANARY");
    expect(message).not.toContain("user:secret");
    expect(existsSync(join(directory, "agent.yaml"))).toBe(false);
  });

  for (const message of [
    "Unsafe\nPRIVATE_OUTPUT_CANARY",
    "https://user:PRIVATE_OUTPUT_CANARY@example.test",
    "x".repeat(AUTHORING_LIMITS.pathBytes + 1),
  ]) {
    test("publication diagnostic text remains bounded and safe for terminal output", async () => {
      const failure = await runCreate("diagnostic", {
        ...automatic,
        cwd: directory,
        publicationFault: ({ boundary }) => {
          if (boundary === "before-ignore")
            throw new AuthoringError("publication-stale\n", message);
        },
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(Error);
      const output = (failure as Error).message;
      expect(output).toContain(
        "[publication-failed] Review the private operation locally before recovery.",
      );
      expect(output).not.toContain("publication-stale");
      expect(output).not.toContain("PRIVATE_OUTPUT_CANARY");
      expect(Buffer.byteLength(output)).toBeLessThan(AUTHORING_LIMITS.pathBytes);
    });
  }
});

function installedRuntime(
  project: string,
  mode: "compatible" | "legacy" | "missing-export" | "redirected-export",
) {
  const runtime = join(project, "node_modules/auggy");
  mkdirSync(join(runtime, "src/cli"), { recursive: true });
  writeFileSync(join(runtime, "src/cli/runtime-package-marker.ts"), AUGGY_RUNTIME_PACKAGE_MARKER);
  writeFileSync(join(runtime, "cli.ts"), "export {};\n");
  writeFileSync(join(runtime, "application.ts"), "export {};\n");
  writeFileSync(join(runtime, "other.ts"), "export {};\n");
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify({
      name: "auggy",
      version: getAuggyVersion(),
      engines: { bun: ">=1.3.14" },
      bin: { auggy: "cli.ts" },
      ...(mode === "legacy"
        ? {}
        : { auggyRuntime: { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] } }),
      exports: mode === "missing-export" ? {} : { "./application": "./application.ts" },
    }),
  );
  if (mode === "redirected-export") {
    writeFileSync(
      join(project, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { paths: { "auggy/application": ["./node_modules/auggy/other.ts"] } },
      }),
    );
  }
}

describe("installation readiness", () => {
  test("failure to start the installer still leaves a retryable non-ready project", async () => {
    await expect(
      runCreate("spawn-failed", {
        ...automatic,
        skipInstall: false,
        cwd: directory,
        bunInstallSpawn: () => {
          throw new Error("spawn failed");
        },
      }),
    ).rejects.toThrow("dependencies are not ready");
    expect(existsSync(join(directory, "spawn-failed/agent.yaml"))).toBe(true);
    expect(logs.join("\n")).toContain("Retry:");
  });

  test("failed installation preserves generated sources and returns a non-ready result", async () => {
    await expect(
      runCreate("failed", {
        ...automatic,
        skipInstall: false,
        cwd: directory,
        bunInstallSpawn: createStubBunInstallSpawn({ exitCode: 1 }),
      }),
    ).rejects.toThrow("dependencies are not ready");
    expect(existsSync(join(directory, "failed/agent.yaml"))).toBe(true);
    expect(existsSync(join(directory, "failed/src/turn.ts"))).toBe(true);
    expect(logs.join("\n")).toContain("not ready");
    expect(logs.join("\n")).toContain("Retry:");
    expect(logs.join("\n")).not.toContain("application runtime verified");
  });

  for (const mode of ["compatible", "legacy", "missing-export", "redirected-export"] as const) {
    test(`actual runtime postcheck handles ${mode} installation`, async () => {
      const operation = runCreate("installed", {
        ...automatic,
        skipInstall: false,
        cwd: directory,
        bunInstallSpawn: (command, options) => {
          installedRuntime(options.cwd, mode);
          return createStubBunInstallSpawn()(command, options);
        },
      });
      if (mode === "compatible") {
        await operation;
        expect(logs.join("\n")).toContain("application runtime verified");
      } else {
        await expect(operation).rejects.toThrow("dependencies are not ready");
        expect(logs.join("\n")).not.toContain("application runtime verified");
        expect(logs.join("\n")).toContain("application contract 1");
      }
      expect(existsSync(join(directory, "installed/src/index.ts"))).toBe(true);
    });
  }
});
