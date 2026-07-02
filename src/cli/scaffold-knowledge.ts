import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { writeFileSafely } from "./safe-write";

export interface KnowledgeScaffoldValues {
  orgName: string;
  orgPurpose: string;
  creatorName: string;
}

export interface KnowledgeScaffoldOptions {
  overwrite?: boolean;
}

/**
 * Write a minimal `knowledge/` directory the knowledge augment can read.
 */
export function writeKnowledgeScaffold(
  agentDir: string,
  values: KnowledgeScaffoldValues,
  opts: KnowledgeScaffoldOptions = {},
): void {
  const knowledgeDir = join(agentDir, "knowledge");
  const localDir = join(knowledgeDir, "local");
  mkdirSync(localDir, { recursive: true });

  const manifest = {
    org: values.orgName,
    purpose: values.orgPurpose,
    creator: values.creatorName,
    phase: "active",
    endpoints: [
      { path: "/mission", description: "Agent purpose, project context, and active focus" },
      { path: "/context", description: "Project background, terminology, workflows, and policies" },
    ],
  };

  writeText(
    join(knowledgeDir, "sources.json"),
    `${JSON.stringify(
      {
        sources: [
          {
            name: "local",
            description: "Local project knowledge maintained with this agent",
            baseUrl: "file://./local",
          },
        ],
      },
      null,
      2,
    )}\n`,
    opts,
  );
  writeText(join(localDir, "manifest"), `${JSON.stringify(manifest, null, 2)}\n`, opts);
  writeText(
    join(localDir, "mission.md"),
    `# Mission\n\n_Add information about this agent's mission here._\n\n## What It Should Know\n\n_Add project or organization information, creator details, product context, policies, FAQs, and domain context here._\n\n## Useful Context\n\n_Add recurring decisions, important links, support notes, constraints, or other context this agent should use when helping visitors._\n`,
    opts,
  );
  writeText(
    join(localDir, "context.md"),
    `# Context\n\n## Background\n\n_Add project, product, organization, or domain background here._\n\n## Terms\n\n_Add vocabulary, abbreviations, entities, or concepts the agent should understand._\n\n## Workflows And Policies\n\n_Add recurring workflows, rules, policies, support notes, constraints, or escalation paths here._\n\n## Team Members\n\n_Add relevant team members, roles, ownership areas, or collaborators here if useful._\n\n## Contacts\n\n_Add support contacts, escalation paths, vendors, or external contacts here if useful._\n`,
    opts,
  );
  writeText(join(knowledgeDir, "README.md"), knowledgeReadme(), opts);
}

function writeText(path: string, text: string, opts: KnowledgeScaffoldOptions): void {
  if (!opts.overwrite && existsSync(path)) return;
  writeFileSafely(path, text);
}

function knowledgeReadme(): string {
  return `# Knowledge

This directory is the agent's private knowledge base. Enable it in \`agent.yaml\`
and configure it in \`augments/knowledge/augment.yaml\`:

\`\`\`yaml
# agent.yaml
augments:
  - knowledge

# augments/knowledge/augment.yaml
type: knowledge
config:
  root: ./knowledge
\`\`\`

## Files

- \`sources.json\` lists the knowledge sources the agent can use.
- \`local/manifest\` describes the local endpoints the agent is allowed to fetch.
- \`local/mission.md\` and \`local/context.md\` are starter endpoint files.

## Add Local Knowledge

1. Add a markdown file under \`local/\`, for example \`local/pricing.md\`.
2. Add a matching endpoint to \`local/manifest\`:

\`\`\`json
{
  "path": "/pricing",
  "description": "Pricing, plans, and billing policy"
}
\`\`\`

3. Restart the agent. The model will see \`/pricing\` in context and can fetch it with:

\`\`\`
knowledge_fetch({ source: "local", endpoint: "/pricing" })
\`\`\`

## Add A Remote Knowledge API

Add another entry to \`sources.json\`:

\`\`\`json
{
  "name": "docs",
  "description": "Published product documentation",
  "baseUrl": "https://docs.example.com/knowledge"
}
\`\`\`

The remote API must expose \`GET /manifest\` and every endpoint listed in that manifest. For example, if its manifest lists \`/quickstart\`, the agent may call:

\`\`\`
knowledge_fetch({ source: "docs", endpoint: "/quickstart" })
\`\`\`

Use short source names like \`local\`, \`docs\`, \`api\`, or \`handbook\`. Use endpoint descriptions that tell the model when to fetch that endpoint.
`;
}
