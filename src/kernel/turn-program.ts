import type { TurnProgram, TurnProgramBinding } from "../types";

/** The legacy and project programs invoke the same guarded operations. */
export const defaultTurnProgram: TurnProgram = async (turn) => {
  const internal = await turn.dispatchInternalTurn();
  if (internal.handled) return internal.completion;
  const prepared = await turn.preparePrompt();
  if (prepared.kind === "terminal") return prepared.completion;
  while (turn.remainingInferences > 0) {
    const step = await turn.infer();
    if (step.kind === "answer") return turn.complete(step);
    const batch = await turn.executeTools(step);
    if (batch.kind === "terminal") return batch.completion;
    if (batch.kind === "final-answer-required") {
      const final = await turn.inferFinal(batch);
      return final.kind === "terminal" ? final.completion : turn.complete(final);
    }
    await turn.refreshPrompt();
  }
  return turn.finishAtLimit();
};

export function validateTurnProgramBinding(
  binding: TurnProgramBinding | undefined,
  packageLimit: number,
): TurnProgramBinding | undefined {
  if (binding === undefined) return undefined;
  if (!binding || typeof binding.run !== "function") {
    throw new Error("A turn program requires a run function.");
  }
  if (
    binding.maxInferences !== undefined &&
    (!Number.isSafeInteger(binding.maxInferences) ||
      binding.maxInferences < 1 ||
      binding.maxInferences > packageLimit)
  ) {
    throw new Error("Program maxInferences must be a positive integer within the package limit.");
  }
  if (
    binding.timeoutMs !== undefined &&
    (!Number.isSafeInteger(binding.timeoutMs) ||
      binding.timeoutMs < 1 ||
      binding.timeoutMs > 900_000)
  ) {
    throw new Error("Program timeoutMs must be a positive integer at most 900000.");
  }
  return Object.freeze({
    run: binding.run,
    ...(binding.maxInferences === undefined ? {} : { maxInferences: binding.maxInferences }),
    timeoutMs: binding.timeoutMs ?? 900_000,
  });
}
