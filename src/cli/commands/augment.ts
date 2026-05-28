import { Command } from "commander";
import { scaffoldCustomAugment } from "../scaffold-custom-augment";

export interface AugmentCommandDeps {
  scaffoldCustomAugment?: typeof scaffoldCustomAugment;
  exit?: (code: number) => void;
}

export function augmentCommand(deps: AugmentCommandDeps = {}): Command {
  const scaffold = deps.scaffoldCustomAugment ?? scaffoldCustomAugment;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  const command = new Command("augment").description("Create and manage custom augments");

  command
    .command("create <slug>")
    .description("Scaffold a local custom augment")
    .option("--dir <path>", "target directory (defaults to ./augments/<slug>)")
    .option("--force", "overwrite an existing target directory")
    .action(async (slug: string, opts: { dir?: string; force?: boolean }) => {
      try {
        const dir = scaffold({
          slug,
          targetDir: opts.dir,
          force: opts.force ?? false,
        });
        console.log(`Created custom augment "${slug}" at ${dir}`);
      } catch (err) {
        console.error(`Error: ${(err as Error).message}`);
        exit(1);
      }
    });

  return command;
}
