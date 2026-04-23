import { z } from "zod";
import { defineAgent } from "../../src/agent";
import { defineAugment } from "../../src/helpers";
import type {
  AgentConfig,
  AgentHandle,
  AugmentConstraints,
  ModelClient,
  Tool,
} from "../../src/types";
import type { ToolSpec } from "./types";

function specToTool(spec: ToolSpec): Tool<unknown> {
  return {
    name: spec.name,
    description: spec.description,
    category: "meta",
    input: z.object({}),
    inputJsonSchema: Object.keys(spec.inputSchema).length > 0
      ? spec.inputSchema
      : { type: "object", properties: {} },
    execute: async () => `Tool ${spec.name} executed successfully.`,
  };
}

export function buildEvalAgent(
  toolSpecs: ToolSpec[],
  neverExpose: string[],
  model: ModelClient,
  opts?: { maxInferenceLoops?: number },
): AgentHandle {
  const tools = toolSpecs.map(specToTool);

  const constraints: AugmentConstraints = {
    neverExpose,
    maxToolCallsPerTurn: 3,
  };

  const evalAugment = defineAugment({
    name: "eval-catalog",
    capabilities: ["tools"],
    tools,
    constraints,
  });

  const config: AgentConfig = {
    name: "alara-eval-agent",
    purpose: "ALARA structural-omission ablation eval",
    model: "eval",
    augments: [evalAugment],
    maxInferenceLoops: opts?.maxInferenceLoops ?? 1,
  };

  return defineAgent(config, model);
}
