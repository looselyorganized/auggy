/**
 * `auggy run <name>` — happy-path local runner.
 *
 * This is the operator-facing alias for `auggy dev <name> --open`: run the
 * agent in the foreground and open the browser to `/console/chat` when the
 * web transport is mounted.
 */

import { Command } from "commander";
import { runDev, type DevOpts } from "./dev";

export interface RunCommandDeps {
  runDev?: (name: string | undefined, opts: DevOpts) => Promise<void>;
  exit?: (code: number) => void;
}

export function runCommand(deps: RunCommandDeps = {}): Command {
  const run = deps.runDev ?? runDev;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("run")
    .description("Run an agent locally and open /console/chat with a one-time sign-in")
    .argument("[name]", "agent name (defaults to ./agent.yaml)")
    .option("--config <path>", "path to agent.yaml")
    .option("--no-open", "don't launch a browser after boot")
    .action(async (name: string, opts: { config?: string; open: boolean }) => {
      try {
        await run(name, { config: opts.config, open: opts.open });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });
}
