import type { GeneratedApplicationFile } from "./authoring/contracts";

export interface CustomAugmentScaffoldOptions {
  slug: string;
  includeSkill?: boolean;
  force?: boolean;
}

export function validateCustomAugmentSlug(slug: string): void {
  if (!/^[a-z0-9][a-z0-9_-]{0,49}$/.test(slug)) {
    throw new Error(
      "Invalid augment slug. Use 1–50 lowercase letters, numbers, hyphens, or underscores, starting with a letter or number.",
    );
  }
}

/** Pure project-owned sample files; the caller publishes them with central registration. */
export function scaffoldCustomAugment(
  opts: CustomAugmentScaffoldOptions,
): readonly GeneratedApplicationFile[] {
  validateCustomAugmentSlug(opts.slug);
  if (opts.force)
    throw new Error(
      "--force no longer overwrites augment source or skills. Choose another slug or review and move existing files manually.",
    );
  const slug = opts.slug;
  const source = `src/augments/${slug}`;
  const files: Record<string, string> = {
    [`${source}/index.ts`]: indexTemplate(slug),
    [`${source}/schemas.ts`]: schemasTemplate(),
    [`${source}/service.ts`]: serviceTemplate(),
    [`${source}/README.md`]: readmeTemplate(slug),
    [`tests/augments/${slug}.test.ts`]: testTemplate(slug),
  };
  if (opts.includeSkill) files[`skills/${slug}/SKILL.md`] = skillTemplate(slug);
  return Object.entries(files).map(([relativePath, text]) => ({
    relativePath,
    bytes: Buffer.from(text),
    mode: 0o644,
  }));
}

export const planCustomAugmentScaffold = scaffoldCustomAugment;

function schemasTemplate(): string {
  return `import { z } from "zod";

export const lookupInput = z.object({
  id: z.string().regex(/^SAMPLE-\\d{3}$/).describe("Sample record identifier, such as SAMPLE-001."),
});

export const recordSchema = z.object({
  id: z.string(),
  status: z.literal("ready"),
  label: z.string(),
});

export type SampleRecord = z.infer<typeof recordSchema>;
`;
}

function serviceTemplate(): string {
  return `import { lookupInput, type SampleRecord } from "./schemas";

// Sample read-only business logic. Replace this fixture with your system-of-record adapter.
const sample: Readonly<SampleRecord> = Object.freeze({
  id: "SAMPLE-001",
  status: "ready",
  label: "Example record",
});

export function lookupRecord(input: unknown): SampleRecord | null {
  const { id } = lookupInput.parse(input);
  return id === sample.id ? { ...sample } : null;
}
`;
}

function indexTemplate(slug: string): string {
  const tool = `${slug.replace(/-/g, "_")}_lookup_record`;
  return `import { defineAugment, defineRoute, defineTool, json } from "auggy";
import { lookupInput, recordSchema } from "./schemas";
import { lookupRecord } from "./service";

export default function createSampleAugment() {
  return defineAugment({
    name: "${slug}",
    tools: [
      defineTool({
        name: "${tool}",
        description: "Look up a sample record by its SAMPLE-001 style identifier.",
        category: "search",
        input: lookupInput,
        execute: async (input, context) => {
          // Exposure constraints and execution authorization are separate boundaries.
          if (context?.peer?.trustLevel !== "creator") {
            return { isError: true, content: JSON.stringify({ error: "forbidden", message: "Creator access required." }) };
          }
          const parsed = lookupInput.safeParse(input);
          if (!parsed.success) return { isError: true, content: JSON.stringify({ error: "invalid-input" }) };
          const record = lookupRecord(parsed.data);
          return record
            ? { content: JSON.stringify(record) }
            : { isError: true, content: JSON.stringify({ error: "not-found" }) };
        },
      }),
    ],
    constraints: {
      perTrustLevel: {
        public: { neverExpose: ["${tool}"] },
        agent: { neverExpose: ["${tool}"] },
      },
    },
    httpRoutes: [
      defineRoute.get("/${slug}/records/:id", {
        // The managed HTTP dispatcher authenticates this route before its handler.
        auth: "creator",
        params: lookupInput,
        response: recordSchema,
        handler: ({ params }) => {
          const record = lookupRecord(params);
          return record ? json(record) : json({ error: "not-found" }, 404);
        },
      }),
    ],
  });
}
`;
}

