import { join } from "node:path";
import { realpathSync } from "node:fs";
import { z } from "zod";
import { readDurableJson, writeDurableJson } from "./durable-json";

/**
 * Schema for the persistent admin-overrides file. Stored at
 * `<agentDir>/admin-overrides.json`. Updated atomically (temp file + rename)
 * with mode 0o600. Read once at agent boot; the closure values are the
 * runtime source of truth thereafter.
 *
 * v1.0 supports five runtime-tunable knobs:
 *   - webTransport.allowAnonymous
 *   - webTransport.publicIntegration
 *   - budgets.dailyBudgetUsd
 *   - notify.globalMaxPerHour
 *   - agentMail.globalMaxPerHour
 *
 * Adding a new override field is a schema migration — bump the version
 * number and add a per-version branch here.
 */
const AdminOverridesV1Schema = z
  .object({
    version: z.literal(1),
    lastModified: z.string().datetime(),
    lastModifiedBy: z.string(),
    overrides: z
      .object({
        webTransport: z
          .object({
            allowAnonymous: z.boolean().optional(),
            publicIntegration: z.boolean().optional(),
          })
          .strict()
          .optional(),
        budgets: z.object({ dailyBudgetUsd: z.number().positive().optional() }).strict().optional(),
        notify: z
          .object({ globalMaxPerHour: z.number().int().positive().optional() })
          .strict()
          .optional(),
        agentMail: z
          .object({ globalMaxPerHour: z.number().int().positive().optional() })
          .strict()
          .optional(),
      })
      .strict(),
  })
  .strict();

export type AdminOverrides = z.infer<typeof AdminOverridesV1Schema>;

function overrideFilePath(agentDir: string): string {
  return join(realpathSync(agentDir), "admin-overrides.json");
}

/**
 * Read the override file. Returns null when:
 *   - agentDir is undefined (no scaffold-aware launch path)
 *   - the file doesn't exist
 * Corrupt JSON, symlinks, unknown versions, and invalid fields throw so a
 * security-relevant override store can never silently reset to yaml values.
 */
export function readOverrides(agentDir: string | undefined): AdminOverrides | null {
  if (!agentDir) return null;
  let path: string;
  try {
    path = overrideFilePath(agentDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  const parsed = readDurableJson(path, "admin overrides", 1024 * 1024);
  if (parsed === null) return null;

  const result = AdminOverridesV1Schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[admin-overrides] ${path} failed validation; refusing to reset runtime policy: ${result.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  }

  return result.data;
}

/**
 * Write the override file atomically with mode 0o600.
 * Pattern: write to a temp file, then rename to the final path. Rename is
 * atomic on POSIX filesystems, so concurrent readers never observe a
 * partially-written file.
 *
 * The 0o600 mode means only the agent process user can read the file —
 * protects the operator's runtime knob state on multi-user hosts.
 */
export function writeOverrides(agentDir: string, overrides: AdminOverrides): void {
  const path = overrideFilePath(agentDir);
  const parsed = AdminOverridesV1Schema.parse(overrides);
  writeDurableJson(path, parsed, "admin overrides");
}
