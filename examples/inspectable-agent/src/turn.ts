import type { TurnProgramBinding } from "auggy/application";
import { observeTurnStart } from "./observability";

export const turnProgram: TurnProgramBinding = {
  maxInferences: 2,
  timeoutMs: 60_000,
  async run(turn) {
    observeTurnStart(turn);
    const internal = await turn.dispatchInternalTurn();
    if (internal.handled) return internal.completion;

    const prompt = await turn.preparePrompt();
    if (prompt.kind === "terminal") return prompt.completion;

    while (turn.remainingInferences > 0) {
      const inference = await turn.infer();
      if (inference.kind === "answer") return turn.complete(inference);

      // The runtime validates, authorizes and settles this whole tool batch.
      const batch = await turn.executeTools(inference);
      if (batch.kind === "terminal") return batch.completion;

      // Change the binding above to 1 to stop after the first completed batch.
      // An unknown effect or terminating tool always takes precedence above.
      if (turn.remainingInferences === 0) return turn.stop("application-limit");

      if (batch.kind === "final-answer-required") {
        const answer = await turn.inferFinal(batch);
        return answer.kind === "terminal" ? answer.completion : turn.complete(answer);
      }
      await turn.refreshPrompt();
    }
    return turn.stop("application-limit");
  },
};
