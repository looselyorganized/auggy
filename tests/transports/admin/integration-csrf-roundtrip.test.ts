/**
 * End-to-end CSRF round-trip — boot a real agent, GET /admin, parse the
 * `_csrf` token from a rendered form, POST it back. The previous shared
 * `__page` token returned 403 (bound to "__page" but validated against
 * the actual action id); per-(actionId, rowKey) tokens make the
 * dashboard usable end-to-end.
 *
 * Also covers row-action rendering (memory-erase had no UI affordance
 * before this fix).
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineAgent } from "@/agent";
import { budgets } from "@/augments/budgets";
import { layeredMemory } from "@/augments/layered-memory";
import { webTransport } from "@/transports/web-transport";
import { createMockModel } from "@tests/fixtures/mock-model";

const BEARER = "csrf-roundtrip-bearer";

function authHeader(): string {
  return `Basic ${Buffer.from(`:${BEARER}`).toString("base64")}`;
}

function parseCsrfFromForm(html: string, actionPath: string): string | null {
  // Find the <form action="actionPath" ...><input ... name="_csrf" value="...">
  const formPattern = new RegExp(
    `<form[^>]*action="${actionPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>([\\s\\S]*?)</form>`,
  );
  const formMatch = html.match(formPattern);
  if (!formMatch) return null;
  const csrfMatch = formMatch[1]!.match(/name="_csrf" value="([^"]+)"/);
  return csrfMatch?.[1] ?? null;
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
  it("GET /admin → parse _csrf from posture-flip form → POST returns 303 (not 403)", async () => {
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
      const getResp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: authHeader() },
      });
      expect(getResp.status).toBe(200);
      const html = await getResp.text();

      const csrf = parseCsrfFromForm(html, "/admin/action/posture-flip");
      expect(csrf).not.toBeNull();
      expect(csrf!.length).toBeGreaterThan(10);

      const postResp = await fetch(`http://127.0.0.1:${port}/admin/action/posture-flip`, {
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

  it("posture-reset form carries a DIFFERENT csrf token than posture-flip", async () => {
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
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: authHeader() },
      });
      const html = await resp.text();
      const flipCsrf = parseCsrfFromForm(html, "/admin/action/posture-flip");
      const resetCsrf = parseCsrfFromForm(html, "/admin/action/posture-reset");
      expect(flipCsrf).not.toBeNull();
      expect(resetCsrf).not.toBeNull();
      expect(flipCsrf).not.toBe(resetCsrf);
    } finally {
      await agent.stop();
    }
  });

  it("row-action buttons render in tables AND POST round-trips with per-row CSRF", async () => {
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
      const resp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: authHeader() },
      });
      const html = await resp.text();

      // The memory-erase rowAction form should render for the seeded row.
      // rowKey "vis_rowtest" is in column 0 (Peer); URL-encoded form action.
      const expectedAction = "/admin/action/memory-erase/row/vis_rowtest";
      expect(html).toContain(`action="${expectedAction}"`);

      const csrf = parseCsrfFromForm(html, expectedAction);
      expect(csrf).not.toBeNull();

      const postResp = await fetch(`http://127.0.0.1:${port}${expectedAction}`, {
        method: "POST",
        headers: {
          authorization: authHeader(),
          "content-type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ _csrf: csrf! }).toString(),
        redirect: "manual",
      });
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
      const getResp = await fetch(`http://127.0.0.1:${port}/admin`, {
        headers: { authorization: authHeader() },
      });
      const html = await getResp.text();

      const csrf = parseCsrfFromForm(html, "/admin/action/budget-cap-adjust");
      expect(csrf).not.toBeNull();

      const postResp = await fetch(`http://127.0.0.1:${port}/admin/action/budget-cap-adjust`, {
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
