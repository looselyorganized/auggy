import { Command } from "commander";
import { createGuiServer } from "../../../chat/server";
import { existsSync, mkdirSync, createWriteStream, createReadStream } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { pipeline } from "node:stream/promises";
import packageJson from "../../../package.json" with { type: "json" };

const DEFAULT_PORT = 8090;
const RELEASE_REPO = "looselyorganized/augment-1";

export function chatCommand(): Command {
  const cmd = new Command("chat")
    .description("Launch the Auggy operator chat surface (Local GUI)")
    .option("-p, --port <port>", "GUI server port", String(DEFAULT_PORT))
    .option("--no-open", "Don't auto-open the browser")
    .option("--rebuild", "Rebuild the GUI dist from source (requires Bun + Vite in chat/)")
    .action(async (opts: { port: string; open: boolean; rebuild: boolean }) => {
      const port = Number(opts.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535) {
        console.error(`Invalid --port value: ${opts.port}`);
        process.exit(1);
      }

      const guiPackageDir = resolve(__dirname, "../../../chat");
      const localDistDir = join(guiPackageDir, "dist");
      const version = packageJson.version;
      const cacheDistDir = join(homedir(), ".auggy", "chat", version, "dist");

      let distDir: string;
      try {
        if (opts.rebuild) {
          console.log("[aug1 chat] Rebuilding chat/dist via Vite...");
          await runVite(guiPackageDir);
        }
        distDir = await resolveDistDir({
          localDistDir,
          cacheDistDir,
          version,
        });
      } catch (err) {
        console.error(`[aug1 chat] Failed to resolve dist: ${(err as Error).message}`);
        process.exit(1);
      }

      let server: ReturnType<typeof createGuiServer>;
      try {
        server = createGuiServer({ port, staticDir: distDir });
      } catch (err) {
        console.error(
          `[aug1 chat] Failed to start server on port ${port}: ${(err as Error).message}\n` +
            `Try a different port: aug1 chat --port ${port + 1}`,
        );
        process.exit(1);
      }

      const url = `http://localhost:${port}`;
      console.log(`[aug1 chat] Local GUI ready at ${url}`);
      console.log("[aug1 chat] Ctrl-C to stop.");

      if (opts.open) openBrowser(url);

      const shutdown = (signal: string) => {
        console.log(`\n[aug1 chat] Received ${signal}, shutting down...`);
        try {
          server.stop();
        } catch {
          /* swallow */
        }
        process.exit(0);
      };
      process.on("SIGINT", () => shutdown("SIGINT"));
      process.on("SIGTERM", () => shutdown("SIGTERM"));
    });

  return cmd;
}

async function resolveDistDir(opts: {
  localDistDir: string;
  cacheDistDir: string;
  version: string;
}): Promise<string> {
  if (existsSync(join(opts.localDistDir, "index.html"))) return opts.localDistDir;
  if (existsSync(join(opts.cacheDistDir, "index.html"))) return opts.cacheDistDir;

  console.log(
    `[aug1 chat] No cached dist for version ${opts.version}; downloading from GitHub release...`,
  );
  await downloadAndCache(opts.version, opts.cacheDistDir);
  if (!existsSync(join(opts.cacheDistDir, "index.html"))) {
    throw new Error("download succeeded but dist/index.html not found after extraction");
  }
  return opts.cacheDistDir;
}

async function downloadAndCache(version: string, cacheDistDir: string): Promise<void> {
  const tag = `v${version}`;
  const tarballUrl = `https://github.com/${RELEASE_REPO}/releases/download/${tag}/chat-dist-${tag}.tar.gz`;
  const checksumUrl = `${tarballUrl}.sha256`;

  const cacheRoot = join(cacheDistDir, "..");
  mkdirSync(cacheRoot, { recursive: true });

  const tarballPath = join(cacheRoot, "dist.tar.gz");
  const tarRes = await fetch(tarballUrl);
  if (!tarRes.ok || !tarRes.body) {
    throw new Error(`Download failed: ${tarRes.status} ${tarRes.statusText} from ${tarballUrl}`);
  }
  await pipeline(tarRes.body as unknown as NodeJS.ReadableStream, createWriteStream(tarballPath));

  const checksumRes = await fetch(checksumUrl);
  if (!checksumRes.ok) {
    throw new Error(`Failed to fetch checksum: ${checksumRes.status} ${checksumRes.statusText}`);
  }
  const checksumLine = await checksumRes.text();
  const expectedSha = checksumLine.split(/\s+/)[0];
  const actualSha = await sha256File(tarballPath);
  if (expectedSha !== actualSha) {
    throw new Error(`Checksum mismatch: expected ${expectedSha}, got ${actualSha}`);
  }

  await runTar(tarballPath, cacheRoot);
}

function sha256File(path: string): Promise<string> {
  return new Promise((resolveP, rejectP) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("data", (chunk: Buffer | string) => hash.update(chunk));
    stream.on("end", () => resolveP(hash.digest("hex")));
    stream.on("error", rejectP);
  });
}

function runTar(tarballPath: string, destDir: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("tar", ["-xzf", tarballPath, "-C", destDir], {
      stdio: "inherit",
    });
    child.on("exit", (code) => (code === 0 ? resolveP() : rejectP(new Error(`tar exit ${code}`))));
    child.on("error", rejectP);
  });
}

function runVite(cwd: string): Promise<void> {
  return new Promise((resolveP, rejectP) => {
    const child = spawn("bun", ["run", "build"], { cwd, stdio: "inherit" });
    child.on("exit", (code) =>
      code === 0 ? resolveP() : rejectP(new Error(`Vite build exit ${code}`)),
    );
    child.on("error", rejectP);
  });
}

function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd = platform === "darwin" ? "open" : platform === "win32" ? "start" : "xdg-open";
  try {
    spawn(cmd, [url], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* best-effort */
  }
}
