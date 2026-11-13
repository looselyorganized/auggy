import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import { readAuthoringDocument } from "../../src/cli/authoring/document";
import { AuthoringError } from "../../src/cli/authoring/document-io";
import {
  applyMigration,
  createInvalidMigrationReport,
  planMigration,
  renderMigrationReport,
} from "../../src/cli/authoring/migration";
import { parseConfig } from "../../src/cli/config-parser";
import { planApplicationScaffold } from "../../src/cli/scaffold-application";
import {
  fileHashes,
  installRuntime,
  migrationFixture,
  put,
  treeSnapshot,
} from "./migration-fixtures";

const roots: string[] = [];
function fixture() {
  const result = migrationFixture();
  roots.push(result.root);
  return result;
}
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function reportError(fn: () => unknown) {
  try {
    fn();
    throw new Error("Expected a preservation rejection");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringError);
    return createInvalidMigrationReport(error);
  }
}

describe("migration planning and preservation", () => {
  test("mixed legacy corpus converts semantic values and source bases without executing or touching owned files", async () => {
    const { project, config } = fixture();
    const previous = process.env.MIGRATION_FIXTURE_TOKEN;
    process.env.MIGRATION_FIXTURE_TOKEN = "controlled-semantic-value";
    try {
      const beforeSemantic = parseConfig(config);
      const beforeHashes = fileHashes(project);
      const beforeTree = treeSnapshot(project);
      const prepared = planMigration(readAuthoringDocument(config));
      expect(prepared.report.mode).toBe("config");
      expect(prepared.report.status).toBe("planned");
      expect(prepared.report.project.format).toBe("mixed");
      expect(prepared.report.declarations.map((entry) => entry.name)).toEqual([
        "identity",
        "orders",
        "inline-web",
      ]);
      expect(prepared.report.declarations[1]?.environmentNames).toEqual([
        "MIGRATION_FIXTURE_TOKEN",
      ]);
      expect(prepared.report.changes.map((change) => change.path)).toEqual([
        "agent.yaml",
        ".gitignore",
      ]);
      expect(JSON.stringify(prepared.report)).not.toContain("private-fixture-canary");
      expect(JSON.stringify(prepared.report)).not.toContain("controlled-semantic-value");
      expect(treeSnapshot(project)).toEqual(beforeTree);
      expect(planMigration(readAuthoringDocument(config)).report.fingerprint).toBe(
        prepared.report.fingerprint,
      );
      const result = await applyMigration(prepared);
      expect(result.status).toBe("complete");
      expect(result.activation).toBe("output");
      expect(parseConfig(config)).toEqual(beforeSemantic);
      const raw = parseYaml(readFileSync(config, "utf8"));
      expect(raw.augments[1].source).toBe("./augments/orders/index.ts");
      expect(raw.augments[1].options.database).toBe("./data/orders.sqlite");
      expect(raw.augments[1].options.ordered).toEqual([
        false,
        0,
        null,
        -0,
        "${MIGRATION_FIXTURE_TOKEN}",
      ]);
      expect(Object.is(raw.augments[1].options.ordered[3], -0)).toBe(true);
      expect(raw.augments[1].options["<<"]).toEqual({ literal: true });
      expect(Object.getOwnPropertyDescriptor(raw.augments[1].options, "__proto__")?.value).toEqual({
        domain: "preserved",
      });
      for (const [path, hash] of beforeHashes)
        if (!["agent.yaml", ".gitignore"].includes(path))
          expect(fileHashes(project).get(path)).toBe(hash);
      const after = treeSnapshot(project);
      const noop = planMigration(readAuthoringDocument(config));
      expect(noop.report.status).toBe("noop");
      expect((await applyMigration(noop)).status).toBe("noop");
      expect(treeSnapshot(project)).toEqual(after);
    } finally {
      if (previous === undefined) delete process.env.MIGRATION_FIXTURE_TOKEN;
      else process.env.MIGRATION_FIXTURE_TOKEN = previous;
    }
  });

  test("inline config-only no-op does not inspect package, env or operation state", async () => {
    const { project, config } = fixture();
    put(
      config,
      "name: sample\naugments: [{type: custom, name: dynamic, source: '${CUSTOM_SOURCE}', options: {token: '${TOKEN}'}}]\n",
    );
    rmSync(join(project, ".env"));
    expect(Bun.spawnSync(["mkfifo", join(project, ".env")]).exitCode).toBe(0);
    put(join(project, ".auggy/operations/invalid/receipt.json"), "malformed private state");
    put(join(project, "package.json"), "malformed package json");
    const before = treeSnapshot(project);
    const plan = planMigration(readAuthoringDocument(config));
    expect(plan.report.status).toBe("noop");
    expect((await applyMigration(plan)).status).toBe("noop");
    expect(treeSnapshot(project)).toEqual(before);
  });

  test.each(["./relative.ts", "/outside/absolute.ts"])(
    "refuses environment-derived legacy source with %s loaded, leaving every byte unchanged",
    (value) => {
      const { project, config } = fixture();
      const metadata = join(project, "augments/orders/augment.yaml");
      put(
        metadata,
        'type: custom\nsource: ${MIGRATION_CUSTOM_SOURCE}\nconfig: {token: "${MIGRATION_FIXTURE_TOKEN}"}\n',
      );
      const previous = process.env.MIGRATION_CUSTOM_SOURCE;
      process.env.MIGRATION_CUSTOM_SOURCE = value;
      try {
        const before = treeSnapshot(project);
        const report = reportError(() => planMigration(readAuthoringDocument(config)));
        expect(report.diagnostics[0]?.code).toBe("unresolved-source");
        expect(JSON.stringify(report)).not.toContain(value);
        expect(treeSnapshot(project)).toEqual(before);
      } finally {
        if (previous === undefined) delete process.env.MIGRATION_CUSTOM_SOURCE;
        else process.env.MIGRATION_CUSTOM_SOURCE = previous;
      }
    },
  );

  test("external literal custom source stays external and metadata/imports stay in place", async () => {
    const { root, project, config } = fixture();
    const source = join(root, "external.ts");
    put(source, 'throw new Error("MUST_NOT_IMPORT_EXTERNAL");\n');
    put(
      join(project, "augments/orders/augment.yaml"),
      `type: custom\nsource: ${JSON.stringify(source)}\nconfig: {database: ./data/orders.sqlite}\n`,
    );
    const before = readFileSync(source);
    const plan = planMigration(readAuthoringDocument(config));
    expect(plan.report.manualActions.some((message) => message.includes("nonportable"))).toBe(true);
    await applyMigration(plan);
    expect(parseYaml(readFileSync(config, "utf8")).augments[1].source).toBe(source);
    expect(readFileSync(source)).toEqual(before);
  });

  test.each([
    "aliases",
    "metadata-duplicate",
    "metadata-missing",
    "metadata-env-type",
    "reference-env-id",
    "metadata-invalid-utf8",
  ])("unsupported %s input rejects with redacted diagnostics and no writes", (mode) => {
    const { project, config } = fixture();
    const metadata = join(project, "augments/orders/augment.yaml");
    if (mode === "aliases") put(config, "name: sample\naugments: &private []\nsecret: *private\n");
    if (mode === "metadata-duplicate")
      put(
        metadata,
        "type: custom\nsource: ./index.ts\nconfig: {token: inline-private-canary, token: secret-second}\n",
      );
    if (mode === "metadata-missing") rmSync(metadata);
    if (mode === "metadata-env-type") put(metadata, "type: ${PRIVATE_TYPE}\nsource: ./index.ts\n");
    if (mode === "reference-env-id") put(config, "name: sample\naugments: [${PRIVATE_ID}]\n");
    if (mode === "metadata-invalid-utf8") put(metadata, Buffer.from([0xff, 0xfe]));
    const before = treeSnapshot(project);
    const report = reportError(() => planMigration(readAuthoringDocument(config)));
    expect(report.status).toBe("invalid");
    expect(JSON.stringify(report)).not.toContain("inline-private-canary");
    expect(treeSnapshot(project)).toEqual(before);
  });
});

