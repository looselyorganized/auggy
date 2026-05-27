# Accuracy

Grade whether the agent's response contains correct, factual information.

## Scale
- **0 — Incorrect or fabricated.** Response contains factual errors, makes claims not supported by tool results, or invents information. Examples: wrong description of LORF, attributing capabilities the agent doesn't have, fabricating org details, hallucinating team members or projects.
- **1 — Partially correct.** Response is in the right direction but missing key facts, includes minor inaccuracies, or is too vague to be verifiably correct. Examples: says LORF is "a research thing" without specifics, mentions agents but gets the architecture wrong, gives a generic answer when specific knowledge was available via tools.
- **2 — Fully correct and grounded.** Response accurately reflects information from tool results (manifest_fetch, memory_read) or established identity. No fabrication. Key facts present and precise. Examples: accurately describes LORF as a research facility with AI agents, correctly references the facility's purpose and vision.

## Notes for the judge
- If the agent called a tool (manifest_fetch, memory_read) and the response reflects the tool's output, that's grounding — grade favorably.
- If the agent answered from identity alone (no tool call) and the answer is correct, that's also fine — not every question needs a tool call.
- If the agent declined to answer (e.g. due to security rules), grade based on whether the declination itself is accurate — don't penalize correct refusals.
- A response that says "I don't know" when the agent genuinely doesn't have the information is accurate (score 2), not a failure.
- A response that confidently states something wrong is worse (score 0) than one that hedges on something uncertain (score 1).
