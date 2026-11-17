import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  cpSync,
  existsSync,
  lstatSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import type { InspectionReport } from "../../src/cli/authoring/contracts";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { fixtureIndex, inspectionFixture, writeFixture } from "./inspect-fixtures";

const repository = resolve(import.meta.dir, "../..");
let fixture: ReturnType<typeof inspectionFixture>;
let executable: string;
let marker: string;
let calls = 0;
let server: ReturnType<typeof Bun.serve>;

function tree(directory: string): string[] {
  return (readdirSync(directory, { recursive: true }) as string[]).sort().map((entry) => {
    const value = lstatSync(join(directory, entry), { bigint: true });
    return `${entry}:${value.mode}:${value.size}:${value.mtimeNs}:${value.ctimeNs}`;
  });
}

beforeEach(() => {
  fixture = inspectionFixture();
  const installation = join(fixture.root, "invoking-installation");
  executable = join(installation, "src/cli/index.ts");
  marker = join(fixture.root, "executed-marker");
  calls = 0;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch() {
      calls++;
      return new Response("unexpected");
    },
  });
  const trap = `await Bun.write(${JSON.stringify(marker)}, "executed"); await fetch(${JSON.stringify(server.url.href)}); throw new Error("EXECUTION_TRAP");`;
  for (const file of [
    "index.ts",
    "export-bootstrap.ts",
    "authoring-bootstrap.ts",
    "authoring-command-options.ts",
    "authoring-command-handlers.ts",
    "agent-name.ts",
    "builtin-types.ts",
    "project-runtime.ts",
    "commands/inspect.ts",
  ]) {
    const target = join(installation, "src/cli", file);
    writeFixture(target, "");
    cpSync(join(repository, "src/cli", file), target);
  }
  cpSync(join(repository, "src/cli/authoring"), join(installation, "src/cli/authoring"), {
    recursive: true,
  });
  writeFixture(
    join(installation, "package.json"),
    '{"name":"auggy","version":"9.8.7","type":"module"}',
  );
  symlinkSync(join(repository, "node_modules"), join(installation, "node_modules"));
  for (const file of [
    "src/cli/cli-program.ts",
    "src/cli/command-bootstrap.ts",
    "src/cli/commands/export.ts",
    "src/cli/augment-resolver.ts",
    "src/cli/config-parser.ts",
    "src/index.ts",
    "src/augments/fileMemory/index.ts",
    "src/engines/openai/index.ts",
    "src/cli/authoring/publication.ts",
    "src/cli/authoring/publication-lease.ts",
    "src/lib/posix-at.ts",
  ])
    writeFixture(join(installation, file), trap);
  for (const file of [
    "src/cli/index.ts",
    "src/application/index.ts",
    ...Object.values(fixtureIndex.runtime),
    ...fixtureIndex.augments.map((entry) => entry.entrypoint),
  ])
    writeFixture(join(fixture.runtime, file), trap);
  for (const file of [
    "src/index.ts",
    "src/agent.ts",
    "src/http.ts",
    "src/turn.ts",
    "src/augments/orders/index.ts",
  ])
    writeFixture(join(fixture.project, file), trap);
  writeFixture(join(fixture.project, "node_modules/@auggy/openai/index.ts"), trap);
  writeFixture(
    join(fixture.project, "node_modules/@auggy/openai/package.json"),
    '{"name":"@auggy/openai","type":"module","main":"index.ts"}',
  );
});
afterEach(() => {
  server?.stop(true);
  rmSync(fixture.root, { recursive: true, force: true });
});

async function invoke(
  args: readonly string[] = ["inspect", "--json"],
  noEnvFile = true,
  cwd = fixture.project,
) {
  const child = Bun.spawn(
    [process.execPath, ...(noEnvFile ? ["--no-env-file"] : []), executable, ...args],
    { cwd, stdout: "pipe", stderr: "pipe" },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, 5_000);
  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    expect(timedOut).toBe(false);
    expect(existsSync(marker)).toBe(false);
    expect(calls).toBe(0);
    return {
      stdout,
      stderr,
      code,
      report: stdout.trim().startsWith("{") ? (JSON.parse(stdout) as InspectionReport) : null,
    };
  } finally {
    clearTimeout(timeout);
  }
}

