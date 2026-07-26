/**
 * `auggy state` — offline runtime-volume inventory, backup verification, and
 * restore fencing. The operator/platform owns scheduling, encryption, and
 * storage of the resulting confidential bundle.
 */

import { dirname, resolve } from "node:path";
import { Command } from "commander";
import { parseConfig } from "../config-parser";
import { resolveConfigPath } from "../resolve-config";
import {
  createRuntimeStateBundle,
  reconcileRuntimeStateRestore,
  resumeRuntimeStateRestore,
  restoreRuntimeStateBundle,
  verifyRuntimeStateBundle,
} from "../runtime-state-bundle";
import { buildRuntimeStateInventory, type RuntimeStateInventory } from "../runtime-state-inventory";

export interface RuntimeStateCommandOptions {
  config?: string;
  cwd?: string;
  root?: string;
}

function requireRoot(options: RuntimeStateCommandOptions): string {
  const configured = options.root ?? process.env.RAILWAY_VOLUME_MOUNT_PATH;
  if (!configured) {
    throw new Error("runtime state root is required (--root or RAILWAY_VOLUME_MOUNT_PATH)");
  }
  return resolve(configured);
}

export function runRuntimeStateInventory(
  name: string | undefined,
  options: RuntimeStateCommandOptions = {},
): RuntimeStateInventory {
  const configPath = resolveConfigPath(name, options.config, { cwd: options.cwd });
  const config = parseConfig(configPath);
  return buildRuntimeStateInventory(config, {
    agentDir: dirname(configPath),
    ...(options.root ? { runtimeDataRoot: resolve(options.root) } : {}),
  });
}

export function runRuntimeStateBackup(
  name: string | undefined,
  options: RuntimeStateCommandOptions & {
    out: string;
    confirmStopped: boolean;
    runtimeVolumeOnly: boolean;
  },
) {
  const root = requireRoot(options);
  const inventory = runRuntimeStateInventory(name, { ...options, root });
  if (inventory.externalPrerequisites.length > 0 && !options.runtimeVolumeOnly) {
    throw new Error(
      "external recovery prerequisites exist; supply their matching recovery points or explicitly select --runtime-volume-only",
    );
  }
  return createRuntimeStateBundle({
    sourceRoot: root,
    bundlePath: resolve(options.out),
    inventory,
    confirmStopped: options.confirmStopped,
  });
}

export function runRuntimeStateRestore(
  bundlePath: string,
  options: RuntimeStateCommandOptions & {
    confirmStopped: boolean;
    runtimeVolumeOnly: boolean;
  },
  name?: string,
) {
  const manifest = verifyRuntimeStateBundle(bundlePath);
  if (manifest.inventory.externalPrerequisites.length > 0 && !options.runtimeVolumeOnly) {
    throw new Error(
      "bundle has external recovery prerequisites; restore their matching recovery points or explicitly select --runtime-volume-only",
    );
  }
  const root = requireRoot(options);
  const expectedInventory = runRuntimeStateInventory(name, { ...options, root });
  return restoreRuntimeStateBundle({
    bundlePath,
    destinationRoot: root,
    confirmStopped: options.confirmStopped,
    expectedInventory,
  });
}

export function runRuntimeStateRestoreResume(
  bundlePath: string,
  options: RuntimeStateCommandOptions & {
    restoreId: string;
    confirmStopped: boolean;
    runtimeVolumeOnly: boolean;
  },
  name?: string,
) {
  const manifest = verifyRuntimeStateBundle(bundlePath);
  if (manifest.inventory.externalPrerequisites.length > 0 && !options.runtimeVolumeOnly) {
    throw new Error(
      "bundle has external recovery prerequisites; restore their matching recovery points or explicitly select --runtime-volume-only",
    );
  }
  const root = requireRoot(options);
  return resumeRuntimeStateRestore({
    bundlePath,
    destinationRoot: root,
    restoreId: options.restoreId,
    expectedInventory: runRuntimeStateInventory(name, { ...options, root }),
    confirmStopped: options.confirmStopped,
  });
}

