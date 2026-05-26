/**
 * auggy run <name> — boot an agent in the foreground and open the operator's
 * default browser to its `/admin` URL once the agent is accepting connections.
 *
 * Thin wrapper over `runDev` with an `onReady` callback that launches the
 * browser. Use `--no-browser` to suppress the launch (e.g., when running on a
 * remote host without a display); `auggy dev` remains the pure-headless path.
 *
 * If the agent has no webTransport augment configured, the browser launch is
 * skipped silently — there's no URL to open.
 */

import { runDev } from "./dev";
import { openBrowser } from "../open-browser";

export interface RunOpts {
  config?: string;
  /** Suppress the browser launch (the agent still starts and runs in the foreground). */
  noBrowser?: boolean;
}

export async function runRun(name: string, opts: RunOpts): Promise<void> {
  await runDev(name, {
    config: opts.config,
    onReady: ({ adminUrl }) => {
      if (!adminUrl) return; // no webTransport → nothing to open
      if (opts.noBrowser) return;
      // Tiny delay so the operator sees the "Agent running" banner first,
      // then the browser pops — better than racing the console output.
      setTimeout(() => {
        const result = openBrowser(adminUrl);
        if (!result.ok) {
          console.log(`  (couldn't auto-launch \`${result.command}\`; open ${adminUrl} manually)`);
        }
      }, 50);
    },
  });
}
