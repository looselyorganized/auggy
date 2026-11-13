import { expect, test } from "bun:test";
import * as application from "../../src/application/index";
import * as agentCompatibility from "../../src/internal/agent";
import pkg from "../../package.json";
import type { ApplicationRunner } from "../../src/types";

// The declaration facade and executable implementation share this contract.
const runner: ApplicationRunner = application.runApplication;

test("public application and compatibility exports do not expose host admission controls", () => {
  expect(Object.keys(application)).toEqual(["runApplication"]);
  expect(runner).toBe(application.runApplication);
  expect(Object.keys(agentCompatibility)).toEqual(["defineAgent"]);
  expect(pkg.exports["./application"]).toEqual({
    types: "./src/application/public.d.ts",
    default: "./src/application/index.ts",
  });
  expect(pkg.exports["./internal/agent"]).toBe("./src/internal/agent.ts");
  expect(pkg.auggyRuntime).toEqual({
    schemaVersion: 1,
    launcherProtocol: 1,
    applicationContracts: [1],
  });
});
