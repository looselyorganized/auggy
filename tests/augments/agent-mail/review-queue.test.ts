import { afterEach, describe, expect, test } from "bun:test";
import {
  closeSync,
  fstatSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentMailReviewQueue } from "../../../src/augments/agentMail/review-queue";

const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "agent-mail-review-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function proposal(expiresAt = 2_000) {
  return {
    trustLevel: "public" as const,
    recipients: ["customer@example.com"],
    subject: "(reply)",
    rateKey: "reply:message_1",
    fingerprint: "fingerprint-1",
    request: { kind: "reply" as const, messageId: "message_1", text: "Thanks" },
    expiresAt,
  };
}

describe("AgentMail outbound review queue", () => {
  test("persists pending actions with owner-only permissions and reloads them", () => {
    const dir = tempDir();
    const queue = createAgentMailReviewQueue({ agentDir: dir, now: () => 1_000, id: () => "r1" });
    queue.enqueue(proposal());

    const path = join(dir, "agent-mail-reviews.json");
    const fd = openSync(path, "r");
    try {
      expect(fstatSync(fd).mode & 0o777).toBe(0o600);
      expect(readFileSync(fd, "utf8")).toContain('"messageId":"message_1"');
    } finally {
      closeSync(fd);
    }

    const reloaded = createAgentMailReviewQueue({ agentDir: dir, now: () => 1_000 });
    expect(reloaded.get("r1")).toMatchObject({ state: "pending", trustLevel: "public" });
  });

  test("deduplicates an identical pending proposal", () => {
    const queue = createAgentMailReviewQueue({ now: () => 1_000, id: () => "r1" });
    expect(queue.enqueue(proposal()).duplicate).toBe(false);
    const duplicate = queue.enqueue(proposal());
    expect(duplicate.duplicate).toBe(true);
    expect(duplicate.record.id).toBe("r1");
    expect(queue.list()).toHaveLength(1);
  });

  test("requires the pending -> sending -> approved transition", () => {
    let now = 1_000;
    const queue = createAgentMailReviewQueue({ now: () => now, id: () => "r1" });
    queue.enqueue(proposal());
    expect(() => queue.approve("r1", {})).toThrow(/expected sending/);
    now = 1_100;
    expect(queue.beginApproval("r1")).toMatchObject({ state: "sending", attemptedAt: 1_100 });
    expect(queue.approve("r1", { messageId: "sent_1", detail: "operator evidence" })).toMatchObject(
      {
        state: "approved",
        providerMessageId: "sent_1",
        detail: "operator evidence",
      },
    );
    expect(() => queue.beginApproval("r1")).toThrow(/approved/);
  });

  test("rejects a pending action without exposing it for approval again", () => {
    const queue = createAgentMailReviewQueue({ now: () => 1_000, id: () => "r1" });
    queue.enqueue(proposal());
    expect(queue.reject("r1", "not appropriate")).toMatchObject({
      state: "rejected",
      detail: "not appropriate",
    });
    expect(() => queue.beginApproval("r1")).toThrow(/rejected/);
  });

  test("expires pending actions fail closed", () => {
    let now = 1_000;
    const queue = createAgentMailReviewQueue({ now: () => now, id: () => "r1" });
    queue.enqueue(proposal(1_500));
    now = 1_500;
    expect(queue.get("r1")?.state).toBe("expired");
    expect(() => queue.beginApproval("r1")).toThrow(/expired/);
  });

  test("refuses a symlinked persistence target", () => {
    const dir = tempDir();
    const target = join(dir, "target.json");
    writeFileSync(target, "{}");
    symlinkSync(target, join(dir, "agent-mail-reviews.json"));
    expect(() => createAgentMailReviewQueue({ agentDir: dir })).toThrow(/failed to open/);
  });

  test("fails closed on corrupt or unknown persisted versions", () => {
    const dir = tempDir();
    const path = join(dir, "agent-mail-reviews.json");
    writeFileSync(path, "{");
    expect(() => createAgentMailReviewQueue({ stateDir: dir })).toThrow(/failed to read/);

    writeFileSync(
      path,
      JSON.stringify({ version: 2, savedAt: new Date(0).toISOString(), records: [] }),
    );
    expect(() => createAgentMailReviewQueue({ stateDir: dir })).toThrow(/failed validation/);
  });

  test("preserves ambiguous sending state across restart and blocks replay", () => {
    const dir = tempDir();
    const first = createAgentMailReviewQueue({ stateDir: dir, now: () => 1_000, id: () => "r1" });
    first.enqueue(proposal());
    first.beginApproval("r1");

    const restarted = createAgentMailReviewQueue({ stateDir: dir, now: () => 1_000 });
    expect(restarted.get("r1")?.state).toBe("sending");
    expect(() => restarted.beginApproval("r1")).toThrow(/sending/);
    expect(() => restarted.enqueue(proposal())).toThrow(/ambiguous sending state/);
  });

  test("isolates review files across instance state directories", () => {
    const supportDir = tempDir();
    const billingDir = tempDir();
    createAgentMailReviewQueue({
      stateDir: supportDir,
      now: () => 1_000,
      id: () => "support",
    }).enqueue(proposal());
    const billing = createAgentMailReviewQueue({
      stateDir: billingDir,
      now: () => 1_000,
      id: () => "billing",
    });
    expect(billing.list()).toEqual([]);
    billing.enqueue({ ...proposal(), fingerprint: "billing-fingerprint" });
    expect(createAgentMailReviewQueue({ stateDir: supportDir }).get("support")).toBeDefined();
    expect(createAgentMailReviewQueue({ stateDir: supportDir }).get("billing")).toBeUndefined();
  });

  test("fails closed when unresolved reviews fill the bounded queue", () => {
    let id = 0;
    const queue = createAgentMailReviewQueue({ now: () => 1_000, id: () => `r${id++}` });
    for (let i = 0; i < 1_000; i++) {
      queue.enqueue({ ...proposal(), fingerprint: `fingerprint-${i}` });
    }
    expect(() =>
      queue.enqueue({ ...proposal(), fingerprint: "fingerprint-over-capacity" }),
    ).toThrow(/capacity 1000 reached/);
  });
});
