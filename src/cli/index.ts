#!/usr/bin/env bun
/**
 * auggy — CLI for the Auggy modular agent runtime.
 *
 * Commands:
 *   auggy create <name>              Scaffold a new agent directory
 *   auggy dev <name> [--config path] Run agent in foreground
 *   auggy start <name> [--config]    Install as launchd service (always-on)
 *   auggy stop <name>                Stop a running agent
 *   auggy status [name]              Show running agents
 */

import { Command } from "commander";
import { runCreate } from "./commands/create";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runStatus } from "./commands/status";

const program = new Command();

program
  .name("auggy")
  .description("Auggy modular agent runtime CLI")
  .version("0.1.0");

program
  .command("create <name>")
  .description("Scaffold a new agent directory")
  .option("--dir <path>", "target directory (defaults to ./<name>)")
  .option("--purpose <text>", "agent purpose description")
  .action(async (name: string, opts: { dir?: string; purpose?: string }) => {
    try {
      await runCreate(name, opts);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

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

program.parse();
