import { afterEach, describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { agentMail } from "../../src/augments/agentMail";
import { createAgentMailInboundLedger } from "../../src/augments/agentMail/inbound-ledger";
import {
  createAgentMailReviewQueue,
  type AgentMailReviewRecord,
} from "../../src/augments/agentMail/review-queue";
import {
  agentMailRestEnvelope,
  normalizeAgentMailMessage,
} from "../../src/augments/agentMail/provider";
import type { AgentMailClient, SendMessageInput } from "../../src/agentmail-client";
import { stageBundle } from "../../src/cli/deploy/bundle";
import { resolveAugments } from "../../src/cli/augment-resolver";
import type { AugmentConfig } from "../../src/cli/types";
import { readOverrides } from "../../src/lib/admin-overrides";
import type { Augment, PeerIdentity, Tool, ToolExecuteContext } from "../../src/types";
import { asStringTool } from "../fixtures/tool-helpers";

const cleanup: string[] = [];

afterEach(() => {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanup.push(root);
  return root;
}

function fakeClient(): { client: AgentMailClient; sent: SendMessageInput[] } {
  const sent: SendMessageInput[] = [];
  return {
    sent,
    client: {
      async send(input) {
        sent.push(input);
        return { status: "sent", messageId: `msg_${sent.length}`, threadId: "thread_1" };
      },
      async reply() {
        return { status: "sent", messageId: "reply_1", threadId: "thread_1" };
      },
      async forward() {
        return { status: "sent", messageId: "forward_1", threadId: "thread_1" };
      },
      async getInbox(inboxId) {
        return { status: "ok", inboxId, email: "agent@example.com" };
      },
    },
  };
}

function peer(trustLevel: PeerIdentity["trustLevel"]): PeerIdentity {
  return {
    id: `peer-${trustLevel}`,
    kind: "human",
    trustLevel,
    sourceAugment: "web",
    ...(trustLevel === "public" ? { publicSubstate: "anonymous" as const } : {}),
  };
}

function context(trustLevel: PeerIdentity["trustLevel"]): ToolExecuteContext {
  return { turnId: crypto.randomUUID(), threadId: "thread-test", peer: peer(trustLevel) };
}

function sendTool(augment: Pick<Augment, "tools">) {
  const tool = augment.tools?.find((candidate) => candidate.name === "send_message") as
    | Tool<unknown>
    | undefined;
  if (!tool) throw new Error("AgentMail send_message tool missing");
  return asStringTool(tool);
}

function envelope(messageId: string, subject: string) {
  return agentMailRestEnvelope(
    normalizeAgentMailMessage({
      inbox_id: "support@agentmail.to",
      thread_id: `thread_${messageId}`,
      message_id: messageId,
      labels: ["received"],
      timestamp: "2026-07-15T10:20:30.000Z",
      from: "customer@example.com",
      to: ["support@agentmail.to"],
      subject,
      text: "Durable inbound body",
      size: 128,
    }),
  );
}

function reviewSubjects(stateDir: string, now: number): string[] {
  return createAgentMailReviewQueue({ stateDir, now: () => now })
    .list()
    .map((record: AgentMailReviewRecord) => record.subject);
}

describe("AgentMail Railway durability", () => {
  test("resolver wiring keeps outbound state on the volume across fresh image directories", async () => {
    const volumeRoot = tempRoot("agent-mail-resolver-volume-");
    const firstImage = tempRoot("agent-mail-resolver-image-a-");
    const secondImage = tempRoot("agent-mail-resolver-image-b-");
    const apiBaseUrl = "https://agentmail-railway-proof.invalid/v0";
    const config: AugmentConfig = {
      name: "support",
      type: "agentMail",
      options: {
        apiKey: "am_support",
        inboxId: "support",
        apiBaseUrl,
        inbound: { mode: "none" },
        outbound: {
          allowedTrustLevels: ["agent", "public"],
          rateLimit: {
            globalMaxPerHour: 100,
            perRecipientCooldownMs: 0,
            dedupWindowMs: 60_000,
          },
        },
      },
    };
    const originalFetch = globalThis.fetch;
    let providerCalls = 0;
    globalThis.fetch = (async (input, init) => {
      const url = String(input);
      if (!url.startsWith(apiBaseUrl)) return originalFetch(input, init);
      providerCalls++;
      return new Response(
        JSON.stringify({ message_id: `provider_${providerCalls}`, thread_id: "thread_1" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }) as typeof fetch;

    try {
      const [first] = await resolveAugments([config], firstImage, {
        runtimeDataRoot: volumeRoot,
      });
      if (!first) throw new Error("resolved AgentMail augment missing");
      const sent = JSON.parse(
        await sendTool(first).execute(
          { to: ["ops@example.com"], subject: "Resolver continuity", text: "sent once" },
          context("agent"),
        ),
      );
      expect(sent.status).toBe("sent");
      const pending = JSON.parse(
        await sendTool(first).execute(
          { to: ["customer@example.com"], subject: "Resolver review", text: "review me" },
          context("public"),
        ),
      ) as { status: string; reviewId: string };
      expect(pending.status).toBe("pending_review");
      await first.onShutdown?.();

      const [restarted] = await resolveAugments([config], secondImage, {
        runtimeDataRoot: volumeRoot,
      });
      if (!restarted) throw new Error("restarted AgentMail augment missing");
      const duplicate = JSON.parse(
        await sendTool(restarted).execute(
          { to: ["ops@example.com"], subject: "Resolver continuity", text: "must not resend" },
          context("agent"),
        ),
      );
      expect(duplicate.status).toBe("rate_limited");
      expect(providerCalls).toBe(1);
      expect(
        await restarted.adminActions?.["agentmail-review-reject"]?.({
          reviewId: pending.reviewId,
          reason: "resolver restart proof",
        }),
      ).toMatchObject({ ok: true });
      await restarted.onShutdown?.();

      const durableDir = join(volumeRoot, "agent-mail", "support");
      expect(existsSync(join(durableDir, "agent-mail-state.json"))).toBe(true);
      expect(existsSync(join(durableDir, "agent-mail-reviews.json"))).toBe(true);
      for (const imageDir of [firstImage, secondImage]) {
        expect(existsSync(join(imageDir, "agent-mail-state.json"))).toBe(false);
        expect(existsSync(join(imageDir, "agent-mail-reviews.json"))).toBe(false);
        expect(existsSync(join(imageDir, "agent-mail.db"))).toBe(false);
      }
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test("survives redeploy on one volume without crossing instance or image boundaries", async () => {
    const volumeRoot = tempRoot("agent-mail-railway-volume-");
    const supportDir = join(volumeRoot, "agent-mail", "support");
    const billingDir = join(volumeRoot, "agent-mail", "billing");
    const supportDb = join(supportDir, "agent-mail.db");
    const billingDb = join(billingDir, "agent-mail.db");
    const now = 2_000_000_000_000;

    let supportLedger = createAgentMailInboundLedger({ dbPath: supportDb, now: () => now });
    supportLedger.enqueue(envelope("support_message", "Support request"));
    supportLedger.close();
    let billingLedger = createAgentMailInboundLedger({ dbPath: billingDb, now: () => now });
    billingLedger.enqueue(envelope("billing_message", "Billing request"));
    billingLedger.close();

    const supportClient = fakeClient();
    const support = agentMail({
      apiKey: "am_support",
      inboxId: "support",
      stateDir: supportDir,
      overrideDir: volumeRoot,
      dbPath: supportDb,
      _client: supportClient.client,
      _now: () => now,
      outbound: {
        allowedTrustLevels: ["agent", "public"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    expect(
      JSON.parse(
        await sendTool(support).execute(
          { to: ["ops@example.com"], subject: "Support digest", text: "sent once" },
          context("agent"),
        ),
      ).status,
    ).toBe("sent");
    const supportReview = JSON.parse(
      await sendTool(support).execute(
        { to: ["customer@example.com"], subject: "Support approval", text: "please review" },
        context("public"),
      ),
    ) as { status: string; reviewId: string };
    expect(supportReview.status).toBe("pending_review");
    expect(await support.adminActions?.["agentmail-cap-adjust"]?.({ value: "13" })).toMatchObject({
      ok: true,
    });
    await support.onShutdown?.();

    const billingClient = fakeClient();
    const billing = agentMail({
      apiKey: "am_billing",
      inboxId: "billing",
      stateDir: billingDir,
      overrideDir: volumeRoot,
      dbPath: billingDb,
      _client: billingClient.client,
      _now: () => now,
      outbound: {
        allowedTrustLevels: ["agent", "public"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    expect(
      JSON.parse(
        await sendTool(billing).execute(
          { to: ["finance@example.com"], subject: "Billing digest", text: "sent once" },
          context("agent"),
        ),
      ).status,
    ).toBe("sent");
    // The identical support fingerprint is allowed in the billing namespace;
    // sharing one rate-state file would incorrectly reject this send.
    expect(
      JSON.parse(
        await sendTool(billing).execute(
          { to: ["ops@example.com"], subject: "Support digest", text: "billing-owned send" },
          context("agent"),
        ),
      ).status,
    ).toBe("sent");
    const billingReview = JSON.parse(
      await sendTool(billing).execute(
        { to: ["payer@example.com"], subject: "Billing approval", text: "please review" },
        context("public"),
      ),
    ) as { status: string; reviewId: string };
    expect(billingReview.status).toBe("pending_review");
    await billing.onShutdown?.();

    // A fresh factory sees rate history, the pending review, and the shared
    // override from the same simulated Railway volume.
    const restartedClient = fakeClient();
    const restarted = agentMail({
      apiKey: "am_support",
      inboxId: "support",
      stateDir: supportDir,
      overrideDir: volumeRoot,
      dbPath: supportDb,
      _client: restartedClient.client,
      _now: () => now + 1_000,
      outbound: {
        allowedTrustLevels: ["agent", "public"],
        rateLimit: { globalMaxPerHour: 100, perRecipientCooldownMs: 0, dedupWindowMs: 60_000 },
      },
    });
    const duplicate = JSON.parse(
      await sendTool(restarted).execute(
        { to: ["ops@example.com"], subject: "Support digest", text: "must not resend" },
        context("agent"),
      ),
    );
    expect(duplicate.status).toBe("rate_limited");
    expect(restartedClient.sent).toHaveLength(0);
    expect(
      await restarted.adminActions?.["agentmail-review-reject"]?.({
        reviewId: supportReview.reviewId,
        reason: "restart confirmed",
      }),
    ).toMatchObject({ ok: true });
    const info = await restarted.adminInfo?.();
    const capRow = info?.sections
      .flatMap((section) => (section.kind === "keyValue" ? section.rows : []))
      .find((row) => row.label === "Global cap (per hour)");
    expect(capRow).toMatchObject({ value: "13", source: "/admin override" });
    await restarted.onShutdown?.();

    expect(reviewSubjects(supportDir, now + 1_000)).toContain("[Auggy] Support approval");
    expect(reviewSubjects(supportDir, now + 1_000)).not.toContain("[Auggy] Billing approval");
    expect(reviewSubjects(billingDir, now + 1_000)).toContain("[Auggy] Billing approval");
    expect(reviewSubjects(billingDir, now + 1_000)).not.toContain("[Auggy] Support approval");
    expect(readOverrides(volumeRoot)?.overrides.agentMail?.globalMaxPerHour).toBe(13);

    supportLedger = createAgentMailInboundLedger({ dbPath: supportDb, now: () => now + 1_000 });
    billingLedger = createAgentMailInboundLedger({ dbPath: billingDb, now: () => now + 1_000 });
    expect(supportLedger.get("support@agentmail.to", "support_message")?.state).toBe("pending");
    expect(supportLedger.get("support@agentmail.to", "billing_message")).toBeNull();
    expect(billingLedger.get("support@agentmail.to", "billing_message")?.state).toBe("pending");
    expect(billingLedger.get("support@agentmail.to", "support_message")).toBeNull();
    supportLedger.close();
    billingLedger.close();

    // Even if a local agent directory contains stale copies, redeploy staging
    // cannot bake any operational state into the image.
    const imageSource = tempRoot("agent-mail-railway-image-source-");
    writeFileSync(join(imageSource, "agent.yaml"), "name: railway-durability\n");
    writeFileSync(join(imageSource, "identity.md"), "# Railway durability\n");
    copyFileSync(supportDb, join(imageSource, "agent-mail.db"));
    copyFileSync(
      join(supportDir, "agent-mail-reviews.json"),
      join(imageSource, "agent-mail-reviews.json"),
    );
    copyFileSync(
      join(supportDir, "agent-mail-state.json"),
      join(imageSource, "agent-mail-state.json"),
    );
    copyFileSync(
      join(volumeRoot, "admin-overrides.json"),
      join(imageSource, "admin-overrides.json"),
    );
    writeFileSync(join(imageSource, "agent-mail.db-wal"), "stale WAL");
    writeFileSync(join(imageSource, "agent-mail.db-shm"), "stale SHM");
    mkdirSync(join(imageSource, "data", "agent-mail", "support"), { recursive: true });
    writeFileSync(join(imageSource, "data", "agent-mail", "support", "secret"), "mail body");

    const staged = stageBundle({ agentDir: imageSource, agentName: "railway-durability" });
    cleanup.push(staged);
    expect(existsSync(join(staged, "agent.yaml"))).toBe(true);
    for (const stateName of [
      "agent-mail.db",
      "agent-mail.db-wal",
      "agent-mail.db-shm",
      "agent-mail-reviews.json",
      "agent-mail-state.json",
      "admin-overrides.json",
      "data",
    ]) {
      expect(existsSync(join(staged, stateName))).toBe(false);
    }
  });
});
