import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, rmSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { MigrationReport } from "../../src/cli/authoring/migration";
import { applyMigration, planMigration } from "../../src/cli/authoring/migration";
import { readAuthoringDocument } from "../../src/cli/authoring/document";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { installRuntime, migrationFixture, put, treeSnapshot } from "./migration-fixtures";

const repository = resolve(import.meta.dir, "../..");
let fixture: ReturnType<typeof migrationFixture>;
let executable: string;
let marker: string;
let requests: number;
let server: ReturnType<typeof Bun.serve>;

beforeEach(() => {
  fixture = migrationFixture();
  const { runtime } = installRuntime(fixture.project);
  const installation = join(fixture.root, "invoking-installation");
  executable = join(installation, "src/cli/index.ts");
  marker = join(fixture.root, "executed-marker");
  requests = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      requests++;
      return new Response("unexpected");
    },
  });
  const trap =
    'await Bun.write(process.env.M4_MIGRATION_TRAP_PATH!, "executed"); await fetch(process.env.M4_MIGRATION_TRAP_URL!); throw new Error("MIGRATION_EXECUTION_TRAP");';
  for (const file of [
    "index.ts",
    "authoring-bootstrap.ts",
    "authoring-command-options.ts",
    "authoring-command-handlers.ts",
    "agent-name.ts",
    "builtin-types.ts",
    "project-runtime.ts",
    "scaffold-application.ts",
    "commands/migrate.ts",
  ]) {
    const target = join(installation, "src/cli", file);
    put(target, "");
    cpSync(join(repository, "src/cli", file), target);
  }
  cpSync(join(repository, "src/cli/authoring"), join(installation, "src/cli/authoring"), {
    recursive: true,
  });
  cpSync(
    join(repository, "src/scaffold-templates/application"),
    join(installation, "src/scaffold-templates/application"),
    { recursive: true },
  );
  put(join(installation, "package.json"), '{"name":"auggy","version":"0.5.0","type":"module"}');
  symlinkSync(join(repository, "node_modules"), join(installation, "node_modules"));
  for (const file of [
    "src/cli/cli-program.ts",
    "src/cli/command-bootstrap.ts",
    "src/cli/config-parser.ts",
    "src/cli/augment-resolver.ts",
    "src/cli/env-parse.ts",
    "src/cli/authoring/publication.ts",
    "src/cli/authoring/publication-recovery.ts",
    "src/cli/authoring/publication-lease.ts",
    "src/lib/posix-at.ts",
    "src/index.ts",
  ])
    put(join(installation, file), trap);
  for (const file of ["src/cli/index.ts", "src/application/index.ts"])
    put(join(runtime, file), trap);
  put(join(fixture.project, "augments/orders/index.ts"), trap);
  put(join(fixture.project, "node_modules/@auggy/anthropic/index.ts"), trap);
  put(
    join(fixture.project, "node_modules/@auggy/anthropic/package.json"),
    '{"name":"@auggy/anthropic","type":"module","main":"index.ts"}',
  );
});
afterEach(() => {
  server?.stop(true);
  if (fixture) rmSync(fixture.root, { recursive: true, force: true });
});

