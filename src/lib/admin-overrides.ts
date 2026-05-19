import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

/**
 * Schema for the persistent admin-overrides file. Stored at
 * `<agentDir>/admin-overrides.json`. Updated atomically (temp file + rename)
 * with mode 0o600. Read once at agent boot; the closure values are the
 * runtime source of truth thereafter.
 *
 * v1.0 supports three runtime-tunable knobs:
 *   - webTransport.allowAnonymous
 *   - budgets.dailyBudgetUsd
 *   - notify.globalMaxPerHour
 *
 * Adding a new override field is a schema migration — bump the version
 * number and add a per-version branch here.
 */
const AdminOverridesV1Schema = z.object({
  version: z.literal(1),
  lastModified: z.string().datetime(),
  lastModifiedBy: z.string(),
  overrides: z.object({
    webTransport: z.object({ allowAnonymous: z.boolean().optional() }).optional(),
    budgets: z.object({ dailyBudgetUsd: z.number().positive().optional() }).optional(),
    notify: z.object({ globalMaxPerHour: z.number().int().positive().optional() }).optional(),
  }),
});

export type AdminOverrides = z.infer<typeof AdminOverridesV1Schema>;

function overrideFilePath(agentDir: string): string {
  return join(agentDir, "admin-overrides.json");
}

/**
 * Read the override file. Returns null when:
 *   - agentDir is undefined (no scaffold-aware launch path)
 *   - agentDir doesn't exist
 *   - the file doesn't exist
 *   - the file is corrupt JSON (warn logged)
 *   - the file fails schema validation (per-field warnings logged)
 *
 * For v1.0 simplicity: on schema validation failure, the whole file is
 * discarded. Per-field salvage (preserve valid fields, drop invalid ones)
 * is a v1.1 refinement.
 */
export function readOverrides(agentDir: string | undefined): AdminOverrides | null {
  if (!agentDir || !existsSync(agentDir)) return null;
  const path = overrideFilePath(agentDir);
  if (!existsSync(path)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    console.warn(
      `[admin-overrides] failed to parse ${path}: ${(err as Error).message}. ` +
        `Falling back to yaml values for all overrides.`,
    );
    return null;
  }

  const result = AdminOverridesV1Schema.safeParse(parsed);
  if (!result.success) {
    for (const issue of result.error.issues) {
      console.warn(
        `[admin-overrides] field ${issue.path.join(".")} failed validation: ${issue.message}. ` +
          `Falling back to yaml for this field.`,
      );
    }
    console.warn(
      `[admin-overrides] discarding entire override file due to validation errors. ` +
        `Per-field salvage is a v1.1 refinement.`,
    );
    return null;
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
  const tmp = `${path}.tmp.${process.pid}`;
  writeFileSync(tmp, JSON.stringify(overrides, null, 2), { mode: 0o600 });
  renameSync(tmp, path);
}
