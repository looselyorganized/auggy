/**
 * End-to-end CSRF round-trip — boot a real agent, GET /console/api/dashboard
 * to discover the per-(actionId, rowKey) CSRF tokens, POST one back. The
 * previous shared `__page` token returned 403 (bound to "__page" but
 * validated against the actual action id); per-action tokens make the
 * dashboard usable end-to-end.
 *
 * Pre-SPA this test scraped HTML forms; with the SPA, the dashboard data
 * (blocks + csrfTokens) is served as JSON for the React client to render.
 * Server-side dispatch contract is unchanged.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { budgets } from "@/augments/budgets";
import { layeredMemory } from "@/augments/layeredMemory";
import { webTransport } from "@/transports/web-transport";
import { createMockModel } from "@tests/fixtures/mock-model";

const BEARER = "csrf-roundtrip-bearer";

function authHeader(): string {
  return `Basic ${Buffer.from(`:${BEARER}`).toString("base64")}`;
}

interface DashboardJson {
  card: { provider: { name: string } };
  blocks: unknown[];
  csrfTokens: { actionId: string; rowKey?: string; token: string }[];
}

function findCsrfToken(data: DashboardJson, actionId: string, rowKey?: string): string | null {
  const match = data.csrfTokens.find(
    (t) => t.actionId === actionId && (t.rowKey ?? undefined) === rowKey,
  );
  return match?.token ?? null;
}

async function fetchDashboard(port: number): Promise<DashboardJson> {
  const resp = await fetch(`http://127.0.0.1:${port}/console/api/dashboard`, {
    headers: { authorization: authHeader() },
  });
  expect(resp.status).toBe(200);
  return (await resp.json()) as DashboardJson;
}

let tempDir: string;
let port: number;
// Deterministic high-block ports — avoid colliding with the 19500-19501
// pair used in tests/integration/full-agent.test.ts. Bun runs test files
// in parallel by default; a randomized range here flaked CI when two
// files happened to draw the same port.
let portCounter = 19800;
beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), "auggy-csrf-rt-"));
  port = portCounter++;
});
afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

describe("admin CSRF round-trip (hotfix)", () => {
  it("GET dashboard → pick posture-flip token → POST returns 303 (not 403)", async () => {
    const model = createMockModel();
    const agent = defineAgent(
      {
        name: "csrf-rt",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: BEARER },
            allowAnonymous: false,
            adminRoute: true,
            agentDir: tempDir,
          }),
        ],
      },
      model,
    );

    await agent.start();
    try {
      const data = await fetchDashboard(port);
      const csrf = findCsrfToken(data, "posture-flip");
      expect(csrf).not.toBeNull();
      expect(csrf!.length).toBeGreaterThan(10);

      const postResp = await fetch(`http://127.0.0.1:${port}/console/action/posture-flip`, {
        method: "POST",
        headers: {
          authorization: authHeader(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf!, value: "true" }).toString(),
        redirect: "manual",
      });
      expect(postResp.status).toBe(303);
      await postResp.text();
    } finally {
      await agent.stop();
    }
  });

  it("posture-reset token is DIFFERENT than posture-flip token", async () => {
    const model = createMockModel();
    const agent = defineAgent(
      {
        name: "csrf-rt",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: BEARER },
            allowAnonymous: false,
            adminRoute: true,
            agentDir: tempDir,
          }),
        ],
      },
      model,
    );
    await agent.start();
    try {
      const data = await fetchDashboard(port);
      const flipCsrf = findCsrfToken(data, "posture-flip");
      const resetCsrf = findCsrfToken(data, "posture-reset");
      expect(flipCsrf).not.toBeNull();
      expect(resetCsrf).not.toBeNull();
      expect(flipCsrf).not.toBe(resetCsrf);
    } finally {
      await agent.stop();
    }
  });

  it("row-action tokens appear per-row AND POST round-trips with per-row CSRF", async () => {
    const model = createMockModel();
    const mem = await layeredMemory({
      backend: "sqlite",
      namespace: "ep",
      dbPath: join(tempDir, "memory.db"),
      autoSave: { enabled: false },
    });
    // Seed the memory store directly via the augment's own write hook so a
    // row actually appears in the table (the table is empty otherwise).
    await mem.memory!.write!("ep:vis_rowtest:hello", "world", {
      peerId: "vis_rowtest",
      trustLevel: "public",
    });

    const agent = defineAgent(
      {
        name: "csrf-rt",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: BEARER },
            allowAnonymous: false,
            adminRoute: true,
            agentDir: tempDir,
          }),
          mem,
        ],
      },
      model,
    );
    await agent.start();
    try {
      const data = await fetchDashboard(port);

      // The seeded row should mint a per-row CSRF token for memory-erase.
      const csrf = findCsrfToken(data, "memory-erase", "vis_rowtest");
      expect(csrf).not.toBeNull();

      const postResp = await fetch(
        `http://127.0.0.1:${port}/console/action/memory-erase/row/vis_rowtest`,
        {
          method: "POST",
          headers: {
            authorization: authHeader(),
            "content-type": "application/x-www-form-urlencoded",
          },
          body: new URLSearchParams({ _csrf: csrf! }).toString(),
          redirect: "manual",
        },
      );
      expect(postResp.status).toBe(303);
      await postResp.text();
    } finally {
      await agent.stop();
    }
  });

  it("budgets cap-adjust round-trips end-to-end", async () => {
    const model = createMockModel();
    const agent = defineAgent(
      {
        name: "csrf-rt",
        model: "mock",
        augments: [
          webTransport({
            port,
            auth: { type: "bearer", token: BEARER },
            allowAnonymous: false,
            adminRoute: true,
            agentDir: tempDir,
          }),
          budgets({
            dbPath: join(tempDir, "budgets.db"),
            agentDir: tempDir,
            dailyBudgetUsd: 100,
            caps: { agent: { maxUsdPerDay: 50 } },
          }),
        ],
      },
      model,
    );
    await agent.start();
    try {
      const data = await fetchDashboard(port);
      const csrf = findCsrfToken(data, "budget-cap-adjust");
      expect(csrf).not.toBeNull();

      const postResp = await fetch(`http://127.0.0.1:${port}/console/action/budget-cap-adjust`, {
        method: "POST",
        headers: {
          authorization: authHeader(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf!, value: "250" }).toString(),
        redirect: "manual",
      });
      expect(postResp.status).toBe(303);
      await postResp.text();
    } finally {
      await agent.stop();
    }
  });
});