async function invoke(
  args: readonly string[] = [],
  options: { noEnvFile?: boolean; cwd?: string } = {},
) {
  const child = Bun.spawn(
    [
      process.execPath,
      ...(options.noEnvFile === false ? [] : ["--no-env-file"]),
      executable,
      "migrate",
      ...args,
      "--json",
    ],
    {
      cwd: options.cwd ?? fixture.project,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        M4_MIGRATION_TRAP_PATH: marker,
        M4_MIGRATION_TRAP_URL: server.url.href,
      },
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  try {
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    expect(timedOut).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(requests).toBe(0);
    return {
      code,
      stdout,
      stderr,
      report: stdout.trim().startsWith("{") ? (JSON.parse(stdout) as MigrationReport) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

describe("actual migration binary passivity", () => {
  test.each([false, true])(
    "preview application=%s reads declarations and metadata only with no project writes",
    async (application) => {
      const before = treeSnapshot(fixture.project);
      const result = await invoke(application ? ["--application"] : []);
      expect(result.code).toBe(0);
      expect(result.stderr).toBe("");
      expect(result.stdout.trim().split("\n")).toHaveLength(1);
      expect(result.report?.schemaVersion).toBe(1);
      expect(result.report?.mode).toBe(application ? "application" : "config");
      expect(result.report?.status).toBe("planned");
      expect(result.report?.declarations[1]?.environmentNames).toEqual(["MIGRATION_FIXTURE_TOKEN"]);
      expect(result.stdout).not.toContain("private-fixture-canary");
      expect(treeSnapshot(fixture.project)).toEqual(before);
      expect(existsSync(join(fixture.project, ".auggy"))).toBe(false);
    },
  );

  test("--no-env-file migration preview does not open an env FIFO", async () => {
    rmSync(join(fixture.project, ".env"));
    expect(Bun.spawnSync(["mkfifo", join(fixture.project, ".env")]).exitCode).toBe(0);
    const before = treeSnapshot(fixture.project);
    expect((await invoke(["--application"])).code).toBe(0);
    expect(treeSnapshot(fixture.project)).toEqual(before);
  });

  test("normal Bun auto-dotenv neither changes plan meaning nor leaks loaded values", async () => {
    put(
      join(fixture.project, ".env"),
      'MIGRATION_FIXTURE_TOKEN=loaded-secret-canary\nBROKEN="unterminated-secret-canary\n',
    );
    const before = treeSnapshot(fixture.project);
    const result = await invoke([], { noEnvFile: false });
    expect(result.code).toBe(0);
    expect(`${result.stdout}${result.stderr}`).not.toContain("loaded-secret-canary");
    expect(`${result.stdout}${result.stderr}`).not.toContain("unterminated-secret-canary");
    expect(treeSnapshot(fixture.project)).toEqual(before);
  });

  test("rollback preview reads receipt data without importing the writer or parsing changed config", async () => {
    const applied = await applyMigration(planMigration(readAuthoringDocument(fixture.config)));
    const before = treeSnapshot(fixture.project);
    const preview = await invoke([
      "--project-dir",
      fixture.project,
      "--rollback",
      applied.operationId!,
    ]);
    expect(preview.code).toBe(0);
    expect(preview.report?.mode).toBe("rollback");
    expect(preview.report?.status).toBe("planned");
    expect(treeSnapshot(fixture.project)).toEqual(before);
    put(fixture.config, "malformed: [private-config-canary\n");
    const changed = treeSnapshot(fixture.project);
    const conflict = await invoke(["--config", fixture.config, "--rollback", applied.operationId!]);
    expect(conflict.code).toBe(1);
    expect(conflict.report?.status).toBe("invalid");
    expect(conflict.report?.diagnostics.some((item) => item.code.startsWith("rollback-"))).toBe(
      true,
    );
    expect(conflict.stdout).not.toContain("private-config-canary");
    expect(treeSnapshot(fixture.project)).toEqual(changed);
  });

  test("no-op --apply never loads the writer or creates a receipt", async () => {
    put(fixture.config, "name: sample\naugments: []\n");
    const before = treeSnapshot(fixture.project);
    const result = await invoke(["--apply"]);
    expect(result.code).toBe(0);
    expect(result.report?.status).toBe("noop");
    expect(treeSnapshot(fixture.project)).toEqual(before);
  });

  test.each([
    "malformed-config",
    "oversized-config",
    "config-fifo",
    "metadata-fifo",
    "package-fifo",
    "runtime-fifo",
    "metadata-env-source",
  ])("rejects %s boundedly and leaves all bytes unchanged", async (mode) => {
    let application = false;
    if (mode === "malformed-config")
      put(fixture.config, "secret: private-error-canary\naugments: [\n");
    if (mode === "oversized-config")
      put(fixture.config, `name: sample\n#${"x".repeat(AUTHORING_LIMITS.documentBytes)}`);
    if (mode === "metadata-env-source")
      put(
        join(fixture.project, "augments/orders/augment.yaml"),
        "type: custom\nsource: ${CUSTOM_SOURCE}\n",
      );
    const fifo =
      mode === "config-fifo"
        ? fixture.config
        : mode === "metadata-fifo"
          ? join(fixture.project, "augments/orders/augment.yaml")
          : mode === "package-fifo"
            ? join(fixture.project, "package.json")
            : mode === "runtime-fifo"
              ? join(fixture.project, "node_modules/auggy/package.json")
              : null;
    if (fifo) {
      rmSync(fifo);
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
      application = mode === "package-fifo" || mode === "runtime-fifo";
    }
    const before = treeSnapshot(fixture.project);
    const result = await invoke(application ? ["--application"] : []);
    expect(result.code).toBe(1);
    expect(result.report?.status).toBe("invalid");
    expect(result.stdout).not.toContain("private-error-canary");
    expect(treeSnapshot(fixture.project)).toEqual(before);
  });

  test("actual grammar error emits one complete schema and help stays passive", async () => {
    const result = await invoke(["--bogus"]);
    expect(result.code).toBe(1);
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.report?.schemaVersion).toBe(1);
    expect(result.report?.status).toBe("invalid");
    expect(result.report?.mode).toBe("config");
    expect(result.report?.project).toEqual({ directory: null, configPath: null, format: null });
    expect(result.report?.changes).toEqual([]);
    expect(result.report?.diagnostics[0]?.code).toBe("invalid-cli-syntax");
    const help = await invoke(["--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--project-dir");
  });

  for (const args of [
    ["--project-dir", "project"],
    ["--application", "--rollback", "00000000-0000-4000-8000-000000000004"],
    ["sample", "--project-dir", "project", "--rollback", "00000000-0000-4000-8000-000000000004"],
  ])
    test(`invalid selector combination fails before configuration reads: ${args[0]}`, async () => {
      rmSync(fixture.config);
      expect(Bun.spawnSync(["mkfifo", fixture.config]).exitCode).toBe(0);
      const before = treeSnapshot(fixture.project);
      const result = await invoke(args);
      expect(result.code).not.toBe(0);
      expect(result.report?.status).toBe("invalid");
      expect(result.report?.diagnostics[0]?.code).toBe("invalid-cli-syntax");
      expect(treeSnapshot(fixture.project)).toEqual(before);
    });

  test("explicit selection and named child use the same passive path", async () => {
    const explicit = await invoke(["ignored", "--config", fixture.config], { cwd: fixture.root });
    expect(explicit.code).toBe(0);
    expect(explicit.report?.project.configPath).toBe(fixture.config);
    const named = await invoke(["project"], { cwd: fixture.root });
    expect(named.code).toBe(0);
    expect(named.report?.project.configPath).toBe(fixture.config);
    const mismatch = await invoke(["different"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.report?.diagnostics[0]?.code).toBe("agent-name-mismatch");
  });
});
