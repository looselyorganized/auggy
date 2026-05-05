/**
 * auggy eval [agent] — run the portable security eval suite against an agent.
 *
 * Wraps `evals/security/run.ts` so operators get the production-DX shape:
 *
 *   auggy eval                          # default fixture (canonical test agent)
 *   auggy eval zip                      # registered agent
 *   auggy eval --config path/to/agent.yaml
 *   auggy eval zip --suite security-only
 *   auggy eval zip --trials 5
 *
 * Config-path resolution order (highest precedence first):
 *   1. --config <path>  (resolved against cwd)
 *   2. [agent] argument (looked up in `~/.auggy/agents.json`)
 *   3. Default: the canonical fixture at `evals/security/fixtures/test-agent.yaml`
 */

import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { Command } from "commander";
import { runEvalSuite, getDefaultFixtureConfigPath } from "../../../evals/security/run";
import { getAgent } from "../agent-index";

interface ResolveEvalConfigOptions {
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
  /** Inject a fixture-path resolver for tests. Defaults to the runner's resolver. */
  defaultFixtureConfigPath?: () => string;
}

/**
 * Resolve the agent.yaml path for `auggy eval`. Mirrors `resolveConfigPath`
 * but allows the agent name to be omitted — falling back to the bundled
 * fixture when neither name nor explicit --config is supplied.
 */
export function resolveEvalConfigPath(
  args: { agentName?: string; explicitConfig?: string },
  opts: ResolveEvalConfigOptions = {},
): string {
  if (args.explicitConfig) {
    const absPath = resolve(args.explicitConfig);
    if (!existsSync(absPath)) {
      throw new Error(`Config file not found: ${absPath}`);
    }
    return absPath;
  }

  if (args.agentName) {
    const entry = getAgent(args.agentName, opts);
    if (!entry) {
      throw new Error(
        `Agent "${args.agentName}" not found.\n\n` +
          `  Run \`auggy ls\` to see registered agents,\n` +
          `  or use --config <path> for a one-off path.`,
      );
    }
    const cfg = join(entry.localDir, "agent.yaml");
    if (!existsSync(cfg)) {
      throw new Error(
        `agent.yaml missing at indexed path: ${cfg}\n\n` +
          `  The agent directory may have been deleted or moved manually.\n` +
          `  Run \`auggy remove ${args.agentName}\` to clean up the index entry.`,
      );
    }
    return cfg;
  }

  const fixtureResolver = opts.defaultFixtureConfigPath ?? getDefaultFixtureConfigPath;
  return fixtureResolver();
}

interface EvalCommandDeps {
  /** Inject for tests so we don't make real API calls. */
  runEvalSuite?: typeof runEvalSuite;
  /** Override exit so tests can assert the exit code without crashing the runner. */
  exit?: (code: number) => void;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
}

export function evalCommand(deps: EvalCommandDeps = {}): Command {
  const runner = deps.runEvalSuite ?? runEvalSuite;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("eval")
    .description("Run the portable security eval suite against an agent")
    .argument("[agent]", "registered agent name (defaults to the bundled fixture)")
    .option("--config <path>", "explicit agent.yaml path (overrides agent name lookup)")
    .option("--suite <which>", "security-only | benign-only | all (default)", "all")
    .option("--trials <n>", "trials per case (default: 3)")
    .action(
      async (
        agentName: string | undefined,
        opts: { config?: string; suite: string; trials?: string },
      ) => {
        let configPath: string;
        try {
          configPath = resolveEvalConfigPath(
            { agentName, explicitConfig: opts.config },
            { auggyDir: deps.auggyDir },
          );
        } catch (err) {
          console.error(`Error: ${(err as Error).message}`);
          exit(1);
          return;
        }

        if (
          opts.suite !== "all" &&
          opts.suite !== "security-only" &&
          opts.suite !== "benign-only"
        ) {
          console.error(
            `Error: --suite must be one of: all, security-only, benign-only (got "${opts.suite}")`,
          );
          exit(1);
          return;
        }

        let trialsOverride: number | undefined;
        if (opts.trials !== undefined) {
          const n = Number.parseInt(opts.trials, 10);
          if (!Number.isInteger(n) || n < 1) {
            console.error(`Error: --trials must be a positive integer (got "${opts.trials}")`);
            exit(1);
            return;
          }
          trialsOverride = n;
        }

        const result = await runner({
          configPath,
          runSecurity: opts.suite !== "benign-only",
          runBenign: opts.suite !== "security-only",
          trialsOverride,
        });
        exit(result.exitCode);
      },
    );
}
