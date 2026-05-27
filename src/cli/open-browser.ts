/**
 * Best-effort cross-platform browser launcher.
 *
 * Spawns the platform default-handler:
 *   - macOS:  `open <url>`
 *   - Linux:  `xdg-open <url>`
 *   - Windows: `start "" <url>` (via cmd /c)
 *
 * Detached + ignored stdio so the parent process (typically `auggy dev --open`)
 * doesn't accumulate a child handle. Failures are swallowed; the caller is
 * expected to also print the URL so the operator can copy/paste if the
 * automated launch silently fails.
 */

import { spawn } from "node:child_process";

export interface OpenBrowserResult {
  /** Whether the spawn call itself succeeded. */
  ok: boolean;
  /** Platform-appropriate command that was attempted. */
  command: string;
}

export function openBrowser(url: string): OpenBrowserResult {
  let command: string;
  let args: string[];
  if (process.platform === "darwin") {
    command = "open";
    args = [url];
  } else if (process.platform === "win32") {
    command = "cmd";
    args = ["/c", "start", "", url];
  } else {
    command = "xdg-open";
    args = [url];
  }

  try {
    const child = spawn(command, args, { stdio: "ignore", detached: true });
    child.on("error", () => {
      // best-effort; the caller has already printed the URL
    });
    child.unref();
    return { ok: true, command };
  } catch {
    return { ok: false, command };
  }
}