describe("explicit application adoption", () => {
  test("adds absent fields, creates owned execution and discloses deadline without changing state or dependencies", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    put(join(project, "bun.lock"), "untouched lock fixture");
    chmodSync(join(project, "package.json"), 0o640);
    const before = treeSnapshot(project);
    const originalManifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    const plan = planMigration(readAuthoringDocument(config), { application: true });
    expect(treeSnapshot(project)).toEqual(before);
    expect(plan.report.manualActions.join("\n")).toContain("900000");
    expect(plan.report.manualActions.join("\n")).toContain("bun install explicitly");
    expect(plan.report.changes).toHaveLength(11);
    const result = await applyMigration(plan);
    expect(result.status).toBe("complete");
    const manifest = JSON.parse(readFileSync(join(project, "package.json"), "utf8"));
    expect(manifest.dependencies).toEqual(originalManifest.dependencies);
    expect(manifest.scripts.unrelated).toBe("echo owned");
    expect(manifest.type).toBe("module");
    expect(manifest.scripts.start).toBe("bun src/index.ts");
    expect(manifest.devDependencies.typescript).toBe("5.9.3");
    expect(readFileSync(join(project, "bun.lock"), "utf8")).toBe("untouched lock fixture");
    expect(parseYaml(readFileSync(config, "utf8")).application).toEqual({
      entrypoint: "./src/index.ts",
      contractVersion: 1,
    });
    for (const file of planApplicationScaffold({ configFileName: "agent.yaml" }).files)
      expect(readFileSync(join(project, file.relativePath))).toEqual(Buffer.from(file.bytes));
  });

  test("custom config basename is encoded in generated startup and selected CLI script", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    const custom = join(project, "custom agent.yaml");
    renameSync(config, custom);
    const result = await applyMigration(
      planMigration(readAuthoringDocument(custom), { application: true }),
    );
    expect(result.status).toBe("complete");
    expect(readFileSync(join(project, "src/index.ts"), "utf8")).toContain("../custom%20agent.yaml");
    expect(JSON.parse(readFileSync(join(project, "package.json"), "utf8")).scripts.cli).toBe(
      "auggy dev --config 'custom agent.yaml'",
    );
    expect(existsSync(config)).toBe(false);
  });

  test("identical package fields retain exact manifest bytes", async () => {
    const { project, config } = fixture();
    installRuntime(project);
    const manifest = {
      private: true,
      ...planApplicationScaffold({ configFileName: "agent.yaml" }).packageFields,
      dependencies: { auggy: "0.5.0" },
    };
    const bytes = JSON.stringify(manifest);
    put(join(project, "package.json"), bytes);
    const plan = planMigration(readAuthoringDocument(config), { application: true });
    expect(plan.report.changes.some((file) => file.path === "package.json")).toBe(false);
    await applyMigration(plan);
    expect(readFileSync(join(project, "package.json"), "utf8")).toBe(bytes);
  });

  test.each([
    "missing-runtime",
    "unsupported-runtime",
    "missing-export",
    "escaping-export",
    "runtime-fifo",
    "package-fifo",
    "package-invalid-utf8",
    "package-oversized",
    "package-deep",
    "package-unsafe-number",
  ])("rejects %s without changing bytes or installing anything", (mode) => {
    const { root, project, config } = fixture();
    const { runtime, manifest } = installRuntime(project);
    if (mode === "missing-runtime") rmSync(runtime, { recursive: true });
    if (mode === "unsupported-runtime")
      put(join(runtime, "package.json"), JSON.stringify({ ...manifest, auggyRuntime: undefined }));
    if (mode === "missing-export")
      put(join(runtime, "package.json"), JSON.stringify({ ...manifest, exports: {} }));
    if (mode === "escaping-export") {
      put(join(root, "outside.ts"), "export {};\n");
      rmSync(join(runtime, "src/application/index.ts"));
      symlinkSync(join(root, "outside.ts"), join(runtime, "src/application/index.ts"));
    }
    if (mode === "runtime-fifo" || mode === "package-fifo") {
      const target = join(mode === "runtime-fifo" ? runtime : project, "package.json");
      rmSync(target);
      expect(Bun.spawnSync(["mkfifo", target]).exitCode).toBe(0);
    }
    if (mode === "package-invalid-utf8")
      put(join(project, "package.json"), Buffer.from([0xff, 0xfe]));
    if (mode === "package-oversized")
      put(
        join(project, "package.json"),
        `{"private":"${"a".repeat(AUTHORING_LIMITS.documentBytes)}"}`,
      );
    if (mode === "package-deep")
      put(join(project, "package.json"), `{"deep":${"[".repeat(70)}0${"]".repeat(70)}}`);
    if (mode === "package-unsafe-number")
      put(join(project, "package.json"), '{"private":true,"number":9007199254740992}');
    const before = treeSnapshot(project);
    const report = reportError(() =>
      planMigration(readAuthoringDocument(config), { application: true }),
    );
    expect(report.status).toBe("invalid");
    expect(treeSnapshot(project)).toEqual(before);
    expect(planMigration(readAuthoringDocument(config)).report.status).toBe("planned");
  });

  test.each([
    "source",
    "readme",
    "typescript",
    "test",
    "script",
    "dependency",
    "type",
    "parent-symlink",
    "case-collision",
    "existing-application",
  ])("preserves %s collision and leaves config-only conversion available", (mode) => {
    const { root, project, config } = fixture();
    installRuntime(project);
    const paths = {
      source: "src/index.ts",
      readme: "README.md",
      typescript: "tsconfig.json",
      test: "tests/application.test.ts",
    };
    if (Object.hasOwn(paths, mode))
      put(join(project, paths[mode as keyof typeof paths]), "owned-private-canary\n");
    if (mode === "script" || mode === "dependency" || mode === "type")
      put(
        join(project, "package.json"),
        JSON.stringify({
          dependencies: { auggy: "0.5.0" },
          ...(mode === "script"
            ? { scripts: { start: "owned-private-canary" } }
            : mode === "dependency"
              ? { devDependencies: { typescript: "^5.9.3" } }
              : { type: "commonjs" }),
        }),
      );
    if (mode === "parent-symlink") {
      mkdirSync(join(root, "outside"));
      symlinkSync(join(root, "outside"), join(project, "src"));
    }
    if (mode === "case-collision") put(join(project, "SRC/index.ts"), "owned-private-canary\n");
    if (mode === "existing-application")
      put(
        config,
        `${readFileSync(config, "utf8")}application: {entrypoint: ./owned.ts, contractVersion: 1}\n`,
      );
    const before = treeSnapshot(project);
    const report = reportError(() =>
      planMigration(readAuthoringDocument(config), { application: true }),
    );
    expect(report.status).toBe("invalid");
    expect(JSON.stringify(report)).not.toContain("owned-private-canary");
    expect(treeSnapshot(project)).toEqual(before);
    expect(planMigration(readAuthoringDocument(config)).report.status).toBe("planned");
  });

  test("reports multiple collisions together without partial edits", () => {
    const { project, config } = fixture();
    installRuntime(project);
    put(join(project, "README.md"), "owned\n");
    put(join(project, "tsconfig.json"), "{}\n");
    put(
      join(project, "package.json"),
      '{"type":"commonjs","scripts":{"start":"owned"},"devDependencies":{"typescript":"~5.0.0"}}',
    );
    const report = reportError(() =>
      planMigration(readAuthoringDocument(config), { application: true }),
    );
    expect(report.diagnostics.length).toBeGreaterThanOrEqual(5);
    expect(renderMigrationReport(report)).toContain("config-only");
  });
});
