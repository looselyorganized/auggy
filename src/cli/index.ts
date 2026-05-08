#!/usr/bin/env bun
/**
 * auggy — CLI for the Auggy agent runtime.
 *
 * Commands:
 *   auggy create <name>              Scaffold a new agent (interactive)
 *   auggy add <name>                 Add augments to an existing agent
 *   auggy add-skill <augment>        Install a bundled skill into an agent
 *   auggy dev <name> [--config]      Run agent in foreground
 *   auggy start <name> [--config]    Install as launchd service (always-on)
 *   auggy stop <name>                Stop a running agent
 *   auggy restart <name>             Stop + start
 *   auggy status [name]              Show running agents
 *   auggy ls                         List registered agents
 *   auggy remove <name> [--yes]      Delete an agent (dir + index entry)
 *   auggy chat                       Launch local GUI
 *   auggy eval [name]                Run portable security eval suite
 */

import { Command } from "commander";
import { runCreate } from "./commands/create";
import { runAdd } from "./commands/add";
import { addSkillCommand } from "./commands/add-skill";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";
import { chatCommand } from "./commands/chat";
import { evalCommand } from "./commands/eval";
import { runRemove } from "./commands/remove";
import { runLs } from "./commands/ls";

const program = new Command();

program.name("auggy").description("Auggy agent runtime CLI").version("0.1.0");

program
  .command("create <name>")
  .description("Scaffold a new agent directory (interactive)")
  .option("--dir <path>", "target directory (defaults to ./<name>)")
  .action(async (name: string, opts: { dir?: string }) => {
    try {
      await runCreate(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("add <name>")
  .description("Add augments to an existing agent")
  .option("--config <path>", "path to agent.yaml")
  .action(async (name: string, opts: { config?: string }) => {
    try {
      await runAdd(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.addCommand(addSkillCommand());

program
  .command("dev <name>")
  .description("Run an agent in the foreground (Ctrl-C to stop)")
  .option("--config <path>", "path to agent.yaml")
  .option("--internal-mode <mode>", "(internal) process mode for PID manifest")
  .action(async (name: string, opts: { config?: string; internalMode?: string }) => {
    try {
      await runDev(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("start <name>")
  .description("Install agent as a launchd service (always-on)")
  .option("--config <path>", "path to agent.yaml")
  .action(async (name: string, opts: { config?: string }) => {
    try {
      await runStart(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("stop <name>")
  .description("Stop a running agent")
  .action(async (name: string) => {
    try {
      await runStop(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("restart <name>")
  .description("Stop and restart a running agent")
  .option("--config <path>", "path to agent.yaml")
  .action(async (name: string, opts: { config?: string }) => {
    try {
      await runRestart(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("status [name]")
  .description("Show running agents or detail a specific one")
  .action(async (name?: string) => {
    try {
      await runStatus(name);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("remove <name>")
  .description("Remove an agent (delete dir + clear index entry)")
  .option("--yes", "skip the confirmation prompt")
  .action(async (name: string, opts: { yes?: boolean }) => {
    try {
      await runRemove(name, { yes: opts.yes });
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("ls")
  .description("List registered agents with their status")
  .action(async () => {
    try {
      await runLs();
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program
  .command("visitors <agent>")
  .description("list verified visitors for an agent")
  .option("--revoke <email>", "revoke a verified visitor by email")
  .option("--yes", "skip the confirmation prompt for --revoke")
  .action(async (agentName: string, options: { revoke?: string; yes?: boolean }) => {
    try {
      if (options.revoke) {
        const { runVisitorsRevoke } = await import("./commands/visitors-revoke");
        await runVisitorsRevoke(agentName, options.revoke, { confirm: options.yes !== true });
        return;
      }
      const { runVisitorsList } = await import("./commands/visitors");
      await runVisitorsList(agentName);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.addCommand(chatCommand());
program.addCommand(evalCommand());

program.parse();
