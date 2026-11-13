/** Parse passive authoring commands before loading the ordinary CLI program. */
import { Command, CommanderError } from "commander";
import {
  createInspectCommand,
  createMigrateCommand,
  type InspectCommandOptions,
  type MigrateCommandOptions,
} from "./authoring-command-options";

export interface AuthoringCommandHandlers {
  inspect(name: string | undefined, options: InspectCommandOptions): number | Promise<number>;
  migrate(name: string | undefined, options: MigrateCommandOptions): number | Promise<number>;
}

export function registerAuthoringCommands(
  program: Command,
  handlers: AuthoringCommandHandlers,
  complete: (code: number) => void = (code) => {
    process.exitCode = code;
  },
): void {
  program.addCommand(
    createInspectCommand().action(async (name, options) => {
      complete(await handlers.inspect(name, options));
    }),
  );
  program.addCommand(
    createMigrateCommand().action(async (name, options) => {
      complete(await handlers.migrate(name, options));
    }),
  );
}

export async function dispatchAuthoringCommand(
  argv: readonly string[],
  handlers: AuthoringCommandHandlers,
): Promise<number | null> {
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  if (args[0] !== "inspect" && args[0] !== "migrate") return null;
  const program = new Command("auggy").exitOverride();
  let code = 0;
  registerAuthoringCommands(program, handlers, (result) => {
    code = result;
  });
  for (const command of program.commands) command.exitOverride();
  try {
    await program.parseAsync([...argv], { from: "user" });
    return code;
  } catch (error) {
    if (error instanceof CommanderError) return error.exitCode;
    throw error;
  }
}
