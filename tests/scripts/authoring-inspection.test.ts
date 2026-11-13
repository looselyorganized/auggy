import { expect, test } from "bun:test";
import type { InspectionReport } from "../../src/cli/authoring/contracts";
import {
  assertInstalledAuthoringInspection,
  runGeneratedAuthoringInspection,
} from "../../scripts/release-smoke/authoring-inspection";

function report(): InspectionReport {
  const project = {
    ownership: "project" as const,
    status: "available" as const,
    path: "/consumer/src/index.ts",
  };
  const packaged = {
    ownership: "package" as const,
    status: "available" as const,
    path: "/consumer/node_modules/auggy/src/application/index.ts",
  };
  return {
    schemaVersion: 1,
    status: "complete",
    inspector: { version: "0.5.0" },
    project: {
      configPath: "/consumer/agent.yaml",
      format: "inline",
      name: "sample",
      identity: { value: null, environmentNames: [] },
    },
    application: {
      mode: "application",
      entrypoint: "./src/index.ts",
      contractVersion: 1,
      source: project,
    },
    runtime: {
      status: "available",
      packageRoot: "/consumer/node_modules/auggy",
      version: "0.5.0",
      manifestSHA256: "local-manifest",
      applicationSupported: true,
    },
    execution: {
      basis: "conventional-project-files",
      startup: project,
      composition: project,
      http: project,
      turn: project,
      runtime: { application: packaged, host: packaged, turn: packaged },
    },
    augments: [
      {
        index: 0,
        name: "web",
        type: "webTransport",
        configuration: { path: "/consumer/agent.yaml", pointer: "/augments/0" },
        optionKeys: [],
        environmentNames: [],
        source: packaged,
      },
    ],
    runtimeDiscovery: "not-evaluated",
    diagnostics: [],
  };
}

test("installed inspection fails on plausible but wrong runtime, unavailable source and partial results", () => {
  const expected = {
    packageRoot: "/consumer/node_modules/auggy",
    manifestSHA256: "local-manifest",
    entrypoint: "/consumer/src/index.ts",
  };
  assertInstalledAuthoringInspection(report(), expected);
  expect(() =>
    assertInstalledAuthoringInspection(report(), {
      ...expected,
      packageRoot: "/global/node_modules/auggy",
    }),
  ).toThrow("wrong installed runtime");
  expect(() =>
    assertInstalledAuthoringInspection(report(), { ...expected, manifestSHA256: "other-artifact" }),
  ).toThrow("wrong installed runtime");
  expect(() =>
    assertInstalledAuthoringInspection({ ...report(), status: "partial" }, expected),
  ).toThrow("complete");
  const present = report();
  const missing: InspectionReport = {
    ...present,
    execution: {
      ...present.execution,
      runtime: {
        ...present.execution.runtime,
        host: { ownership: "package", status: "missing", path: null },
      },
    },
  };
  expect(() => assertInstalledAuthoringInspection(missing, expected)).toThrow(
    "installed runtime implementation",
  );
  expect(typeof runGeneratedAuthoringInspection).toBe("function");
});
