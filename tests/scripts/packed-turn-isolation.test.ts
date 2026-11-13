import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPackedTurn } from "../../scripts/release-smoke/packed-turn";

let root: string;
let options: Parameters<typeof runPackedTurn>[0];

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "auggy-packed-isolation-"));
  for (const directory of ["repo", "agent", "home", "installed"]) {
    await mkdir(join(root, directory));
  }
  await writeFile(join(root, "installed/cli.ts"), "// fixture: must never execute\n");
  options = {
    cli: join(root, "installed/cli.ts"),
    agentDir: join(root, "agent"),
    home: join(root, "home"),
    evidenceDir: join(root, "evidence"),
    repoRoot: join(root, "repo"),
  };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("rejects a consumer symlink into the source checkout before writing evidence or fixtures", async () => {
  const alias = join(root, "source-alias");
  await symlink(options.repoRoot, alias);
  await expect(runPackedTurn({ ...options, agentDir: alias })).rejects.toThrow(
    "Packed consumer must live outside the source checkout",
  );
  expect(existsSync(options.evidenceDir)).toBe(false);
  expect(existsSync(join(options.repoRoot, ".packed-acceptance"))).toBe(false);
});

test("rejects a globally linked source CLI before running it", async () => {
  const sourceCli = join(options.repoRoot, "cli.ts");
  await writeFile(sourceCli, "throw new Error('source CLI must not execute');\n");
  const alias = join(root, "linked-auggy");
  await symlink(sourceCli, alias);
  await expect(runPackedTurn({ ...options, cli: alias })).rejects.toThrow(
    "CLI must resolve outside the source checkout",
  );
  expect(existsSync(join(options.agentDir, ".packed-acceptance"))).toBe(false);
});

test("rejects source-checkout HOME before reading package or environment files", async () => {
  await expect(runPackedTurn({ ...options, home: options.repoRoot })).rejects.toThrow(
    "Consumer HOME must be isolated from the source checkout",
  );
  expect(existsSync(options.evidenceDir)).toBe(false);
});
