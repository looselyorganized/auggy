/**
 * `auggy chat` — open a running agent's `/console/chat` in the browser.
 *
 * Replaces the previous standalone GUI (`chat/` package with its own port
 * 8090 + agent picker) now that every agent serves a built-in console at
 * `/console` (see docs/21-console.md). One agent → one console; the
 * console's Chat tab is the single source of truth for operator chat.
 *
 *   auggy chat                  — discover running agents; open if one,
 *                                 prompt if many, error if none.
 *   auggy chat <name>           — open that agent's /console/chat.
 *   auggy chat <name> --no-open — print the URL only.
 *
 * The standalone `chat/` package is deprecated and will be removed once
 * downstream callers migrate.
 */

import { Command } from "commander";
import { select } from "@inquirer/prompts";
import { listPidManifests, readPidManifest, isProcessAlive } from "../pid-registry";
import { openBrowser } from "../open-browser";
import type { PidManifest } from "../types";

export function chatCommand(): Command {
  return new Command("chat")
    .description("Open a running agent's /console/chat in your browser")
    .argument("[name]", "Agent name (optional when only one agent is running)")
    .option("--no-open", "Print the URL only; don't launch a browser")
    .action(async (name: string | undefined, opts: { open: boolean }) => {
      let manifest: PidManifest | null;
      try {
        manifest = await pickAgentManifest(name);
      } catch (err) {
        console.error(`[auggy chat] ${(err as Error).message}`);
        process.exit(1);
        return;
      }
      if (!manifest) {
        // pickAgentManifest already printed a tailored message.
        process.exit(1);
        return;
      }

      const port = manifest.port;
      if (port === null) {
        console.error(
          `[auggy chat] Agent "${manifest.name}" is running without webTransport — no /console to open. ` +
            `Add a webTransport augment to expose the operator console.`,
        );
        process.exit(1);
        return;
      }

      const url = `http://localhost:${port}/console/chat`;
      console.log(url);

      if (opts.open) {
        const result = openBrowser(url);
        if (!result.ok) {
          console.log(`[auggy chat] Couldn't launch a browser; open the URL above manually.`);
        }
      }
    });
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

async function pickAgentManifest(name: string | undefined): Promise<PidManifest | null> {
  if (name) {
    const m = readPidManifest(name);
    if (!m) {
      console.error(
        `[auggy chat] No PID manifest for "${name}". Run \`auggy run ${name}\` first ` +
          `(or \`auggy list\` to see what's running).`,
      );
      return null;
    }
    if (!isProcessAlive(m.pid)) {
      console.error(
        `[auggy chat] Agent "${name}" has a stale PID manifest. ` +
          `Run \`auggy run ${name}\` to boot it.`,
      );
      return null;
    }
    return m;
  }

  const running = listPidManifests();
  if (running.length === 0) {
    console.error("[auggy chat] No agents running. Boot one with `auggy run <name>` first.");
    return null;
  }
  if (running.length === 1) return running[0]!;

  return await select<PidManifest>({
    message: "Which agent?",
    choices: running.map((m) => ({
      name: `${m.name} (port ${m.port ?? "—"}, pid ${m.pid})`,
      value: m,
    })),
  });
}
