import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import {
  runRuntimeStateBackup,
  runRuntimeStateInventory,
  runRuntimeStateRestore,
} from "../../../src/cli/commands/state";
import {
  admitRuntimeStateIdentity,
  reconcileRuntimeStateRestore,
} from "../../../src/cli/runtime-state-bundle";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(withCoordination = false) {
  const root = mkdtempSync(join(tmpdir(), "auggy-state-command-"));
  roots.push(root);
  const agentDir = join(root, "agent");
  const stateRoot = join(root, "state");
  const backups = join(root, "backups");
  mkdirSync(agentDir, { mode: 0o700 });
  mkdirSync(stateRoot, { mode: 0o700 });
  mkdirSync(backups, { mode: 0o700 });
  writeFileSync(
    join(agentDir, "agent.yaml"),
    stringify({
      id: "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211",
      name: "state-command-test",
      engine: { provider: "anthropic", model: "claude-sonnet-4-6" },
      augments: [
        {
          name: "identity",
          type: "fileMemory",
          options: {
            label: "self",
            source: "./identity.md",
            mutable: false,
            origin: "operator",
            priority: "required",
            placement: "system",
            eviction: "never",
          },
        },
      ],
      ...(withCoordination
        ? {
            settings: {
              coordination: {
                mode: "postgres",
                namespace: "8a3d7828-1597-4db4-bd0e-adc1a1036211",
              },
            },
          }
        : {}),
    }),
  );
  writeFileSync(join(agentDir, "identity.md"), "# Identity\n");
  writeFileSync(join(stateRoot, "opaque-runtime-state.json"), '{"value":1}', { mode: 0o600 });
  admitRuntimeStateIdentity(stateRoot, "aug1_8a3d7828-1597-4db4-bd0e-adc1a1036211");
  return { root, agentDir, stateRoot, backups };
}

describe("runtime state command helpers", () => {
  test("backup selects AUGGY_DATA_DIR from the chosen config's .env outside cwd", () => {
    const paths = fixture();
    const previous = process.env.AUGGY_DATA_DIR;
    const railway = process.env.RAILWAY_VOLUME_MOUNT_PATH;
    delete process.env.AUGGY_DATA_DIR;
    process.env.RAILWAY_VOLUME_MOUNT_PATH = join(paths.root, "must-not-select");
    writeFileSync(join(paths.agentDir, ".env"), `AUGGY_DATA_DIR=${paths.stateRoot}\n`, {
      mode: 0o600,
    });
    try {
      const manifest = runRuntimeStateBackup(undefined, {
        config: join(paths.agentDir, "agent.yaml"),
        cwd: paths.root,
        out: join(paths.backups, "from-env.auggy-state"),
        confirmStopped: true,
        runtimeVolumeOnly: true,
      });
      expect(manifest.files.map((file) => file.path)).toContain("opaque-runtime-state.json");
      expect(
        runRuntimeStateInventory(undefined, {
          config: join(paths.agentDir, "agent.yaml"),
        }).stores.find((store) => store.id === "runtime-identity")?.backupPlane,
      ).toBe("runtime-volume");
      process.env.AUGGY_DATA_DIR = "";
      expect(() =>
        runRuntimeStateInventory(undefined, { config: join(paths.agentDir, "agent.yaml") }),
      ).toThrow();
      expect(() =>
        runRuntimeStateInventory(undefined, {
          config: join(paths.agentDir, "agent.yaml"),
          root: paths.stateRoot,
        }),
      ).not.toThrow();
    } finally {
      if (previous === undefined) delete process.env.AUGGY_DATA_DIR;
      else process.env.AUGGY_DATA_DIR = previous;
      if (railway === undefined) delete process.env.RAILWAY_VOLUME_MOUNT_PATH;
      else process.env.RAILWAY_VOLUME_MOUNT_PATH = railway;
    }
  });

  test("prints a secret-free inventory and performs a fenced restore rehearsal", () => {
    const paths = fixture();
    const inventory = runRuntimeStateInventory(undefined, {
      cwd: paths.agentDir,
      root: paths.stateRoot,
    });
    expect(inventory.agent.name).toBe("state-command-test");
    expect(JSON.stringify(inventory)).not.toContain(
      process.env.ANTHROPIC_API_KEY ?? "absent-secret",
    );

    const bundlePath = join(paths.backups, "runtime.auggy-state");
    const manifest = runRuntimeStateBackup(undefined, {
      cwd: paths.agentDir,
      root: paths.stateRoot,
      out: bundlePath,
      confirmStopped: true,
      runtimeVolumeOnly: true,
    });
    expect(manifest.files.map((file) => file.path)).toEqual([
      ".auggy-state-identity.json",
      "opaque-runtime-state.json",
    ]);

    const restored = join(paths.root, "restored");
    const fence = runRuntimeStateRestore(bundlePath, {
      cwd: paths.agentDir,
      root: restored,
      confirmStopped: true,
      runtimeVolumeOnly: true,
    });
    expect(readFileSync(join(restored, "opaque-runtime-state.json"), "utf8")).toBe('{"value":1}');
    expect(existsSync(join(restored, ".auggy-restore-fence.json"))).toBe(true);
    reconcileRuntimeStateRestore({
      runtimeDataRoot: restored,
      restoreId: fence.restoreId,
      confirmDownstreamReconciled: true,
    });
  });

  test("refuses to imply external coordination state is present without an explicit scope", () => {
    const paths = fixture(true);
    expect(() =>
      runRuntimeStateBackup(undefined, {
        cwd: paths.agentDir,
        root: paths.stateRoot,
        out: join(paths.backups, "runtime.auggy-state"),
        confirmStopped: true,
        runtimeVolumeOnly: false,
      }),
    ).toThrow("external recovery prerequisites exist");
    expect(existsSync(join(paths.backups, "runtime.auggy-state"))).toBe(false);
  });
});