function skillTemplate(slug: string): string {
  return `---
name: ${slug}
description: Look up sample records using the ${slug} capability.
allowedTrustLevels:
  - creator
---

# ${slug}

Use \`${slug.replace(/-/g, "_")}_lookup_record\` with an identifier such as SAMPLE-001.
This is sample read-only logic, not a production database. Replace the service with
an adapter to your system of record before relying on real business data.
`;
}

function readmeTemplate(slug: string): string {
  return `# ${slug}

Sample read-only lookup logic created by \`auggy augment create ${slug}\` and
registered once in \`agent.yaml\`. The deterministic in-memory fixture is not a
production database, durable workflow, or system of record.

- \`schemas.ts\` owns validation shared by the tool and route.
- \`service.ts\` owns the read-only lookup. Replace it with a narrow system-of-record adapter.
- \`index.ts\` exposes \`${slug.replace(/-/g, "_")}_lookup_record\` and \`GET /${slug}/records/:id\`.
- \`tests/augments/${slug}.test.ts\` checks validation, lookup, missing records, and tool denial.

The sample ID is SAMPLE-001. The route requires creator authentication through the
managed HTTP transport, returns 400 for invalid IDs and 404 for missing records.
The tool has creator-only exposure constraints and an execution-time identity check.
Route authentication and tool authorization remain separate decisions. Do not relax
either without an explicit policy for the intended callers.

Run \`bun test tests/augments/${slug}.test.ts\` from the project root. HTTP authentication
must also be tested through the running managed transport; calling a route handler
directly does not authenticate a request.
`;
}

function testTemplate(slug: string): string {
  const tool = `${slug.replace(/-/g, "_")}_lookup_record`;
  return `import { describe, expect, test } from "bun:test";
import type { ToolExecuteContext, TrustLevel } from "auggy";
import createSampleAugment from "../../src/augments/${slug}/index";
import { lookupRecord } from "../../src/augments/${slug}/service";

const expected = { id: "SAMPLE-001", status: "ready", label: "Example record" } as const;
const augment = createSampleAugment();
const tool = augment.tools!.find((entry) => entry.name === "${tool}")!;
const route = augment.httpRoutes![0]!;
function context(trustLevel: TrustLevel): ToolExecuteContext {
  return { turnId: "test", threadId: "test", peer: { id: "test", kind: "human", trustLevel, sourceAugment: "test" } };
}

describe("${slug} sample lookup", () => {
  test("service validates input and returns a copy of the fixture or null", () => {
    expect(lookupRecord({ id: "SAMPLE-001" })).toEqual(expected);
    expect(lookupRecord({ id: "SAMPLE-999" })).toBeNull();
    expect(() => lookupRecord({ id: "invalid" })).toThrow();
    const record = lookupRecord({ id: "SAMPLE-001" })!;
    record.label = "changed";
    expect(lookupRecord({ id: "SAMPLE-001" })).toEqual(expected);
  });

  test("tool validates inputs and reports missing records", async () => {
    expect(tool.input.safeParse({ id: "invalid" }).success).toBe(false);
    expect(await tool.execute({ id: "SAMPLE-001" }, context("creator"))).toEqual({ content: JSON.stringify(expected) });
    expect(await tool.execute({ id: "SAMPLE-999" }, context("creator"))).toMatchObject({ isError: true, content: JSON.stringify({ error: "not-found" }) });
    expect(await tool.execute({ id: "invalid" }, context("creator"))).toMatchObject({ isError: true });
  });

  test("tool denies public, agent, and absent identities even on direct execution", async () => {
    for (const trustLevel of ["public", "agent"] as const) {
      expect(augment.constraints?.perTrustLevel?.[trustLevel]?.neverExpose).toContain(tool.name);
      expect(await tool.execute({ id: "SAMPLE-001" }, context(trustLevel))).toMatchObject({ isError: true });
    }
    expect(await tool.execute({ id: "SAMPLE-001" })).toMatchObject({ isError: true });
  });

  test("route declares creator policy and shares validation and service results", async () => {
    expect(route.auth).toBe("creator");
    expect(route.path).toBe("/${slug}/records/:id");
    // Authentication belongs to the managed HTTP dispatcher. These are adapter unit tests.
    const call = (id: string) => route.handler(new Request("http://localhost/${slug}/records/" + id), { signal: new AbortController().signal, params: { id } });
    const response = await call("SAMPLE-001");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(expected);
    expect((await call("invalid")).status).toBe(400);
    expect((await call("SAMPLE-999")).status).toBe(404);
  });
});
`;
}
