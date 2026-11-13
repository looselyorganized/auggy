import { afterEach, describe, expect, test } from "bun:test";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { parse } from "yaml";
import { AUTHORING_LIMITS } from "../../src/cli/authoring/contracts";
import {
  assertInlineAuthoring,
  editAuthoringDocument,
  readAuthoringDocument,
} from "../../src/cli/authoring/document";
import { AuthoringError } from "../../src/cli/authoring/document-io";

const directories: string[] = [];
function fixture(yaml: string): { dir: string; path: string } {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "auggy-document-")));
  directories.push(dir);
  const path = join(dir, "agent.yaml");
  writeFileSync(path, yaml);
  return { dir, path };
}
function metadata(dir: string, name: string, yaml: string): string {
  const path = join(dir, "augments", name, "augment.yaml");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml);
  return path;
}
function text(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("utf8");
}
function expectCode(fn: () => unknown, code: string): void {
  try {
    fn();
    throw new Error("expected controlled failure");
  } catch (error) {
    expect(error).toBeInstanceOf(AuthoringError);
    expect((error as AuthoringError).code).toBe(code);
  }
}
afterEach(() => {
  for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("passive raw authoring", () => {
  test("bounds migration guidance after shell quoting repeated selectors", () => {
    const { dir } = fixture("augments: []\n");
    const nested = join(dir, "'".repeat(180));
    mkdirSync(nested);
    const path = join(nested, "agent.yaml");
    writeFileSync(path, "augments: [budgets]\n");
    metadata(nested, "budgets", "type: budgets\n");
    try {
      assertInlineAuthoring(readAuthoringDocument(path));
      throw new Error("expected migration guidance");
    } catch (error) {
      expect(error).toBeInstanceOf(AuthoringError);
      const message = (error as AuthoringError).message;
      expect(Buffer.byteLength(message)).toBeLessThanOrEqual(AUTHORING_LIMITS.diagnosticBytes);
      expect(message).toContain("<selected-config-path>");
      expect(message).toContain("--apply");
    }
  });

  test("preserves quoted merge-looking domain keys through reads and new edits", () => {
    const { path } = fixture(
      'augments: [{ type: budgets, options: { "<<": { literal: true } } }]\n',
    );
    const document = readAuthoringDocument(path);
    expect(document.declarations[0]?.options).toEqual({ "<<": { literal: true } });
    const edited = editAuthoringDocument(document, [
      { kind: "set-augment-options", name: "budgets", options: { "<<": { literal: false } } },
    ]);
    writeFileSync(path, edited.bytes);
    expect(readAuthoringDocument(path).declarations[0]?.options).toEqual({
      "<<": { literal: false },
    });
    const appended = editAuthoringDocument(readAuthoringDocument(path), [
      { kind: "append-augment", entry: { type: "webFetch", options: { "<<": 3 } } },
    ]);
    writeFileSync(path, appended.bytes);
    expect(readAuthoringDocument(path).declarations[1]?.options).toEqual({ "<<": 3 });
  });

  test("reads inline raw values, type-derived names, env names and safe own properties", () => {
    const { dir, path } = fixture(
      `name: demo\nid: \${IDENTITY}\naugments:\n  - type: budgets\n    options:\n      __proto__: { polluted: false }\n      constructor: 0\n      prototype: null\n      values: [false, 0, null, -0, 1.25, '\${MISSING_TOKEN}']\n`,
    );
    const document = readAuthoringDocument(path);
    expect(document.projectDir).toBe(dir);
    expect(document.format).toBe("inline");
    expect(document.declarations[0]?.name).toBe("budgets");
    expect(document.declarations[0]?.environmentNames).toEqual(["MISSING_TOKEN"]);
    expect(document.declarations[0]?.origin).toEqual({
      kind: "inline",
      path,
      pointer: "/augments/0",
      sourceBaseDir: dir,
    });
    expect(document.declarations[0]?.options).toEqual({
      __proto__: { polluted: false },
      constructor: 0,
      prototype: null,
      values: [false, 0, null, -0, 1.25, "${MISSING_TOKEN}"],
    });
    expect(Object.hasOwn(document.declarations[0]?.options as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(document.value)).toBeNull();
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });

  test("keeps no-op document byte identical and never loads env or source modules", () => {
    const { dir, path } = fixture(
      "# untouched\naugments: [{ name: sentinel, type: custom, source: ./throw.ts, options: { token: '${AUTHORING_PASSIVE_SENTINEL}' } }]\n",
    );
    writeFileSync(join(dir, ".env"), "AUTHORING_PASSIVE_SENTINEL=PRIVATE_ENV_VALUE\n");
    writeFileSync(join(dir, "throw.ts"), "throw new Error('must never import');\n");
    const before = process.env.AUTHORING_PASSIVE_SENTINEL;
    const document = readAuthoringDocument(path);
    expect(text(editAuthoringDocument(document, []).bytes)).toBe(readFileSync(path, "utf8"));
    expect(process.env.AUTHORING_PASSIVE_SENTINEL).toBe(before);
    expect(document.declarations[0]?.options).toEqual({ token: "${AUTHORING_PASSIVE_SENTINEL}" });
    expect(document.inputs).toHaveLength(1);
  });

  test("reads mixed legacy provenance and preserves absent versus null config", () => {
    const { dir, path } = fixture("augments: [plain, explicitNull, { type: budgets }]\n");
    metadata(dir, "plain", "type: filesystem\n");
    const metadataPath = metadata(dir, "explicitNull", "type: webFetch\nconfig: null\n");
    const document = readAuthoringDocument(path);
    expect(document.format).toBe("mixed");
    expect(document.inputs).toHaveLength(3);
    expect(document.declarations.map((entry) => entry.name)).toEqual([
      "plain",
      "explicitNull",
      "budgets",
    ]);
    expect(Object.hasOwn(document.declarations[0]!, "options")).toBe(false);
    expect(Object.hasOwn(document.declarations[1]!, "options")).toBe(true);
    expect(document.declarations[1]?.options).toBeNull();
    expect(document.declarations[1]?.origin).toEqual({
      kind: "referenced",
      path: metadataPath,
      pointer: "",
      sourceBaseDir: dirname(metadataPath),
    });
    expectCode(() => assertInlineAuthoring(document), "migration-required");
    expect(() => assertInlineAuthoring(document)).toThrow("auggy migrate --config");
    expect(() => assertInlineAuthoring(document)).toThrow("--apply");
    const edited = parse(
      text(editAuthoringDocument(document, [{ kind: "inline-references" }]).bytes),
    );
    expect(Object.hasOwn(edited.augments[0], "options")).toBe(false);
    expect(edited.augments[1].options).toBeNull();
  });

  test("migration rebases literal custom source only and retains comments, option paths and declaration order", () => {
    const { dir, path } = fixture(
      "# central heading\naugments:\n  - orders # instance comment\n  - type: budgets # budget comment\nsettings: { enabled: false }\n",
    );
    const original =
      "# metadata heading\ntype: custom\nsource: ./index.ts # source note\nconfig:\n  dbPath: ./data/orders.sqlite # keep path\n  flags: [false, 0, null, -0, 0.125]\n  token: '${TOKEN}'\n";
    const meta = metadata(dir, "orders", original);
    const document = readAuthoringDocument(path);
    const result = text(editAuthoringDocument(document, [{ kind: "inline-references" }]).bytes);
    const converted = parse(result);
    expect(converted.augments[0]).toEqual({
      name: "orders",
      type: "custom",
      source: "./augments/orders/index.ts",
      options: {
        dbPath: "./data/orders.sqlite",
        flags: [false, 0, null, -0, 0.125],
        token: "${TOKEN}",
      },
    });
    expect(Object.is(converted.augments[0].options.flags[3], -0)).toBe(true);
    for (const comment of [
      "central heading",
      "instance comment",
      "metadata heading",
      "budget comment",
      "keep path",
    ])
      expect(result).toContain(comment);
    expect(readFileSync(meta, "utf8")).toBe(original);
    expect(readFileSync(path, "utf8")).toContain("- orders");
  });

  test("external literal sources are preserved as references without reading or moving them", () => {
    const { dir, path } = fixture("augments: [relativeExternal, absoluteExternal]\n");
    metadata(
      dir,
      "relativeExternal",
      "type: custom\nsource: ../../../shared/impl.ts\nconfig: { dbPath: ../database.sqlite }\n",
    );
    metadata(dir, "absoluteExternal", "type: custom\nsource: /external/unreadable/impl.ts\n");
    const document = readAuthoringDocument(path);
    const converted = parse(
      text(editAuthoringDocument(document, [{ kind: "inline-references" }]).bytes),
    );
    expect(converted.augments[0].source).toBe("../shared/impl.ts");
    expect(converted.augments[0].options.dbPath).toBe("../database.sqlite");
    expect(converted.augments[1].source).toBe("/external/unreadable/impl.ts");
    expect(document.inputs).toHaveLength(3);
  });

  test("known inline placeholders remain unresolved for inspection and config-only conversion", () => {
    const { dir, path } = fixture(
      "augments: [old, { name: '${INSTANCE}', type: '${TYPE}', source: '${SOURCE}', options: { x: '${OPT}' } }]\n",
    );
    metadata(dir, "old", "type: budgets\n");
    const document = readAuthoringDocument(path);
    expect(document.declarations[1]?.name).toBeNull();
    const output = parse(
      text(editAuthoringDocument(document, [{ kind: "inline-references" }]).bytes),
    );
    expect(output.augments[1].name).toBe("${INSTANCE}");
    expect(output.augments[1].source).toBe("${SOURCE}");
  });

  test.each(["./relative.ts", "/absolute/source.ts"])(
    "refuses env legacy source without using environment value %s",
    (source) => {
      const { dir, path } = fixture("augments: [orders]\n");
      const meta = metadata(dir, "orders", "type: custom\nsource: '${AUTHORING_SOURCE}'\n");
      const previous = process.env.AUTHORING_SOURCE;
      process.env.AUTHORING_SOURCE = source;
      try {
        const before = readFileSync(path);
        const metadataBefore = readFileSync(meta);
        const document = readAuthoringDocument(path);
        expectCode(
          () => editAuthoringDocument(document, [{ kind: "inline-references" }]),
          "unresolved-source",
        );
        expect(readFileSync(path)).toEqual(before);
        expect(readFileSync(meta)).toEqual(metadataBefore);
      } finally {
        if (previous === undefined) delete process.env.AUTHORING_SOURCE;
        else process.env.AUTHORING_SOURCE = previous;
      }
    },
  );

  test.each([
    ["augments: ['${ID}']\n", "unresolved-reference"],
    ["augments: [{ type: budgets }, { name: budgets, type: webFetch }]\n", "duplicate-augment"],
    ["augments: [{ type: custom, source: ./x.ts }]\n", "invalid-declaration"],
    ["augments: [false]\n", "invalid-declaration"],
    ["augments: null\n", "invalid-declarations"],
    ["augments: []\nsecret: PRIVATE_SENTINEL\nsecret: 2\n", "invalid-yaml"],
    ["augments: []\nvalue: &anchor { x: 1 }\ncopy: *anchor\n", "unsupported-yaml"],
    ["augments: []\nvalue: { <<: { x: 1 } }\n", "invalid-yaml-key"],
    ["augments: []\nvalue: !secret PRIVATE_SENTINEL\n", "invalid-yaml"],
    ["augments: []\nvalue: !!timestamp 2026-01-01\n", "invalid-yaml"],
    ["augments: []\nvalue: .inf\n", "unsafe-number"],
    ["augments: []\nvalue: 9007199254740993\n", "unsafe-number"],
    ["augments: []\nvalue: { 1: literal }\n", "invalid-yaml-key"],
    ["%YAML 1.1\n---\naugments: []\n", "unsupported-yaml"],
  ])("sanitizes unsupported YAML %s", (yaml, code) => {
    const { path } = fixture(yaml);
    expectCode(() => readAuthoringDocument(path), code);
    try {
      readAuthoringDocument(path);
    } catch (error) {
      expect(String(error)).not.toContain("PRIVATE_SENTINEL");
      expect((error as Error).cause).toBeUndefined();
      expect(JSON.stringify((error as AuthoringError).diagnostic)).not.toContain(
        "PRIVATE_SENTINEL",
      );
    }
  });

  test("enforces node, depth, declaration and byte bounds", () => {
    const manyNodes = fixture(`augments: []\nvalues: [${Array(50_000).fill("0").join(",")}]\n`);
    expectCode(() => readAuthoringDocument(manyNodes.path), "yaml-limit");
    const deep = fixture(`augments: []\nvalues: ${"[".repeat(65)}0${"]".repeat(65)}\n`);
    expectCode(() => readAuthoringDocument(deep.path), "yaml-limit");
    const many = fixture(
      `augments: [${Array.from({ length: 257 }, (_, i) => `{ name: a${i}, type: budgets }`).join(",")}]\n`,
    );
    expectCode(() => readAuthoringDocument(many.path), "augment-limit");
    const oversized = fixture(" ".repeat(AUTHORING_LIMITS.documentBytes + 1));
    expectCode(() => readAuthoringDocument(oversized.path), "file-too-large");
  });

  test("refuses missing, oversized, symlinked and invalid metadata", () => {
    const { dir, path } = fixture("augments: [orders]\n");
    expectCode(() => readAuthoringDocument(path), "missing-metadata");
    const meta = metadata(dir, "orders", " ".repeat(AUTHORING_LIMITS.metadataBytes + 1));
    expectCode(() => readAuthoringDocument(path), "file-too-large");
    writeFileSync(meta, "type: budgets\nconfig: false\n");
    expectCode(() => readAuthoringDocument(path), "invalid-metadata");
    writeFileSync(meta, "type: '${TYPE}'\n");
    expectCode(() => readAuthoringDocument(path), "unresolved-reference");
    rmSync(dirname(meta), { recursive: true });
    symlinkSync(dir, dirname(meta));
    expectCode(() => readAuthoringDocument(path), "unsafe-metadata-path");
  });
});

describe("closed document edits", () => {
  test("append, options replacement and removal keep unrelated comments and values", () => {
    const { path } = fixture(
      "# heading\nname: demo # retained\naugments:\n  - type: budgets\n    options: { x: false, y: 0 }\n  - name: removeMe\n    type: webFetch\nsettings: { nullable: null, ratio: 0.25 } # keep\n",
    );
    const document = readAuthoringDocument(path);
    const bytes = editAuthoringDocument(document, [
      {
        kind: "append-augment",
        entry: {
          name: "files",
          type: "filesystem",
          options: { root: "${ROOT}", negativeZero: -0 },
        },
      },
      { kind: "set-augment-options", name: "budgets", options: null },
      { kind: "remove-augment", name: "removeMe" },
    ]).bytes;
    const result = text(bytes);
    const value = parse(result);
    expect(
      value.augments.map((entry: { name?: string; type: string }) => entry.name ?? entry.type),
    ).toEqual(["budgets", "files"]);
    expect(value.augments[0].options).toBeNull();
    expect(Object.is(value.augments[1].options.negativeZero, -0)).toBe(true);
    expect(value.settings).toEqual({ nullable: null, ratio: 0.25 });
    expect(result).toContain("# retained");
    expect(result).toContain("# keep");
    expect(document.declarations).toHaveLength(2);
  });

  test.each(["{ name: '${NAME}', type: budgets }", "{ name: future, type: futureType }"])(
    "graph changes refuse unresolved structure %s",
    (entry) => {
      const { path } = fixture(`augments: [${entry}]\n`);
      const document = readAuthoringDocument(path);
      expectCode(() => assertInlineAuthoring(document), "unresolved-declaration");
      expectCode(
        () =>
          editAuthoringDocument(document, [
            { kind: "append-augment", entry: { type: "filesystem" } },
          ]),
        "unresolved-declaration",
      );
    },
  );

  test("supports adoption after conversion, rejects application replacement and invalid edits", () => {
    const { dir, path } = fixture("augments: [old]\n");
    metadata(dir, "old", "type: budgets\n");
    const document = readAuthoringDocument(path);
    const result = editAuthoringDocument(document, [
      { kind: "inline-references" },
      {
        kind: "set-application",
        application: { entrypoint: "./src/index.ts", contractVersion: 1 },
      },
    ]);
    expect(parse(text(result.bytes)).application).toEqual({
      entrypoint: "./src/index.ts",
      contractVersion: 1,
    });
    writeFileSync(path, result.bytes);
    const current = readAuthoringDocument(path);
    expectCode(
      () =>
        editAuthoringDocument(current, [
          {
            kind: "set-application",
            application: { entrypoint: "./other.ts", contractVersion: 1 },
          },
        ]),
      "application-conflict",
    );
    expectCode(
      () =>
        editAuthoringDocument(current, [
          {
            kind: "set-application",
            application: { entrypoint: "./../outside.ts", contractVersion: 1 },
          },
        ]),
      "invalid-application",
    );
    expectCode(
      () =>
        editAuthoringDocument(current, [
          { kind: "append-augment", entry: { type: "budgets", name: "old" } },
        ]),
      "duplicate-augment",
    );
    expectCode(
      () =>
        editAuthoringDocument(current, [
          { kind: "set-augment-options", name: "old", options: Number.POSITIVE_INFINITY },
        ]),
      "invalid-edit",
    );
    expectCode(
      () => editAuthoringDocument(current, [{ kind: "remove-augment", name: "absent" }]),
      "missing-augment",
    );
  });

  test("rejects changed private input bytes and counterfeit documents", () => {
    const { path } = fixture("augments: [{ type: budgets }]\n");
    const document = readAuthoringDocument(path);
    expectCode(() => editAuthoringDocument({ ...document }, []), "invalid-document-snapshot");
    document.config.bytes[0] = 0;
    expectCode(() => editAuthoringDocument(document, []), "invalid-document-snapshot");
  });
});

describe("authoring boundary regressions", () => {
  test("keeps generated central YAML within the next reader's 1 MiB bound", () => {
    const { path } = fixture(`augments: [{ type: budgets }]\npurpose: '${"x".repeat(600_000)}'\n`);
    const document = readAuthoringDocument(path);
    expectCode(
      () =>
        editAuthoringDocument(document, [
          { kind: "set-augment-options", name: "budgets", options: { large: "y".repeat(500_000) } },
        ]),
      "output-limit",
    );
    expectCode(
      () =>
        editAuthoringDocument(document, [
          {
            kind: "set-augment-options",
            name: "budgets",
            options: { large: "y".repeat(AUTHORING_LIMITS.outputBytes + 1) },
          },
        ]),
      "output-limit",
    );
  });

  test.each(["./bad\npath.ts", "./bad:path.ts", "./${INVALID-NAME}/index.ts", "./src/index.ts "])(
    "refuses malformed application entrypoint %s",
    (entrypoint) => {
      const { path } = fixture("augments: []\n");
      expectCode(
        () =>
          editAuthoringDocument(readAuthoringDocument(path), [
            { kind: "set-application", application: { entrypoint, contractVersion: 1 } },
          ]),
        "invalid-application",
      );
    },
  );

  test("bounds the aggregate referenced input before materializing its last metadata", () => {
    const names = Array.from({ length: 33 }, (_, index) => `instance${index}`);
    const { dir, path } = fixture(`augments: [${names.join(", ")}]\n`);
    for (const name of names)
      metadata(dir, name, `type: budgets\nconfig: { text: '${"x".repeat(260_000)}' }\n`);
    expectCode(() => readAuthoringDocument(path), "input-limit");
  });

  test("passive module dependency closure excludes environment, factories, network, publication and FFI", () => {
    const root = join(import.meta.dir, "../../src/cli");
    const permitted = new Set([
      "authoring/document.ts",
      "authoring/document-io.ts",
      "authoring/contracts.ts",
      "authoring/mutation.ts",
      "agent-name.ts",
      "builtin-types.ts",
    ]);
    const pending = ["authoring/document.ts", "authoring/mutation.ts"];
    const visited = new Set<string>();
    const scanner = new Bun.Transpiler({ loader: "ts" });
    while (pending.length) {
      const local = pending.pop()!;
      if (visited.has(local)) continue;
      visited.add(local);
      expect(permitted.has(local)).toBe(true);
      const source = readFileSync(join(root, local), "utf8");
      expect(source).not.toMatch(/process\.env|fetch\(|import\(/);
      for (const entry of scanner.scanImports(source)) {
        if (!entry.path.startsWith(".")) {
          expect(["node:fs", "node:path", "node:crypto", "yaml"]).toContain(entry.path);
          continue;
        }
        const absolute = join(dirname(join(root, local)), `${entry.path}.ts`);
        const relative = absolute.slice(root.length + 1);
        pending.push(relative);
      }
    }
    expect(visited.has("builtin-types.ts")).toBe(true);
  });
});

test("editing rejects changed referenced snapshot bytes instead of pairing stale AST with new preconditions", () => {
  const { dir, path } = fixture("augments: [old]\n");
  metadata(dir, "old", "type: budgets\n");
  const document = readAuthoringDocument(path);
  const input = document.inputs[1]!;
  if (!input.exists) throw new Error("Expected metadata snapshot");
  input.bytes[0] = 0;
  expectCode(
    () => editAuthoringDocument(document, [{ kind: "inline-references" }]),
    "invalid-document-snapshot",
  );
});