export function runtimeStateCommand(): Command {
  const command = new Command("state").description(
    "Inventory and rehearse offline single-replica runtime-volume recovery",
  );

  command
    .command("inventory [name]")
    .description("Print the versioned runtime-state inventory without record content")
    .option("--config <path>", "path to agent.yaml")
    .option("--root <path>", "runtime data root (classifies volume-owned paths)")
    .action((name: string | undefined, options: RuntimeStateCommandOptions) => {
      try {
        console.log(JSON.stringify(runRuntimeStateInventory(name, options), null, 2));
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  command
    .command("backup [name]")
    .description("Create a confidential, integrity-manifested offline volume bundle")
    .requiredOption("--out <path>", "new bundle directory to create")
    .option("--config <path>", "path to agent.yaml")
    .option("--root <path>", "stopped runtime data root")
    .option("--confirm-stopped", "confirm the only replica is stopped and drained")
    .option(
      "--runtime-volume-only",
      "acknowledge that external databases and downstream effects are not included",
    )
    .action(
      (
        name: string | undefined,
        options: RuntimeStateCommandOptions & {
          out: string;
          confirmStopped?: boolean;
          runtimeVolumeOnly?: boolean;
        },
      ) => {
        try {
          const manifest = runRuntimeStateBackup(name, {
            ...options,
            confirmStopped: options.confirmStopped === true,
            runtimeVolumeOnly: options.runtimeVolumeOnly === true,
          });
          console.log(
            `Runtime-volume bundle created: ${manifest.files.length} file(s), ${manifest.inventory.externalPrerequisites.length} external prerequisite(s).`,
          );
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  command
    .command("verify <bundle>")
    .description("Verify bundle paths, hashes, SQLite integrity, and manifest compatibility")
    .action((bundle: string) => {
      try {
        const manifest = verifyRuntimeStateBundle(bundle);
        console.log(`Runtime-volume bundle verified: ${manifest.files.length} file(s).`);
      } catch (error) {
        console.error(`Error: ${(error as Error).message}`);
        process.exitCode = 1;
      }
    });

  command
    .command("restore <bundle> [name]")
    .description("Restore into an empty root and leave startup fenced for reconciliation")
    .option("--config <path>", "path to the current compatible agent.yaml")
    .option("--root <path>", "empty runtime data root")
    .option("--confirm-stopped", "confirm the only replica is stopped and drained")
    .option(
      "--runtime-volume-only",
      "acknowledge and separately restore every external prerequisite",
    )
    .action(
      (
        bundle: string,
        name: string | undefined,
        options: RuntimeStateCommandOptions & {
          confirmStopped?: boolean;
          runtimeVolumeOnly?: boolean;
        },
      ) => {
        try {
          const fence = runRuntimeStateRestore(
            bundle,
            {
              ...options,
              confirmStopped: options.confirmStopped === true,
              runtimeVolumeOnly: options.runtimeVolumeOnly === true,
            },
            name,
          );
          console.log(
            `Runtime-volume restore copied and fenced. Restore ID: ${fence.restoreId}. Reconcile downstream effects before startup.`,
          );
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  command
    .command("reconcile")
    .description("Clear a completed restore fence after downstream reconciliation")
    .requiredOption("--restore-id <id>", "exact restore ID printed by the restore command")
    .option("--root <path>", "restored runtime data root")
    .option(
      "--confirm-downstream-reconciled",
      "confirm remote effects, revocations, quotas, and replay ledgers were reconciled",
    )
    .action(
      (
        options: RuntimeStateCommandOptions & {
          restoreId: string;
          confirmDownstreamReconciled?: boolean;
        },
      ) => {
        try {
          reconcileRuntimeStateRestore({
            runtimeDataRoot: requireRoot(options),
            restoreId: options.restoreId,
            confirmDownstreamReconciled: options.confirmDownstreamReconciled === true,
          });
          console.log("Runtime-volume restore fence cleared.");
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  command
    .command("restore-resume <bundle> [name]")
    .description("Resume an exact interrupted empty-target restore")
    .requiredOption("--restore-id <id>", "exact restore ID stored in the copying fence")
    .option("--config <path>", "path to the current compatible agent.yaml")
    .option("--root <path>", "interrupted restore root")
    .option("--confirm-stopped", "confirm the only replica is stopped and drained")
    .option(
      "--runtime-volume-only",
      "acknowledge and separately restore every external prerequisite",
    )
    .action(
      (
        bundle: string,
        name: string | undefined,
        options: RuntimeStateCommandOptions & {
          restoreId: string;
          confirmStopped?: boolean;
          runtimeVolumeOnly?: boolean;
        },
      ) => {
        try {
          const fence = runRuntimeStateRestoreResume(
            bundle,
            {
              ...options,
              confirmStopped: options.confirmStopped === true,
              runtimeVolumeOnly: options.runtimeVolumeOnly === true,
            },
            name,
          );
          console.log(
            `Runtime-volume restore resumed and fenced for reconciliation. Restore ID: ${fence.restoreId}.`,
          );
        } catch (error) {
          console.error(`Error: ${(error as Error).message}`);
          process.exitCode = 1;
        }
      },
    );

  return command;
}
