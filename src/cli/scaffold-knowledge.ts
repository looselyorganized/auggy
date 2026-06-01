import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface KnowledgeScaffoldValues {
  orgName: string;
  orgPurpose: string;
  operatorName: string;
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
    operator: values.operatorName,
    phase: "active",
    endpoints: [
      { path: "/mission", description: "Org mission and active focus" },
      { path: "/team", description: "People and roles" },
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
    `# Mission\n\nThis agent helps with ${values.orgPurpose}\n\n## What This Agent Should Know\n\n- The project or organization is called ${values.orgName}.\n- The operator is ${values.operatorName}.\n- The current goal is ${values.orgPurpose}\n\n## Useful Context\n\nAdd product notes, project goals, policies, FAQs, domain context, or recurring decisions here.\n`,
    opts,
  );
  writeText(
    join(localDir, "team.md"),
    `# Team\n\n## Operator\n\n- ${values.operatorName}: primary operator and owner of this agent.\n\n## Contacts\n\nAdd people, roles, escalation paths, support contacts, or teams the agent should know about.\n`,
    opts,
  );
  writeText(join(knowledgeDir, "README.md"), knowledgeReadme(), opts);
}

function writeText(path: string, text: string, opts: KnowledgeScaffoldOptions): void {
  if (!opts.overwrite && existsSync(path)) return;
  writeFileSync(path, text);
}

function knowledgeReadme(): string {
  return `# Knowledge

This directory is the agent's private knowledge base. It is mounted by \`agent.yaml\`:

\`\`\`yaml
- name: knowledge
  type: knowledge
  options:
    root: ./knowledge
\`\`\`

## Files

- \`sources.json\` lists the knowledge sources the agent can use.
- \`local/manifest\` describes the local endpoints the agent is allowed to fetch.
- \`local/mission.md\` and \`local/team.md\` are starter endpoint files.

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
