/**
 * `auggy coordination migrate [name]` — explicitly provision the optional
 * PostgreSQL coordination schema. This command intentionally does not start
 * an agent or enable replicas.
 */

import { Command } from "commander";
import { POSTGRES_COORDINATION_MIGRATIONS, migratePostgresCoordinator } from "../../coordination";
import type { PostgresMigrationExecutor } from "../../coordination/migrations";
import {
  assertSecurePostgresCoordinationUrl,
  createSecurePostgresCoordinationClient,
} from "../../coordination/postgres-url";
import { parseConfig } from "../config-parser";
import { resolveConfigPath } from "../resolve-config";

export interface CoordinationMigrationClient extends PostgresMigrationExecutor {
  close(): Promise<void>;
}

export interface CoordinationMigrateOptions {
  config?: string;
  auggyDir?: string;
  cwd?: string;
  /** Injectable only for tests; do not log this argument. */
  env?: Record<string, string | undefined>;
  createClient?: (url: string) => CoordinationMigrationClient;
  migrate?: (client: PostgresMigrationExecutor) => Promise<void>;
}

export interface CoordinationMigrateCommandDeps {
  runCoordinationMigrate?: (
    name: string | undefined,
    opts: CoordinationMigrateOptions,
  ) => Promise<readonly string[]>;
  exit?: (code: number) => void;
}

class SafeCoordinationMigrationError extends Error {}

function createClient(url: string): CoordinationMigrationClient {
  return createSecurePostgresCoordinationClient(url) as unknown as CoordinationMigrationClient;
}

function safeMigrationError(): SafeCoordinationMigrationError {
  // Database clients sometimes include their connection string in errors. Do
  // not retain the original error as a cause, either: callers may serialize it.
  return new SafeCoordinationMigrationError("coordination migration failed");
}

/**
 * Apply the built-in, checksum-verified coordinator schema migrations.
 * Configuration resolves normally, but the secret is read only from the named
 * environment variable immediately before opening the database connection.
 */
export async function runCoordinationMigrate(
  name: string | undefined,
  opts: CoordinationMigrateOptions = {},
): Promise<readonly string[]> {
  const configPath = resolveConfigPath(name, opts.config, {
    auggyDir: opts.auggyDir,
    cwd: opts.cwd,
  });
  const config = parseConfig(configPath);
  const coordination = config.settings.coordination;
  if (!coordination) {
    throw new SafeCoordinationMigrationError(
      "settings.coordination must be configured before running coordination migrations",
    );
  }

  const url = (opts.env ?? process.env)[coordination.urlEnv];
  if (typeof url !== "string" || url.trim().length === 0) {
    throw new SafeCoordinationMigrationError(
      `coordination database environment variable ${coordination.urlEnv} is missing or empty`,
    );
  }
  try {
    assertSecurePostgresCoordinationUrl(url);
  } catch {
    throw safeMigrationError();
  }

  let client: CoordinationMigrationClient | undefined;
  let failure: Error | undefined;
  try {
    client = (opts.createClient ?? createClient)(url);
    await (opts.migrate ?? migratePostgresCoordinator)(client);
  } catch {
    failure = safeMigrationError();
  } finally {
    if (client) {
      try {
        await client.close();
      } catch {
        failure ??= safeMigrationError();
      }
    }
  }

  if (failure) throw failure;
  return POSTGRES_COORDINATION_MIGRATIONS.map((migration) => migration.id);
}

export function coordinationCommand(deps: CoordinationMigrateCommandDeps = {}): Command {
  const run = deps.runCoordinationMigrate ?? runCoordinationMigrate;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const command = new Command("coordination").description(
    "Provision the disabled distributed-coordination preview",
  );
  command
    .command("migrate [name]")
    .description("Apply the configured PostgreSQL coordination schema migrations")
    .option("--config <path>", "path to agent.yaml")
    .action(async (name: string | undefined, opts: { config?: string }) => {
      try {
        const migrations = await run(name, { config: opts.config });
        console.log(
          `Coordination preview schema provisioned: ${migrations.join(", ")}. Runtime replicas remain unsupported.`,
        );
        exit(0);
      } catch (err) {
        const message =
          err instanceof SafeCoordinationMigrationError
            ? err.message
            : "coordination migration failed";
        console.error(`Error: ${message}`);
        exit(1);
      }
    });
  return command;
}
