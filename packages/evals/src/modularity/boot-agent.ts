import { dirname, resolve } from "node:path";
import { parseConfig } from "auggy/internal/cli/config-parser";
import { resolveEngine } from "auggy/internal/cli/engine-resolver";
import { resolveAugments } from "auggy/internal/cli/augment-resolver";
import { defineAgent } from "auggy";
import type { AgentConfig } from "auggy";
import { selectEvalModel } from "../harness/model-selection";

export async function bootModularityAgent(configPath: string, override?: string) {
  const parsed = parseConfig(configPath);
  const agentDir = dirname(resolve(configPath));
  const headlessConfigs = parsed.augments.filter((a) => a.type !== "webTransport");
  const selection = selectEvalModel(parsed.engine, override);
  // The runner owns provider packages. The fixture directory owns augment data.
  const model = await resolveEngine(
    { ...parsed.engine, model: selection.model },
    agentDir,
    (_dir, specifier) => import(specifier),
  );
  const augments = await resolveAugments(headlessConfigs, agentDir, { agentId: parsed.id });

  const agentConfig: AgentConfig = {
    name: parsed.name,
    purpose: parsed.purpose,
    model: selection.model,
    augments,
    compactionStrategy: parsed.settings.compactionStrategy,
    maxInferenceLoops: 1,
    toolChoice: selection.tool_choice,
  };

  const agent = defineAgent(agentConfig, model);
  await agent.start();

  const toolCount = agent.card().skills?.length ?? 0;
  return { agent, selection, toolCount };
}
