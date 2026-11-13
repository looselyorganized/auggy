/**
 * `auggy run <name>` — happy-path local runner.
 *
 * This is the operator-facing alias for `auggy dev <name> --open`: run the
 * agent in the foreground and open the browser to `/console/chat` when the
 * web transport is mounted.
 */

import type { Command } from "commander";
import { createLaunchCommand } from "../launch-command-options";
import { runDev, type DevOpts } from "./dev";

export interface RunCommandDeps {
  runDev?: (name: string | undefined, opts: DevOpts) => Promise<void>;
  exit?: (code: number) => void;
}

export function runCommand(deps: RunCommandDeps = {}): Command {
  const run = deps.runDev ?? runDev;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return createLaunchCommand("run").action(
    async (name: string, opts: { config?: string; open: boolean }) => {
      try {
        await run(name, { config: opts.config, open: opts.open });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    },
  );
}
