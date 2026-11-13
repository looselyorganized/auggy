#!/usr/bin/env bun
import { createRequire } from "node:module";
import { dispatchAuthoringCommand } from "./authoring-bootstrap";
import { authoringCommandHandlers } from "./authoring-command-handlers";

// Keep the synchronous programmatic API without evaluating command handlers
// before the binary has selected the project's explicit local installation.
type CliProgram = typeof import("./cli-program");
const require = createRequire(import.meta.url);
function program(): CliProgram {
  return require("./cli-program.ts") as CliProgram;
}

export const buildCli: CliProgram["buildCli"] = (...args) => program().buildCli(...args);
export const describeSavedRailwayTarget: CliProgram["describeSavedRailwayTarget"] = (...args) =>
  program().describeSavedRailwayTarget(...args);
export const formatDeployInfoLine: CliProgram["formatDeployInfoLine"] = (...args) =>
  program().formatDeployInfoLine(...args);
export const formatDeployResultMessage: CliProgram["formatDeployResultMessage"] = (...args) =>
  program().formatDeployResultMessage(...args);

if (import.meta.main) {
  try {
    const argv = process.argv.slice(2);
    const authoring = await dispatchAuthoringCommand(argv, authoringCommandHandlers);
    if (authoring !== null) process.exitCode = authoring;
    else {
      const { bootstrapCli } = await import("./command-bootstrap");
      const result = await bootstrapCli(argv);
      if (result.kind === "handled") process.exitCode = result.exitCode;
      else await buildCli().parseAsync(result.argv, { from: "user" });
    }
  } catch (error) {
    console.error(`Error: ${error instanceof Error ? error.message : "CLI operation failed"}`);
    process.exitCode = 1;
  }
}
