/**
 * Wizard-restart machinery for interactive CLI flows.
 *
 * Wrap a single prompt call with `withEscRestart(ctx => prompt(config, ctx))`
 * and pressing `Esc` during that prompt rejects with `WizardRestartRequested`.
 * The caller catches the sentinel at the top of the wizard and restarts from
 * the first prompt.
 *
 * Why call-time wrapping (not module-scope wrapping): tests replace
 * `@inquirer/prompts` via `mock.module(...)`. ESM live-bindings re-route
 * those replacements at call time. Capturing a prompt reference at module
 * scope (`const askSelect = wrap(select)`) defeats that — file-level
 * re-mocks no longer propagate. Pass the call lazily via a thunk and the
 * problem goes away.
 *
 * Non-TTY contexts (CI, tests with mocked prompts) skip the keypress
 * listener and forward the caller's signal as-is.
 */

import { AbortPromptError } from "@inquirer/core";

/**
 * Thrown by `withEscRestart` when the operator presses Esc. Catch this at
 * the wizard's outer loop to restart the flow.
 */
export class WizardRestartRequested extends Error {
  override name = "WizardRestartRequested";
  constructor() {
    super("wizard restart requested (Esc)");
  }
}

/**
 * Run a prompt call with Esc-aware cancellation. The provided callback
 * receives a context object whose `signal` aborts on Esc; pass it to
 * `@inquirer/prompts` as the second argument and inquirer will reject
 * with `AbortPromptError`, which we surface as `WizardRestartRequested`.
 *
 * Implementation note: inquirer enables raw mode + keypress events on
 * stdin while a prompt is active. We piggyback on those events by adding
 * our own listener for the duration of the call.
 */
export async function withEscRestart<T>(
  promptCall: (ctx: { signal: AbortSignal }) => Promise<T>,
): Promise<T> {
  const ac = new AbortController();

  // TTY path: attach a keypress listener that aborts on Esc. Non-TTY (CI,
  // tests) skips the listener entirely — promptCall still gets a signal
  // (never aborts) so the call-site doesn't need to branch.
  const isTty = Boolean(process.stdin.isTTY);
  const onKey = (_str: unknown, key: { name?: string } | undefined): void => {
    if (key?.name === "escape") ac.abort();
  };
  if (isTty) process.stdin.on("keypress", onKey);

  try {
    return await promptCall({ signal: ac.signal });
  } catch (err) {
    // Inquirer rejects with AbortPromptError when its signal aborts.
    // Surface that as a restart request regardless of TTY state so test
    // doubles (which throw AbortPromptError directly) round-trip cleanly.
    if (err instanceof AbortPromptError) {
      throw new WizardRestartRequested();
    }
    throw err;
  } finally {
    if (isTty) process.stdin.removeListener("keypress", onKey);
  }
}
