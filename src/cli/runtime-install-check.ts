import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AUGGY_RUNTIME_PACKAGE_MARKER } from "./runtime-package-marker";
import { getAuggyVersion } from "./scaffold-package-json";

export interface RuntimeInstallCheckResult {
  ok: boolean;
  message?: string;
  fix?: string;
}

export type RuntimeInstallCheck = (agentDir: string) => RuntimeInstallCheckResult;

const MARKER_PATH = join("src", "cli", "runtime-package-marker.ts");

export const checkAgentRuntimeInstall: RuntimeInstallCheck = (agentDir) => {
  const packageDir = join(agentDir, "node_modules", "auggy");
  const packageJsonPath = join(packageDir, "package.json");
  const markerPath = join(packageDir, MARKER_PATH);

  if (!existsSync(packageJsonPath)) {
    return {
      ok: false,
      message: "Agent dependencies installed, but node_modules/auggy was not found.",
      fix: "Run `bun install` in the agent directory. If this repeats, check package.json's `auggy` dependency.",
    };
  }

  const installed = readInstalledPackage(packageJsonPath);
  const installedLabel = installed?.version ? `auggy@${installed.version}` : "auggy";
  const expectedLabel = `auggy@${getAuggyVersion()}`;

  if (!existsSync(markerPath)) {
    return {
      ok: false,
      message: `Agent installed ${installedLabel}, but it does not match this CLI's runtime shape (${expectedLabel}).`,
      fix:
        "If you are testing a local tarball, keep `auggy-x.y.z.tgz` in this directory or a parent directory before running `auggy create`, " +
        "or set `AUGGY_SCAFFOLD_AUGGY_SPEC=file:/absolute/path/to/auggy-x.y.z.tgz`. " +
        "Otherwise publish/install a new Auggy version before creating agents.",
    };
  }

  const markerText = readFileSync(markerPath, "utf-8");
  if (!markerText.includes(AUGGY_RUNTIME_PACKAGE_MARKER)) {
    return {
      ok: false,
      message: `Agent installed ${installedLabel}, but its runtime marker does not match this CLI (${expectedLabel}).`,
      fix: "Reinstall the agent's dependencies from the same Auggy package as the CLI, then rerun `auggy doctor`.",
    };
  }

  return { ok: true };
};

function readInstalledPackage(path: string): { version?: string } | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf-8")) as { version?: string };
  } catch {
    return undefined;
  }
}
