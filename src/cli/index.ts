#!/usr/bin/env bun
/**
 * aug1 — CLI for the Auggy agent runtime.
 *
 * Commands:
 *   aug1 create <name>              Scaffold a new agent (interactive)
 *   aug1 add <name>                 Add augments to an existing agent
 *   aug1 dev <name> [--config]      Run agent in foreground
 *   aug1 start <name> [--config]    Install as launchd service (always-on)
 *   aug1 stop <name>                Stop a running agent
 *   aug1 restart <name>             Stop + start
 *   aug1 status [name]              Show running agents
 */

import { Command } from "commander";
import { runCreate } from "./commands/create";
import { runAdd } from "./commands/add";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";

const program = new Command();

program.name("aug1").description("Auggy agent runtime CLI").version("0.1.0");

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

program.parse();
