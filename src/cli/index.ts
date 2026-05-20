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
 *   auggy remove <name> [--yes] [--cloud]  Delete an agent (dir + index, optionally Railway service)
 *   auggy deploy <name> --to railway       Deploy an agent to Railway
 *   auggy chat                       Launch local GUI
 *   auggy eval [name]                Run portable security eval suite
 */

import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
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

program.name("auggy").description("Auggy agent runtime CLI").version(pkg.version);

program
  .command("create <name>")
  .description("Scaffold a new agent at ~/.auggy/agents/<name>/ (interactive)")
  .option("--skip-install", "write package.json but don't run bun install")
  .action(async (name: string, opts: { skipInstall?: boolean }) => {
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
  .option("--skip-install", "mutate package.json but don't run bun install")
  .action(async (name: string, opts: { config?: string; skipInstall?: boolean }) => {
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
  .description(
    "Remove an agent (delete dir + clear index entry; --cloud also destroys Railway service)",
  )
  .option("--yes", "skip the confirmation prompt")
  .option("--cloud", "also destroy the agent's Railway service (when cloud-deployed)")
  .action(async (name: string, opts: { yes?: boolean; cloud?: boolean }) => {
    try {
      await runRemove(name, { yes: opts.yes, cloud: opts.cloud });
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

program
  .command("deploy <name>")
  .description("Deploy an agent to the cloud (--to railway)")
  .option("--to <provider>", "deploy target (only `railway` supported in v1.0)", "railway")
  .option("--yes", "skip the secrets-push confirmation prompt")
  .action(async (name: string, opts: { to: string; yes?: boolean }) => {
    try {
      const { runDeploy } = await import("./commands/deploy");
      const { createRailwayCli } = await import("./deploy/railway-cli");
      const { input, confirm } = await import("@inquirer/prompts");

      const cli = createRailwayCli();
      const result = await runDeploy(name, {
        to: opts.to as "railway",
        yes: opts.yes ?? false,
        cli,
        promptProjectId: () =>
          input({
            message:
              "Railway project ID (find it in the Railway dashboard URL or via `railway list`):",
            validate: (v) => v.trim().length > 0 || "project ID required",
          }),
        promptConfirm: (message) => confirm({ message, default: false }),
        logger: {
          info: (msg) => console.log(msg),
          warn: (msg) => console.warn(`warn: ${msg}`),
          error: (msg) => console.error(`error: ${msg}`),
        },
      });
      console.log(`\nDeployed ${name} to Railway.`);
      console.log(`  URL:        ${result.url}`);
      console.log(`  Project:    ${result.projectId}`);
      console.log(`  Service:    ${result.serviceId}`);
      console.log(`  Volume:     ${result.volumeId} (mounted at /app/data)`);
      console.log(`\nFollow the build in the Railway dashboard or with \`railway logs\`.`);
    } catch (err) {
      console.error(`Error: ${(err as Error).message}`);
      process.exit(1);
    }
  });

program.addCommand(chatCommand());
program.addCommand(evalCommand());

program.parse();
