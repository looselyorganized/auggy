/** Handlers stay lazy so inspection and previews never load the ordinary CLI graph. */
import type { AuthoringCommandHandlers } from "./authoring-bootstrap";
import { AuthoringError } from "./authoring/document-io";

export const authoringCommandHandlers: AuthoringCommandHandlers = {
  async inspect(name, options) {
    return (await import("./commands/inspect")).runInspect(name, options);
  },
  async migrate(name, options) {
    const modulePath = "./commands/migrate.ts";
    const command = (await import(modulePath)) as {
      runMigrate: AuthoringCommandHandlers["migrate"];
    };
    return command.runMigrate(name, options);
  },
  async syntaxError(command) {
    const error = new AuthoringError(
      "invalid-cli-syntax",
      `Use auggy ${command} --help to review supported arguments.`,
    );
    if (command === "inspect") {
      const { createInvalidInspectionReport } = await import("./authoring/inspection");
      console.log(JSON.stringify(createInvalidInspectionReport("", error)));
    } else {
      console.log(
        JSON.stringify({ schemaVersion: 1, status: "invalid", diagnostics: [error.diagnostic] }),
      );
    }
  },
};
