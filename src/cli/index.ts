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
 *   auggy models list [provider]     List known/provider engine models
 *   auggy routes [name]              Show custom HTTP routes registered by an agent
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
import { routesCommand } from "./commands/routes";
import { augmentCommand } from "./commands/augment";
import { runDev } from "./commands/dev";
import { runStart } from "./commands/start";
import { runStop } from "./commands/stop";
import { runRestart } from "./commands/restart";
import { runStatus } from "./commands/status";
import { chatCommand } from "./commands/chat";
import { evalCommand } from "./commands/eval";
import { mcpCommand } from "./commands/mcp";
import { modelsCommand } from "./commands/models";
import { runRemove } from "./commands/remove";
import { runLs } from "./commands/ls";
import { withBrailleSpinner } from "./spinner";
import type { DeployResult } from "./commands/deploy";
import { failureMark, successMark, warningLabel, type CliStyleOptions } from "./_shared/styles";

export function buildCli(): Command {
  const program = new Command();

  program.name("auggy").description("Auggy agent runtime CLI").version(pkg.version);

  program
    .command("create <name>")
    .description("Scaffold a standalone agent project at ./<name> (interactive)")
    .option("--skip-install", "write package.json but don't run bun install")
    .option("--refresh-models", "fetch live provider model catalogs before model selection")
    .action(async (name: string, opts: { skipInstall?: boolean; refreshModels?: boolean }) => {
      try {
        assertInteractiveCommand("auggy create");
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
    .option("--refresh-models", "fetch live provider model catalogs before model selection")
    .action(
      async (
        name: string | undefined,
        opts: { skipInstall?: boolean; refreshModels?: boolean },
      ) => {
        try {
          assertInteractiveCommand("auggy init");
          const { runInit } = await import("./commands/create");
          await runInit({
            name,
            skipInstall: opts.skipInstall,
            refreshModels: opts.refreshModels,
          });
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          process.exit(1);
        }
      },
    );

  program.addCommand(skillCommand());
  program.addCommand(runCommand());
  program.addCommand(doctorCommand());
  program.addCommand(modelsCommand());
  program.addCommand(routesCommand());
  program.addCommand(augmentCommand());
  program.addCommand(mcpCommand());

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
    .option("--workspace <workspace>", "Railway workspace ID or name when creating a new project")
    .option("--yes", "skip the secrets-push confirmation prompt")
    .action(
      async (
        name: string | undefined,
        opts: { to: string; project?: string; service?: string; workspace?: string; yes?: boolean },
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
            workspace: opts.workspace,
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
            promptWorkspace: async (workspaces) => {
              const manual = "__manual__";
              if (workspaces.length > 0) {
                const selected = await select({
                  message: "Create this project in Railway workspace:",
                  choices: [
                    ...workspaces.map((workspace) => ({
                      name: workspace.name,
                      value: workspace.id,
                    })),
                    { name: "Enter workspace manually", value: manual },
                  ],
                });
                if (selected !== manual) return selected;
              }
              return input({
                message:
                  "Railway workspace name or ID (personal/team workspace, not project name):",
                validate: (v) => v.trim().length > 0 || "workspace required",
              });
            },
            promptConfirm: (message) => confirm({ message, default: false }),
            logger: {
              info: (msg) => {
                const line = formatDeployInfoLine(msg);
                if (line) console.log(line);
              },
              warn: (msg) => console.warn(formatWarning(msg)),
              error: (msg) => console.error(`error: ${msg}`),
              task: (msg, run) =>
                withBrailleSpinner(msg, run, {
                  failureText: `${failureMark()} ${msg}`,
                }),
            },
          });
          console.log(formatDeployResultMessage(result, { nameArg: name }));
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

function assertInteractiveCommand(command: string): void {
  if (process.stdin.isTTY) return;
  throw new Error(
    `${command} is interactive and needs a terminal.\n\n` +
      "  Run it directly in your shell, or use a terminal/PTY in automation.",
  );
}

if (import.meta.main) {
  buildCli().parse();
}

function formatWarning(msg: string): string {
  return `\n${warningLabel({ color: process.stderr.isTTY })}: ${msg}\n`;
}

export function formatDeployInfoLine(msg: string, style: CliStyleOptions = {}): string | null {
  const check = successMark(style);

  if (/^Bundle staged at /.test(msg)) return null;
  if (/^Vendored local Auggy runtime /.test(msg)) return null;
  if (/^Linked staging dir /.test(msg)) return null;

  if (msg === "Deploy preflight passed.") return `${check} Deploy preflight passed`;
  if (msg === "Railway CLI ready.") return `${check} Railway CLI ready`;
  if (msg === "Build started. Railway will build the image, deploy it, then start the service.") {
    return `${check} Build started`;
  }

  let match = msg.match(/^Using Railway workspace "(.+)"\.$/);
  if (match) return `${check} Railway workspace: ${match[1]}`;

  match = msg.match(/^Created Railway project (.+) \((.+)\)\.$/);
  if (match) return `${check} Created Railway project ${match[1]} (${match[2]})`;

  match = msg.match(/^First deploy of (.+) to existing Railway project (.+)\.$/);
  if (match) return `${check} Railway project: ${match[2]}`;

  match = msg.match(/^Redeploying (.+) to Railway project (.+)\.$/);
  if (match) return `${check} Railway project: ${match[2]}`;

  match = msg.match(/^Created Railway service (.+)\.$/);
  if (match) return `${check} Created Railway service ${match[1]}`;

  match = msg.match(/^Using existing Railway service (.+)\.$/);
  if (match) return `${check} Railway service: ${match[1]}`;

  match = msg.match(/^Volume "(.+)" mounted at (.+)\.$/);
  if (match) return `${check} Mounted volume ${match[1]} at ${match[2]}`;

  match = msg.match(/^Public URL: (.+)$/);
  if (match) return `${check} Public URL: ${match[1]}`;

  match = msg.match(/^Pushed (.+ env var\(s\)) to Railway\.$/);
  if (match) return `${check} Pushed ${match[1]} to Railway`;

  match = msg.match(/^Railway deployment finished: (.+)\.$/);
  if (match) return `${check} Build successful (${match[1]})`;

  match = msg.match(/^Deployment health verified: (.+)$/);
  if (match) return `${check} Service is healthy: ${match[1]}`;

  match = msg.match(/^Service status: (.+)\.$/);
  if (match) return `${check} Railway status: ${match[1]}`;

  match = msg.match(
    /^Railway deployment status not final yet; continuing with health check \((.+)\)\.$/,
  );
  if (match) return `Railway status pending: ${match[1]}`;

  match = msg.match(
    /^Deployment health is pending \((.+)\)\. Railway may still be building or starting the service\.$/,
  );
  if (match) return `Health check pending: ${match[1]}`;

  return msg;
}

export function formatDeployResultMessage(
  result: DeployResult,
  opts: { nameArg?: string | undefined } = {},
): string {
  const rerun = opts.nameArg ? `auggy deploy ${opts.nameArg} --yes` : "auggy deploy --yes";
  const chatUrl = new URL("/console/chat", result.url).toString();
  const consoleUrl = new URL("/console", result.url).toString();
  const healthSuffix = result.health.ok ? "" : " (pending)";
  const appSuffix = result.health.ok ? "" : " (when healthy)";
  const lines = [
    "",
    result.health.ok
      ? `${result.name} is live on Railway.`
      : `Railway build submitted for ${result.name}.`,
    "",
    `  Chat:     ${chatUrl}${appSuffix}`,
    `  Console:  ${consoleUrl}${appSuffix}`,
    `  Health:   ${result.health.url}${healthSuffix}`,
    `  Home:     ${result.url}`,
    "",
    result.health.ok ? "Manage it:" : "Next:",
    "  auggy logs",
    `  ${rerun.padEnd(24)} Redeploy`,
    "",
    "Details:",
    `  Project:  ${result.projectId}`,
    `  Service:  ${result.serviceId}`,
    `  Volume:   ${result.volumeId} (mounted at /app/data)`,
    `  Sign-in:  username auggy, password AUGGY_WEB_TOKEN from .env`,
  ];

  if (!result.health.ok) {
    lines.push("");
    lines.push("Health is pending. Check `auggy logs`, then redeploy after fixing the service.");
  }

  return lines.join("\n");
}
