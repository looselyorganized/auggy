import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// Keep executable fixture source static. Test-owned paths travel only as argv.
const fixturePath = fileURLToPath(import.meta.url);
const mode = process.argv[2];
const outputPath = process.argv[3];

function requiredOutputPath(): string {
  if (!outputPath) throw new Error("Fixture output path is required");
  return outputPath;
}

switch (mode) {
  case "idle":
    setInterval(() => {}, 1_000);
    break;
  case "delayed-marker": {
    const marker = requiredOutputPath();
    setTimeout(() => writeFileSync(marker, "escaped"), 800);
    setInterval(() => {}, 1_000);
    break;
  }
  case "delayed-descendant":
    spawn(process.execPath, [fixturePath, "delayed-marker", requiredOutputPath()], {
      stdio: "inherit",
    });
    setInterval(() => {}, 1_000);
    break;
  case "escaped-descendant": {
    const pidFile = requiredOutputPath();
    const exitCode = process.argv[4];
    if (exitCode !== "0" && exitCode !== "1") throw new Error("Invalid fixture exit code");
    const escaped = spawn(process.execPath, [fixturePath, "idle"], {
      detached: true,
      stdio: ["ignore", process.stdout, process.stderr],
    });
    writeFileSync(pidFile, String(escaped.pid));
    escaped.unref();
    if (exitCode === "1") console.error("install Auggy explicitly");
    process.exit(Number(exitCode));
    break;
  }
  case "graceful":
    process.on("SIGTERM", () => process.exit(0));
    writeFileSync(requiredOutputPath(), "ready");
    setInterval(() => {}, 1_000);
    break;
  default:
    throw new Error("Unknown process fixture mode");
}
