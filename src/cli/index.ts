#!/usr/bin/env bun
/**
 * auggy — CLI for the Auggy agent runtime.
 *
 * Commands:
 *   auggy create <name>              Scaffold a new agent (interactive)
 *   auggy add [name] [augment]       Add augments to an existing agent (shortcut)
 *   auggy augment add <augment>      Add an augment to an agent
 *   auggy augment remove <augment>   Remove an augment from an agent
 *   auggy augment list               List augments in an agent
 *   auggy skill add <augment>        Repair/reinstall a bundled skill
 *   auggy run [name] [--no-open]     Run agent in foreground; opens /console/chat by default
 *   auggy doctor [name]              Check whether an agent is ready to run
 *   auggy augment create <slug>      Scaffold a local custom augment
 *   auggy dev [name] [--open]        Run agent in foreground; --open pops /console in browser
 *   auggy start [name] [--config]    Install as launchd service (always-on)
 *   auggy stop <name>                Stop a running agent
 *   auggy restart <name>             Stop + start
 *   auggy status [name]              Show running agents
 *   auggy list                       List agent projects in this directory
 *   auggy remove [name] [--yes] [--cloud]  Delete an agent project, optionally Railway service
 *   auggy deploy [name]             Deploy an agent to Railway
 *   auggy logs [name]               Show Railway logs for a deployed agent
 *   auggy chat                       Launch local GUI
 *   auggy eval [name]                Run portable security eval suite
 */

import { Command } from "commander";
import pkg from "../../package.json" with { type: "json" };
import { runCreate } from "./commands/create";
import { runAdd } from "./commands/add";
import { skillCommand } from "./commands/add-skill";
import { runCommand } from "./commands/run";
import { doctorCommand } from "./commands/doctor";
import { augmentCommand } from "./commands/augment";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";
import { chatCommand } from "./commands/chat";
import { evalCommand } from "./commands/eval";
import { runRemove } from "./commands/remove";
import { runLs } from "./commands/ls";
import { withBrailleSpinner } from "./spinner";

