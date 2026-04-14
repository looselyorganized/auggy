/**
 * auggy create <name> — scaffold a new agent directory.
 */

import { scaffoldAgent } from "../scaffold";

export async function runCreate(
  name: string,
  opts: { dir?: string; purpose?: string },
): Promise<void> {
  const dir = scaffoldAgent({
    name,
    targetDir: opts.dir,
    purpose: opts.purpose,
  });

  console.log(`Agent "${name}" created at ${dir}`);
  console.log();
  console.log("Next steps:");
  console.log(`  1. Edit ${dir}/agent.yaml to configure augments`);
  console.log(`  2. Edit ${dir}/.env to add your API keys`);
  console.log(`  3. Edit ${dir}/identity.md to define the agent's personality`);
  console.log(`  4. Run: aug1 dev ${name}`);
}
