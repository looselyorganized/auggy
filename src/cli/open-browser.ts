/**
 * Best-effort cross-platform browser launcher.
 *
 * Spawns the platform default-handler:
 *   - macOS:  `/usr/bin/open <url>`
 *   - Linux:  `/usr/bin/xdg-open <url>`
 *   - Windows: `C:\\Windows\\System32\\rundll32.exe url.dll,FileProtocolHandler <url>`
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
  if (!isSafeBrowserUrl(url)) return { ok: false, command: "" };

  let command = "/usr/bin/xdg-open";
  try {
    let child: ReturnType<typeof spawn>;
    if (process.platform === "darwin") {
      command = "/usr/bin/open";
      child = spawn("/usr/bin/open", [url], { stdio: "ignore", detached: true });
    } else if (process.platform === "win32") {
      command = "C:\\Windows\\System32\\rundll32.exe";
      child = spawn("C:\\Windows\\System32\\rundll32.exe", ["url.dll,FileProtocolHandler", url], {
        stdio: "ignore",
        detached: true,
      });
    } else {
      child = spawn("/usr/bin/xdg-open", [url], { stdio: "ignore", detached: true });
    }
    child.on("error", () => {
      // best-effort; the caller has already printed the URL
    });
    child.unref();
    return { ok: true, command };
  } catch {
    return { ok: false, command };
  }
}

function isSafeBrowserUrl(value: string): boolean {
  if (value.length === 0 || value.length > 4096) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}
