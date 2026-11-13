import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  inspectLaunchSelection,
  parseBootstrapCommand,
  validateDelegationEnvelope,
} from "../../src/cli/command-bootstrap";
import { createLaunchCommand, PROJECT_COMMANDS } from "../../src/cli/launch-command-options";
import { buildCli } from "../../src/cli/index";

const repository = realpathSync(join(import.meta.dir, "../.."));
const capabilities = { schemaVersion: 1, launcherProtocol: 1, applicationContracts: [1] };
let directory: string;
let project: string;
let globalRoot: string;
let localRoot: string;
const roots: string[] = [];

// These fixtures exercise the actual bootstrap source with inert command bodies.
// They are not evidence of an application launch or a packed runtime acceptance.
function runtime(root: string, body: string, metadata = true) {
  mkdirSync(join(root, "src/cli"), { recursive: true });
  mkdirSync(join(root, "node_modules"), { recursive: true });
  for (const dependency of ["commander", "yaml"]) {
    symlinkSync(
      realpathSync(join(repository, "node_modules", dependency)),
      join(root, "node_modules", dependency),
    );
  }
  for (const file of [
    "index.ts",
    "command-bootstrap.ts",
    "launch-command-options.ts",
    "agent-name.ts",
    "resolve-config.ts",
    "project-runtime.ts",
    "application-definition.ts",
  ]) {
    copyFileSync(join(repository, "src/cli", file), join(root, "src/cli", file));
  }
  writeFileSync(join(root, "src/cli/cli-program.ts"), body);
  writeFileSync(
    join(root, "application.ts"),
    "throw new Error('application must remain unimported during bootstrap');",
  );
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify({
      name: "auggy",
      version: "0.5.0",
      type: "module",
      engines: { bun: ">=1.3.14" },
      bin: { auggy: "src/cli/index.ts" },
      exports: { "./application": "./application.ts" },
      ...(metadata ? { auggyRuntime: capabilities } : {}),
    }),
  );
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "auggy-bootstrap-"));
  roots.push(directory);
  project = join(directory, "project");
  globalRoot = join(directory, "global");
  localRoot = join(project, "node_modules/auggy");
  runtime(globalRoot, "throw new Error('global command graph imported');");
  runtime(
    localRoot,
    `export function buildCli() { return { parseAsync(argv) { console.log(JSON.stringify({ selected: import.meta.url, argv })); } }; }`,
  );
  writeFileSync(join(project, "package.json"), '{"private":true}');
  writeFileSync(join(project, "agent.yaml"), "name: example\n");
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function environment(extra: Record<string, string> = {}) {
  return { HOME: directory, PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: tmpdir(), ...extra };
}
async function execute(
  argv: string[],
  options: { entry?: string; env?: Record<string, string>; cwd?: string } = {},
) {
  const child = Bun.spawn(
    [process.execPath, options.entry ?? join(globalRoot, "src/cli/index.ts"), ...argv],
    {
      cwd: options.cwd ?? project,
      env: environment(options.env),
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    return { code, stdout, stderr };
  } finally {
    clearTimeout(timer);
  }
}

function application(entrypoint = "./main.ts") {
  writeFileSync(
    join(project, "agent.yaml"),
    `name: example\napplication:\n  entrypoint: ${entrypoint}\n  contractVersion: 1\n`,
  );
  writeFileSync(
    join(project, "main.ts"),
    `await Bun.write(${JSON.stringify(join(directory, "app-evaluated"))}, "unexpected");`,
  );
}

describe("runtime-free command bootstrap", () => {
  test("shares full CLI argument, option, default, and help grammar", () => {
    const full = buildCli();
    for (const name of [...PROJECT_COMMANDS, "stop", "status"] as const) {
      const actual = full.commands.find((command) => command.name() === name)!;
      const narrow = createLaunchCommand(name);
      expect(
        narrow.registeredArguments.map((argument) => [argument.name(), argument.required]),
      ).toEqual(actual.registeredArguments.map((argument) => [argument.name(), argument.required]));
      expect(
        narrow.options.map((option) => [option.flags, option.defaultValue, option.description]),
      ).toEqual(
        actual.options.map((option) => [option.flags, option.defaultValue, option.description]),
      );
      expect(narrow.description()).toBe(actual.description());
    }
    expect(parseBootstrapCommand(["run", "--config=./agent.yaml", "--no-open", "example"])).toEqual(
      { command: "run", name: "example", options: { config: "./agent.yaml", open: false } },
    );
    expect(parseBootstrapCommand(["dev", "--open"])).toEqual({
      command: "dev",
      name: undefined,
      options: { open: true },
    });
  });

  test("delegates equal-version distinct artifacts once and preserves canonical config and options", async () => {
    const result = await execute(["run", "example", "--no-open", "--config=./agent.yaml"]);
    expect(result.code).toBe(0);
    const output = JSON.parse(result.stdout);
    expect(output.selected).toContain(`${localRoot}/src/cli/cli-program.ts`);
    expect(output.argv).toEqual([
      "run",
      "example",
      "--no-open",
      "--config",
      realpathSync(join(project, "agent.yaml")),
    ]);
    expect(result.stderr).toBe("");
  });

  test("leading root terminator cannot bypass local selection or change Commander semantics", async () => {
    for (const name of ["run", "dev", "start", "routes"]) {
      const result = await execute(["--", name, "example"]);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).argv).toEqual([
        name,
        "example",
        "--config",
        realpathSync(join(project, "agent.yaml")),
      ]);
      expect(result.stderr).toBe("");
    }
    for (const argv of [
      ["--", "run"],
      ["--", "dev", "example"],
      ["start", "--", "example"],
      ["--", "routes", "example"],
    ]) {
      const full = buildCli().exitOverride();
      let captured: unknown;
      for (const command of full.commands)
        command.exitOverride().action((name, options) => {
          captured = { command: command.name(), name, options };
        });
      full.parse(argv, { from: "user" });
      expect(captured).toEqual(parseBootstrapCommand(argv));
    }
    const terminated = await execute(["run", "--", "example"]);
    expect(terminated.code).toBe(0);
    expect(JSON.parse(terminated.stdout).argv).toEqual([
      "run",
      "--config",
      realpathSync(join(project, "agent.yaml")),
      "--",
      "example",
    ]);
    // Bun itself strips a first script-argument terminator; exercise the
    // raw Commander form directly so the full CLI grammar stays authoritative.
    expect(parseBootstrapCommand(["--", "run", "--no-open", "example"])).toEqual({ exitCode: 1 });
  });

  test("canonical config forwarding preserves required option values that resemble flags", async () => {
    for (const value of ["--config=literal", "--config", "--"]) {
      const argv = ["routes", "--out", value, "--json", "example"];
      const result = await execute(argv);
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).argv).toEqual([
        ...argv,
        "--config",
        realpathSync(join(project, "agent.yaml")),
      ]);
    }
  });

  test("an explicit workspace link and direct local CLI select the same package", async () => {
    const moved = join(directory, "workspace-runtime");
    const { renameSync } = await import("node:fs");
    renameSync(localRoot, moved);
    symlinkSync(moved, localRoot);
    for (const entry of [join(globalRoot, "src/cli/index.ts"), join(moved, "src/cli/index.ts")]) {
      const result = await execute(["dev", "--config", "./agent.yaml", "--open"], { entry });
      expect(result.code).toBe(0);
      expect(JSON.parse(result.stdout).selected).toContain(moved);
    }
  });

  test("rejects missing or ancestor-only dependencies before either command graph", async () => {
    rmSync(localRoot, { recursive: true });
    const result = await execute(["run", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("install Auggy explicitly");
    expect(result.stderr).not.toContain("command graph imported");
  });

  test("rejects invalid application declaration and path before entry evaluation", async () => {
    application("../outside.ts");
    writeFileSync(join(directory, "outside.ts"), "throw new Error('outside imported');");
    const result = await execute(["dev"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("inside the project");
    expect(existsSync(join(directory, "app-evaluated"))).toBe(false);
    expect(result.stderr).not.toContain("command graph imported");
  });

  test("unsupported application metadata rejects before either runtime or application import", async () => {
    application();
    const manifest = JSON.parse(readFileSync(join(localRoot, "package.json"), "utf8"));
    delete manifest.auggyRuntime;
    writeFileSync(join(localRoot, "package.json"), JSON.stringify(manifest));
    const result = await execute(["run", "--no-open"]);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("does not support application contract 1");
    expect(existsSync(join(directory, "app-evaluated"))).toBe(false);
  });

  test("legacy metadata-free local binary receives existing grammar exactly once", async () => {
    const manifest = JSON.parse(readFileSync(join(localRoot, "package.json"), "utf8"));
    delete manifest.auggyRuntime;
    writeFileSync(join(localRoot, "package.json"), JSON.stringify(manifest));
    writeFileSync(
      join(localRoot, "src/cli/index.ts"),
      "console.log(JSON.stringify(process.argv.slice(2))); process.exitCode = 19;",
    );
    const result = await execute(["dev", "example", "--internal-mode", "railway"]);
    expect(result.code).toBe(19);
    expect(JSON.parse(result.stdout)).toEqual([
      "dev",
      "example",
      "--internal-mode",
      "railway",
      "--config",
      realpathSync(join(project, "agent.yaml")),
    ]);
  });

  test("inherited envelope cannot authorize a second hop or a changed selection", async () => {
    const selected = inspectLaunchSelection(join(project, "agent.yaml"));
    const envelope = {
      protocol: 1,
      configPath: selected.configPath,
      packageRoot: selected.runtime.packageRoot,
      cliPath: selected.runtime.cliPath,
      manifestSHA256: selected.runtime.manifestSHA256,
    };
    expect(() =>
      validateDelegationEnvelope(JSON.stringify(envelope), selected, selected.runtime.packageRoot),
    ).not.toThrow();
    for (const invalid of [
      "1",
      "{}",
      JSON.stringify({ ...envelope, manifestSHA256: "changed" }),
      JSON.stringify({ ...envelope, extra: true }),
    ]) {
      expect(() =>
        validateDelegationEnvelope(invalid, selected, selected.runtime.packageRoot),
      ).toThrow();
    }
    const result = await execute(["run", "--no-open"], {
      env: { AUGGY_CLI_DELEGATION: JSON.stringify(envelope) },
    });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("refusing a second hop");
    const direct = await execute(["run", "--no-open"], {
      entry: join(localRoot, "src/cli/index.ts"),
      env: { AUGGY_CLI_DELEGATION: JSON.stringify({ ...envelope, manifestSHA256: "changed" }) },
    });
    expect(direct.code).toBe(1);
    expect(direct.stderr).toContain("selection changed");
  });

  test("forwards termination to the selected child and preserves its exit code", async () => {
    writeFileSync(
      join(localRoot, "src/cli/cli-program.ts"),
      `export function buildCli() { return { async parseAsync() {
      const keepAlive = setInterval(() => {}, 1000);
      process.on("SIGTERM", () => { clearInterval(keepAlive); process.exit(23); });
      console.log("child-ready");
      await new Promise(() => {});
    } }; }`,
    );
    const child = Bun.spawn([process.execPath, join(globalRoot, "src/cli/index.ts"), "dev"], {
      cwd: project,
      env: environment(),
      stdout: "pipe",
      stderr: "pipe",
    });
    const deadline = setTimeout(() => child.kill("SIGKILL"), 5_000);
    const reader = child.stdout.getReader();
    let output = "";
    try {
      while (!output.includes("child-ready")) {
        const chunk = await reader.read();
        if (chunk.done) throw new Error("selected child exited before readiness");
        output += new TextDecoder().decode(chunk.value);
      }
      child.kill("SIGTERM");
      expect(await child.exited).toBe(23);
      expect(await new Response(child.stderr).text()).toBe("");
    } finally {
      clearTimeout(deadline);
      reader.releaseLock();
      child.kill("SIGKILL");
    }
  });

  test("help and syntax errors do not require local dependencies or import handlers", async () => {
    rmSync(localRoot, { recursive: true });
    for (const args of [
      ["run", "--help"],
      ["run", "--config"],
      ["restart"],
      ["dev", "--unknown"],
    ]) {
      const result = await execute(args);
      expect(result.code).toBe(args.includes("--help") ? 0 : 1);
      expect(result.stderr).not.toContain("install Auggy");
      expect(result.stderr).not.toContain("command graph imported");
    }
  });

  test("recovery works from a broken project without loading config or runtime modules", async () => {
    application("./missing.ts");
    rmSync(localRoot, { recursive: true });
    const source = `import { createRequire } from "node:module";
      import { bootstrapCli } from ${JSON.stringify(join(repository, "src/cli/command-bootstrap.ts"))};
      await bootstrapCli(["status"]);
      await bootstrapCli(["stop", "aug1_11111111-1111-4111-8111-111111111111"]);
      const keys = Object.keys(createRequire(import.meta.url).cache);
      if (keys.some(key => /\\/(config-parser|augment-resolver|agent|cli-program)\\.ts$/.test(key))) throw new Error("runtime graph imported for recovery");`;
    const entry = join(directory, "recovery.ts");
    writeFileSync(entry, source);
    const result = await execute([], { entry });
    expect(result.stderr).toBe("");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("No agents running");
    expect(result.stdout).toContain("is not running");
    expect(existsSync(join(directory, "app-evaluated"))).toBe(false);
  });
});