describe("actual passive binary dispatch", () => {
  test("installed-layout executable bypasses invoking and selected runtime modules", async () => {
    const before = tree(fixture.project);
    const result = await invoke();
    expect(result.code).toBe(0);
    expect(result.stderr).toBe("");
    expect(result.stdout.trim().split("\n")).toHaveLength(1);
    expect(result.report?.status).toBe("complete");
    expect(result.report?.inspector.version).toBe("9.8.7");
    expect(result.report?.runtime.version).toBe("4.5.6");
    expect(result.report?.runtime.packageRoot).toBe(fixture.runtime);
    expect(result.report?.augments[0]?.source.path?.startsWith(fixture.runtime)).toBe(true);
    expect(tree(fixture.project)).toEqual(before);
  });
  test("--no-env-file does not read an application .env FIFO", async () => {
    expect(Bun.spawnSync(["mkfifo", join(fixture.project, ".env")]).exitCode).toBe(0);
    const result = await invoke();
    expect(result.code).toBe(0);
    expect(result.report?.augments[0]?.environmentNames).toEqual(["UNSET_SECRET"]);
  });
  test("normal Bun invocation neither uses nor exposes loaded or malformed env values", async () => {
    writeFixture(
      join(fixture.project, ".env"),
      'UNSET_SECRET=loaded-env-secret-canary\nCUSTOM_SOURCE=./src/augments/orders\nBROKEN="unterminated-env-secret-canary\n',
    );
    writeFixture(
      fixture.config,
      'name: sample\nid: ${AUGGY_AGENT_ID}\naugments: [{ name: dynamic, type: custom, source: "${CUSTOM_SOURCE}/index.ts", options: { token: "${UNSET_SECRET}" } }]\n',
    );
    const before = tree(fixture.project);
    const result = await invoke(["inspect", "--json"], false);
    expect(result.code).toBe(0);
    expect(result.report?.status).toBe("partial");
    expect(result.report?.augments[0]?.source.status).toBe("unresolved");
    expect(`${result.stdout}${result.stderr}`).not.toContain("loaded-env-secret-canary");
    expect(`${result.stdout}${result.stderr}`).not.toContain("unterminated-env-secret-canary");
    expect(tree(fixture.project)).toEqual(before);
  });
  test("missing local runtime stays partial even with the invoking install available", async () => {
    rmSync(fixture.runtime, { recursive: true });
    const result = await invoke();
    expect(result.code).toBe(0);
    expect(result.report?.status).toBe("partial");
    expect(result.report?.runtime.packageRoot).toBeNull();
    expect(result.report?.augments[0]?.source.path).toBeNull();
  });
  test.each([
    "malformed-config",
    "oversized-named-config",
    "config-fifo",
    "package-fifo",
    "runtime-fifo",
    "index-fifo",
    "source-escape",
  ])("binary fails safely for %s", async (mode) => {
    const args = ["inspect", ...(mode === "oversized-named-config" ? ["sample"] : []), "--json"];
    if (mode === "malformed-config")
      writeFileSync(fixture.config, "name: [broken\nsecret: error-secret-canary\n");
    if (mode === "oversized-named-config")
      writeFileSync(fixture.config, `name: sample\n#${"a".repeat(AUTHORING_LIMITS.documentBytes)}`);
    const fifo =
      mode === "config-fifo"
        ? fixture.config
        : mode === "package-fifo"
          ? join(fixture.project, "package.json")
          : mode === "runtime-fifo"
            ? join(fixture.runtime, "package.json")
            : mode === "index-fifo"
              ? fixture.indexPath
              : null;
    if (fifo) {
      rmSync(fifo);
      expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    }
    if (mode === "source-escape")
      writeFileSync(
        fixture.indexPath,
        JSON.stringify({
          ...fixtureIndex,
          augments: [{ type: "fileMemory", entrypoint: "../outside.ts" }],
        }),
      );
    const result = await invoke(args);
    expect(result.code).toBe(1);
    expect(result.report?.status).toBe("invalid");
    expect(result.report?.schemaVersion).toBe(1);
    expect(`${result.stdout}${result.stderr}`).not.toContain("error-secret-canary");
  });
  test.each([
    "missing-index",
    "future-index",
    "corrupt-index",
    "duplicate-index",
    "index-link-escape",
    "unsupported-capability",
    "missing-custom",
  ])("binary classifies %s without evaluation", async (mode) => {
    let invalid = false;
    if (mode === "missing-index") rmSync(fixture.indexPath);
    if (mode === "future-index") writeFileSync(fixture.indexPath, '{"schemaVersion":99}');
    if (mode === "corrupt-index") {
      writeFileSync(fixture.indexPath, '{"secret":"index-secret-canary"');
      invalid = true;
    }
    if (mode === "duplicate-index") {
      writeFileSync(
        fixture.indexPath,
        JSON.stringify({
          ...fixtureIndex,
          augments: [...fixtureIndex.augments, fixtureIndex.augments[0]],
        }),
      );
      invalid = true;
    }
    if (mode === "index-link-escape") {
      const outside = join(fixture.root, "outside-index.json");
      cpSync(fixture.indexPath, outside);
      rmSync(fixture.indexPath);
      symlinkSync(outside, fixture.indexPath);
      invalid = true;
    }
    if (mode === "unsupported-capability")
      writeFileSync(
        join(fixture.runtime, "package.json"),
        JSON.stringify({ ...fixture.manifest, auggyRuntime: undefined }),
      );
    if (mode === "missing-custom") rmSync(join(fixture.project, "src/augments/orders/index.ts"));
    const result = await invoke();
    expect(result.code).toBe(invalid ? 1 : 0);
    expect(result.report?.status).toBe(invalid ? "invalid" : "partial");
    expect(`${result.stdout}${result.stderr}`).not.toContain("index-secret-canary");
  });
  test("legacy mixed declarations keep their source provenance through the binary", async () => {
    writeFixture(fixture.config, "name: sample\naugments: [old, {type: fileMemory}]\n");
    writeFixture(
      join(fixture.project, "augments/old/augment.yaml"),
      'type: custom\nsource: ../../src/augments/orders/index.ts\nconfig: {token: "${UNSET_SECRET}"}\n',
    );
    const result = await invoke();
    expect(result.code).toBe(0);
    expect(result.report?.project.format).toBe("mixed");
    expect(result.report?.application.mode).toBe("legacy");
    expect(result.report?.augments[0]?.source.path).toBe(
      join(fixture.project, "src/augments/orders/index.ts"),
    );
  });
  test("JSON grammar errors are shaped and help stays passive", async () => {
    const invalid = await invoke(["inspect", "--unknown", "--json"]);
    expect(invalid.code).not.toBe(0);
    expect(invalid.report?.status).toBe("invalid");
    expect(invalid.report?.diagnostics[0]?.code).toBe("invalid-cli-syntax");
    const help = await invoke(["inspect", "--help"]);
    expect(help.code).toBe(0);
    expect(help.stdout).toContain("--config");
  });
  test("config selection honors explicit config and child selection in the real binary", async () => {
    const explicit = await invoke(
      ["inspect", "ignored", "--config", fixture.config, "--json"],
      true,
      fixture.root,
    );
    expect(explicit.report?.project.configPath).toBe(fixture.config);
    const child = await invoke(["inspect", "project", "--json"], true, fixture.root);
    expect(child.report?.project.configPath).toBe(fixture.config);
    const mismatch = await invoke(["inspect", "different", "--json"]);
    expect(mismatch.code).toBe(1);
    expect(mismatch.report?.diagnostics[0]?.code).toBe("agent-name-mismatch");
  });
});
