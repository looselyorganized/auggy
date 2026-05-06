/**
 * auggy eval [suite|agent] — run an eval suite.
 *
 * Suite routing:
 *   auggy eval auto-save                # auto-save fixture validation (dry-run)
 *   auggy eval auto-save --dry-run      # explicit dry-run (same as above)
 *
 * Security eval (default when no suite name is given):
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
import { runAutoSaveEval } from "../../../evals/auto-save/run";
import { getAgent } from "../agent-index";

/** Known suite names that route to specialized runners (not the security runner). */
const NAMED_SUITES = ["auto-save"] as const;
type NamedSuite = (typeof NAMED_SUITES)[number];

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

export interface EvalCommandDeps {
  /** Inject for tests so we don't make real API calls. */
  runEvalSuite?: typeof runEvalSuite;
  /** Inject auto-save runner for tests. */
  runAutoSaveEval?: typeof runAutoSaveEval;
  /** Override exit so tests can assert the exit code without crashing the runner. */
  exit?: (code: number) => void;
  /** Override `~/.auggy/` for tests. */
  auggyDir?: string;
}

export function evalCommand(deps: EvalCommandDeps = {}): Command {
  const runner = deps.runEvalSuite ?? runEvalSuite;
  const autoSaveRunner = deps.runAutoSaveEval ?? runAutoSaveEval;
  const exit = deps.exit ?? ((code: number) => process.exit(code));

  return new Command("eval")
    .description("Run an eval suite: auto-save (fixture validation) or security (default)")
    .argument(
      "[suite-or-agent]",
      "suite name (auto-save) or registered agent name for security eval (defaults to the bundled fixture)",
    )
    .option(
      "--config <path>",
      "explicit agent.yaml path (overrides agent name lookup; security eval only)",
    )
    .option(
      "--suite <which>",
      "security-only | benign-only | all (default; security eval only)",
      "all",
    )
    .option("--trials <n>", "trials per case (default: 3; security eval only)")
    .option("--dry-run", "validate auto-save fixtures without LLM calls (auto-save suite only)")
    .action(
      async (
        suiteOrAgent: string | undefined,
        opts: { config?: string; suite: string; trials?: string; dryRun?: boolean },
      ) => {
        // Route named suites to their own runners.
        if (suiteOrAgent != null && NAMED_SUITES.includes(suiteOrAgent as NamedSuite)) {
          const suiteName = suiteOrAgent as NamedSuite;

          if (suiteName === "auto-save") {
            const result = await autoSaveRunner({ dryRun: opts.dryRun !== false });
            exit(result.exitCode);
            return;
          }

          // Future named suites routed here.
          console.error(`Error: unknown suite "${suiteName}"`);
          exit(1);
          return;
        }

        // Security eval path (default when no named suite is given).
        const agentName = suiteOrAgent;
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
