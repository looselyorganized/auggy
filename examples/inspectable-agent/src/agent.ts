import type { AgentComposer } from "auggy/application";
import { observeFinalization } from "./observability";
import { turnProgram } from "./turn";

// YAML supplies the provider, settings and enabled augments exactly once.
export const composeAgent: AgentComposer = (configured) =>
  configured.compose({ turnProgram, onTurnFinalized: observeFinalization });
