import type { AgentExecutionOptions, TurnProgramBinding } from "auggy/application";
import { observeFinalization } from "./observability";
import { turnProgram } from "./turn";

// YAML supplies the provider, settings and enabled augments exactly once.
export const agentExecution: AgentExecutionOptions & { turnProgram: TurnProgramBinding } = {
  turnProgram,
  onTurnFinalized: observeFinalization,
};
