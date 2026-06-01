/**
 * auggy start <name> — install an agent as a launchd service.
 *
 * Generates a plist, symlinks it to ~/Library/LaunchAgents/, and
 * loads it via launchctl. The plist invokes `auggy dev <name>` so
 * launchd handles daemonization and restart.
 */

import { mkdirSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { $ } from "bun";
import { parseConfig } from "../config-parser";
import {
  generatePlist,
  plistLabel,
  plistStorePath,
  plistInstallPath,
  logDir,
} from "../plist-generator";
import { readPidManifest, tryClaimName } from "../pid-registry";
import { resolveConfigPath } from "../resolve-config";

function resolveBunPath(): string {
  return process.execPath;
}

function resolveCliEntryPoint(): string {
  return resolve(import.meta.dir, "../index.ts");
}

export async function runStart(
  name: string | undefined,
  opts: { config?: string; cwd?: string },
): Promise<void> {
  const configPath = resolveConfigPath(name, opts.config, { cwd: opts.cwd });
  const agentDir = dirname(configPath);

  // Validate config before installing.
  const config = parseConfig(configPath);
  const agentName = config.name;

  // Check if already running.
  if (!tryClaimName(agentName)) {
    throw new Error(
      `Agent "${agentName}" is already running. Use "auggy stop ${agentName}" first.`,
    );
  }

  // Unload existing plist if present.
  const label = plistLabel(agentName);
  const installPath = plistInstallPath(agentName);
  try {
    const result = await $`launchctl list`.quiet();
    if (result.stdout.toString().includes(label)) {
      await $`launchctl unload ${installPath}`.quiet();
    }
  } catch {}

  // Clean up old plist files.
  const storePath = plistStorePath(agentName);
  try {
    unlinkSync(installPath);
  } catch {}
  try {
    unlinkSync(storePath);
  } catch {}

  // Generate plist.
  const plist = generatePlist({
    name: agentName,
    agentDir: resolve(agentDir),
    configPath: resolve(configPath),
    bunPath: resolveBunPath(),
    cliEntryPoint: resolveCliEntryPoint(),
  });

  // Ensure directories exist.
  mkdirSync(dirname(storePath), { recursive: true });
  mkdirSync(dirname(installPath), { recursive: true });
  mkdirSync(logDir(), { recursive: true });

  // Write plist and symlink to LaunchAgents.
  writeFileSync(storePath, plist);
  symlinkSync(storePath, installPath);

  // Load into launchd.
  try {
    await $`launchctl load ${installPath}`.quiet();
  } catch (err: unknown) {
    const stderr = (err as { stderr?: { toString(): string } }).stderr?.toString() ?? "";
    if (!stderr.includes("service already loaded")) {
      throw new Error(`launchctl load failed: ${stderr.trim() || (err as Error).message}`);
    }
  }

  // Poll for the agent to start.
  const MAX_WAIT = 8_000;
  const POLL_INTERVAL = 500;
  let waited = 0;

  while (waited < MAX_WAIT) {
    await Bun.sleep(POLL_INTERVAL);
    waited += POLL_INTERVAL;

    const manifest = readPidManifest(agentName);
    if (manifest) {
      console.log(`Agent "${agentName}" installed and running (PID ${manifest.pid})`);
      console.log();
      console.log(`  Mode:    always-on (launchd-managed)`);
      console.log(`  Restart: automatic on crash`);
      if (manifest.port) {
        console.log(`  URL:     http://localhost:${manifest.port}`);
      }
      console.log(`  Logs:    ${logDir()}/${agentName}.{log,err}`);
      console.log();
      console.log(`  To stop:   auggy stop ${agentName}`);
      console.log(`  To status: auggy status ${agentName}`);
      console.log(`  To logs:   tail -f ${logDir()}/${agentName}.log`);
      return;
    }
  }

  console.error(`Agent "${agentName}" did not start within ${MAX_WAIT / 1000}s.`);
  console.error(`Check logs: tail -20 ${logDir()}/${agentName}.err`);
  process.exit(1);
}
