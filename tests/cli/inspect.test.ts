import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inspectProject, renderInspectionReport } from "../../src/cli/authoring/inspection";
import { fixtureIndex, inspectionFixture, writeFixture } from "./inspect-fixtures";

let fixture: ReturnType<typeof inspectionFixture>;
beforeEach(() => {
  fixture = inspectionFixture();
});
afterEach(() => rmSync(fixture.root, { recursive: true, force: true }));
function config(value: string) {
  writeFileSync(fixture.config, value);
}
function updateManifest(fields: Record<string, unknown>) {
  writeFileSync(
    join(fixture.runtime, "package.json"),
    JSON.stringify({ ...fixture.manifest, ...fields }),
  );
}

describe("passive inspection reports", () => {
  test("reports declared provenance and exact installed sources without option values", () => {
    const before = readFileSync(fixture.config, "utf8");
    const report = inspectProject(fixture.config, { inspectorVersion: "9.8.7" });
    expect(report.status).toBe("complete");
    expect(report.schemaVersion).toBe(1);
    expect(report.inspector.version).toBe("9.8.7");
    expect(report.runtime.version).toBe("4.5.6");
    expect(report.runtime.manifestSHA256).toMatch(/^[a-f0-9]{64}$/);
    expect(report.runtime.packageRoot).toBe(fixture.runtime);
    expect(report.project.format).toBe("inline");
    expect(report.augments.map((item) => item.name)).toEqual(["fileMemory", "orders"]);
    expect(report.augments[0]?.configuration.pointer).toBe("/augments/0");
    expect(report.augments[0]?.optionKeys).toEqual(["source", "password", "token"]);
    expect(report.augments[0]?.environmentNames).toEqual(["UNSET_SECRET"]);
    expect(report.augments[0]?.source.path).toBe(
      join(fixture.runtime, "src/augments/fileMemory/index.ts"),
    );
    expect(report.augments[1]?.source.path).toBe(
      join(fixture.project, "src/augments/orders/index.ts"),
    );
    expect(report.execution.basis).toBe("conventional-project-files");
    expect(report.execution.http?.path).toBe(join(fixture.project, "src/http.ts"));
    expect(report.execution.turn?.path).toBe(join(fixture.project, "src/turn.ts"));
    expect(report.runtimeDiscovery).toBe("not-evaluated");
    for (const rendered of [JSON.stringify(report), renderInspectionReport(report)]) {
      expect(rendered).not.toContain("inline-secret-canary");
      expect(rendered).not.toContain("./notes.md");
      expect(rendered).not.toContain("INSPECTION_EXECUTED_CODE");
    }
    expect(readFileSync(fixture.config, "utf8")).toBe(before);
  });

  test("legacy and mixed graphs preserve order and referenced source bases", () => {
    config("name: sample\naugments:\n  - old\n  - type: webTransport\n");
    writeFixture(
      join(fixture.project, "augments/old/augment.yaml"),
      "type: custom\nsource: ./index.ts\nconfig:\n  token: ${OLD_TOKEN}\n  password: hidden-legacy-secret\n",
    );
    writeFixture(
      join(fixture.project, "augments/old/index.ts"),
      'throw new Error("never import");',
    );
    const report = inspectProject(fixture.config);
    expect(report.status).toBe("complete");
    expect(report.project.format).toBe("mixed");
    expect(report.application.mode).toBe("legacy");
    expect(report.execution.startup).toBeNull();
    expect(report.augments.map((item) => item.name)).toEqual(["old", "webTransport"]);
    expect(report.augments[0]?.configuration).toEqual({
      path: join(fixture.project, "augments/old/augment.yaml"),
      pointer: "",
    });
    expect(report.augments[0]?.source.path).toBe(join(fixture.project, "augments/old/index.ts"));
    expect(report.augments[1]?.source.path).toBe(
      join(fixture.runtime, "src/transports/web-transport.ts"),
    );
    expect(JSON.stringify(report)).not.toContain("hidden-legacy-secret");
    config("name: sample\naugments: [old]\n");
    expect(inspectProject(fixture.config).project.format).toBe("referenced");
  });

  test.each(["package", "runtime", "index", "older-index", "future-index"])(
    "missing or unsupported %s remains partial",
    (mode) => {
      if (mode === "package") rmSync(join(fixture.project, "package.json"));
      if (mode === "runtime") rmSync(fixture.runtime, { recursive: true });
      if (mode === "index") rmSync(fixture.indexPath);
      if (mode === "older-index") writeFileSync(fixture.indexPath, '{"schemaVersion":0}');
      if (mode === "future-index")
        writeFileSync(fixture.indexPath, '{"schemaVersion":37,"future":"opaque"}');
      const report = inspectProject(fixture.config);
      expect(report.status).toBe("partial");
      expect(report.augments[0]?.source.status).toBe("unavailable");
      expect(report.augments[0]?.source.path).toBeNull();
      expect(report.augments[1]?.source.status).toBe("available");
      expect(report.diagnostics.length).toBeGreaterThan(0);
    },
  );

  test("unsupported capability and future declaration contract are inspectable", () => {
    updateManifest({ auggyRuntime: undefined });
    expect(inspectProject(fixture.config).status).toBe("partial");
    expect(inspectProject(fixture.config).runtime.applicationSupported).toBe(false);
    config("name: sample\napplication: { entrypoint: ./src/index.ts, contractVersion: 2 }\n");
    expect(inspectProject(fixture.config).application.contractVersion).toBe(2);
    expect(inspectProject(fixture.config).status).toBe("partial");
  });

  test("an explicitly linked selected installation retains its own provenance", () => {
    const linked = join(fixture.root, "linked");
    writeFixture(join(linked, "package.json"), "{}");
    writeFixture(join(linked, "agent.yaml"), "name: linked\naugments: [{type: fileMemory}]\n");
    writeFixture(join(linked, "node_modules/placeholder"), "");
    symlinkSync(fixture.runtime, join(linked, "node_modules/auggy"));
    const report = inspectProject(join(linked, "agent.yaml"));
    expect(report.status).toBe("complete");
    expect(report.runtime.packageRoot).toBe(fixture.runtime);
  });

  test("unknown and environment-dependent declarations stay unresolved", () => {
    config(
      "name: sample\nid: ${AUGGY_AGENT_ID}\naugments:\n  - type: futureType\n  - name: dynamic\n    type: custom\n    source: ${CUSTOM_SOURCE}/index.ts\n",
    );
    const report = inspectProject(fixture.config);
    expect(report.status).toBe("partial");
    expect(report.project.identity).toEqual({ value: null, environmentNames: ["AUGGY_AGENT_ID"] });
    expect(report.augments[0]?.source.reason).toBe("unmapped-augment-type");
    expect(report.augments[1]?.source).toMatchObject({
      status: "unresolved",
      path: "${CUSTOM_SOURCE}/index.ts",
    });
  });

  test("external custom source is navigable and explicitly nonportable", () => {
    const external = join(fixture.root, "outside.ts");
    writeFileSync(external, 'throw new Error("must not run");');
    config(
      `name: sample\naugments: [{ name: external, type: custom, source: ${JSON.stringify(external)} }]\n`,
    );
    const report = inspectProject(fixture.config);
    expect(report.augments[0]?.source).toMatchObject({
      status: "available",
      ownership: "external",
      path: external,
    });
    expect(report.diagnostics.some((item) => item.code === "external-custom-source")).toBe(true);
  });

  test("missing custom files and unknown custom application layouts stay truthful", () => {
    config(
      "name: sample\napplication: { entrypoint: ./main.ts, contractVersion: 1 }\naugments: [{ name: missing, type: custom, source: ./gone.ts }]\n",
    );
    writeFixture(join(fixture.project, "main.ts"), 'throw new Error("do not import");');
    const report = inspectProject(fixture.config);
    expect(report.status).toBe("partial");
    expect(report.execution.startup?.status).toBe("available");
    expect(report.execution.http).toBeNull();
    expect(report.execution.turn).toBeNull();
    expect(report.augments[0]?.source.status).toBe("missing");
    rmSync(join(fixture.project, "main.ts"));
    expect(inspectProject(fixture.config).application.source?.status).toBe("missing");
  });

  test.each([
    "name: [secret-canary\n",
    "name: one\nname: secret-canary\n",
    "name: sample\nid: secret-canary\n",
    "name: sample\napplication: { entrypoint: ../secret-canary.ts, contractVersion: 1 }\n",
    "name: sample\naugments: [{type: fileMemory}, {type: fileMemory}]\n",
    "name: sample\naugments: [missing]\n",
    'name: sample\napplication: { entrypoint: ./src/index.ts, contractVersion: "secret-canary" }\n',
  ])("invalid declarations emit only controlled shaped errors (%#)", (value) => {
    config(value);
    const report = inspectProject(fixture.config);
    expect(report.schemaVersion).toBe(1);
    expect(report.status).toBe("invalid");
    expect(report.runtimeDiscovery).toBe("not-evaluated");
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(JSON.stringify(report)).not.toContain("secret-canary");
  });

  test("malformed project and local runtime manifests are invalid", () => {
    for (const path of [
      join(fixture.project, "package.json"),
      join(fixture.runtime, "package.json"),
    ]) {
      const before = readFileSync(path);
      writeFileSync(path, '{"secret":"secret-canary"');
      const report = inspectProject(fixture.config);
      expect(report.status).toBe("invalid");
      expect(JSON.stringify(report)).not.toContain("secret-canary");
      writeFileSync(path, before);
    }
    updateManifest({ auggyRuntime: { schemaVersion: 2 } });
    expect(inspectProject(fixture.config).status).toBe("invalid");
  });

  test("URL credentials, control text and invalid identity values cannot leak", () => {
    config(
      'name: sample\naugments:\n  - name: remote\n    type: custom\n    source: https://user:secret-canary@example.test/anything?token=secret-query\n    options:\n      "\\u001b[31msecret-terminal": hidden-value\n',
    );
    const report = inspectProject(fixture.config);
    expect(report.status).toBe("partial");
    expect(report.augments[0]?.source.path).toBeNull();
    expect(report.augments[0]?.optionKeys).toEqual(["<unavailable>"]);
    for (const value of ["secret-canary", "secret-query", "secret-terminal", "hidden-value"])
      expect(JSON.stringify(report)).not.toContain(value);
  });

  test("application link escapes are invalid even with a missing target", () => {
    rmSync(join(fixture.project, "src/index.ts"));
    symlinkSync(join(fixture.root, "missing.ts"), join(fixture.project, "src/index.ts"));
    expect(inspectProject(fixture.config).status).toBe("invalid");
  });

  test("selected source index mappings are not synthesized from the invoking catalog", () => {
    writeFixture(join(fixture.runtime, "special/adapter.ts"), 'throw new Error("never");');
    writeFileSync(
      fixture.indexPath,
      JSON.stringify({
        ...fixtureIndex,
        augments: [{ type: "fileMemory", entrypoint: "special/adapter.ts" }],
      }),
    );
    expect(inspectProject(fixture.config).augments[0]?.source.path).toBe(
      join(fixture.runtime, "special/adapter.ts"),
    );
  });
});