export function buildCli(): Command {
  const program = new Command();

  program.name("auggy").description("Auggy agent runtime CLI").version(pkg.version);

  program
    .command("create <name>")
    .description("Scaffold a standalone agent project at ./<name> (interactive)")
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
    .command("add [target] [augment]")
    .description("Add augments to an existing agent")
    .option("--config <path>", "path to agent.yaml")
    .option("--skip-install", "mutate package.json but don't run bun install")
    .option("--yes", "skip preview augment confirmation prompts")
    .action(
      async (
        target: string | undefined,
        augment: string | undefined,
        opts: { config?: string; skipInstall?: boolean; yes?: boolean },
      ) => {
        try {
          await runAdd(target, { ...opts, augment });
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program
    .command("init [name]")
    .description("Initialize the current directory as an Auggy agent project")
    .option("--skip-install", "write package.json but don't run bun install")
    .action(async (name: string | undefined, opts: { skipInstall?: boolean }) => {
      try {
        const { runInit } = await import("./commands/create");
        await runInit({ name, skipInstall: opts.skipInstall });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program.addCommand(skillCommand());
  program.addCommand(runCommand());
  program.addCommand(doctorCommand());
  program.addCommand(augmentCommand());

  program
    .command("dev [name]")
    .description("Run an agent in the foreground (Ctrl-C to stop)")
    .option("--config <path>", "path to agent.yaml")
    .option("--open", "auto-launch the operator's browser to /console/chat once the agent is up")
    .option("--internal-mode <mode>", "(internal) process mode for PID manifest")
    .action(
      async (
        name: string | undefined,
        opts: { config?: string; open?: boolean; internalMode?: string },
      ) => {
        try {
          await runDev(name, opts);
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program
    .command("start [name]")
    .description("Install agent as a launchd service (always-on)")
    .option("--config <path>", "path to agent.yaml")
    .action(async (name: string | undefined, opts: { config?: string }) => {
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
    .command("remove [name]")
    .description("Remove an agent project (--cloud also destroys the Railway service)")
    .option("--yes", "skip the confirmation prompt")
    .option("--cloud", "also destroy the agent's Railway service (when cloud-deployed)")
    .action(async (name: string | undefined, opts: { yes?: boolean; cloud?: boolean }) => {
      try {
        await runRemove(name, { yes: opts.yes, cloud: opts.cloud });
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("list")
    .description("List agent projects in this directory with their status")
    .action(async () => {
      try {
        await runLs();
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("visitors <name>")
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
    .command("logs [name]")
    .description("Show Railway logs for a deployed agent")
    .action(async (name: string | undefined) => {
      try {
        const { runLogs } = await import("./commands/logs");
        await runLogs(name);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        process.exit(1);
      }
    });

  program
    .command("deploy [name]")
    .description("Deploy an agent to the cloud (--to railway)")
    .option("--to <provider>", "deploy target (only `railway` supported in v1.0)", "railway")
    .option("--project <project-id>", "deploy into an existing Railway project")
    .option("--service <name-or-id>", "deploy into an existing Railway service")
    .option("--yes", "skip the secrets-push confirmation prompt")
    .action(
      async (
        name: string | undefined,
        opts: { to: string; project?: string; service?: string; yes?: boolean },
      ) => {
        try {
          const { runDeploy } = await import("./commands/deploy");
          const { createRailwayCli } = await import("./deploy/railway-cli");
          const { input, confirm, select } = await import("@inquirer/prompts");

          const cli = createRailwayCli();
          const result = await runDeploy(name, {
            to: opts.to as "railway",
            yes: opts.yes ?? false,
            project: opts.project,
            service: opts.service,
            cli,
            promptProjectTarget: () =>
              select({
                message: "Railway target:",
                choices: [
                  {
                    name: `Create a new Railway project for ${name ?? "this agent"}`,
                    value: "new" as const,
                  },
                  { name: "Use an existing Railway project", value: "existing" as const },
                ],
              }),
            promptProjectName: (defaultName) =>
              input({
                message: "New Railway project name:",
                default: defaultName,
                validate: (v) => v.trim().length > 0 || "project name required",
              }),
            promptProjectId: () =>
              input({
                message:
                  "Railway project ID (find it in the Railway dashboard URL or via `railway list`):",
                validate: (v) => v.trim().length > 0 || "project ID required",
              }),
            promptConfirm: (message) => confirm({ message, default: false }),
            logger: {
              info: (msg) => console.log(msg),
              warn: (msg) => console.warn(formatWarning(msg)),
              error: (msg) => console.error(`error: ${msg}`),
              task: (msg, run) => withBrailleSpinner(msg, run),
            },
          });
          console.log(
            result.health.ok
              ? `\n${result.name} is live on Railway.`
              : `\nRailway build submitted for ${result.name}.`,
          );
          console.log(`  URL:        ${result.url}`);
          console.log(`  Project:    ${result.projectId}`);
          console.log(`  Service:    ${result.serviceId}`);
          console.log(`  Volume:     ${result.volumeId} (mounted at /app/data)`);
          console.log(
            `  Health:     ${result.health.url}${result.health.ok ? "" : " (not healthy yet)"}`,
          );
          console.log(
            `  Chat:       ${new URL("/console/chat", result.url).toString()}${
              result.health.ok ? "" : " (when healthy)"
            }`,
          );
          console.log(
            `  Console:    ${new URL("/console", result.url).toString()}${
              result.health.ok ? "" : " (when healthy)"
            }`,
          );
          console.log(
            `  Sign-in:    username auggy, password AUGGY_WEB_TOKEN from this agent's .env`,
          );
          if (!result.health.ok) {
            const rerun = name ? `auggy deploy ${name} --yes` : "auggy deploy --yes";
            console.log(
              `\nHealth is pending while Railway finishes the build/startup. If it does not become healthy, check \`railway logs\`, then rerun \`${rerun}\`.`,
            );
          } else {
            console.log(
              `\nCurrent health is passing. Follow the new build in the Railway dashboard or with \`railway logs\`.`,
            );
          }
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program.addCommand(chatCommand());
  program.addCommand(evalCommand());

  return program;
}

if (import.meta.main) {
  buildCli().parse();
}

function formatWarning(msg: string): string {
  const label = process.stderr.isTTY ? "\x1b[33mWARN\x1b[0m" : "WARN";
  return `\n${label}: ${msg}\n`;
}
