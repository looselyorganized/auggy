/**
 * launchd plist generator — creates a macOS plist that keeps an
 * Auggy agent alive via launchd.
 *
 * The plist invokes `auggy dev <name>` (the foreground runner) and
 * lets launchd handle daemonization, restart, and log routing.
 *
 * Pattern replicated from telemetry-exporter/com.lo.telemetry-exporter.plist.
 */

import { homedir } from "os";
import { dirname, join } from "path";

export interface PlistOptions {
  /** Agent name (used in label and log file names). */
  name: string;
  /** Absolute path to the agent directory. */
  agentDir: string;
  /** Absolute path to agent.yaml. */
  configPath: string;
  /** Absolute path to the bun binary. */
  bunPath: string;
  /** Absolute path to the auggy CLI entrypoint (src/cli/index.ts). */
  cliEntryPoint: string;
}

/** The launchd label for an agent. */
export function plistLabel(name: string): string {
  return `com.auggy.agent.${name}`;
}

/** Where generated plists are stored. */
export function plistStorePath(name: string): string {
  return join(homedir(), ".auggy", "plists", `${plistLabel(name)}.plist`);
}

/** Where the symlink goes in ~/Library/LaunchAgents/. */
export function plistInstallPath(name: string): string {
  return join(
    homedir(),
    "Library",
    "LaunchAgents",
    `${plistLabel(name)}.plist`,
  );
}

/** Log directory for agent stdout/stderr. */
export function logDir(): string {
  return join(homedir(), ".auggy", "logs");
}

function escapeXml(s: string): string {
  return s
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

/**
 * Generate a launchd plist XML string for an Auggy agent.
 *
 * The plist runs `bun run <cliEntryPoint> dev <name> --config <configPath>`
 * with KeepAlive=true so launchd restarts on crash.
 */
export function generatePlist(opts: PlistOptions): string {
  const label = plistLabel(opts.name);
  const bunDir = dirname(opts.bunPath);
  const home = homedir();
  const logs = logDir();

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(opts.bunPath)}</string>
    <string>run</string>
    <string>${escapeXml(opts.cliEntryPoint)}</string>
    <string>dev</string>
    <string>${escapeXml(opts.name)}</string>
    <string>--config</string>
    <string>${escapeXml(opts.configPath)}</string>
    <string>--internal-mode</string>
    <string>launchd</string>
  </array>

  <key>WorkingDirectory</key>
  <string>${escapeXml(opts.agentDir)}</string>

  <key>KeepAlive</key>
  <true/>

  <key>ThrottleInterval</key>
  <integer>10</integer>

  <key>RunAtLoad</key>
  <true/>

  <key>StandardOutPath</key>
  <string>${escapeXml(join(logs, `${opts.name}.log`))}</string>

  <key>StandardErrorPath</key>
  <string>${escapeXml(join(logs, `${opts.name}.err`))}</string>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(bunDir)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>HOME</key>
    <string>${escapeXml(home)}</string>
  </dict>
</dict>
</plist>
`;
}
