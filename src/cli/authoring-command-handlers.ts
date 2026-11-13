/** Handlers stay lazy so inspection and previews never load the ordinary CLI graph. */
import type { AuthoringCommandHandlers } from "./authoring-bootstrap";
import { AuthoringError } from "./authoring/document-io";

export const authoringCommandHandlers: AuthoringCommandHandlers = {
  async inspect(name, options) {
    return (await import("./commands/inspect")).runInspect(name, options);
  },
  async migrate(name, options) {
    return (await import("./commands/migrate")).runMigrate(name, options);
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
      const { createInvalidMigrationReport } = await import("./authoring/migration");
      console.log(JSON.stringify(createInvalidMigrationReport(error)));
    }
  },
};
