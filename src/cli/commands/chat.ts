import { Command } from "commander";
import { createGuiServer } from "../../../chat/server";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";

const DEFAULT_PORT = 8090;

export function chatCommand(): Command {
  const cmd = new Command("chat")
    .description("Launch the Auggy operator chat surface (Local GUI)")
    .option("-p, --port <port>", "GUI server port", String(DEFAULT_PORT))
    .option("--no-open", "Don't auto-open the browser")
    .option("--rebuild", "Rebuild the GUI dist from source (requires Bun + Vite in chat/)")
    .action(async (opts: { port: string; open: boolean; rebuild: boolean }) => {
      const port = Number(opts.port);
      if (!Number.isFinite(port) || port < 1 || port > 65535) {
        console.error(`Invalid --port value: ${opts.port}`);
        process.exit(1);
      }

      const guiPackageDir = resolve(__dirname, "../../../chat");
      const distDir = join(guiPackageDir, "dist");

      if (opts.rebuild) {
        console.log("[aug1 chat] Rebuilding chat/dist via Vite...");
        try {
          await runVite(guiPackageDir);
        } catch (err) {
          console.error(`[aug1 chat] Vite build failed:`, (err as Error).message);
          process.exit(1);
        }
      }

      if (!existsSync(join(distDir, "index.html"))) {
        console.error(
          `[aug1 chat] No dist found at ${distDir}.\n` +
            "Run `aug1 chat --rebuild` to build from source.",
        );
        process.exit(1);
      }

      let server: ReturnType<typeof createGuiServer>;
      try {
        server = createGuiServer({ port, staticDir: distDir });
      } catch (err) {
        console.error(
          `[aug1 chat] Failed to start server on port ${port}:`,
          (err as Error).message,
        );
        process.exit(1);
      }

      const url = `http://localhost:${port}`;
      console.log(`[aug1 chat] Local GUI ready at ${url}`);
      console.log("[aug1 chat] Ctrl-C to stop.");

      if (opts.open) {
        openBrowser(url);
      }

      const shutdown = (signal: string) => {
        console.log(`\n[aug1 chat] Received ${signal}, shutting down...`);
        try {
          server.stop();
        } catch {}
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });

  return cmd;
}

function runVite(cwd: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("bun", ["run", "build"], { cwd, stdio: "inherit" });
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`Vite build failed with exit code ${code}`));
    });
    child.on("error", rejectP);
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    // best-effort
  }
}
