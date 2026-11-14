/** Explicit CI-only policy data. This module never runs privileged commands. */
import { randomUUID } from "node:crypto";
import { lstatSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { applicationHash } from "./application-consumer";
import { readBoundedRegularFile } from "./bounded-file";
import { inspectIntegrationChromiumExecutable } from "./integration-browser";

function check(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}

export function prepareCIChromiumUserNamespacePolicy(options: {
  buildDirectory: string;
  executable: string;
  sha256: string;
}): { path: string; sha256: string } {
  const root = realpathSync(options.buildDirectory);
  const rootStat = lstatSync(root);
  check(
    rootStat.isDirectory() &&
      (rootStat.mode & 0o777) === 0o700 &&
      rootStat.uid === process.getuid?.(),
    "CI browser build directory must be private and owned",
  );
  // No AppArmor escapes, globbing, variables, whitespace or policy delimiters.
  check(/^\/[A-Za-z0-9_./-]+$/.test(options.executable), "Unsafe AppArmor executable path");
  const executable = inspectIntegrationChromiumExecutable({
    path: options.executable,
    sha256: options.sha256,
  });
  check(executable === options.executable, "AppArmor attachment must use the exact real path");
  const browserRoot = join(root, "browsers");
  const child = relative(browserRoot, executable);
  check(
    child !== "" && !child.startsWith(`..${sep}`) && child !== ".." && !child.startsWith(sep),
    "AppArmor attachment must remain inside the owned browser download",
  );
  for (let parent = dirname(executable); parent !== root; parent = dirname(parent)) {
    const stat = lstatSync(parent);
    check(
      stat.isDirectory() && !stat.isSymbolicLink() && realpathSync(parent) === parent,
      "AppArmor browser parents must be ordinary directories",
    );
  }
  const name = `auggy-m5-chromium-${randomUUID()}`;
  const policy = `abi <abi/4.0>,\ninclude <tunables/global>\nprofile ${name} "${executable}" flags=(unconfined) {\n  userns,\n}\n`;
  const path = join(root, name);
  writeFileSync(path, policy, { mode: 0o600, flag: "wx" });
  return { path, sha256: applicationHash(policy) };
}

export function verifyCIChromiumUserNamespacePolicy(path: string, sha256: string): void {
  check(/^[a-f0-9]{64}$/.test(sha256), "Invalid AppArmor policy identity");
  const snapshot = readBoundedRegularFile(path, 8192);
  check(
    (snapshot.mode & 0o777) === 0o600 && applicationHash(snapshot.bytes) === sha256,
    "Owned AppArmor policy changed",
  );
}

if (import.meta.main) {
  const [action, ...args] = process.argv.slice(2);
  if (action === "prepare" && args.length === 3) {
    const policy = prepareCIChromiumUserNamespacePolicy({
      buildDirectory: args[0]!,
      executable: args[1]!,
      sha256: args[2]!,
    });
    process.stdout.write(`${policy.path}\n${policy.sha256}\n`);
  } else if (action === "verify" && args.length === 2) {
    verifyCIChromiumUserNamespacePolicy(args[0]!, args[1]!);
  } else throw new Error("Expected explicit CI browser policy prepare or verify arguments");
}
