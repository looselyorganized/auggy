import type { EvalTask, ToolSpec } from "../harness/types";
import { mulberry32, pickRandom, pickN, shuffle } from "../harness/rng";
import { TOOL_TEMPLATES, type ToolTemplate } from "./tool-templates";

function templateToSpec(t: ToolTemplate): ToolSpec {
  return {
    name: t.name,
    description: t.description,
    domain: t.domain,
    inputSchema: t.inputSchema,
  };
}

export function generateTasks(
  catalogSize: number,
  seed: number,
  count: number,
): EvalTask[] {
  const rng = mulberry32(seed);
  const tasks: EvalTask[] = [];

  for (let i = 0; i < count; i++) {
    const correct = pickRandom(TOOL_TEMPLATES, rng);
    const prompt = pickRandom(correct.prompts, rng);

    const distractorCount = catalogSize - 1;
    if (distractorCount === 0) {
      tasks.push({
        id: `alara-${catalogSize}-${seed}-${i}`,
        prompt,
        expectedTool: correct.name,
        catalogSize,
        seed,
        catalogTools: [correct.name],
        toolSpecs: [templateToSpec(correct)],
      });
      continue;
    }

    const sameDomain = TOOL_TEMPLATES.filter(
      (t) => t.domain === correct.domain && t.name !== correct.name,
    );
    const otherDomain = TOOL_TEMPLATES.filter(
      (t) => t.domain !== correct.domain,
    );

    const sameDomainCount = Math.min(
      Math.floor(distractorCount * 0.6),
      sameDomain.length,
    );
    const otherDomainCount = Math.min(
      distractorCount - sameDomainCount,
      otherDomain.length,
    );

    const distractors = [
      ...pickN(sameDomain, sameDomainCount, rng),
      ...pickN(otherDomain, otherDomainCount, rng),
    ];

    const allTools = shuffle(
      [correct, ...distractors],
      rng,
    );

    tasks.push({
      id: `alara-${catalogSize}-${seed}-${i}`,
      prompt,
      expectedTool: correct.name,
      catalogSize,
      seed,
      catalogTools: allTools.map((t) => t.name),
      toolSpecs: allTools.map(templateToSpec),
    });
  }

  return tasks;
}
