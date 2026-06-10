import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import conciergeServices from "./index";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempLeadsPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "concierge-services-"));
  dirs.push(dir);
  return join(dir, "leads.jsonl");
}

describe("concierge-services", () => {
  test("serves service search over an HTTP route", async () => {
    const augment = conciergeServices({ leadsPath: tempLeadsPath() });
    const route = augment.httpRoutes?.find((r) => r.method === "GET" && r.path === "/services");

    expect(route).toBeDefined();

    const res = await route!.handler(new Request("http://localhost/services?need=gift"), {
      signal: AbortSignal.timeout(1000),
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { services: Array<{ id: string }> };
    expect(body.services.map((service) => service.id)).toContain("curated-gifting");
  });

  test("saves leads through route and tool paths using the same domain logic", async () => {
    const leadsPath = tempLeadsPath();
    const augment = conciergeServices({ leadsPath });
    const route = augment.httpRoutes?.find(
      (r) => r.method === "POST" && r.path === "/leads/create",
    );
    const tool = augment.tools?.find((t) => t.name === "save_lead");

    expect(route).toBeDefined();
    expect(tool).toBeDefined();

    const routeRes = await route!.handler(
      new Request("http://localhost/leads/create", {
        method: "POST",
        body: JSON.stringify({
          name: "Ada",
          email: "ada@example.com",
          need: "A gift package",
          timeline: "this week",
          budgetUsd: 250,
        }),
      }),
      { signal: AbortSignal.timeout(1000) },
    );

    expect(routeRes.status).toBe(201);
    const routeBody = (await routeRes.json()) as { lead: { highIntent: boolean } };
    expect(routeBody.lead.highIntent).toBe(true);

    await tool!.execute({
      name: "Grace",
      email: "grace@example.com",
      need: "Home styling",
      budgetUsd: 300,
    });

    expect(existsSync(leadsPath)).toBe(true);
    const lines = readFileSync(leadsPath, "utf-8").trim().split("\n");
    expect(lines).toHaveLength(2);
  });
});
